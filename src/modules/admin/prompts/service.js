'use strict';

/**
 * Версии промптов ИИ (F-101): чтение, новая версия, сравнение, активация/откат.
 * Текст версии неизменяем (триггер prompt_body_immutable): правка = новая версия. Активна ровно одна версия
 * ключа (индекс uq_prompt_active); предыдущая получает статус previous и остаётся доступной для отката.
 * Оценочные прогоны и согласование (W-42) не реализованы: активирует администратор.
 */

const crypto = require('crypto');

const TEXT_MAX = 20000;
const COMMENT_MAX = 300;

const clean = (s, max) =>
  String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, max);

/** Построчное сравнение (LCS): [{ op: 'same' | 'add' | 'del', text }]. */
function lineDiff(a, b) {
  const x = String(a).split('\n');
  const y = String(b).split('\n');
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: 'same', text: x[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: 'del', text: x[i] });
      i += 1;
    } else {
      out.push({ op: 'add', text: y[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ op: 'del', text: x[i++] });
  while (j < m) out.push({ op: 'add', text: y[j++] });
  return out;
}

function createPromptService({ db, keys }) {
  const known = (key) => keys.includes(key);

  const view = (row) => ({
    key: row.prompt_key,
    version: row.version,
    text: row.body,
    author: row.author_name || (row.author_id ? `пользователь #${row.author_id}` : 'начальная версия (файл)'),
    comment: row.comment || '',
    active: row.status === 'active',
    status: row.status,
    created_at: row.created_at,
  });

  const rows = (key) =>
    db
      .prepare(
        `SELECT v.*, u.full_name AS author_name FROM prompt_versions v LEFT JOIN users u ON u.id = v.author_id
         WHERE v.prompt_key = ? ORDER BY v.version DESC`,
      )
      .all(key);

  const versions = (key) => rows(key).map(view);
  const version = (key, n) => versions(key).find((v) => v.version === n) || null;

  function listKeys() {
    return keys.map((key) => {
      const list = rows(key);
      const active = list.find((v) => v.status === 'active') || null;
      return { key, active_version: active ? active.version : null, versions: list.length, updated_at: list.length ? list[0].created_at : null };
    });
  }

  /** @returns {{ok:true, version:number}|{ok:false, code:'E-VALIDATION'|'E-CONFLICT'|'E-NOT-FOUND'}} */
  function createVersion(key, { text, comment }, authorId) {
    if (!known(key)) return { ok: false, code: 'E-NOT-FOUND' };
    const body = clean(text, TEXT_MAX + 1);
    if (!body.trim() || body.length > TEXT_MAX) return { ok: false, code: 'E-VALIDATION', fields: ['text'] };
    const note = clean(comment, COMMENT_MAX).trim();
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const created = db
      .transaction(() => {
        const all = db.prepare('SELECT version, body_sha256 FROM prompt_versions WHERE prompt_key = ?').all(key);
        // Копия существующей версии — не новая версия: правка должна что-то менять.
        if (all.some((r) => r.body_sha256 === sha)) return null;
        const next = all.reduce((max, r) => Math.max(max, r.version), 0) + 1;
        db.prepare(
          "INSERT INTO prompt_versions(prompt_key, version, body, body_sha256, status, author_id, comment) VALUES (?,?,?,?,'draft',?,?)",
        ).run(key, next, body, sha, authorId, note || null);
        return next;
      })
      .immediate();
    if (created === null) return { ok: false, code: 'E-CONFLICT', same_text: true };
    return { ok: true, version: created, length: body.length };
  }

  function diff(key, fromN, toN) {
    if (!known(key)) return null;
    const list = rows(key);
    const active = list.find((v) => v.status === 'active');
    const f = fromN === undefined ? (active ? active.version : null) : Number(fromN);
    const t = toN === undefined ? (list.length ? list[0].version : null) : Number(toN);
    const from = list.find((v) => v.version === f);
    const to = list.find((v) => v.version === t);
    if (!from || !to) return null;
    return { key, from: from.version, to: to.version, lines: lineDiff(from.body, to.body) };
  }

  /** @returns {{ok:true, version:number, previous:number|null}|{ok:false, code:string}} */
  function activate(key, n, adminId) {
    if (!known(key)) return { ok: false, code: 'E-NOT-FOUND' };
    if (!Number.isInteger(n) || n < 1) return { ok: false, code: 'E-VALIDATION', fields: ['version'] };
    const target = version(key, n);
    if (!target) return { ok: false, code: 'E-NOT-FOUND' };
    if (target.status === 'active' || target.status === 'rejected') return { ok: false, code: 'E-CONFLICT' };
    const previous = db
      .transaction(() => {
        const cur = db.prepare("SELECT version FROM prompt_versions WHERE prompt_key = ? AND status = 'active'").get(key);
        if (cur) db.prepare("UPDATE prompt_versions SET status = 'previous' WHERE prompt_key = ? AND status = 'active'").run(key);
        db.prepare("UPDATE prompt_versions SET status = 'active', approved_by = ? WHERE prompt_key = ? AND version = ?").run(adminId, key, n);
        return cur ? cur.version : null;
      })
      .immediate();
    return { ok: true, version: n, previous };
  }

  /** Запись в журнал действий: ключ, номер версии, длина — сам текст в журнал не пишется (PD-17). */
  function logAction(user, requestId, name, key, data) {
    db.prepare('INSERT INTO action_log(actor_id,actor_role,action,target_type,new_safe_json,request_id) VALUES (?,?,?,?,?,?)').run(
      user.id,
      user.role,
      name,
      'prompt',
      JSON.stringify({ key, ...data }),
      requestId || null,
    );
  }

  return { known, listKeys, versions, version, createVersion, diff, activate, logAction };
}

module.exports = { createPromptService, lineDiff, TEXT_MAX, COMMENT_MAX };
