# 02. Контракт обмена

Версия контракта: **`rps-batch/1`**, версия протокола моста: **1**. Документ — единственный источник истины для
сайта (`source/site-integration`), расширения (`source/extension`) и тестов.

## 1. Каналы

| Канал | Откуда → куда | Назначение |
|---|---|---|
| **Мост страницы** (`window.postMessage`) | content script на `promts.vibecods.xyz` ↔ страница сайта | получить пресеты и **сформированную сайтом** партию заданий |
| **Импорт** | файл пользователя → панель расширения | режим C: JSON-экспорт сайта, партия `rps-batch/1`, JSONL, TXT |
| **Сообщения расширения** | панель ↔ service worker ↔ content script ChatGPT | управление очередью и наблюдение за вкладкой |

HTTPS API на стороне сайта **не вводится** (сайт — статический, без сервера и авторизации; см. `01-ARCHITECTURE.md`).
Контракт `rps-batch/1` не зависит от транспорта: тот же объект можно отдавать из `/api/extension/v1/batches`
(идемпотентный `POST` по `batch_id`) без изменения расширения.

## 2. Мост страницы, протокол v1

Запрос (расширение → страница): `{ source:"rps-extension", version:1, id, type, payload? }`
Ответ (страница → расширение): `{ source:"rps-site", version:1, id, type, ok, payload? , error?:{code,message} }`

* `id` — `[A-Za-z0-9._:-]{1,64}`, ответ несёт тот же `id`.
* Принимаются только сообщения с `event.source === window` и `event.origin === location.origin`.
* Типы запросов: `hello`, `list-presets`, `create-batch`, `cancel`.
  * `hello:result` → `{app, engine, bridge_version, limits{maxCharacters,maxFrames,maxTotalJobs}, strategies, profiles, lengths, site_character}`
  * `list-presets:result` → `{presets:[{id,name,description,builtin}]}`
  * `create-batch` (payload ниже) → серия `create-batch:progress {done,total}` и итог `create-batch:result {batch}` либо `ok:false`
  * `cancel {target}` → `cancel:result {cancelled}`
* Ошибки: `BAD_REQUEST BAD_SOURCE VERSION_MISMATCH BAD_ID BAD_TYPE BAD_PAYLOAD TOO_LARGE BUSY PRESET_NOT_FOUND NO_SITE_CHARACTER
  PASSPORT_FAILED GENERATION_FAILED IDENTITY_DRIFT UNSAFE_PROMPT CANCELLED INTERNAL`.

`create-batch` payload:

```json
{ "mode":"single|multi", "characters":1..50, "frames_per_character":1..100, "strategy":"character|series",
  "preset_id":"natural-selfie|user-…|null", "seed":"RP-…|null", "profile":"gpt-image", "length":"short|standard|detailed",
  "include_negative":true, "use_site_character":false }
```

Лимиты: `characters × frames_per_character ≤ 1500`. Подтверждение больших партий — в расширении (раздел 6).

## 3. Партия `rps-batch/1`

```text
Batch { schema:"rps-batch/1", batch_id, created_at, source{app,engine,bridge,origin,kind}, spec{…payload, seed}, characters[Character] }
Character { character_id, index, name, seed, identity{core, fingerprint, fingerprint_alg}, notes[], jobs[Job] }
Job { image_job_id, index, prompt, negative|null, styling{hairStyle,makeup,glasses}, params{…}, reference:null }
```

| Поле | Правило |
|---|---|
| `batch_id` | `RPS-` + 10 hex от SHA-256 канонического JSON (движок, протокол, параметры, seed, настройки) → **идемпотентно**: тот же запрос даёт тот же id |
| `character_id` | `<batch_id>-C001…` |
| `image_job_id` | `<character_id>-F001…`, уникален в партии; `(character_id, index)` уникальна |
| `prompt` | 20…8000 символов, без управляющих символов, кроме `\n`; готовый английский текст движка сайта (профиль `gpt-image`) |
| `identity.core` | неизменяемое ядро: `age, hairColor, hairLength, hairType, eyeColor, skinTone, build, height, freckles, features[]` |
| `identity.fingerprint` | SHA-256 (hex) канонического JSON ядра; расширение **пересчитывает** и отклоняет партию при расхождении |
| `styling` | переменная часть кадра (в режимах «персонаж»/«серия» движок меняет причёску, макияж, очки по сцене) |
| `params` | сцена/сезон/погода/время/съёмка/кадрирование/ракурс/эмоция/формат кадра — для метаданных |
| `reference` | зарезервировано; всегда `null` (передача референса не реализована) |

**Идентичность.** Ядро внешности постоянно у всех кадров персонажа (проверяется сайтом при сборке и расширением при приёме);
`styling` меняется. Персонажи партии различаются минимум по 4 полям ядра (иначе в `notes` пишется предупреждение).
Текстовая генерация **не гарантирует** идентичное лицо — см. `06-LIMITATIONS.md`.

## 4. Статусы и конечный автомат

Состояния раннера: `idle, preparing, submitting, waiting, downloading, verifying, completed, retryable_error, paused, blocked, failed`.
Статусы задания: `pending, preparing, submitting, waiting, downloading, verifying, completed, retryable_error, failed`.

Допустимые переходы раннера (все остальные запрещены и отвергаются кодом):

```text
idle            → preparing
preparing       → submitting | retryable_error | blocked | paused | failed | completed | idle
submitting      → waiting | downloading | retryable_error | blocked | paused | failed | idle
waiting         → downloading | retryable_error | blocked | paused | failed | idle
downloading     → verifying | retryable_error | blocked | paused | failed | idle
verifying       → completed | retryable_error | failed | blocked | paused | idle
completed       → preparing | paused | idle
retryable_error → preparing | failed | paused | blocked | idle
paused          → preparing | idle
blocked         → preparing | idle
failed          → preparing | paused | idle
```

Следующее задание передаётся **только** после `verifying → completed` (файл сохранён и проверен) и паузы интервала.

## 5. Коды ошибок

| Класс | Коды | Поведение |
|---|---|---|
| Блокирующие (раннер → `blocked`, уведомление, **без обхода**) | `CAPTCHA, AUTH_REQUIRED, RATE_LIMIT, UI_CHANGED, TAB_NOT_FOUND, TAB_CLOSED, PAGE_BUSY, OFFLINE` | ждут действия пользователя и «Продолжить» |
| Повторяемые (расходуют попытки, пауза с нарастающим интервалом) | `GENERATION_ERROR, STALLED, TIMEOUT, NO_IMAGE, PROMPT_NOT_ACCEPTED, FETCH_FAILED, DOWNLOAD_FAILED, SIZE_MISMATCH, PREVIEW_ONLY, DUPLICATE_IMAGE` | `retryable_error` → повтор, затем `failed` |
| Сеть | `NETWORK` | не расходует попытки; ожидание ≤ 15 мин, затем `OFFLINE` |
| Окончательные (задание `failed`, очередь идёт дальше) | `CONTENT_POLICY, MULTIPLE_IMAGES, UNSUPPORTED_IMAGE_FORMAT, INTEGRITY, INTERNAL` | `CONTENT_POLICY` ×3 подряд → `blocked` |

## 6. Метаданные на диске

```text
<Загрузки>/<rootFolder>/Batch_2026-10-17_001/manifest.json
<Загрузки>/<rootFolder>/Batch_2026-10-17_001/Character_001/character.json
<Загрузки>/<rootFolder>/Batch_2026-10-17_001/Character_001/prompts.jsonl
<Загрузки>/<rootFolder>/Batch_2026-10-17_001/Character_001/001.png   (расширение — по реальному формату: png|jpg|webp|gif)
```

`prompts.jsonl`, одна строка на задание:
`{"image_job_id","index","status","prompt","negative","params","styling","file","format","bytes","width","height","sha256","attempts","started_at","completed_at","error"}`.
`manifest.json`: `{schema, batch_id, folder, created_at, source, spec, totals, characters[{character_id,index,folder,name,identity,jobs:[{image_job_id,status,file}]}]}`.
Подтверждение загрузки: состояние `complete`, `exists`, совпадение размера файла с проверенным размером ответа.

## 7. Сообщения панель ↔ service worker

Все сообщения: `{ rps:1, type, …}`; ответ: `{ ok:true, … }` либо `{ ok:false, error:{code,message} }`. Service worker принимает только сообщения
от страниц самого расширения (проверка `sender.id`, `sender.url`) и валидирует поля.

| `type` | Поля | Ответ |
|---|---|---|
| `GET_VIEW` | — | `view` |
| `SITE_STATUS` | — | `site{connected,tabId,origin,engine,bridge_version,limits,site_character}` |
| `SITE_LIST_PRESETS` | — | `presets[]` |
| `SITE_CREATE_BATCH` | `params` (payload §2), `test?` | `summary{batch_id,total,characters,frames,folder,existed}` |
| `IMPORT_BATCH` | `text, fileName, test?` | `summary` |
| `START` | `batch_id, confirm?{acknowledged,typed_total}` | `view` |
| `PAUSE` `RESUME` `STOP` `EMERGENCY_STOP` | — | `view` |
| `RETRY_FAILED` | `batch_id` | `view` |
| `SELECT_BATCH` / `DELETE_BATCH` | `batch_id` | `view` |
| `UPDATE_SETTINGS` | `patch` | `settings` |
| `DIAGNOSE_CHATGPT` | — | `report` |
| `OPEN_CHATGPT` / `OPEN_SITE` | — | `{}` |
| `SHOW_FILE` | `image_job_id` | `{}` |
| `GET_EVENTS` | `batch_id, limit` | `events[]` |
| `EXPORT_LOG` | `batch_id, format:"json|csv"` | `{filename, mime, text}` |

Порт `rps-panel`: service worker присылает `{type:"VIEW", view}` при каждом изменении состояния.

`view`: `{version, runner, batch|null, batches[], settings, site, chatgpt, events[]}`; `runner`: `{state, batch_id, job_id, phase_started_at,
next_allowed_at, retry_at, pause_requested, halted, block{code,message,at}|null, chat{tabId,characterId,framesInChat,url}}`;
`batch`: `{batch_id, folder, kind, status, created_at, totals{total,completed,failed,pending,active,retryable}, characters[{character_id,index,name,total,completed,failed,jobs[{index,status,attempts,file,error_code}]}]}`.

Подтверждение запуска: если `total > confirmThreshold` (50) требуется `confirm.acknowledged=true`; если `total > strongConfirmThreshold` (300) —
ещё и `confirm.typed_total === total`; `total > maxBatchJobs` (1500) запрещено. Проверка выполняется в service worker, а не только в интерфейсе.
