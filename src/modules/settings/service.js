'use strict';

/**
 * W-41 (этап 14, веха В5): служба рабочих настроек F-97 — версии, откат,
 * перенос, «Кто утвердил» (F-98 в демо), выключатели возможностей и режим
 * обслуживания F-117 (S-57, S-58). Действующая версия читается через кеш
 * 30 с (DB-91); сохранение сбрасывает кеш — настройка действует сразу.
 */

const crypto = require('crypto');
const registry = require('./registry');
const riskClassifier = require('../../riskClassifier');
const crisisProtocol = require('../../crisisProtocol');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Безопасная форма для журнала (Settings, правило 7): коды/хеши/длины, без
// текстов и значений словарей (PD-17).
function safeForm(value) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string')
    return value.length <= 60
      ? value
      : { sha256: crypto.createHash('sha256').update(value).digest('hex').slice(0, 24), length: value.length };
  if (Array.isArray(value))
    return {
      count: value.length,
      sha256: crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24),
    };
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = safeForm(v);
  return out;
}

function create({ db, config, now, P }) {
  const current = () => now(config);
  const CACHE_TTL = 30 * 1000;
  const cache = new Map();

  const notifyKeys = registry.NOTIFY;
  const isClinical = registry.CLINICAL;
  const isLegalReal = registry.LEGAL_REAL;

  function invalidate(key) {
    cache.delete(key);
    if (key === 'crisis.rules') syncCrisisRules();
  }

  function syncCrisisRules() {
    const row = db
      .prepare("SELECT value_json FROM setting_versions WHERE key='crisis.rules' AND status='active'")
      .get();
    riskClassifier.setActiveRules(row ? JSON.parse(row.value_json) : null);
  }

  function seedDefaults() {
    const seeds = [
      ...Object.keys(registry.DEFAULTS),
      ...Object.keys(registry.RETENTION_RANGES),
      ...registry.FEATURES.map((f) => `features.${f}`),
    ];
    const insert = db.prepare(
      "INSERT INTO setting_versions(key,version,value_json,status,is_clinical,author_id,comment) VALUES (?,1,?,'active',?,NULL,'начальное значение (система)')",
    );
    for (const key of seeds) {
      const exists = db.prepare('SELECT 1 FROM setting_versions WHERE key = ? LIMIT 1').get(key);
      if (exists) continue;
      insert.run(key, JSON.stringify(registry.defaultValue(key)), isClinical(key) ? 1 : 0);
    }
    syncCrisisRules();
  }

  function active(key) {
    const cached = cache.get(key);
    if (cached && current().getTime() - cached.at < CACHE_TTL) return cached;
    const row = db
      .prepare("SELECT * FROM setting_versions WHERE key=? AND status='active' ORDER BY version DESC LIMIT 1")
      .get(key);
    const result = row
      ? { version: row.version, value: JSON.parse(row.value_json) }
      : { version: 0, value: registry.defaultValue(key) };
    cache.set(key, { ...result, at: current().getTime() });
    return result;
  }

  function effective(key) {
    return active(key);
  }

  function full(key) {
    const row = activeRow(key);
    const currentVersion = row || { version: 0, value: JSON.stringify(registry.defaultValue(key)) };
    const history = db
      .prepare('SELECT * FROM setting_versions WHERE key=? ORDER BY version DESC')
      .all(key)
      .map(present);
    if (!row) history.unshift(present({ ...currentVersion, value_json: currentVersion.value, status: 'default', key }));
    return {
      key,
      current: present({
        ...row,
        version: row ? row.version : 0,
        value_json: row ? row.value_json : JSON.stringify(registry.defaultValue(key)),
      }),
      history,
    };
  }

  function activeRow(key) {
    return db
      .prepare("SELECT * FROM setting_versions WHERE key=? AND status='active' ORDER BY version DESC LIMIT 1")
      .get(key);
  }

  function present(row) {
    return {
      version: row.version,
      value: JSON.parse(row.value_json),
      status: row.status,
      review_required: !!row.is_clinical,
      author_id: row.author_id ?? null,
      comment: row.comment ?? null,
      approved_by: row.approved_by_text ?? null,
      basis: row.basis ?? null,
      rolled_back_from: row.rolled_back_from ?? null,
      created_at: row.created_at ?? null,
    };
  }

  function logSetting(actorId, key, version, oldValue, newValue) {
    db.prepare(
      "INSERT INTO action_log(actor_id,actor_role,action,target_type,target_id,old_safe_json,new_safe_json,created_at) VALUES (?,?,'setting.update','setting',?,?,?,?)",
    ).run(
      actorId ?? null,
      'admin',
      key,
      JSON.stringify(safeForm(oldValue)),
      JSON.stringify(safeForm(newValue)),
      current().toISOString(),
    );
  }

  function notifyAdmins(actorId, key, versionId) {
    const stamp = current().toISOString();
    const admins = db
      .prepare("SELECT id FROM users WHERE role='admin' AND status='active' AND id != ?")
      .all(actorId ?? -1);
    for (const a of admins) {
      // event_key уникален на версию настройки (UNIQUE recipient_id+event_key).
      db.prepare(
        "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'system',?,'setting',?,?,NULL,?,'active',?)",
      ).run(a.id, `setting:${key}:v${versionId}:${a.id}`, versionId, `Изменение настройки: ${key}`, stamp, stamp);
    }
  }

  // ---------- проверка значения (E-SETTING-INVALID / регрессии) ----------

  function validate(key, value) {
    if (key === 'data_mode') return { status: 422, code: 'E-SETTING-INVALID', field: 'value' };
    const match = registry.matchValidator(key);
    if (!match) return key === 'crisis.rules' ? null : { status: 404, code: 'E-NOT-FOUND' };
    const ctx = { db, dataMode: config.dataMode, effective: (k) => effective(k) };
    const bad = match.fn(value, ctx, match.arg || key);
    if (!bad) return null;
    return bad.in_use
      ? { status: 409, code: 'E-IN-USE', extra: { field: bad.field, in_use: bad.in_use } }
      : { status: 422, code: 'E-SETTING-INVALID', field: bad.field };
  }

  // S-55: каждый прежний положительный пример кризисного набора должен остаться
  // положительным, иначе включить нельзя (E-CRISIS-REGRESSION, details.missed).
  function validateCrisisRules(nextRules) {
    if (!nextRules || typeof nextRules !== 'object' || Array.isArray(nextRules))
      return { status: 422, code: 'E-SETTING-INVALID', field: 'phrases' };
    if (!Array.isArray(nextRules.phrases)) return { status: 422, code: 'E-SETTING-INVALID', field: 'phrases' };
    for (const [i, p] of nextRules.phrases.entries()) {
      if (!p || !String(p.text || '').trim() || String(p.text).length > 200)
        return { status: 422, code: 'E-SETTING-INVALID', field: `phrases.${i}.text` };
    }
    const previous = effective('crisis.rules').value || { phrases: [] };
    const missed = riskClassifier
      .phrasesOf(previous)
      .map((p, i) => ({ code: p.code || `phrases.${i}`, text: p.text }))
      .filter((p) => riskClassifier.classifyWithRules(nextRules, p.text).length === 0)
      .map((p) => p.code);
    if (missed.length) return { status: 422, code: 'E-CRISIS-REGRESSION', extra: { missed: missed.slice(0, 20) } };
    return null;
  }

  // ---------- новая версия / откат ----------

  function createVersion(
    key,
    value,
    { authorId, comment, approvedBy, basis, baseVersion, rolledBackFrom, status, isClinical, approvedAt },
  ) {
    const cur = activeRow(key);
    const version = (cur ? cur.version : 0) + 1;
    const apply = db.transaction(() => {
      if (cur) db.prepare("UPDATE setting_versions SET status='previous' WHERE key=? AND status='active'").run(key);
      return db
        .prepare(
          'INSERT INTO setting_versions(key,version,value_json,status,is_clinical,author_id,comment,approved_by_text,approved_at,basis,rolled_back_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          key,
          version,
          JSON.stringify(value),
          status,
          isClinical ? 1 : 0,
          authorId ?? null,
          comment || null,
          approvedBy || null,
          approvedAt || null,
          basis || null,
          rolledBackFrom ?? null,
        ).lastInsertRowid;
    });
    const id = apply();
    invalidate(key);
    return { version, id };
  }
  // ---------- сохранить значение (PUT /admin/settings/:key) ----------

  function set(key, value, opts = {}) {
    const v = validate(key, value);
    if (v) return { ok: false, ...v };
    if (key === 'crisis.rules') {
      const regression = validateCrisisRules(value);
      if (regression) return { ok: false, ...regression };
    }
    const clinical = isClinical(key);
    const legalReal = isLegalReal(key);
    const real = config.dataMode === 'real';
    if (clinical && real && !opts.approvedBy) {
      // В real клиническая версия ждёт утверждения КО (F-98); действует прежняя.
      const { version, id } = createVersion(key, value, {
        authorId: opts.authorId,
        comment: opts.comment,
        basis: opts.basis,
        status: 'pending_approval',
        isClinical: true,
      });
      db.prepare(
        "INSERT INTO approvals(object_type,object_id,object_key,author_id,status,created_at) VALUES ('setting',?,?,?,'pending',?)",
      ).run(id, key, opts.authorId ?? null, current().toISOString());
      return { ok: true, version, id, status: 'pending_approval', review_required: true };
    }
    if (clinical && !real && !opts.approvedBy) {
      return { ok: false, status: 409, code: 'E-APPROVAL-REQUIRED' };
    }
    if (real && legalReal && !opts.basis) {
      return { ok: false, status: 422, code: 'E-BASIS-REQUIRED', field: 'basis' };
    }
    const oldValue = active(key).value;
    if (stableStringify(oldValue) === stableStringify(value)) {
      const row = activeRow(key);
      return {
        ok: true,
        version: row ? row.version : 0,
        id: row ? row.id : null,
        status: 'active',
        unchanged: true,
        review_required: clinical,
      };
    }
    const { version, id } = createVersion(key, value, {
      authorId: opts.authorId,
      comment: opts.comment,
      approvedBy: opts.approvedBy,
      basis: opts.basis,
      status: 'active',
      isClinical: clinical,
      approvedAt: clinical && opts.approvedBy ? current().toISOString() : null,
    });
    logSetting(opts.authorId, key, version, oldValue, value);
    if (notifyKeys(key)) notifyAdmins(opts.authorId, key, id);
    return { ok: true, version, id, status: 'active', review_required: clinical };
  }

  // ---------- откат (новая версия с прежним значением) ----------

  function rollback(key, toVersion, opts = {}) {
    const target = db.prepare('SELECT * FROM setting_versions WHERE key=? AND version=?').get(key, Number(toVersion));
    if (!target) return { ok: false, status: 404, code: 'E-NOT-FOUND' };
    const value = JSON.parse(target.value_json);
    const v = validate(key, value);
    if (v && v.code === 'E-SETTING-INVALID') return { ok: false, ...v };
    if (key === 'crisis.rules') {
      const regression = validateCrisisRules(value);
      if (regression) return { ok: false, ...regression };
    }
    const oldValue = active(key).value;
    const { version, id } = createVersion(key, value, {
      authorId: opts.authorId,
      comment: opts.comment,
      rolledBackFrom: Number(toVersion),
      status: 'active',
      isClinical: isClinical(key),
    });
    logSetting(opts.authorId, key, version, oldValue, value);
    if (notifyKeys(key)) notifyAdmins(opts.authorId, key, id);
    return { ok: true, version, id, status: 'active', review_required: isClinical(key) };
  }
  // ---------- выключатели возможностей S-57 и обслуживание S-58 ----------

  function setFeature(feature, enabled, opts = {}) {
    if (!registry.FEATURES.includes(feature)) return { ok: false, status: 404, code: 'E-NOT-FOUND' };
    const key = `features.${feature}`;
    if (config.dataMode === 'real' && feature === 'patient_assistant' && enabled && !opts.basis)
      return { ok: false, status: 422, code: 'E-BASIS-REQUIRED', field: 'basis' };
    const result = set(key, !!enabled, opts);
    return result.ok ? { ok: true, feature, enabled: !!enabled, version: result.version } : result;
  }

  function featuresAll() {
    const out = {};
    for (const f of registry.FEATURES) out[f] = active(`features.${f}`).value !== false;
    return out;
  }

  function maintenanceState() {
    const value = active('service.maintenance').value || {};
    return {
      on: value.on === true,
      until: value.until ?? null,
      message_key: value.message_key ?? null,
    };
  }

  function setMaintenance(body = {}, opts = {}) {
    const value = {
      on: body.on === true,
      until: body.until ?? null,
      message_key: body.message_key ?? null,
    };
    const result = set('service.maintenance', value, opts);
    if (result.ok && value.on) {
      // Режим обслуживания закрывает сессии всех, кроме администраторов (F-117).
      db.prepare(
        "UPDATE sessions SET closed_at=?, close_reason='maintenance' WHERE closed_at IS NULL AND user_id IN (SELECT id FROM users WHERE role <> 'admin')",
      ).run(current().toISOString());
    }
    return result.ok ? { ok: true, ...value, version: result.version } : result;
  }
  // ---------- перенос: экспорт без секретов и загрузка черновиками ----------

  function exportAll() {
    const rows = db
      .prepare("SELECT key, version, value_json FROM setting_versions WHERE status='active' ORDER BY key")
      .all();
    const settings = {};
    for (const row of rows) settings[row.key] = JSON.parse(row.value_json);
    return { exported_at: current().toISOString(), data_mode: config.dataMode, settings };
  }

  function importPreview(uploadId) {
    const row = db.prepare('SELECT * FROM stored_files WHERE id = ?').get(Number(uploadId));
    if (!row) return { ok: false, status: 404, code: 'E-NOT-FOUND' };
    const fs = require('fs');
    const path = require('path');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'files', row.storage_name), 'utf8'));
    } catch (_) {
      return { ok: false, status: 422, code: 'E-IMPORT-FORMAT' };
    }
    const incoming = parsed && parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))
      return { ok: false, status: 422, code: 'E-IMPORT-FORMAT' };
    const diff = [];
    for (const [key, value] of Object.entries(incoming)) {
      if (!registry.matchValidator(key) && key !== 'crisis.rules') continue; // неизвестные ключи пропускаем
      const from = active(key).value;
      if (stableStringify(from) !== stableStringify(value)) diff.push({ key, from, to: value });
    }
    return { ok: true, diff };
  }
  function importApply(uploadId, opts = {}) {
    const preview = importPreview(uploadId);
    if (!preview.ok) return preview;
    const applied = [];
    for (const item of preview.diff) {
      const r = set(item.key, item.to, { ...opts, comment: 'перенос настроек' });
      if (!r.ok) return { ok: false, ...r, key: item.key };
      applied.push({ key: item.key, version: r.version, status: r.status });
    }
    return { ok: true, diff: preview.diff, applied };
  }

  // ---------- очередь утверждений КО (F-98) ----------

  function approvalsList() {
    return db
      .prepare("SELECT * FROM approvals WHERE status='pending' ORDER BY id")
      .all()
      .map((row) => {
        const to = db.prepare('SELECT * FROM setting_versions WHERE id = ?').get(row.object_id);
        return {
          id: row.id,
          object_type: row.object_type,
          setting_key: row.object_key,
          object_id: row.object_id,
          author: row.author_id,
          from_value: active(row.object_key).value,
          to_value: to ? JSON.parse(to.value_json) : null,
          created_at: row.created_at,
        };
      });
  }

  function decide(approvalId, { decideBy, approve, reason }) {
    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(approvalId));
    if (!row || row.status !== 'pending') return { ok: false, status: 404, code: 'E-NOT-FOUND' };
    if (row.author_id && decideBy === row.author_id) return { ok: false, status: 409, code: 'E-APPROVAL-SELF' };
    if (!approve && !String(reason || '').trim())
      return { ok: false, status: 422, code: 'E-VALIDATION', field: 'reason' };
    // Два ожидающих одного ключа: утверждать можно только первое (E-CONFLICT).
    const earlier = db
      .prepare("SELECT COUNT(*) n FROM approvals WHERE object_key = ? AND status='pending' AND id < ?")
      .get(row.object_key, row.id).n;
    if (earlier > 0) return { ok: false, status: 409, code: 'E-CONFLICT' };
    const stamp = current().toISOString();
    const apply = db.transaction(() => {
      db.prepare('UPDATE approvals SET status=?, decided_by=?, decided_at=?, reason=? WHERE id=?').run(
        approve ? 'approved' : 'rejected',
        decideBy ?? null,
        stamp,
        reason || null,
        row.id,
      );
      if (approve) {
        db.prepare("UPDATE setting_versions SET status='previous' WHERE key=? AND status='active' AND id != ?").run(
          row.object_key,
          row.object_id,
        );
        db.prepare(
          "UPDATE setting_versions SET status='active', approved_by=?, approved_at=? WHERE id=? AND status='pending_approval'",
        ).run(decideBy ?? null, stamp, row.object_id);
      }
    });
    apply();
    invalidate(row.object_key);
    return { ok: true, status: approve ? 'approved' : 'rejected' };
  }
  return {
    registry,
    active,
    effective,
    full,
    seedDefaults,
    safeForm,
    logSetting,
    notifyAdmins,
    invalidate,
    activeRow,
    present,
    validate,
    set,
    rollback,
    setFeature,
    featuresAll,
    maintenanceState,
    setMaintenance,
    exportAll,
    importPreview,
    importApply,
    approvalsList,
    decide,
  };
}

module.exports = { create, stableStringify, safeForm };
