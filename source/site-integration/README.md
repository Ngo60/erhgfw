# Интеграция с сайтом (мост расширения)

Тонкий адаптер для RealPhoto Prompt Studio: сайт остаётся единственным источником генерации промптов, расширение — исполнитель очереди.

```text
files/src/extension-bridge/   protocol.ts · build-batch.ts · bridge.ts · index.ts   (копируются в src/extension-bridge/)
files/tests/extension-bridge.test.ts                                               (35 тестов на реальном движке)
patches/0001-extension-bridge.patch                                                (то же в виде git-патча, включая 2 строки в src/main.tsx)
apply.mjs                                                                          (идемпотентная установка: --check / --revert)
```

Установка, проверки, развёртывание, откат — `docs/04-SERVER-SETUP.md`. Протокол и формат партии — `docs/02-CONTRACT.md`.

Что делает мост: на запрос расширения (`hello`, `list-presets`, `create-batch`, `cancel`) вызывает **существующие** функции сайта (`generateScenario`, `runBatch`, `renderScenario`, `normalizeSettings`) и возвращает партию `rps-batch/1`.
Для каждого персонажа создаётся отдельный паспорт внешности (минимум 4 различающихся поля ядра между персонажами), все кадры проверяются на неизменность ядра и на безопасность текста (`safetyProblems` сайта).
Мост ничего не вызывает сам и не обращается к сети.

Совместимость: движок `ENGINE_VERSION = 1.0.0`, `tsconfig` сайта (`strict`, `erasableSyntaxOnly`) — файлы типизированы под него; на чистом клоне `Juncker38/wefeer@29a55fa`: `typecheck` чист, 452 теста проходят.
