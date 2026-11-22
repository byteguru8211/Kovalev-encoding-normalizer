import fs from 'node:fs';
import { Config } from './src/server/config.mjs';
import { JobRepository } from './src/server/db.mjs';
import { JobProcessor } from './src/worker/processor.mjs';

const config = Config.fromEnv();
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.jobsDir, { recursive: true });

const repo = new JobRepository(config.dbPath);
const processor = new JobProcessor({ config, repo, log });
const active = new Map();
let shuttingDown = false;

function log(fields) {
  console.log(JSON.stringify({ at: new Date().toISOString(), component: 'worker', ...fields }));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function recoverInterruptedJobs() {
  for (const job of repo.runningJobs()) {
    log({ event: 'recovery_found_running', jobId: job.id, stalePid: job.workerPid });
    if (pidAlive(job.workerPid)) {
      log({ event: 'recovery_waiting_stale_child', jobId: job.id, pid: job.workerPid });
      while (pidAlive(job.workerPid)) {
        await sleep(200);
      }
    }
    repo.failJob(job.id, 'interrupted', 'Обработка была прервана аварийной остановкой обработчика');
    log({ event: 'job_failed', jobId: job.id, code: 'interrupted' });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tick() {
  if (shuttingDown) return;
  for (const [jobId, promise] of active) {
    if (promise.settled) {
      active.delete(jobId);
    }
  }
  while (active.size < config.maxConcurrent) {
    const job = repo.claimNextJob();
    if (!job) break;
    log({ event: 'job_claimed', jobId: job.id });
    const promise = processor
      .execute(job)
      .catch((error) => {
        repo.failJob(job.id, 'worker_internal_error', String(error?.message ?? error));
        log({ event: 'job_failed', jobId: job.id, code: 'worker_internal_error', message: String(error?.message ?? error) });
      })
      .finally(() => {
        promise.settled = true;
      });
    active.set(job.id, promise);
  }
}

async function main() {
  log({ event: 'worker_started', maxConcurrent: config.maxConcurrent, dataDir: config.dataDir, version: config.version });
  await recoverInterruptedJobs();
  const timer = setInterval(() => {
    tick().catch((error) => log({ event: 'worker_tick_error', message: String(error?.message ?? error) }));
  }, 1000);
  await tick();

  const stop = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ event: 'worker_stopping', signal });
    clearInterval(timer);
    if (active.size === 0) {
      repo.close();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((error) => {
  log({ event: 'worker_fatal', message: String(error?.stack ?? error) });
  process.exit(1);
});
