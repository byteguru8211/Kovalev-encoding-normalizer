# Ковалёв Юрий, группа 20390 — курсовая работа, тема 27

**Приведение кодировок и переводов строк** — веб-сервис обработки файлов на Linux.

Пользователь загружает текстовые файлы через браузер; сервис определяет кодировку
(только по BOM: UTF-8 / UTF-16LE / UTF-16BE; без BOM — строгий UTF-8), декодирует
байты без подстановки символов замены, приводит CRLF и CR к LF и отдаёт
`normalized.txt` (UTF-8 без BOM) и `encoding-report.json` со счётчиками исходных
переводов строк и числом кодовых точек. Повреждённые входы (нечётная длина UTF-16,
непарные суррогаты, битый UTF-8) приводят задание в состояние `failed` с понятной
причиной.

Стек: Ubuntu 24.04, Node.js 24 LTS, Express 5, Multer 2, SQLite (`node:sqlite`),
systemd, Nginx. Предметная часть — собственный декодировщик байтов.

---

## 1. Устройство системы

### Путь задания

```
Браузер -> Nginx:80 -> API (node, 127.0.0.1:3000) -> SQLite jobs.db
                                    -> входные файлы /var/lib/filelab/jobs/<id>/input/
Worker (отдельная служба) -> SQLite (атомарный захват задания)
                -> дочерний процесс bin/normalize.mjs на каждое задание
                -> staging -> results -> SQLite (succeeded/failed)
Браузер <- Nginx <- API <- сведения о задании и готовые файлы
```

### Компоненты

| Файл | Роль |
|---|---|
| `server.mjs` | вход API-службы: маршруты `/api/health`, `/api/jobs...`, приём multipart |
| `worker.mjs` | вход службы-обработчика: опрос очереди, запуск дочерних процессов, восстановление |
| `src/normalizer/` | ядро темы 27: `codecs.mjs` (детектор BOM, строгие декодеры UTF-16/UTF-8), `line-endings.mjs` (CRLF/CR→LF, счётчики), `pipeline.mjs` (фасад `TextNormalizer`), `errors.mjs` |
| `bin/normalize.mjs` | CLI обработчика: `--input/--output` или `--manifest/--output-dir`; коды выхода 0/2/1 |
| `src/server/app.mjs` | Express-приложение, маршруты, ограничения, маппинг ошибок HTTP |
| `src/server/db.mjs` | `JobRepository` поверх `node:sqlite` (WAL, busy_timeout, транзакция при захвате) |
| `src/server/config.mjs` | конфигурация из переменных окружения |
| `src/worker/processor.mjs` | `JobProcessor`: манифест, spawn дочернего процесса, тайм-аут, публикация результатов |
| `public/` | одностраничный клиент (HTML/CSS/JS без фреймворков) |
| `deploy/` | юниты systemd, конфигурация Nginx, `filelab.env` |
| `scripts/` | `install.sh`, `teacher-access.sh`, `teacher-access-stop.sh` |
| `tests/` | модульные тесты ядра (`node --test`) |

### Хранилище и права

| Путь | Содержимое | Кто изменяет |
|---|---|---|
| `/opt/filelab` | установленный код + `VERSION` | root при обновлении |
| `/var/www/filelab` | статический клиент | root при обновлении |
| `/var/lib/filelab` | `jobs.db`, `incoming/`, `jobs/<id>/` | пользователь службы `filelab` |
| `/etc/filelab.env` | конфигурация запуска | root |
| `/etc/systemd/system/filelab-*.service` | описания служб | root |
| `/etc/nginx/sites-available/filelab` | конфигурация Nginx | root |

Службы работают от непривилегированного `filelab` (nologin). Каталог кода принадлежит
root — ошибка приложения не может изменить саму программу.

### Жизненный цикл задания

Состояния: `queued → running → succeeded | failed`. Времена хранятся в UTC (ISO 8601,
поле `Z`) и отображаются клиентом с часовым поясом.

* Приём: `POST /api/jobs` сохраняет файлы в `incoming/<token>`, проверяет количество
  (1–10), размер (≤10 MiB файл, ≤50 MiB сумма) и JSON-параметры, создаёт запись
  `queued` и переносит файлы в `jobs/<id>/input/`. Имена файлов на диске — UUID,
  исходное имя хранится как подпись для пользователя; путь пользователями не задаётся.
* Выдача: worker в короткой транзакции `BEGIN IMMEDIATE` выбирает первое `queued`
  по (`created_at`, `rowid`) и помечает `running` — повторный запуск одного задания
  исключён.
* Обработка: дочерний процесс `node bin/normalize.mjs --manifest ...` (без shell,
  аргументы массивом). PID пишется в БД и в журнал. Тайм-аут `FILELAB_JOB_TIMEOUT_SEC`
  (120 с) — SIGKILL и `failed/timeout`.
* Публикация: результаты пишутся в `jobs/<id>/.staging/`, после кода выхода 0 файлы
  атомарно перемещаются `rename()` в `jobs/<id>/results/`, и только затем задание
  помечается `succeeded`.
* Восстановление: при старте worker все `running`-задания проверяются по PID: живой
  дочерний процесс (осиротевший после SIGKILL worker) дожидается завершения, затем
  задание помечается `failed/interrupted`; очередь (`queued`) продолжает
  обрабатываться. Перезапуск только API ничего не помечает — состояние живёт в SQLite.
* Конкурентность: `FILELAB_MAX_CONCURRENT` (по умолчанию 1; испытания прогнаны с 1 и 2).

### Правила темы 27 и их связь с контрольными фактами

Определение кодировки (`src/normalizer/codecs.mjs`):

1. `EF BB BF` → UTF-8 с BOM; `FF FE` → UTF-16LE; `FE FF` → UTF-16BE.
2. Без BOM допускается только строгий UTF-8: отвергаются overlong-последовательности,
   байты `C0/C1/FE/F8+`, кодовые точки > U+10FFFF и суррогаты, закодированные в UTF-8,
   обрывы последовательностей.
3. UTF-16: нечётная длина тела → `odd_utf16_length`; непарный суррогат →
   `invalid_surrogate`. Символы замены (U+FFFD) не подставляются никогда.
4. Переводы строк после декодирования: `CRLF` и одиночный `CR` → `LF`; ведётся счёт
   всех трёх исходных типов.
5. Выход — UTF-8 без BOM; все ведущие U+FEFF (артефакты BOM/ZWNBSP) отбрасываются,
   поэтому результат никогда не начинается с `EF BB BF` и повторная нормализация
   идемпотентна даже для входа с несколькими U+FEFF в начале.

Обработка выполняется над содержимым всего файла: вход читается целиком в память
(объём ограничен лимитом 10 MiB на файл) и затем декодируется побайтово. Поточное
чтение не используется сознательно — полный текст нужен для строгой проверки байтов,
подсчёта кодовых точек и записи результата.

`cases/27/expected.json` ↔ результат:

| Факт эталона | Где в моём результате |
|---|---|
| `encoding: "UTF-16LE"` | `files[0].encoding` в `encoding-report.json` |
| `CRLF: 1, CR: 1, LF: 0` | `files[0].sourceLineEndings` |
| `normalizedText: "А\nБ\n"` | байты `normalized.txt`: `D0 90 0A D0 91 0A` |
| `outputBOM: false` | `files[0].outputBom: false` (и отсутствие `EF BB BF` в первых байтах) |

`codePoints` — число кодовых точек декодированного исходного текста (для контроля 5:
`А`, `CR`, `LF`, `Б`, `CR`); `normalizedCodePoints` — после приведения (4).

---

## 2. Развёртывание с чистой ОС

Все команды выполняются **на сервере** (Ubuntu 24.04), если не указано иное.

1. Пакеты:
   ```bash
   sudo apt update
   sudo apt install -y openssh-server nginx curl ca-certificates git xz-utils sqlite3 python3 rsync
   sudo systemctl enable --now ssh
   ```
2. Node.js 24 LTS (проверенная сумма SHA256):
   ```bash
   mkdir -p ~/filelab-install && cd ~/filelab-install
   NODE_VERSION=v24.22.2; NODE_ARCH=linux-x64
   BASE=https://nodejs.org/dist/$NODE_VERSION; ARCHIVE=node-$NODE_VERSION-$NODE_ARCH.tar.xz
   curl -fLO "$BASE/$ARCHIVE"; curl -fLO "$BASE/SHASUMS256.txt"
   grep "  $ARCHIVE$" SHASUMS256.txt > node-checksum.txt
   test -s node-checksum.txt && sha256sum -c node-checksum.txt   # дождаться OK
   sudo mkdir -p /opt/node24
   sudo tar -xJf "$ARCHIVE" -C /opt/node24 --strip-components=1
   sudo ln -sfn /opt/node24/bin/node /usr/local/bin/node
   sudo ln -sfn /opt/node24/bin/npm /usr/local/bin/npm
   node --version    # v24.22.2
   ```
3. Код и установка:
   ```bash
   git clone https://github.com/byteguru8211/Kovalev-encoding-normalizer.git
   cd Kovalev-encoding-normalizer
   npm ci
   node --test "tests/*.test.mjs"        # 18 passed
   sudo bash scripts/install.sh
   ```
   Сценарий идемпотентен: создаёт пользователя `filelab`, каталоги, службы,
   конфигурацию Nginx (отключает стандартный сайт `default`), запускает службы и
   проверяет `/api/health` напрямую (127.0.0.1:3000) и через Nginx (порт 80).
4. Проверка после установки (на сервере):
   ```bash
   systemctl is-active filelab-api filelab-worker nginx
   curl -fsS http://127.0.0.1/api/health
   ```
5. Доступ преподавателя (Tailscale + SSH root) — раздел 3.

Соответствие сдаваемой версии установленному коду проверяется так: коммит из
`git rev-parse HEAD` в репозитории и список SHA256 файлов `/opt/filelab`
(БД и журналы в список не входят):

```bash
find /opt/filelab -type f -not -path '*/node_modules/*' -not -name VERSION -printf '%P\n' | sort | xargs sha256sum
```

---

## 3. Эксплуатация и диагностика

### Запуск и остановка (на сервере)

```bash
sudo systemctl start|stop|restart filelab-api filelab-worker
systemctl status filelab-api filelab-worker nginx --no-pager
sudo journalctl -u filelab-api -n 30 --no-pager
sudo journalctl -u filelab-worker -n 30 --no-pager
```

Журнал worker содержит события `job_claimed`, `job_started` (с PID дочернего процесса),
`job_succeeded` / `job_failed` (с кодом и временем) по идентификатору задания.
Содержимое загруженных файлов, пароли и ключи в журнал не пишутся.

### Доступ преподавателя через Tailscale (на сервере)

```bash
sudo bash scripts/teacher-access.sh        # открыть доступ на время проверки
sudo bash scripts/teacher-access-stop.sh   # закрыть доступ после проверки
```

`teacher-access.sh`: включает вход root по паролю (`/etc/ssh/sshd_config.d/99-course-review.conf`),
просит задать пароль root, поднимает Tailscale (показывает ссылку активации) и печатает:
адрес сайта `http://100.x.y.z/`, команду `ssh root@100.x.y.z`. Ссылку на сеть Tailscale
и пароль передаются преподавателю лично. Stop-скрипт возвращает sshd к настройкам по
умолчанию, снимает машину с Tailscale и блокирует аккаунт root.

Остановка всего сервиса на время между проверками:

```bash
sudo systemctl stop filelab-api filelab-worker   # nginx можно оставить
sudo bash scripts/teacher-access-stop.sh
```

### Типовые неисправности

| Симптом | Куда смотреть |
|---|---|
| 502 от Nginx | `systemctl is-active filelab-api`, `curl http://127.0.0.1:3000/api/health`, журнал API |
| Задания стоят в `queued` | `systemctl is-active filelab-worker`, журнал worker (ошибки захвата) |
| 413 на маленьких файлах | лимиты Nginx (`client_max_body_size`) и `Config.maxFileBytes` |
| Не запускается после reboot | `systemctl is-enabled filelab-api filelab-worker`, путь `/usr/local/bin/node` |
| SSH не проходит | `sshd -T | grep -E 'permitrootlogin|passwordauthentication'`, `tailscale status` |

---

## 4. Выполненные испытания

Полные протоколы с идентификаторами заданий — в [docs/TESTS.md](docs/TESTS.md).
Краткая сводка:

| Сценарий | Результат |
|---|---|
| Обычное задание (контроль темы: UTF-16LE «А\r\nБ\r») | ✅ `succeeded`, `normalized.txt` = `D0 90 0A D0 91 0A`, счётчики CRLF=1, CR=1, LF=0 |
| Неправильный параметр (params=не-JSON) | ✅ HTTP 400 `invalid_params`, задание не создаётся |
| Неправильное содержимое (broken-utf16.txt) | ✅ `failed`, код `odd_utf16_length` |
| Три задания при лимите 1 / лимите 2 | ✅ см. docs/TESTS.md |
| Остановка worker при непустой очереди | ✅ см. docs/TESTS.md |
| Аварийное завершение worker (SIGKILL) | ✅ `failed/interrupted` после перезапуска |
| Перезапуск API | ✅ состояние и результаты сохраняются |
| Перезагрузка Linux | ✅ после `sudo reboot` службы active+enabled, health ок, IP прежний, зависших `running` нет |
| Идемпотентность | ✅ нормализация `normalized.txt` повторно даёт те же байты |
| `check-http.mjs cases/27` | ✅ транспорт пройден, артефакты скачаны |

Тесты: `node --test "tests/*.test.mjs"` — 18 тестов. Ядро темы (13): контрольный
факт темы, все кодировки, все виды битых последовательностей, идемпотентность
(включая вход с несколькими U+FEFF). HTTP-слой (5): вход существует на диске в момент
`queued`, более 10 файлов дают 413, некорректный `params` даёт 400, `runningJobs`
возвращает все зависшие задания независимо от давности.
