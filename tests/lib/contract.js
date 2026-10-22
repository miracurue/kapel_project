'use strict';

// Замороженный контракт API этапа 12 (tests/api/contract/operations.json, собирается
// tests/tools/build_contract.py из утверждённого openapi.yaml) и помощники для обхода операций.

const fs = require('fs');
const { CONTRACT } = require('./paths');

let cache = null;
function operations() {
  if (!cache) cache = JSON.parse(fs.readFileSync(CONTRACT, 'utf8')).operations;
  return cache;
}

const api = () => operations().filter((o) => o.path.startsWith('/api/'));
const pages = () => operations().filter((o) => o.tag === 'pages');
const isMutating = (o) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(o.method);

// Значения параметров пути для «пустых» проверок прав (объект может не существовать: роль проверяется раньше).
const PATH_SAMPLES = {
  kind: 'ai', key: 'ui.undo_window_seconds', purpose: 'patient_assistant', journal: 'access', feature: 'voice',
  name: 'gigachat.auth_key', code: 'phq9', item: 'operator', job: 'mail_queue', token: 'test-token-0000',
  item_key: 'item-1', undo_id: 'undo-0000', version: '1', n: '1', session_id: '1',
};

function fillPath(path, overrides = {}) {
  return path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(
    overrides[name] !== undefined ? overrides[name] : (PATH_SAMPLES[name] !== undefined ? PATH_SAMPLES[name] : '1')));
}

// Роли R-, которым операция разрешена (с объёмом С/З/В/Ч/А/Д/КО/ИП/ПС).
function allowedRoles(op) {
  return new Map(op.roles.map((r) => [r.role, r.scope]));
}

// Express-путь /a/:id ↔ OpenAPI /a/{id}
const toExpress = (p) => p.replace(/\{([^}]+)\}/g, ':$1');
const fromExpress = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

// HTTP-статус, разрешённый контрактом для кода ошибки этой операции.
function statusFor(op, code) {
  return (op.errors[code] || [])[0];
}

module.exports = { operations, api, pages, isMutating, fillPath, allowedRoles, toExpress, fromExpress, statusFor, PATH_SAMPLES };
