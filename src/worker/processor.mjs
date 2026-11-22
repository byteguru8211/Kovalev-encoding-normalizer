import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { jobPaths } from '../server/db.mjs';

const CLI_PATH = path.resolve(import.meta.dirname, '../../bin/normalize.mjs');

export class JobProcessor {
  constructor({ config, repo, log, isShuttingDown = () => false }) {
    this.config = config;
    this.repo = repo;
    this.log = log;
    this.isShuttingDown = isShuttingDown;
  }

  execute(job) {
    const paths = jobPaths(this.config.dataDir, job.id);
    fs.mkdirSync(paths.staging, { recursive: true });
    const manifestPath = path.join(paths.root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(this.#buildManifest(job, paths), null, 2));

    const started = process.hrtime.bigint();
    return this.#runChild(job, manifestPath, paths).then((outcome) => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (outcome.status === 'ok') {
        this.#publish(job, paths);
        this.log({ event: 'job_succeeded', jobId: job.id, pid: outcome.pid, elapsedMs: Math.round(elapsedMs) });
      } else {
        const interrupted = this.isShuttingDown() && outcome.signal !== null;
        const code = interrupted ? 'interrupted' : outcome.code;
        const message = interrupted
          ? 'Обработка прервана остановкой службы-обработчика'
          : outcome.message;
        this.repo.failJob(job.id, code, message);
        this.log({ event: 'job_failed', jobId: job.id, pid: outcome.pid ?? null, code, elapsedMs: Math.round(elapsedMs) });
      }
      fs.rmSync(paths.staging, { recursive: true, force: true });
      fs.rmSync(manifestPath, { force: true });
    });
  }

  #buildManifest(job, paths) {
    const count = job.files.length;
    return job.files.map((file) => ({
      input: path.join(paths.input, file.storedName),
      name: file.originalName,
      output: count === 1 ? 'normalized.txt' : `normalized-${file.index}.txt`,
    }));
  }

  #runChild(job, manifestPath, paths) {
    return new Promise((resolve) => {
      const cliArgs = [
        CLI_PATH,
        '--manifest', manifestPath,
        '--output-dir', paths.staging,
        '--report', path.join(paths.staging, 'encoding-report.json'),
      ];
      const testDelayMs = Number(job.params?.testDelayMs);
      if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
        cliArgs.push('--delay-ms', String(Math.min(testDelayMs, 30000)));
      }
      const child = spawn(process.execPath, cliArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: paths.root,
      });
      this.repo.setWorkerPid(job.id, child.pid);
      this.log({ event: 'job_started', jobId: job.id, pid: child.pid, files: job.files.length });

      let stderrText = '';
      child.stderr.on('data', (chunk) => {
        if (stderrText.length < 65536) {
          stderrText += chunk;
        }
      });
      child.stdout.resume();

      const timer = setTimeout(() => {
        child.killedByTimeout = true;
        child.kill('SIGKILL');
      }, this.config.jobTimeoutSec * 1000);

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (child.killedByTimeout) {
          resolve({ status: 'error', pid: child.pid, code: 'timeout', message: `Обработка превысила ${this.config.jobTimeoutSec} секунд и была остановлена` });
          return;
        }
        if (code === 0) {
          resolve({ status: 'ok', pid: child.pid });
          return;
        }
        resolve({ status: 'error', pid: child.pid, signal, ...this.#parseChildError(code, signal, stderrText) });
      });
    });
  }

  #parseChildError(code, signal, stderrText) {
    const lastLine = stderrText.trim().split('\n').at(-1) ?? '';
    try {
      const parsed = JSON.parse(lastLine);
      if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
        return { code: parsed.code, message: parsed.message };
      }
    } catch {
      // stderr contained no JSON error object
    }
    return {
      code: code === 1 ? 'internal_error' : 'handler_error',
      message: `Обработчик завершился с кодом ${code}${signal ? ` (сигнал ${signal})` : ''}: ${lastLine.slice(0, 500)}`,
    };
  }

  #publish(job, paths) {
    const reportPath = path.join(paths.staging, 'encoding-report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    fs.mkdirSync(paths.results, { recursive: true });

    const staged = fs.readdirSync(paths.staging).filter((name) => name !== 'encoding-report.json.tmp');
    const results = [];
    for (const name of staged) {
      const from = path.join(paths.staging, name);
      const to = path.join(paths.results, name);
      fs.renameSync(from, to);
      results.push({ name, size: fs.statSync(to).size });
    }

    const summary = {
      files: report.files.length,
      CRLF: 0,
      CR: 0,
      LF: 0,
      codePoints: 0,
      encodings: report.files.map((file) => file.encoding),
    };
    for (const file of report.files) {
      summary.CRLF += file.sourceLineEndings.CRLF;
      summary.CR += file.sourceLineEndings.CR;
      summary.LF += file.sourceLineEndings.LF;
      summary.codePoints += file.codePoints;
    }

    this.repo.succeedJob(job.id, { results, summary });
  }
}
