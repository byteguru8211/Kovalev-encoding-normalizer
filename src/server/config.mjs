import path from 'node:path';

export class Config {
  static fromEnv(env = process.env) {
    return new Config({
      port: Number(env.FILELAB_PORT ?? 3000),
      host: env.FILELAB_HOST ?? '127.0.0.1',
      dataDir: env.FILELAB_DATA_DIR ?? path.resolve('data'),
      maxConcurrent: Number(env.FILELAB_MAX_CONCURRENT ?? 1),
      jobTimeoutSec: Number(env.FILELAB_JOB_TIMEOUT_SEC ?? 120),
      version: env.FILELAB_VERSION ?? 'dev',
      topic: env.FILELAB_TOPIC ?? '27',
    });
  }

  constructor(fields) {
    Object.assign(this, fields);
    this.dbPath = path.join(this.dataDir, 'jobs.db');
    this.jobsDir = path.join(this.dataDir, 'jobs');
  }

  static get maxFiles() {
    return 10;
  }

  static get maxFileBytes() {
    return 10 * 1024 * 1024;
  }

  static get maxTotalBytes() {
    return 50 * 1024 * 1024;
  }
}
