const STATE_LABELS = {
  queued: 'в очереди',
  running: 'выполняется',
  succeeded: 'выполнено',
  failed: 'ошибка',
};

const healthBox = document.getElementById('health');
const form = document.getElementById('upload-form');
const submitButton = document.getElementById('submit-btn');
const submitStatus = document.getElementById('submit-status');
const jobsBox = document.getElementById('jobs');
const refreshButton = document.getElementById('refresh-btn');
const findInput = document.getElementById('find-input');

let pollTimer = null;

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // response has no JSON body
  }
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function setStatus(text, kind = '') {
  submitStatus.textContent = text;
  submitStatus.className = `status ${kind}`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { timeZoneName: 'short' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderJob(job) {
  const card = el('article', `job state-${job.state}`);

  const head = el('div', 'job-head');
  head.append(
    el('code', 'job-id', job.id),
    el('span', `badge badge-${job.state}`, STATE_LABELS[job.state] ?? job.state),
  );
  card.append(head);

  const meta = el('div', 'job-meta');
  meta.append(
    el('span', undefined, `создано: ${formatTime(job.createdAt)}`),
    el('span', undefined, `начато: ${formatTime(job.startedAt)}`),
    el('span', undefined, `завершено: ${formatTime(job.finishedAt)}`),
  );
  card.append(meta);

  if (job.files?.length) {
    card.append(el('div', 'job-files', `входы: ${job.files.map((f) => `${f.originalName} (${f.size} Б)`).join(', ')}`));
  }
  if (job.error) {
    card.append(el('div', 'job-error', `${job.error.code}: ${job.error.message}`));
  }
  if (job.summary) {
    const s = job.summary;
    card.append(el('div', 'job-summary',
      `UTF-8 → CRLF ${s.CRLF}, CR ${s.CR}, LF ${s.LF}; кодовых точек ${s.codePoints}; кодировки: ${s.encodings.join(', ')}`));
  }
  if (job.results?.length) {
    const list = el('div', 'job-results');
    for (const result of job.results) {
      const link = el('a', undefined, `${result.name} (${result.size} Б)`);
      link.href = result.url;
      list.append(link);
    }
    card.append(list);
  }
  return card;
}

async function loadJobs() {
  const forcedId = findInput.value.trim();
  let jobs;
  try {
    if (forcedId) {
      jobs = [await fetchJson(`/api/jobs/${encodeURIComponent(forcedId)}`)];
    } else {
      jobs = (await fetchJson('/api/jobs')).jobs;
    }
  } catch (error) {
    jobsBox.replaceChildren(el('p', 'jobs-empty', `Не удалось загрузить задания: ${error.message}`));
    return false;
  }
  if (jobs.length === 0) {
    jobsBox.replaceChildren(el('p', 'jobs-empty', 'Заданий пока нет — отправьте файл.'));
    return false;
  }
  jobsBox.replaceChildren(...jobs.map(renderJob));
  return jobs.some((job) => job.state === 'queued' || job.state === 'running');
}

async function refreshLoop() {
  const hasActive = await loadJobs();
  if (pollTimer) clearTimeout(pollTimer);
  if (hasActive) {
    pollTimer = setTimeout(refreshLoop, 3000);
  }
}

function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshLoop, 3000);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const files = document.getElementById('files').files;
  if (files.length === 0) {
    setStatus('Выберите хотя бы один файл.', 'error');
    return;
  }
  const data = new FormData();
  for (const file of files) {
    data.append('files', file);
  }
  data.append('params', JSON.stringify({}));
  submitButton.disabled = true;
  setStatus('Отправка…');
  try {
    const job = await fetchJson('/api/jobs', { method: 'POST', body: data });
    setStatus(`Задание принято: ${job.id}`, 'ok');
    findInput.value = '';
    await refreshLoop();
    startPolling();
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`, 'error');
  } finally {
    submitButton.disabled = false;
  }
});

refreshButton.addEventListener('click', () => refreshLoop());
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') refreshLoop();
});

async function init() {
  try {
    const health = await fetchJson('/api/health');
    healthBox.textContent = `Сервер: ${health.status}, тема ${health.topic}, версия ${health.version}`;
  } catch (error) {
    healthBox.textContent = `Сервер недоступен: ${error.message}`;
  }
  await refreshLoop();
}

init();
