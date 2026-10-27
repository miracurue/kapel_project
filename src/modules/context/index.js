'use strict';

/**
 * Маршруты композера (F-12, F-13, F-29): подсказки, поиск «@»/«+ → Из моих
 * данных», готовые вопросы S-16 и проверка чипов на каждой отправке сообщений
 * ИИ. Права объявлены в контракте (perm context.suggest); здесь — объектные
 * проверки и сборка ответов без содержимого объектов (PD-14).
 */

const chips = require('./chips');
const { isFullyAssigned } = require('../../access/assignment');
const { redactEntry } = require('../diary/visibility');
const { instrumentLabelFor } = require('../../format');
const { t } = require('../../i18n');

const DAY_MS = 86400000;

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function toSuggestion(row) {
  return {
    chip: { type: row.type, id: row.id, version: row.version === undefined ? null : row.version },
    label: row.label,
  };
}

/** Подсказки пациента (F-12, Common rules C): лекарство, последний тест, вчерашний дневник. */
function patientSuggestions(db, user, tab, current) {
  const yesterday = isoDay(new Date(current.getTime() - DAY_MS));
  if (tab === 'meds') {
    return planSuggestions(db, user.id, current).slice(0, 3);
  }
  if (tab === 'tests') {
    return resultSuggestions(db, user.id, null).slice(0, 3);
  }
  if (tab === 'diary') {
    return db
      .prepare(
        'SELECT id, entry_date FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL ORDER BY entry_date DESC, id DESC LIMIT 3',
      )
      .all(user.id)
      .map((row) => ({
        type: 'diary_entry',
        id: row.id,
        label: t('msg.composer.label.diary', 'Дневник · {when}').replace('{when}', chips.shortDate(row.entry_date)),
      }))
      .map(toSuggestion);
  }
  if (tab && tab !== 'chat') return [];
  // Чат: три слота по правилу C, пустой слот не заполняется чужим типом.
  const items = [];
  const plan = planSuggestions(db, user.id, current);
  if (plan.length) items.push(plan[0]);
  const results = resultSuggestions(db, user.id, new Date(current.getTime() - 30 * DAY_MS));
  if (results.length) items.push(results[0]);
  const diary = db
    .prepare(
      'SELECT id, entry_date FROM mood_entries WHERE patient_id=? AND entry_date=? AND hidden_at IS NULL ORDER BY id DESC LIMIT 1',
    )
    .get(user.id, yesterday);
  if (diary)
    items.push({
      type: 'diary_entry',
      id: diary.id,
      label: t('msg.composer.label.diary', 'Дневник · {when}').replace(
        '{when}',
        t('msg.composer.when.yesterday', 'вчера'),
      ),
    });
  return items.slice(0, 3).map(toSuggestion);
}

/** Пункт опубликованного плана: подпись «Сертралин 50 мг», без содержимого. */
function planSuggestions(db, patientId, current) {
  const nowIso = current ? current.toISOString() : new Date().toISOString();
  return db
    .prepare(
      "SELECT pi.id, pi.dose_value, pi.dose_unit, pv.version, i.name FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id JOIN inn i ON i.id=pi.inn_id WHERE pv.patient_id=? AND pv.status='published' AND (pv.visible_from IS NULL OR pv.visible_from<=?) AND pi.status='active' ORDER BY pv.version DESC, pi.id LIMIT 6",
    )
    .all(patientId, nowIso)
    .map((row) => ({ type: 'plan_item', id: row.id, version: row.version, label: chips.medLabel(row) }));
}

/** Результаты методик (онлайн и очные), подпись — название и дата, без ответов. */
function resultSuggestions(db, patientId, since) {
  const online = db
    .prepare(
      'SELECT id, instrument, created_at FROM online_results WHERE patient_id=? AND invalid_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 10',
    )
    .all(patientId)
    .map((r) => ({
      type: 'result',
      id: r.id,
      ts: r.created_at,
      label: `${instrumentLabelFor('patient', r.instrument)} · ${chips.shortDate(r.created_at)}`,
    }));
  const offline = db
    .prepare(
      'SELECT id, instrument, test_date FROM offline_results WHERE patient_id=? ORDER BY test_date DESC, id DESC LIMIT 10',
    )
    .all(patientId)
    .map((r) => ({
      type: 'result',
      id: r.id,
      ts: r.test_date,
      label: `${instrumentLabelFor('patient', r.instrument)} · ${chips.shortDate(r.test_date)}`,
    }));
  const all = [...online, ...offline].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return since ? all.filter((r) => String(r.ts).slice(0, 10) >= isoDay(since)) : all;
}

/** Подсказки специалиста: 3 последних объекта выбранного пациента из allowlist роли. */
function clinicianSuggestions(db, user, patientId, tab) {
  const allowed = chips.ALLOWED[user.role];
  const rows = [];
  const can = (type) => allowed.has(type);
  if (can('result')) for (const r of resultSuggestions(db, patientId, null).slice(0, 5)) rows.push(r);
  if (can('diary_entry')) {
    for (const r of db
      .prepare(
        'SELECT id, entry_date, created_at FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 5',
      )
      .all(patientId)) {
      rows.push({
        type: 'diary_entry',
        id: r.id,
        ts: r.created_at,
        label: t('msg.composer.label.diary', 'Дневник · {when}').replace('{when}', chips.shortDate(r.entry_date)),
      });
    }
  }
  if (can('plan_item')) for (const r of planSuggestions(db, patientId, null)) rows.push({ ...r, ts: null });
  if (can('patient_med')) {
    for (const r of db
      .prepare(
        'SELECT id, created_at FROM patient_meds WHERE patient_id=? AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 5',
      )
      .all(patientId)) {
      rows.push({
        type: 'patient_med',
        id: r.id,
        ts: r.created_at,
        label: t('msg.composer.label.med', 'Препарат · {date}').replace('{date}', chips.shortDate(r.created_at)),
      });
    }
  }
  if (can('adverse_event')) {
    for (const r of db
      .prepare(
        "SELECT id, created_at FROM adverse_events WHERE patient_id=? AND status NOT IN ('draft','cancelled') AND NOT (status='service_queue' AND psychiatrist_id IS NULL) ORDER BY created_at DESC LIMIT 5",
      )
      .all(patientId)) {
      rows.push({
        type: 'adverse_event',
        id: r.id,
        ts: r.created_at,
        label: t('msg.composer.label.ae', 'Побочный эффект · {date}').replace('{date}', chips.shortDate(r.created_at)),
      });
    }
  }
  if (can('visit')) {
    for (const r of db
      .prepare(
        "SELECT id, starts_at FROM visits WHERE patient_id=? AND status<>'cancelled' ORDER BY starts_at DESC LIMIT 5",
      )
      .all(patientId)) {
      rows.push({
        type: 'visit',
        id: r.id,
        ts: r.starts_at,
        label: t('msg.composer.label.visit', 'Визит · {date}').replace('{date}', chips.shortDate(r.starts_at)),
      });
    }
  }
  const tabTypes = { meds: ['plan_item', 'patient_med'], tests: ['result'], diary: ['diary_entry'], visits: ['visit'] };
  const filtered = tab && tabTypes[tab] ? rows.filter((r) => tabTypes[tab].includes(r.type)) : rows;
  return filtered
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, 3)
    .map(toSuggestion);
}

/** Поиск «@» и «+ → Из моих данных»: до 20 результатов, только доступные объекты. */
function searchObjects(db, user, query, patientId) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  const hits = [];
  const match = (label) =>
    String(label || '')
      .toLowerCase()
      .includes(q);
  const scope = user.role === 'patient' ? user.id : patientId;
  if (!scope) return [];
  if (chips.ALLOWED[user.role].has('plan_item'))
    for (const r of planSuggestions(db, scope, null)) if (match(r.label)) hits.push({ ...r, ts: null });
  if (chips.ALLOWED[user.role].has('result'))
    for (const r of resultSuggestions(db, scope, null)) if (match(r.label)) hits.push(r);
  if (chips.ALLOWED[user.role].has('diary_entry')) {
    for (const r of db
      .prepare(
        'SELECT id, entry_date, note FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 100',
      )
      .all(scope)) {
      const visible = redactEntry(db, scope, user, r);
      // Only a visible note may affect matching; responses contain metadata (PD-14).
      const label = t('msg.composer.label.diary', 'Дневник · {when}').replace('{when}', chips.shortDate(r.entry_date));
      if (match(label) || match(visible.note)) hits.push({ type: 'diary_entry', id: r.id, ts: r.entry_date, label });
    }
  }
  if (chips.ALLOWED[user.role].has('patient_med')) {
    for (const r of db
      .prepare(
        'SELECT id, created_at FROM patient_meds WHERE patient_id=? AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 50',
      )
      .all(scope)) {
      const label = t('msg.composer.label.med', 'Препарат · {date}').replace('{date}', chips.shortDate(r.created_at));
      if (match(label)) hits.push({ type: 'patient_med', id: r.id, ts: r.created_at, label });
    }
  }
  if (chips.ALLOWED[user.role].has('adverse_event')) {
    for (const r of db
      .prepare(
        "SELECT id, created_at FROM adverse_events WHERE patient_id=? AND (?=1 OR (status NOT IN ('draft','cancelled') AND NOT (status='service_queue' AND psychiatrist_id IS NULL))) ORDER BY created_at DESC LIMIT 50",
      )
      .all(scope, user.role === 'patient' ? 1 : 0)) {
      const label = t('msg.composer.label.ae', 'Побочный эффект · {date}').replace(
        '{date}',
        chips.shortDate(r.created_at),
      );
      if (match(label)) hits.push({ type: 'adverse_event', id: r.id, ts: r.created_at, label });
    }
  }
  if (chips.ALLOWED[user.role].has('visit')) {
    for (const r of db
      .prepare(
        "SELECT id, starts_at FROM visits WHERE patient_id=? AND status<>'cancelled' ORDER BY starts_at DESC LIMIT 50",
      )
      .all(scope)) {
      const label = t('msg.composer.label.visit', 'Визит · {date}').replace('{date}', chips.shortDate(r.starts_at));
      if (match(label)) hits.push({ type: 'visit', id: r.id, ts: r.starts_at, label });
    }
  }
  if (chips.ALLOWED[user.role].has('library_item')) {
    for (const r of db
      .prepare(
        "SELECT li.id, lv.title FROM library_items li JOIN library_versions lv ON lv.item_id=li.id AND lv.version=li.current_version WHERE li.status='published' AND li.hidden_at IS NULL AND (li.audience='patient' OR ?='clinician') ORDER BY li.id LIMIT 100",
      )
      .all(user.role === 'patient' ? 'patient' : 'clinician')) {
      if (match(r.title)) hits.push({ type: 'library_item', id: r.id, ts: null, label: r.title });
    }
  }
  return hits
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, 20)
    .map(toSuggestion);
}

/** Готовые вопросы S-16 (F-29): до 4, «Мне хуже» всегда среди них, настройка действует сразу. */
function readyQuestions(activeSetting, type) {
  const setting = activeSetting(`ai.suggested_questions.${type}`);
  const fromSetting = Array.isArray(setting && setting.value)
    ? setting.value.filter((x) => typeof x === 'string' && x.trim())
    : [];
  const list = fromSetting.length ? [...fromSetting] : chips.QUESTION_KEYS[type].map((key) => t(key, ''));
  const questions = list.filter((x, i) => list.indexOf(x) === i && x !== chips.WORSE);
  return [chips.WORSE, ...questions].slice(0, 4);
}

/**
 * Регистрация. Важно: вызывается раньше обработчиков ИИ-сообщений, чтобы
 * проверка чипов (F-13) выполнялась до вызова модели.
 */
function install(app, deps) {
  const { db, P, config, now, activeSetting } = deps;
  const current = () => now(config);

  const assignedPatient = (user, rawId) => {
    const pid = Number(rawId);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return isFullyAssigned(db, pid, user.id) ? pid : null;
  };

  // GET /api/v1/context/suggestions — подсказки над полем ввода (F-12).
  app.get('/api/v1/context/suggestions', (req, res) => {
    const tab = String(req.query.tab || 'chat');
    if (req.user.role === 'patient') {
      return res.json({ items: patientSuggestions(db, req.user, tab, current()) });
    }
    const raw = req.query.patient_id;
    if (raw === undefined || raw === '') return res.json({ items: [] });
    const pid = assignedPatient(req.user, raw);
    if (!pid) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    chips.logAccess(db, req, req.user, 'patient', pid, 'allow', pid, 'assignment');
    return res.json({ items: clinicianSuggestions(db, req.user, pid, tab) });
  });

  // GET /api/v1/context/search — «@» и «+ → Из моих данных» (F-12).
  app.get('/api/v1/context/search', (req, res) => {
    const raw = req.query.patient_id;
    let pid = null;
    if (req.user.role !== 'patient') {
      if (raw !== undefined && raw !== '') {
        pid = assignedPatient(req.user, raw);
        if (!pid) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      }
    }
    if (pid) chips.logAccess(db, req, req.user, 'patient', pid, 'allow', pid, 'assignment');
    return res.json({ items: searchObjects(db, req.user, req.query.q, pid) });
  });

  // GET /api/v1/ai/questions — «✦ Спросить ИИ»: чип объекта и готовые вопросы (F-29).
  app.get('/api/v1/ai/questions', (req, res) => {
    const type = String(req.query.object_type || '');
    if (!chips.QUESTION_KEYS[type])
      return P.sendError(req, res, 422, 'E-VALIDATION', {
        fields: [{ field: 'object_type', key: 'err.e-validation' }],
      });
    const rawId = req.query.object_id;
    const id = /^\d+$/.test(String(rawId)) ? Number(rawId) : String(rawId || '');
    const resolved = chips.resolveObject(db, type, id);
    if (!resolved || (resolved.ownerOnly && req.user.role !== 'patient')) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    // Объекты без владельца-пациента (библиотека) доступны всем ролям allowlist.
    if (resolved.patientId != null) {
      const expected = req.user.role === 'patient' ? req.user.id : assignedPatient(req.user, resolved.patientId);
      if (!expected || resolved.patientId !== expected) {
        chips.logAccess(
          db,
          req,
          req.user,
          type,
          Number(id) || null,
          'deny',
          resolved.patientId || (req.user.role === 'patient' ? req.user.id : null),
        );
        return P.sendError(req, res, 404, 'E-NOT-FOUND');
      }
      if (req.user.role !== 'patient')
        chips.logAccess(db, req, req.user, type, Number(id) || null, 'allow', resolved.patientId, 'assignment');
    }
    return res.json({
      chip: { type, id: resolved.itemKey || id, version: resolved.version === undefined ? null : resolved.version },
      label: resolved.label,
      questions: readyQuestions(activeSetting, type),
    });
  });

  // F-13: проверка чипов на каждой отправке — до обработчиков сообщений, модель не вызывается.
  const messageGuard = (getPatientId) => (req, res, next) => {
    const chipsIn = req.body && req.body.chips;
    if (chipsIn === undefined || chipsIn === null) return next();
    if (!Array.isArray(chipsIn)) return P.sendError(req, res, 422, 'E-VALIDATION');
    if (chipsIn.length > 5) return P.sendError(req, res, 422, 'E-VALIDATION');
    if (!chipsIn.length) return next();
    const { rejected, allowed } = chips.validateChips(db, req, req.user, chipsIn, getPatientId(req));
    if (rejected.length) {
      return P.sendError(req, res, 409, 'E-CONTEXT-REJECTED', { details: { rejected_chips: rejected } });
    }
    req.composerChips = allowed; // ссылки без содержимого; содержимое собирает сервер (F-13)
    return next();
  };

  app.post(
    '/api/v1/ai/patient/messages',
    messageGuard(() => null),
  );
  app.post(
    '/api/v1/ai/clinician/messages',
    messageGuard((req) => {
      const fromBody = Number(req.body && req.body.patient_id);
      if (Number.isInteger(fromBody) && fromBody > 0) return fromBody;
      const chip = ((req.body && req.body.chips) || []).find((c) => c && c.type === 'patient');
      return chip ? Number(chip.id) : null;
    }),
  );

  // S-16: значение настройки готовых вопросов — 1–4 строки, «Мне хуже» не удаляется.
  app.put('/api/v1/admin/settings/:key', (req, res, next) => {
    const key = String(req.params.key || '');
    if (!key.startsWith('ai.suggested_questions.')) return next();
    const value = req.body && req.body.value;
    const ok =
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 4 &&
      value.every((x) => typeof x === 'string' && x.trim().length > 0 && x.trim().length <= 200) &&
      value.includes(chips.WORSE);
    if (!ok) return P.sendError(req, res, 422, 'E-SETTING-INVALID');
    return next();
  });
}

module.exports = { install, patientSuggestions, clinicianSuggestions, searchObjects, readyQuestions };
