import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed')),
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  params        TEXT NOT NULL,
  files         TEXT NOT NULL,
  results       TEXT NOT NULL DEFAULT '[]',
  summary       TEXT,
  error_code    TEXT,
  error_message TEXT,
  worker_pid    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_state_created ON jobs (state, created_at);
`;

export class JobRepository {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  createJob({ params, files }) {
    return this.createJobWithId(randomUUID(), { params, files });
  }

  createJobWithId(id, { params, files }) {
    const createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO jobs (id, state, created_at, params, files) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'queued', createdAt, JSON.stringify(params), JSON.stringify(files));
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? JobRepository.#toDto(row) : null;
  }

  listJobs(limit = 100) {
    const rows = this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit);
    return rows.map((row) => JobRepository.#toDto(row));
  }

  claimNextJob() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `SELECT id FROM jobs WHERE state = 'queued'
           ORDER BY created_at, rowid LIMIT 1`,
        )
        .get();
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db
        .prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'")
        .run(new Date().toISOString(), row.id);
      this.db.exec('COMMIT');
      return this.getJob(row.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setWorkerPid(id, pid) {
    this.db.prepare('UPDATE jobs SET worker_pid = ? WHERE id = ?').run(pid, id);
  }

  succeedJob(id, { results, summary }) {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'succeeded', finished_at = ?, results = ?, summary = ?,
         error_code = NULL, error_message = NULL WHERE id = ? AND state = 'running'`,
      )
      .run(new Date().toISOString(), JSON.stringify(results), JSON.stringify(summary), id);
  }

  failJob(id, code, message) {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'failed', finished_at = ?, error_code = ?, error_message = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(new Date().toISOString(), code, message, id);
  }

  runningJobs() {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE state = 'running' ORDER BY created_at, rowid")
      .all();
    return rows.map((row) => JobRepository.#toDto(row));
  }

  static #toDto(row) {
    return {
      id: row.id,
      state: row.state,
      createdAt: row.created_at,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
      params: JSON.parse(row.params),
      files: JSON.parse(row.files),
      results: JSON.parse(row.results),
      summary: row.summary ? JSON.parse(row.summary) : null,
      error: row.error_code
        ? { code: row.error_code, message: row.error_message }
        : null,
      workerPid: row.worker_pid ?? null,
    };
  }
}

export function jobPaths(dataDir, jobId) {
  const root = path.join(dataDir, 'jobs', jobId);
  return {
    root,
    input: path.join(root, 'input'),
    staging: path.join(root, '.staging'),
    results: path.join(root, 'results'),
  };
}
