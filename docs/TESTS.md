# Протокол испытаний

Все испытания выполнены 22.11.2026 на установленном стенде (версия 1.0.0,
`FILELAB_MAX_CONCURRENT` менялся по сценарию). Команды выполнялись на сервере;
идентификаторы заданий — фактические из SQLite/журнала.

Тестовая задержка задаётся параметром `{"testDelayMs": N}` (не более 30 с) —
это явный тестовый режим, добавляющий паузу в дочерний процесс до предметной
операции; полезной работой не является.

## 1. Обычное задание по теме (контроль темы 27)

Вход: `fixtures/27/utf16.txt` (UTF-16LE BOM, «А\r\nБ\r»).

- Задание `7c21aa00-43f9-455a-96b4-2439eec65e2e` → `succeeded`.
- `normalized.txt` = 6 байт `D0 90 0A D0 91 0A` («А\nБ\n»).
- `encoding-report.json`: encoding UTF-16LE, CRLF=1, CR=1, LF=0,
  codePoints=5, outputBom=false.
- Основание правильности: совпадение с `cases/27/expected.json` по всем четырём
  контрольным фактам (см. таблицу в README).

## 2. Неправильный параметр

`params={"columns":` (некорректный JSON) → **HTTP 400**
`{"code":"invalid_params","message":"Поле params не является корректным JSON"}`,
задание не создано, очередь не тронута.

## 3. Неправильное содержимое файла

Вход: `fixtures/27/broken-utf16.txt` (BOM + 1 байт).

- Задание `74df265c-0e97-472b-b905-99526523993b` → `failed`,
  `error.code = odd_utf16_length`, сообщение «UTF-16 body has odd byte length 1».
- API остался работоспособен, очередь не зависла (следующие задания выполнялись).

## 4. Изменённый допустимый вход (несколько файлов)

Входы: `multi.txt` (строгий UTF-8 без BOM, CRLF+CR+LF) и `u16be.txt`
(UTF-16BE BOM, «😀 x»). Задание `bf22eebd-4493-4a9a-9b49-961e88c86988` → `succeeded`,
результаты `normalized-1.txt`, `normalized-2.txt`, `encoding-report.json`
(CRLF=1, CR=1, LF=1; UTF-16BE codePoints=3 — эмодзи как одна кодовая точка).

## 5. Закрытие страницы после принятия

Страница перезагружена (F5) во время работы и после — список заданий восстановлен
запросом `GET /api/jobs`, принятые задания не потеряны (`135d3a08…` и др.).

## 6. Три задания при лимите 1

Входы: контроль темы, `params={"testDelayMs":3000}`.

| id | startedAt | finishedAt |
|---|---|---|
| `28f7cf90` | 11:55:05.425 | 11:55:08.518 |
| `efe4c0a6` | 11:55:09.438 | 11:55:12.527 |
| `5c10cc8f` | 11:55:13.447 | 11:55:16.5 |

Интервалы не пересекаются — одновременно выполнялось не более одного; все получили
конечное состояние `succeeded`.

## 7. Те же задания при лимите 2

`FILELAB_MAX_CONCURRENT=2`, `testDelayMs=4000`:

| id | startedAt | finishedAt |
|---|---|---|
| `25979321` | 11:55:39.801 | 11:55:43.900 |
| `a25adc7b` | 11:55:39.821 | 11:55:43.916 |
| `f69344d4` | 11:55:44.815 | 11:55:48.9 |

Два задания выполнялись одновременно, третье ожидало в `queued`; API отвечал во
время обработки (`GET /api/jobs` возвращал 200). Лимит возвращён к 1.

## 8. Остановка обработчика при непустой очереди

Два задания с `testDelayMs=15000`; во время работы первого `systemctl stop
filelab-worker`.

- Выполнявшееся `43a4f591` → `failed` (дочерний процесс остановлен вместе со
  службой, `KillMode=control-group`);
- queued-задание `ac64bc2e` осталось в очереди, API продолжал показывать список;
- после `systemctl start filelab-worker` queued-задание выполнено (`succeeded`).

После доработки кода остановка выполняющегося задания фиксируется кодом
`interrupted` (см. сценарий 9).

## 9. Аварийное завершение обработчика (SIGKILL)

Задание `5bac82ed-a147-4720-93c7-b12476d9b609` (`testDelayMs=20000`), worker убит
`kill -9`. Systemd перезапустил службу (`Restart=on-failure`), новый worker:

```
worker_started → recovery_found_running jobId=5bac82ed stalePid=25304 → job_failed code=interrupted
```

Задание → `failed`, `error.code = interrupted`, «Обработка была прервана
аварийной остановкой обработчика». Очередь продолжила работу.

## 10. Перезапуск API

`systemctl restart filelab-api` при живом worker: SHA256 `normalized.txt` задания
`7c21aa00` совпал до и после (`3186b045…`), история заданий (15 записей) сохранена,
работающая обработка worker не прервалась.

## 11. Идемпотентность нормализации

Результат контрольного задания (`D0 90 0A D0 91 0A`) подан как вход нового
задания `135d3a08-68fc-4e4b-b458-622388ce3a60` → `succeeded`, SHA256 результата
идентичен SHA256 входа. Модульный тест идемпотентности — в `tests/normalizer.test.mjs`.

## 12. Перезагрузка Linux

Выполняется автором перед сдачей. Службы `filelab-api`, `filelab-worker`, `nginx`,
`ssh`, `tailscaled` отмечены `systemctl is-enabled ... = enabled`, поэтому поднимаются
при загрузке автоматически. Порядок прогона (на сервере, после `sudo reboot` и
переподключения по SSH):

```bash
uptime                                   # свежая загрузка
systemctl is-active filelab-api filelab-worker nginx ssh
curl -fsS http://127.0.0.1:3000/api/health   # прямой Node
curl -fsS http://127.0.0.1/api/health        # через Nginx
tailscale ip -4                          # 100.105.86.5
# история заданий и готовые результаты не исчезли:
node check-http.mjs http://127.0.0.1 cases/27 report-reboot
# зависших running нет:
sudo sqlite3 /var/lib/filelab/jobs.db "select id,state from jobs where state='running';"
```

Ожидаемо: все службы `active`, оба health дают `topic:"27"`, Tailscale-IP тот же,
контрольное задание проходит, запрос `running` пуст (ни одно задание не зависло).

Результат фактического прогона: дата 2026-11-22 (uptime 1 мин после `sudo reboot`):

- `systemctl is-active filelab-api filelab-worker nginx ssh tailscaled` → все `active`
  (службы также `enabled` — подняты автоматически при загрузке);
- `curl http://127.0.0.1:3000/api/health` и `curl http://127.0.0.1/api/health` →
  `{"status":"ok","version":"1.0.0","topic":"27"}`;
- `tailscale ip -4` → прежний `100.105.86.5`, сайт отвечает по этому адресу;
- журнал worker: `worker_started` в 12:10:24 без `recovery_found_running` (ни одно
  задание не было в `running` на момент выключения);
- `sqlite3 jobs.db "select count(*), sum(state='running') ..."` → зависших `running` = 0,
  история заданий сохранена;
- `node check-http.mjs http://127.0.0.1 cases/27 report-reboot` →
  `transport_passed_semantic_review_required`, скачанный `normalized.txt` =
  `D0 90 0A D0 91 0A` («А\nБ\n»).


## Транспортная проверка комплекта

```
node check-http.mjs http://127.0.0.1 cases/27 report-27
→ transport_passed_semantic_review_required (все проверки пройдены, артефакты скачаны)
```
