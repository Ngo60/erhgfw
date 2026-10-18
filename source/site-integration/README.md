# Интеграция с сайтом: мост расширения + генератор 1.1.0

Тонкий адаптер для RealPhoto Prompt Studio: сайт остаётся единственным источником генерации промптов, расширение — исполнитель очереди.
Пакет также содержит улучшения генератора (селфи и реализм), поэтому ставится целиком.

```text
manifest.json                 список файлов с хешами «до» (чистый сайт) и «после»; пересчитывается scripts/make-site-manifest.mjs
files/                        то, что копируется в сайт
  src/extension-bridge/       мост: protocol.ts · build-batch.ts · bridge.ts · index.ts            (новые)
  src/render/selfie.ts        рука/хват/голова/взгляд/свободная рука у селфи                        (новый)
  src/render/realism.ts       реалистичность фона, характер камеры, negative                        (новый)
  src/render/render.ts        рендерер промптов                                                    (заменяет файл сайта)
  src/engine/compose.ts       движок: версия 1.1.0 и веса ракурса селфи                            (заменяет файл сайта)
  tests/                      extension-bridge.test.ts (36 тестов) · selfie-realism.test.ts (22)
apply.mjs                     установка / --check / --revert / --force
patches/0001-site-integration.patch   то же в виде git-патча на чистый Juncker38/wefeer@29a55fa
```

Установка, проверки, развёртывание, откат — `docs/04-SERVER-SETUP.md`. Что изменилось в генераторе и почему — `docs/07-GENERATOR-CHANGES.md`.
Протокол и формат партии — `docs/02-CONTRACT.md`.

Что делает мост: на запрос расширения (`hello`, `list-presets`, `create-batch`, `cancel`) вызывает **существующие** функции сайта и возвращает партию `rps-batch/1`.
Для каждого персонажа создаётся отдельный паспорт внешности (минимум 4 различающихся поля ядра между персонажами), все кадры проверяются на неизменность ядра и на безопасность текста (`safetyProblems` сайта).
В `params` каждого задания попадают детали селфи (`selfie_hand`, `selfie_grip`, `selfie_free_hand`) и `head_pose`. Мост ничего не вызывает сам и не обращается к сети.

Совместимость: движок `ENGINE_VERSION = 1.1.0`; файлы типизированы под `tsconfig` сайта (`strict`, `erasableSyntaxOnly`). На чистом клоне `Juncker38/wefeer@29a55fa` после установки: `typecheck` чист, 475 тестов проходят.

Если вы меняете файлы пакета: скопируйте их в `files/`, выполните `node scripts/make-site-manifest.mjs <чистый-чекаут-сайта>` и `node --test tests/unit/site-integration.test.mjs`.
