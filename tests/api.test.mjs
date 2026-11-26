import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.mjs';
import { Config } from '../src/server/config.mjs';
import { JobRepository, jobPaths } from '../src/server/db.mjs';

function makeServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filelab-test-'));
  const config = new Config({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    maxConcurrent: 1,
    jobTimeoutSec: 120,
    version: 'test',
    topic: '27',
  });
  fs.mkdirSync(config.jobsDir, { recursive: true });
  const repo = new JobRepository(config.dbPath);
  const app = createApp({ config, repo });
  const server = app.listen(0, '127.0.0.1');
  const ready = new Promise((resolve) => server.once('listening', resolve));
  return {
    server,
    repo,
    config,
    ready,
    base: () => `http://127.0.0.1:${server.address().port}`,
  };
}

function utf16leControlBytes() {
  const bom = [0xff, 0xfe];
  const body = [];
  for (const unit of [0x0410, 0x000d, 0x000a, 0x0411, 0x000d]) {
    body.push(unit & 0xff, unit >> 8);
  }
  return new Uint8Array([...bom, ...body]);
}

async function submit(ctx, files, params = '{}') {
  const form = new FormData();
  for (const file of files) {
    form.append('files', new Blob([file.bytes]), file.name);
  }
  form.append('params', params);
  return fetch(`${ctx.base()}/api/jobs`, { method: 'POST', body: form });
}

test('control topic-27 job is accepted and input exists before any worker runs', async (t) => {
  const ctx = makeServer();
  await ctx.ready;
  t.after(() => { ctx.server.close(); ctx.repo.close(); fs.rmSync(ctx.config.dataDir, { recursive: true, force: true }); });

  const res = await submit(ctx, [{ name: 'utf16.txt', bytes: utf16leControlBytes() }]);
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.equal(job.state, 'queued');

  // The queued job must already have its input files on disk (Fix 1).
  const details = await (await fetch(`${ctx.base()}/api/jobs/${job.id}`)).json();
  assert.equal(details.files.length, 1);
  const stored = ctx.repo.getJob(job.id).files[0].storedName;
  assert.ok(fs.existsSync(path.join(jobPaths(ctx.config.dataDir, job.id).input, stored)),
    'input file must exist the moment the job is queued');
});

test('more than 10 files returns 413, not 500 (Fix 4)', async (t) => {
  const ctx = makeServer();
  await ctx.ready;
  t.after(() => { ctx.server.close(); ctx.repo.close(); fs.rmSync(ctx.config.dataDir, { recursive: true, force: true }); });

  for (const count of [11, 12]) {
    const files = Array.from({ length: count }, (_, i) => ({ name: `f${i}.txt`, bytes: new Uint8Array([0x41]) }));
    const res = await submit(ctx, files);
    assert.equal(res.status, 413, `HTTP status for ${count} files`);
    const body = await res.json();
    assert.equal(body.error.code, 'too_many_files');
  }
});

test('invalid params JSON returns 400', async (t) => {
  const ctx = makeServer();
  await ctx.ready;
  t.after(() => { ctx.server.close(); ctx.repo.close(); fs.rmSync(ctx.config.dataDir, { recursive: true, force: true }); });
  const res = await submit(ctx, [{ name: 'a.txt', bytes: new Uint8Array([0x41]) }], '{"columns":');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_params');
});

test('runningJobs returns every running job regardless of recency (Fix 3)', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filelab-db-'));
  const dbPath = path.join(dataDir, 'jobs.db');
  const repo = new JobRepository(dbPath);
  t.after(() => { repo.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  // Insert 1200 jobs; make a few OLD ones running to exceed the old 1000-row window.
  const ids = [];
  for (let i = 0; i < 1200; i += 1) {
    ids.push(repo.createJob({ params: {}, files: [] }).id);
  }
  // Force the first two (oldest) into running.
  for (const id of ids.slice(0, 2)) {
    repo.claimNextJob(); // claims oldest queued -> running, FIFO
  }
  const running = repo.runningJobs();
  assert.equal(running.length, 2);
  assert.deepEqual(running.map((j) => j.id).sort(), ids.slice(0, 2).sort());
});
