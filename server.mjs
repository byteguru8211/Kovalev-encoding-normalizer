import fs from 'node:fs';
import path from 'node:path';
import { Config } from './src/server/config.mjs';
import { JobRepository } from './src/server/db.mjs';
import { createApp } from './src/server/app.mjs';

const config = Config.fromEnv();
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.jobsDir, { recursive: true });

const repo = new JobRepository(config.dbPath);
const app = createApp({ config, repo });

app.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      event: 'api_started',
      host: config.host,
      port: config.port,
      dataDir: config.dataDir,
      version: config.version,
      topic: config.topic,
    }),
  );
});
