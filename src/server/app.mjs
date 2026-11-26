import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Config } from './config.mjs';
import { JobRepository, jobPaths } from './db.mjs';

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class HttpApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApp({ config, repo }) {
  const app = express();
  app.disable('x-powered-by');

  const incomingDir = path.join(config.dataDir, 'incoming');
  fs.mkdirSync(incomingDir, { recursive: true });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: config.version, topic: config.topic });
  });

  const upload = buildUpload(incomingDir);
  app.post('/api/jobs', attachUploadToken(upload), upload.array('files', Config.maxFiles), async (req, res, next) => {
    try {
      const job = acceptJob({ req, config, repo, incomingDir });
      res.status(202).json({ id: job.id, state: job.state });
    } catch (error) {
      fs.rmSync(path.join(incomingDir, req.uploadToken), { recursive: true, force: true });
      next(error);
    }
  });

  app.get('/api/jobs', (req, res) => {
    res.json({ jobs: repo.listJobs(100).map(toPublicJob) });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = findJob(req.params.id, repo);
    res.json(toPublicJob(job));
  });

  app.get('/api/jobs/:id/results/:name', (req, res) => {
    const job = findJob(req.params.id, repo);
    const safeName = path.basename(req.params.name);
    const result = job.results.find((entry) => entry.name === safeName);
    if (!result) {
      throw new HttpApiError(404, 'result_not_found', 'Результат с таким именем отсутствует');
    }
    const filePath = path.join(jobPaths(config.dataDir, job.id).results, safeName);
    if (!fs.existsSync(filePath)) {
      throw new HttpApiError(404, 'result_missing', 'Файл результата недоступен на диске');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });

  app.use(express.static(path.resolve(import.meta.dirname, '../../public')));

  app.use((error, req, res, next) => {
    const mapped = mapError(error);
    if (req.uploadToken) {
      fs.rmSync(path.join(incomingDir, req.uploadToken), { recursive: true, force: true });
    }
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
  });

  return app;
}

function attachUploadToken(upload) {
  return (req, res, next) => {
    req.uploadToken = randomUUID();
    next();
  };
}

function buildUpload(incomingDir) {
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(incomingDir, req.uploadToken);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, randomUUID());
    },
  });
  return multer({
    storage,
    limits: {
      fileSize: Config.maxFileBytes,
      files: Config.maxFiles,
      fields: 1,
    },
  });
}

function acceptJob({ req, config, repo, incomingDir }) {
  const uploadDir = path.join(incomingDir, req.uploadToken);
  const files = req.files ?? [];
  if (files.length === 0) {
    throw new HttpApiError(400, 'no_files', 'Требуется передать от 1 до 10 файлов в поле files');
  }
  if (files.length > Config.maxFiles) {
    throw new HttpApiError(413, 'too_many_files', `Один запрос содержит не более ${Config.maxFiles} файлов`);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > Config.maxTotalBytes) {
    throw new HttpApiError(413, 'total_size_exceeded', 'Суммарный размер файлов превышает 50 MiB');
  }
  const params = parseParams(req.body?.params);

  // Move the inputs into the job directory BEFORE the job becomes queued, so the
  // worker can never claim a job whose input files are not yet on disk.
  const id = randomUUID();
  const paths = jobPaths(config.dataDir, id);
  fs.mkdirSync(paths.input, { recursive: true });
  try {
    for (const file of files) {
      fs.renameSync(file.path, path.join(paths.input, path.basename(file.path)));
    }
  } catch (error) {
    fs.rmSync(paths.root, { recursive: true, force: true });
    throw new HttpApiError(500, 'storage_error', 'Не удалось сохранить входные файлы');
  }

  const job = repo.createJobWithId(id, {
    params,
    files: files.map((file, index) => ({
      index: index + 1,
      originalName: file.originalname || `file-${index + 1}`,
      storedName: path.basename(file.path),
      size: file.size,
    })),
  });

  fs.rmSync(uploadDir, { recursive: true, force: true });
  return job;
}

function parseParams(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return {};
  }
  if (typeof raw !== 'string') {
    throw new HttpApiError(400, 'invalid_params', 'Поле params должно быть строкой с JSON');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpApiError(400, 'invalid_params', 'Поле params не является корректным JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpApiError(400, 'invalid_params', 'Поле params должно быть JSON-объектом');
  }
  return parsed;
}

function findJob(id, repo) {
  if (!JOB_ID_PATTERN.test(id)) {
    throw new HttpApiError(400, 'invalid_job_id', 'Недопустимый формат идентификатора задания');
  }
  const job = repo.getJob(id);
  if (!job) {
    throw new HttpApiError(404, 'job_not_found', 'Задание с таким идентификатором отсутствует');
  }
  return job;
}

function toPublicJob(job) {
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    results: job.results.map((entry) => ({
      ...entry,
      url: `/api/jobs/${job.id}/results/${entry.name}`,
    })),
    summary: job.summary,
    files: job.files.map(({ index, originalName, size }) => ({ index, originalName, size })),
  };
}

function mapError(error) {
  if (error instanceof HttpApiError) {
    return error;
  }
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return new HttpApiError(413, 'file_too_large', 'Размер файла превышает 10 MiB');
  }
  if (error?.code === 'LIMIT_FILE_COUNT' || error?.code === 'LIMIT_UNEXPECTED_FILE') {
    return new HttpApiError(413, 'too_many_files', `Один запрос содержит не более ${Config.maxFiles} файлов`);
  }
  if (error?.type === 'entity.parse.failed') {
    return new HttpApiError(400, 'invalid_request', 'Некорректная форма запроса');
  }
  console.error('Unhandled error:', error);
  return new HttpApiError(500, 'internal_error', 'Внутренняя ошибка сервера');
}
