# Тесты этапа 13 (план тестов)

Тесты написаны до кода по утверждённым отчётам `.agents/web-developer/` (03, 06–12) и сейчас ожидаемо красные.
Разработка их не меняет: неверный тест — запрос в `14-build.md` и коммит `test-change: T-xx, одобрено <дата>` (стандарты §10).

| Папка | Что | Команда |
|---|---|---|
| `api/` | API, права ролей, правила ПДн, настройки S-, режимы (node:test + fetch) | `npm run test:api` |
| `acceptance/` | сценарии в браузере по прототипу v5, доступность (playwright-core + axe-core) | `npm run test:acceptance` |
| `performance/` | скорость на объёме «через год» (скрипт на Node) | `npm run test:perf` |
| `tools/gate.js` | тесты, которые должны быть зелёными к вехе или задаче W- | `npm run test:gate -- --upto В2` |

- Номер и задача — в названии: `T-101 [W-24] …`; над тестом — `// covers: T-101, UC-05, F-16, PD-16`.
- Контракт API заморожен: `api/contract/operations.json` собирается из утверждённого `openapi.yaml` командой `npm run test:contract:build`.
- Мир тестов (`fixtures/world.js`), каталог-заглушка и набор опечаток (`fixtures/catalog/`), корпус ПДн (`fixtures/pii_corpus.js`) — только синтетика.
- Подделки внешних сервисов: `lib/fakes/` (заглушка ИИ, ml-worker, SMTP, GigaChat). Тестовые хуки приложения (только `NODE_ENV=test`) описаны в `lib/app.js` и отчёте 13.
- Браузер: `CHROMIUM_PATH` или кеш `~/.cache/ms-playwright`. `KEEP_TEST_DATA=1` оставляет временные папки для разбора.
