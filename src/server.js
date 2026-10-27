#!/usr/bin/env node
'use strict';

// W-39: тестовая среда задаёт DB_PATH (scripts/migrate.js и tests/lib/app.js),
// а src/db.js исторически читает TDR_DB_PATH. Синхронизируем до подключения
// src/db.js, чтобы сервер в тестах работал на временной БД, а не на dev-БД.
if (process.env.DB_PATH && !process.env.TDR_DB_PATH) {
  process.env.TDR_DB_PATH = process.env.DB_PATH;
}

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const path = require('path');
const { isFullyAssigned } = require('./access/assignment');
const fs = require('fs');
const { loadConfig, now } = require('./config');
const access = require('./access');
const { shell, errorPage, esc } = require('./pages');
const { t } = require('./i18n');
const P = require('./platform');
const clinicalRoutes = require('./modules/clinical/routes');
const v3Routes = require('./modules/v3/routes');
const analyticsFacts = require('./modules/analytics/facts');
const contextRoutes = require('./modules/context'); // W-33: композер — подсказки, чипы, S-16
const chatResume = require('./ai/chatResume'); // возврат в последний чат пациента
const patientChatPage = require('./modules/patient/chatPage'); // W-34: чат пациента P-13
const workChatPage = require('./modules/work/chatPage'); // W-35: чат специалиста P-20
const approvalsPage = require('./modules/work/approvalsPage'); // P-51: «Утверждения»
const libraryPage = require('./modules/library/page'); // W-48: вкладка «Библиотека» (P-15)
const techniques = require('./modules/techniques/catalog'); // методики самопомощи (карточки и страницы)
const libraryWorkPage = require('./modules/library/workPage'); // рабочее место автора в библиотеке (специалисты)
const crisisGate = require('./ai/crisisGate');

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(2);
}
const db = P.openDb(config);
const app = express();
const contract = access.contract();
const apiOps = contract.filter((op) => op.path.startsWith('/api/'));
const compiled = apiOps.map((op) => ({
  ...op,
  regex: new RegExp(`^${op.path.replace(/\{[^}]+\}/g, '([^/]+)')}$`),
  names: [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]),
}));

function matchOperation(method, urlPath) {
  for (const op of compiled) {
    if (op.method !== method) continue;
    const match = op.regex.exec(urlPath);
    if (!match) continue;
    return { op, params: Object.fromEntries(op.names.map((name, i) => [name, decodeURIComponent(match[i + 1])])) };
  }
  return null;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.raw({ type: 'multipart/form-data', limit: '12mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.use((req, res, next) => {
  req.requestId = P.requestId();
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!['/healthz', '/readyz'].includes(req.path)) res.setHeader('Cache-Control', 'no-store');
  req.session = P.loadSession(db, config, req);
  req.user =
    req.session?.user ||
    (req.session?.data?.role ? { role: req.session.data.role === 'demo_host' ? 'host' : req.session.data.role } : null);
  next();
});
// Напоминания пациента (приём лекарств, тесты, вопрос о форме обращения): значок на вкладке «Чат» и карточки в чате.
app.use((req, res, next) => {
  if (req.user && req.user.role === 'patient' && req.user.id && req.method === 'GET' && !req.path.startsWith('/api/')) {
    try {
      req.reminders = require('./modules/patient/reminders').dueReminders(db, {
        patientId: req.user.id,
        now: now(config),
        timezone: activeSetting('org.timezone_hours').value?.timezone || 'Europe/Moscow',
        labelOf: (code) => require('./format').instrumentLabelFor('patient', code) || code,
      });
      req.user = { ...req.user, reminder_count: req.reminders.length };
    } catch (_) {
      req.reminders = [];
    }
  }
  next();
});

// Регистрация, согласия и их версии, заявки специалистов (src/modules/registration). Функции ниже — объявления,
// поднимаются выше этой строки.
// Связь специалистов по пациенту (маршрутизация, src/modules/care_links).
const careLinks = require('./modules/care_links')({
  db,
  P,
  config,
  now,
  access,
  action: (...args) => action(...args),
});
const registration = require('./modules/registration')({
  db,
  careLinks,
  P,
  config,
  now,
  bcrypt,
  access,
  shell,
  t,
  esc,
  action: (...args) => action(...args),
  bumpRate: (...args) => bumpRate(...args),
  passwordFields: (...args) => passwordFields(...args),
});
app.use(registration.gate);

const { isAllowed } = access;

function auditPatient(req, patientId, decision, section, basis = 'assignment') {
  const actor = req.user;
  const current = P.iso(now(config));
  if (decision === 'allow') {
    const tag = P.sha(req.session.sid_hash).slice(0, 16);
    const found = db
      .prepare(
        "SELECT id FROM phi_access_log WHERE actor_id=? AND patient_id=? AND section=? AND decision='allow' AND session_tag=? AND unixepoch(created_at) >= unixepoch(?) - 60 LIMIT 1",
      )
      .get(actor.id, patientId, section, tag, current);
    if (found) return true;
  }
  db.prepare(
    `INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis,session_tag)
    VALUES (?,?,?,?,?,?,?,?)`,
  ).run(actor.id, actor.role, patientId, section, 'view', decision, basis, P.sha(req.session.sid_hash).slice(0, 16));
  return true;
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const matched = matchOperation(req.method, req.path);
  if (!matched) return next();
  req.operation = matched.op;
  req.routeParams = matched.params;
  if (matched.op.tag === 'demo' && !config.demoMode) return P.sendError(req, res, 404, 'E-DEMO-ONLY');
  if (req.path === '/api/v1/auth/logout' && !req.session) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!req.session || req.headers['x-csrf-token'] !== req.session.data.csrf)
      return P.sendError(req, res, 403, 'E-CSRF');
  }
  if (matched.op.idempotency === 'required' && !req.headers['idempotency-key']) {
    return P.sendError(req, res, 422, 'E-VALIDATION', {
      fields: [{ field: 'Idempotency-Key', key: 'err.e-validation.idempotency-key' }],
    });
  }
  if (!matched.op.public && !req.user) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
  if (!matched.op.public && !isAllowed(matched.op, req.user)) return P.sendError(req, res, 403, 'E-ACCESS');
  if (
    req.user?.must_change_password &&
    !['/api/v1/me/password', '/api/v1/auth/logout', '/api/v1/csrf'].includes(req.path)
  ) {
    return P.sendError(req, res, 403, 'E-ACCESS');
  }
  const patientId = Number(matched.params.patient_id);
  if (patientId && ['psychiatrist', 'psychologist'].includes(req.user?.role)) {
    // W-51: завершение наблюдения должно уметь ответить E-ARCHIVED и после
    // закрытия закрепления (повторный archive, T-212) — закрепление здесь не
    // проверяем, его проверяет обработчик маршрута.
    if (matched.op.permission !== 'episode.close') {
      const own = isFullyAssigned(db, patientId, req.user.id);
      if (!own) {
        try {
          auditPatient(req, patientId, 'deny', matched.op.patientAccess || 'patient');
        } catch (_) {
          /* отказ остаётся отказом */
        }
        return P.sendError(req, res, 404, 'E-NOT-FOUND');
      }
    }
    if (!baseConsentGiven(patientId)) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
  }
  return next();
});

// W-50 (PD-12): запрос на стирание — обработка ограничена сразу (T-202).
// Пациент: свои изменяющие запросы запрещены (кроме отмены стирания, кризисной
// помощи, выхода); специалист: новые записи по пациенту запрещены. Перехватчик
// должен быть зарегистрирован раньше маршрутов дневника/назначений (Express-layer
// order), поэтому он здесь, а не в модуле privacy.
app.use((req, res, next) => {
  if (!req.user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const restricted = (patientId) =>
    db
      .prepare(
        "SELECT 1 FROM data_subject_requests WHERE patient_id=? AND request_type='erasure' AND status IN ('submitted','in_work','waiting_crisis')",
      )
      .get(patientId);
  if (req.user.role === 'patient') {
    if (
      ['/api/v1/me/deletion-request', '/api/v1/crisis/help', '/api/v1/auth/logout', '/api/v1/csrf'].some(
        (p) => req.path === p || req.path.startsWith(`${p}/`),
      )
    )
      return next();
    // Отказ от собственного черновика НЯ — удаление данных, а не новая запись (F-45).
    if (req.path === '/api/v1/me/adverse-events' && req.body?.discard === true && req.body?.draft_id) return next();
    if (restricted(req.user.id)) {
      // Кризисная фраза в свободном тексте не теряется и при ограничении обработки (PD-12): запись не
      // создаётся, но карточка 112 показывается и сигнал уходит врачу.
      const text = require('./modules/diary/routes').collectText(req.body);
      if (text && crisisText(text)) {
        const record = recordCrisis(req.user.id, 'message', text);
        return res
          .status(200)
          .json({ crisis: { ...crisisCard(record.delivered), id: record.id || null }, saved: false });
      }
      // Решение владельца 2026-10-25: если причина — отзыв обязательного согласия, пациент видит
      // «нужно согласие», а не общий отказ. Запись не создаётся в обоих случаях.
      if (!baseConsentGiven(req.user.id)) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
      return P.sendError(req, res, 403, 'E-ACCESS');
    }
    return next();
  }
  if (['psychiatrist', 'psychologist'].includes(req.user.role)) {
    const pid = Number(req.routeParams && req.routeParams.patient_id);
    if (pid && restricted(pid)) return P.sendError(req, res, 409, 'E-STATUS');
  }
  return next();
});

// Цветок и капельки пациента: «+N» после записей и маршруты /api/v1/me/flower. Раньше маршрутов дневника и тестов.
const flower = require('./modules/flower/routes').install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
  idemCached,
  saveIdem,
});

// W-41: рабочие настройки (F-97, F-98, F-117). Регистрация модуля: создаёт
// службу настроек, начальные значения, провайдеры для платформы (S-40) и
// кризисного протокола (S-18/S-30) и ранние перехватчики S-57/S-58/S-25.
// Монтируется сразу после контрактного контроля доступа, чтобы действующие
// значения применялись к маршрутам, объявленным ниже (/me, /uploads, /stt).
const settings = require('./modules/settings/service').create({ db, config, now, P });
require('./modules/settings/routes').install(app, { db, P, config, now, settings });

// W-33: серверная часть композера — подсказки, поиск «@», готовые вопросы S-16,
// проверка чипов F-13 на каждой отправке. Монтируется ДО patientApi, чтобы чипы
// валидировались до вызова модели; ничего из существующего не удаляется.
contextRoutes.install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
});

// W-30/W-32: серверная часть ИИ (шлюз F-26, помощник пациента F-27, треды F-28, ИИ специалиста F-32).
// Монтируется сразу после контрактного контроля доступа (роль/perm/CSRF/чужой пациент — там),
// раньше прежних обработчиков-заглушек; ничего из существующего не удаляется.
require('./ai/patientApi').install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
  makeUndo,
  idemCached,
  saveIdem,
  // opts.force: сигнал передала модель (raise_crisis_signal / навык crisis_signal): словарь не спрашиваем, сигнал создаём.
  crisis: (text, source, patientId, opts) => {
    if (!(opts && opts.force) && !crisisText(text)) return null;
    const record = recordCrisis(patientId, source, text);
    return { ...crisisCard(record.delivered), id: record.id || null };
  },
});

app.get('/assets/ru.json', (_req, res) => res.sendFile(path.join(__dirname, '..', 'locales', 'ru.json')));

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
// Знания о лекарствах (Postgres) необязательны: не настроены — 'disabled' и readyz не краснеет; настроены, но
// недоступны — чаты работают по прежней схеме, а readyz остаётся 'ready' с knowledge.status = 'down'/'degraded'.
// Жёсткая готовность (оркестратору): KNOWLEDGE_REQUIRED=1 — тогда down/degraded даёт 'not_ready'.
app.get('/readyz', async (_req, res) => {
  const migrations = db.prepare('SELECT count(*) n FROM schema_migrations').get().n;
  let knowledge;
  try {
    knowledge = await require('./modules/knowledge/service').getKnowledge().status();
  } catch {
    knowledge = { configured: true, status: 'down' };
  }
  const strict = process.env.KNOWLEDGE_REQUIRED === '1' && knowledge.configured && knowledge.status !== 'ok';
  res.status(strict ? 503 : 200).json({
    status: migrations >= 6 && !strict ? 'ready' : 'not_ready',
    version: '0.1.0',
    data_mode: config.dataMode,
    knowledge: {
      configured: knowledge.configured,
      status: knowledge.status,
      ...(knowledge.documents === undefined
        ? {}
        : { documents: knowledge.documents, chunks: knowledge.chunks, vectors: knowledge.vectors }),
    },
  });
});

app.get('/api/v1/csrf', (req, res) => {
  let session = req.session;
  if (!session) session = P.createSession(db, config, res);
  res.json({ token: session.data.csrf });
});

function action(actor, name, targetType = null, targetId = null) {
  db.prepare('INSERT INTO action_log(actor_id,actor_role,action,target_type,target_id) VALUES (?,?,?,?,?)').run(
    actor?.id || null,
    actor?.role || 'guest',
    name,
    targetType,
    targetId === null ? null : String(targetId),
  );
}

// Общая проверка входа для API и HTML-формы: лимит попыток (5 за 15 минут по почте), журнал попыток, сессия.
// Возвращает { fail: { status, code, details? } } либо { user, session }.
function authenticate(req, res) {
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  const current = now(config);
  const emailHmac = P.hmac(config, email);
  const attempt = (userId, result) =>
    db
      .prepare('INSERT INTO login_attempts(email_hmac,user_id,result,created_at) VALUES (?,?,?,?)')
      .run(emailHmac, userId, result, P.iso(current));
  const since = P.iso(new Date(current.getTime() - 15 * 60 * 1000));
  const failures = db
    .prepare(
      "SELECT count(*) n FROM login_attempts WHERE email_hmac=? AND result IN ('bad_password','unknown') AND created_at>=?",
    )
    .get(emailHmac, since).n;
  if (failures >= 5) return { fail: { status: 423, code: 'E-AUTH-LOCKED', details: { retry_after_s: 60 } } };
  const user = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (!user || !user.password_hash || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    const application = user ? null : registration.applicationForLogin(email, req.body.password);
    if (application) return { fail: { status: 403, code: 'E-AUTH-PENDING', application } };
    attempt(user?.id || null, user ? 'bad_password' : 'unknown');
    return { fail: { status: 401, code: 'E-AUTH-INVALID' } };
  }
  if (user.status === 'blocked') attempt(user.id, 'blocked');
  if (user.status !== 'active') return { fail: { status: 403, code: 'E-AUTH-BLOCKED' } };
  P.closeSession(db, config, req.session, 'rotated');
  const session = P.createSession(db, config, res, { userId: user.id, role: user.role });
  attempt(user.id, 'ok');
  action(user, 'auth.login.success');
  return { user, session };
}

app.post('/api/v1/auth/login', (req, res) => {
  const { fail, user, session } = authenticate(req, res);
  if (fail?.application)
    return P.sendError(req, res, 403, 'E-AUTH-PENDING', {
      details: { status: fail.application.status, reason: fail.application.reject_reason },
    });
  if (fail) return P.sendError(req, res, fail.status, fail.code, fail.details ? { details: fail.details } : undefined);
  res.json({
    user: { id: user.id, role: user.role, display_name: user.full_name },
    next: user.must_change_password
      ? 'change_password'
      : user.role === 'patient'
        ? 'app'
        : user.role === 'admin'
          ? 'admin'
          : 'work',
    csrf: session.data.csrf,
  });
});

app.post('/api/v1/auth/logout', (req, res) => {
  P.closeSession(db, config, req.session);
  res.setHeader('Set-Cookie', 'cc_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/v1/auth/logout-all', (req, res) => {
  const current = P.iso(now(config));
  db.prepare(
    "UPDATE sessions SET closed_at=?,close_reason='logout_all' WHERE user_id=? AND sid_hash<>? AND closed_at IS NULL",
  ).run(current, req.user.id, req.session.sid_hash);
  res.json({ ok: true });
});

const tabs = {
  patient: ['chat', 'meds', 'tests', 'diary', 'library', 'visits', 'doctor'],
  psychiatrist: ['chat', 'patients', 'signals', 'docs', 'tools', 'offline', 'analytics', 'approvals', 'library'],
  psychologist: ['chat', 'patients', 'signals', 'docs', 'tools', 'offline', 'analytics', 'library'],
  admin: ['dashboard', 'requests', 'people', 'settings', 'log', 'content', 'program', 'service'],
  host: ['route', 'data'],
};

app.get('/api/v1/me', (req, res) => {
  const user = req.user;
  const consents = user.id && user.role === 'patient' ? consentList(user.id) : [];
  res.json({
    user: {
      id: user.id || null,
      role: user.role === 'host' ? 'demo_host' : user.role,
      display_name: user.full_name || 'Ведущий демонстрации',
      email: user.email || null,
    },
    tabs: tabs[user.role] || [],
    data_mode: config.dataMode,
    demo_mode: config.demoMode,
    consents,
    onboarding_pending:
      user.id && user.role === 'patient' ? registration.service.renewal(user.id).kinds.length > 0 : false,
  });
});

app.post('/api/v1/me/onboarding', (req, res) => {
  if (!req.user) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
  if (!req.session || req.headers['x-csrf-token'] !== req.session.data.csrf)
    return P.sendError(req, res, 403, 'E-CSRF');
  db.prepare('UPDATE user_prefs SET onboarding_done_at=? WHERE user_id=?').run(P.iso(now(config)), req.user.id);
  return res.json({ ok: true });
});

app.get('/api/v1/me/sessions', (req, res) => {
  const rows = db
    .prepare(
      'SELECT sid_hash,device_label,created_at,last_seen_at FROM sessions WHERE user_id=? AND closed_at IS NULL ORDER BY created_at DESC',
    )
    .all(req.user.id);
  res.json({
    items: rows.map((x) => ({
      current: x.sid_hash === req.session.sid_hash,
      device: x.device_label || 'Браузер',
      created_at: x.created_at,
      last_seen_at: x.last_seen_at,
    })),
  });
});

function passwordFields(password, email) {
  const fields = [];
  if (String(password || '').length < 10) fields.push({ field: 'password', key: 'err.e-validation.password_short' });
  if (String(password || '').toLowerCase() === String(email || '').toLowerCase())
    fields.push({ field: 'password', key: 'err.e-validation.password_email' });
  return fields;
}

app.patch('/api/v1/me/profile', (req, res) => {
  if (req.body.display_name !== undefined) {
    const name = String(req.body.display_name).replace(/\s+/g, ' ').trim();
    if (!name || name.length > 80 || /[<>]/.test(name))
      return P.sendError(req, res, 422, 'E-VALIDATION', {
        fields: [{ field: 'display_name', key: 'err.e-validation.required' }],
      });
    db.prepare('UPDATE users SET full_name=?,updated_at=? WHERE id=?').run(name, P.iso(now(config)), req.user.id);
    action(req.user, 'profile.name_changed', 'user', req.user.id); // значение имени в журнал не пишется
  }
  if (req.body.email) {
    if (!bcrypt.compareSync(String(req.body.current_password || ''), req.user.password_hash))
      return P.sendError(req, res, 401, 'E-AUTH-INVALID');
    if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE AND id<>?').get(req.body.email, req.user.id))
      return P.sendError(req, res, 409, 'E-EMAIL-TAKEN');
    db.prepare('UPDATE users SET email=?,email_hmac=?,updated_at=? WHERE id=?').run(
      String(req.body.email).toLowerCase(),
      P.hmac(config, req.body.email),
      P.iso(now(config)),
      req.user.id,
    );
  }
  action(req.user, 'profile.updated', 'user', req.user.id);
  res.json({ ok: true });
});

app.post('/api/v1/me/password', (req, res) => {
  if (!bcrypt.compareSync(String(req.body.current_password || ''), req.user.password_hash))
    return P.sendError(req, res, 401, 'E-AUTH-INVALID');
  const password = req.body.new_password;
  const fields = passwordFields(password, req.user.email);
  if (fields.length || password !== req.body.new_password_repeat)
    return P.sendError(req, res, 422, 'E-VALIDATION', { fields });
  const current = P.iso(now(config));
  db.prepare(
    'UPDATE users SET password_hash=?,must_change_password=0,password_changed_at=?,sessions_valid_from=? WHERE id=?',
  ).run(bcrypt.hashSync(password, 10), current, current, req.user.id);
  db.prepare(
    "UPDATE sessions SET closed_at=?,close_reason='password_change' WHERE user_id=? AND sid_hash<>? AND closed_at IS NULL",
  ).run(current, req.user.id, req.session.sid_hash);
  action(req.user, 'auth.password.changed', 'user', req.user.id);
  res.json({ ok: true });
});

const consentList = (userId) => registration.service.patientConsents(userId);

app.get('/api/v1/consents', (req, res) => {
  const userId = req.user?.id || null;
  res.json({
    items: consentList(userId),
    agreement: userId ? registration.service.status(userId, 'agreement') : null,
    pending: false,
  });
});

function inviteHash(code) {
  return P.sha(String(code).trim().toUpperCase());
}

app.post('/api/v1/invites', async (req, res) => {
  const windowStart = P.iso(new Date(now(config).getTime() - 60 * 60 * 1000));
  const count = db
    .prepare('SELECT count(*) n FROM invite_codes WHERE created_by=? AND created_at>=?')
    .get(req.user.id, windowStart).n;
  if (count >= 30) return P.sendError(req, res, 429, 'E-RATE-LIMIT', { details: { retry_after_s: 60 } });
  const code = `CC-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const current = now(config);
  const expires = new Date(current.getTime() + 7 * 86400000);
  const info = db
    .prepare(
      "INSERT INTO invite_codes(code_hash,clinician_id,created_by,status,expires_at,created_at) VALUES (?,?,?,'active',?,?)",
    )
    .run(inviteHash(code), req.user.id, req.user.id, P.iso(expires), P.iso(current));
  // Ссылка и QR: камера телефона открывает регистрацию (или привязку в профиле) с уже подставленным кодом.
  const link = `${config.baseUrl}/register?code=${encodeURIComponent(code)}`;
  let qrSvg = null;
  try {
    qrSvg = await require('qrcode').toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  } catch (_) {
    qrSvg = null; // код остаётся рабочим и без картинки
  }
  res.status(201).json({
    id: Number(info.lastInsertRowid),
    code,
    status: 'active',
    expires_at: P.iso(expires),
    link,
    qr_svg: qrSvg,
  });
});

app.get('/api/v1/invites', (req, res) => {
  const items = db
    .prepare('SELECT id,status,expires_at,created_at FROM invite_codes WHERE created_by=? ORDER BY id DESC')
    .all(req.user.id);
  res.json({ items, page: 1, page_size: 50, total: items.length });
});

app.post('/api/v1/invites/:id/revoke', (req, res) => {
  db.prepare("UPDATE invite_codes SET status='revoked',revoked_at=? WHERE id=? AND created_by=?").run(
    P.iso(now(config)),
    Number(req.params.id),
    req.user.id,
  );
  res.json({ ok: true });
});

function bumpRate(key, limit, windowMs) {
  const current = now(config);
  const bucket = new Date(Math.floor(current.getTime() / windowMs) * windowMs).toISOString();
  const row = db.prepare('SELECT count FROM rate_counters WHERE key=? AND window_start=?').get(key, bucket);
  const count = (row?.count || 0) + 1;
  db.prepare(
    'INSERT INTO rate_counters(key,window_start,count) VALUES (?,?,?) ON CONFLICT(key,window_start) DO UPDATE SET count=excluded.count',
  ).run(key, bucket, count);
  return count > limit;
}

// Регистрация (POST /auth/register, /auth/register-specialist) — src/modules/registration/routes.js.
app.post('/api/v1/consents/:kind', (req, res) => {
  const kind = req.params.kind;
  if (!['base', 'ai', 'research', 'program'].includes(kind)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
  const userId = req.user?.id;
  if (!userId) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
  const version = registration.service.current(kind);
  if (req.body.action === 'decline') return res.json({ state: 'declined', version: version.version });
  const actionName = req.body.action === 'revoke' ? 'revoked' : 'given';
  // Человек видел другую редакцию: пусть откроет новую (E-CONFLICT).
  if (req.body.version !== undefined && Number(req.body.version) !== version.version)
    return P.sendError(req, res, 409, 'E-CONFLICT');
  if (kind === 'base' && actionName === 'given' && !req.body.checkbox)
    return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
  if (kind === 'base' && actionName === 'revoked' && !req.body.confirm)
    return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'confirm', key: 'err.e-validation' }] });
  const ipHmac = registration.service.ipHmac(req);
  registration.service.record(userId, kind, actionName, { ipHmac });
  if (kind === 'base' && actionName === 'given') registration.service.record(userId, 'agreement', 'given', { ipHmac });
  if (kind === 'base' && actionName === 'revoked') {
    const current = now(config);
    db.prepare(
      "INSERT INTO data_subject_requests(patient_id,request_type,status,due_at,requested_at,version) VALUES (?,'erasure','submitted',?,?,1)",
    ).run(userId, P.iso(new Date(current.getTime() + 30 * 86400000)), P.iso(current));
    return res.json({ state: actionName });
  }
  const response = { state: actionName, version: version.version };
  // «Отменить» выключение ИИ-помощника (F-17, T-031): восстановление — новое событие «given».
  if (kind === 'ai' && actionName === 'revoked')
    response.undo = makeUndo(userId, 'consent.ai.revoke', 'consent_ai', userId);
  res.json(response);
});

app.post('/api/v1/auth/password-reset', (req, res) => {
  const email = String(req.body.email || '')
    .trim()
    .toLowerCase();
  if (bumpRate(`reset:${P.hmac(config, email)}`, 3, 60 * 60 * 1000))
    return P.sendError(req, res, 429, 'E-RATE-LIMIT', { details: { retry_after_s: 60 } });
  const user = db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE AND status='active'").get(email);
  if (user) {
    const raw = P.token(24);
    const current = now(config);
    db.prepare("UPDATE password_reset_tokens SET status='superseded' WHERE user_id=? AND status='active'").run(user.id);
    const info = db
      .prepare(
        "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,status,created_at) VALUES (?,?,?,'active',?)",
      )
      .run(user.id, P.sha(raw), P.iso(new Date(current.getTime() + 60 * 60 * 1000)), P.iso(current));
    const link = `${config.baseUrl}/password/reset/${raw}`;
    db.prepare(
      "INSERT INTO mail_queue(kind,user_id,to_enc,to_hmac,ref_type,ref_id,template_version,next_attempt_at,status) VALUES ('password_reset',?,?,?,?,?,1,?,'queued')",
    ).run(user.id, email, P.hmac(config, email), link, info.lastInsertRowid, P.iso(current));
  }
  res.json({ message: 'Если адрес существует, письмо отправлено.' });
});

app.post('/api/v1/auth/password-reset/confirm', (req, res) => {
  const row = db
    .prepare("SELECT * FROM password_reset_tokens WHERE token_hash=? AND status='active'")
    .get(P.sha(req.body.token || ''));
  if (!row || new Date(row.expires_at) < now(config)) return P.sendError(req, res, 410, 'E-RESET-TOKEN');
  const password = String(req.body.password || '');
  if (password !== req.body.password_repeat || password.length < 10) return P.sendError(req, res, 422, 'E-VALIDATION');
  const current = P.iso(now(config));
  db.prepare("UPDATE password_reset_tokens SET status='used',used_at=? WHERE id=?").run(current, row.id);
  db.prepare('UPDATE users SET password_hash=?,sessions_valid_from=?,password_changed_at=? WHERE id=?').run(
    bcrypt.hashSync(password, 10),
    current,
    current,
    row.user_id,
  );
  db.prepare("UPDATE sessions SET closed_at=?,close_reason='password_reset' WHERE user_id=? AND closed_at IS NULL").run(
    current,
    row.user_id,
  );
  res.json({ ok: true });
});

function baseConsentGiven(userId) {
  return (
    db.prepare("SELECT action FROM consent_current WHERE user_id=? AND consent_kind='base'").get(userId)?.action ===
    'given'
  );
}

function crisisCard(delivered = true) {
  return crisisGate.card(delivered);
}

function crisisText(text) {
  return crisisGate.detect(text);
}

function recordCrisis(patientId, source, text) {
  source = [
    'chat',
    'ai_chat',
    'chatbot',
    'message',
    'diary',
    'ae',
    'previsit',
    'test',
    'offline',
    'button',
    'stt',
    'ocr',
  ].includes(source)
    ? source
    : 'button';
  const current = P.iso(now(config));
  // W-41: срок реакции — настройка S-18 (рабочее/нерабочее время) и рабочие
  // часы S-30 через кризисный протокол; действуют сразу (T-268).
  const due =
    require('./crisisProtocol').computeDueAt(2, now(config)) || P.iso(new Date(now(config).getTime() + 60 * 60 * 1000));
  try {
    const open = db
      .prepare(
        "SELECT id FROM crisis_escalations WHERE patient_id=? AND status IN ('new','in_work') AND created_at>=? ORDER BY id DESC LIMIT 1",
      )
      .get(patientId, P.iso(new Date(now(config).getTime() - 86400000)));
    const match = String(text || '').match(/[^.!?]*?(нет смысла жить|поконч|суицид)[^.!?]*[.!?]?/i);
    const quote = (require('./crisisText').sentenceWithSignal(text) || match?.[0] || String(text || ''))
      .trim()
      .slice(0, 300);
    const id =
      open?.id ||
      Number(
        db
          .prepare(
            "INSERT INTO crisis_escalations(patient_id,source,tier,triggers_json,quote_enc,status,due_at,created_at) VALUES (?,?,2,'[\"text_rule\"]',?,'new',?,?)",
          )
          .run(patientId, source, quote, due, current).lastInsertRowid,
      );
    // A stricter current SLA can accelerate a signal, never postpone it.
    if (open) db.prepare('UPDATE crisis_escalations SET due_at=MIN(due_at,?) WHERE id=?').run(due, id);
    db.prepare(
      'INSERT INTO crisis_incident_log(escalation_id,patient_id,event_type,detail_json,created_at) VALUES (?,?,?, ?,?)',
    ).run(id, patientId, open ? 'appended' : 'created', JSON.stringify({ source }), current);
    if (!open) {
      const clinicians = db
        .prepare(
          "SELECT ca.clinician_id FROM care_assignments ca JOIN users c ON c.id = ca.clinician_id WHERE ca.patient_id=? AND ca.ended_at IS NULL AND c.status='active'",
        )
        .all(patientId);
      for (const { clinician_id: recipient } of clinicians) {
        db.prepare(
          "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'crisis',?,'crisis',?,'Новый сигнал безопасности',?,?,'active',?)",
        ).run(recipient, `crisis:${id}:${recipient}`, id, patientId, current, current);
      }
      // W-38: у пациента нет активного специалиста — кризис сразу в очередь администратору (F-82).
      if (!clinicians.length)
        db.prepare(
          "INSERT INTO service_queue(kind,patient_id,ref_type,ref_id,priority,due_at,status,created_at) VALUES ('crisis_no_clinician',?,'crisis',?,0,?,'new',?)",
        ).run(patientId, id, due, current);
    }
    return { id, delivered: true };
  } catch (_) {
    return { delivered: false };
  }
}

function makeUndo(userId, type, objectType, objectId) {
  const raw = P.token(18);
  const current = now(config);
  // W-41 (S-01): окно «Отменить» — настройка ui.undo_window_seconds, действует сразу (T-043).
  const windowSeconds = Number(activeSetting('ui.undo_window_seconds').value);
  const until = new Date(
    current.getTime() + (Number.isInteger(windowSeconds) && windowSeconds > 0 ? windowSeconds : 10) * 1000,
  );
  db.prepare(
    "INSERT INTO undo_actions(key_hash,author_id,action_type,method,object_type,object_id,window_until,state,created_at) VALUES (?,?,?,'soft_delete',?,?,?,'applied',?)",
  ).run(P.sha(raw), userId, type, objectType, objectId, P.iso(until), P.iso(current));
  return { id: raw, expires_at: P.iso(until) };
}

function idemCached(req, userId) {
  const key = req.headers['idempotency-key'];
  const bodyHash = P.sha(JSON.stringify(req.body || {}));
  const row = db.prepare('SELECT * FROM idempotency_keys WHERE user_id=? AND key=?').get(userId, key);
  if (!row) return { key, bodyHash };
  if (row.body_sha256 !== bodyHash) return { mismatch: true };
  return { cached: JSON.parse(row.response_json) };
}

function saveIdem(userId, state, response) {
  db.prepare('INSERT INTO idempotency_keys(user_id,key,body_sha256,response_json) VALUES (?,?,?,?)').run(
    userId,
    state.key,
    state.bodyHash,
    JSON.stringify(response),
  );
}

app.post('/api/v1/me/diary', (req, res) => {
  const note = String(req.body.note || '');
  const crisis = crisisText(note);
  const crisisRecord = crisis ? recordCrisis(req.user.id, 'diary', note) : null;
  if (!baseConsentGiven(req.user.id)) {
    // F-45/UC-08: без согласия клиническая запись не создаётся. Кризисный
    // детектор уже сработал выше (recordCrisis), но ответ — отказ T-159.
    return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
  }
  const activeEpisode = db
    .prepare('SELECT 1 FROM care_episodes WHERE patient_id=? AND ended_at IS NULL')
    .get(req.user.id);
  if (!activeEpisode) return P.sendError(req, res, 409, 'E-ARCHIVED');
  const state = idemCached(req, req.user.id);
  if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
  if (state.cached) return res.json(state.cached);
  if (bumpRate(`messages:${req.user.id}`, 30, 60 * 60 * 1000))
    return P.sendError(req, res, 429, 'E-RATE-LIMIT', { details: { retry_after_s: 60 } });
  const current = P.iso(now(config));
  if (!req.body.mood && !req.body.sleep && !req.body.anxiety && !req.body.note && !req.body.triggers)
    return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ key: 'err.e-validation.diary_empty' }] });
  const info = db
    .prepare(
      'INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,note,created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      req.user.id,
      req.body.day || current.slice(0, 10),
      req.body.mood || null,
      req.body.sleep || null,
      req.body.anxiety || null,
      note || null,
      current,
    );
  const response = {
    entry: { id: Number(info.lastInsertRowid), mood: req.body.mood },
    undo: makeUndo(req.user.id, 'diary.save', 'mood_entry', Number(info.lastInsertRowid)),
  };
  if (crisis) response.crisis = crisisCard(crisisRecord.delivered);
  else if (/тошнит|побоч|таблетк/i.test(note)) response.ae_suggestion = true;
  saveIdem(req.user.id, state, response);
  P.safeEvent(db, req.session, 'diary.saved');
  res.status(201).json(response);
});

app.get('/api/v1/me/diary', (req, res) => {
  // period из контракта: 2w, 3m или all (по умолчанию все записи — календарь листает месяцы на клиенте)
  const periodDays = { '2w': 14, '3m': 92 }[String(req.query.period || '')];
  const today = P.iso(now(config)).slice(0, 10);
  const since = periodDays
    ? new Date(Date.parse(`${today}T00:00:00Z`) - (periodDays - 1) * 86400000).toISOString().slice(0, 10)
    : null;
  const items = db
    .prepare(
      `SELECT id,mood,sleep,anxiety,note,entry_date FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL${since ? ' AND entry_date>=?' : ''} ORDER BY entry_date DESC, id DESC`,
    )
    .all(...[req.user.id, ...(since ? [since] : [])]);
  // Толкование для пациента строится по общим фактам аналитики (src/modules/analytics), а не по этому списку.
  const analytics = analyticsFacts.patientInsights(db, req.user.id, today);
  res.json({ items, page: 1, page_size: 50, total: items.length, today, analytics });
});

const v3MessageRoutes = require('./modules/v3/security').create(app, {
  db,
  P,
  config,
  now,
  auditPatient,
  baseConsentGiven,
  activeSetting,
  crisis: (text, source, patientId) => {
    if (!crisisText(text)) return null;
    const record = recordCrisis(patientId, source, text);
    return { ...crisisCard(record.delivered), id: record.id || null };
  },
});
v3MessageRoutes.post('/api/v1/me/messages', (req, res) => {
  const crisisResult = req.crisisResult;
  const uploadIds = Array.isArray(req.body.upload_ids) ? req.body.upload_ids.map(Number) : [];
  if (uploadIds.length > 5) return P.sendError(req, res, 422, 'E-FILE-COUNT');
  if (!baseConsentGiven(req.user.id)) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
  if (!crisisResult && bumpRate(`messages:${req.user.id}`, 30, 60 * 60 * 1000))
    return P.sendError(req, res, 429, 'E-RATE-LIMIT', { details: { retry_after_s: 60 } });
  const files = uploadIds.map((id) =>
    db
      .prepare("SELECT id FROM stored_files WHERE id=? AND owner_user_id=? AND status='temp' AND expires_at>?")
      .get(id, req.user.id, P.iso(now(config))),
  );
  if (new Set(uploadIds).size !== uploadIds.length || files.some((file) => !file))
    return P.sendError(req, res, 422, 'E-VALIDATION');
  const current = now(config);
  const visible = new Date(current.getTime() + Number(activeSetting('ui.undo_window_seconds').value || 10) * 1000);
  const clinician = db
    .prepare(
      'SELECT clinician_id FROM care_assignments WHERE patient_id=? AND ended_at IS NULL AND (? IS NULL OR clinician_id=?) ORDER BY id LIMIT 1',
    )
    .get(req.user.id, req.body.to_clinician_id || null, req.body.to_clinician_id || null);
  if (req.body.to_clinician_id && !clinician) return P.sendError(req, res, 404, 'E-NOT-FOUND');
  const info = db
    .prepare(
      "INSERT INTO care_messages(patient_id,clinician_id,sender_id,sender_role,body,visible_from,status,created_at) VALUES (?,?,?,'patient',?,?,'sent',?)",
    )
    .run(
      req.user.id,
      clinician?.clinician_id || null,
      req.user.id,
      String(req.body.text || ''),
      P.iso(visible),
      P.iso(current),
    );
  const response = {
    message: { id: Number(info.lastInsertRowid) },
    undo: makeUndo(req.user.id, 'message.send', 'care_message', Number(info.lastInsertRowid)),
  };
  for (const fileId of uploadIds) {
    const file = db
      .prepare("SELECT id FROM stored_files WHERE id=? AND owner_user_id=? AND status='temp'")
      .get(fileId, req.user.id);
    if (!file) return P.sendError(req, res, 422, 'E-VALIDATION');
    db.prepare(
      "UPDATE stored_files SET purpose='message_attachment',linked_type='care_message',linked_id=?,status='linked',expires_at=NULL WHERE id=?",
    ).run(Number(info.lastInsertRowid), fileId);
  }
  if (clinician)
    db.prepare(
      "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'message',?,'care_message',?,'Новое сообщение',?,?,'active',?)",
    ).run(
      clinician.clinician_id,
      `message:${info.lastInsertRowid}`,
      info.lastInsertRowid,
      req.user.id,
      P.iso(visible),
      P.iso(current),
    );
  if (!clinician) {
    db.prepare(
      "INSERT INTO service_queue(kind,patient_id,ref_type,ref_id,status,created_at) VALUES ('message_no_clinician',?,'care_message',?,'new',?)",
    ).run(req.user.id, Number(info.lastInsertRowid), P.iso(current));
    response.warnings = [{ code: 'E-NO-CLINICIAN' }];
  }
  if (crisisResult) response.crisis = crisisResult;
  P.safeEvent(db, req.session, 'message.sent');
  res.status(201).json(response);
});

v3MessageRoutes.get('/api/v1/patients/:patientId/messages', (req, res) => {
  const patientId = Number(req.params.patientId);
  const rows = db
    .prepare(
      "SELECT id,patient_id,clinician_id,body,created_at,read_at,sender_role FROM care_messages WHERE patient_id=? AND status='sent' AND (visible_from<=? OR sender_id=?) ORDER BY id",
    )
    .all(patientId, P.iso(now(config)), req.user.id)
    .filter((row) => require('./modules/files/service').messageParticipant(db, req.user.id, row, P.iso(now(config))));
  res.json({
    items: rows.map((row) => ({
      ...row,
      upload_ids: db
        .prepare("SELECT id FROM stored_files WHERE linked_type='care_message' AND linked_id=? AND status='linked'")
        .all(row.id)
        .map((file) => file.id),
    })),
    page: 1,
    page_size: 50,
    total: rows.length,
  });
});
v3MessageRoutes.get('/api/v1/me/messages', (req, res) => {
  const items = db
    .prepare(
      "SELECT id,clinician_id,body,created_at,read_at,sender_role FROM care_messages WHERE patient_id=? AND status='sent' AND (visible_from<=? OR sender_id=?) ORDER BY id",
    )
    .all(req.user.id, P.iso(now(config)), req.user.id);
  const recipients = db
    .prepare(
      "SELECT u.id,u.full_name name,u.role FROM care_assignments ca JOIN users u ON u.id=ca.clinician_id WHERE ca.patient_id=? AND ca.ended_at IS NULL AND COALESCE(ca.end_reason,'')<>'signal_only' AND u.status='active' ORDER BY ca.id",
    )
    .all(req.user.id);
  res.json({
    recipients,
    items: items.map((row) => ({
      ...row,
      upload_ids: db
        .prepare("SELECT id FROM stored_files WHERE linked_type='care_message' AND linked_id=? AND status='linked'")
        .all(row.id)
        .map((file) => file.id),
    })),
    page: 1,
    page_size: 50,
    total: items.length,
  });
});
v3MessageRoutes.post('/api/v1/messages/read', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  if (req.user.role === 'patient')
    db.prepare(
      `UPDATE care_messages SET read_at=? WHERE patient_id=? AND id IN (${ids.map(() => '?').join(',') || 'NULL'})`,
    ).run(P.iso(now(config)), req.user.id, ...ids);
  else
    db.prepare(`UPDATE care_messages SET read_at=? WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`).run(
      P.iso(now(config)),
      ...ids,
    );
  res.json({ ok: true });
});
v3MessageRoutes.post('/api/v1/patients/:patientId/messages', (req, res) => {
  const patientId = Number(req.params.patientId);
  const uploadIds = Array.isArray(req.body.upload_ids) ? req.body.upload_ids.map(Number) : [];
  if (uploadIds.length > 5) return P.sendError(req, res, 422, 'E-FILE-COUNT');
  if (!String(req.body.text || '').trim() && !uploadIds.length) return P.sendError(req, res, 422, 'E-VALIDATION');
  if (
    new Set(uploadIds).size !== uploadIds.length ||
    uploadIds.some(
      (id) =>
        !db
          .prepare("SELECT id FROM stored_files WHERE id=? AND owner_user_id=? AND status='temp' AND expires_at>?")
          .get(id, req.user.id, P.iso(now(config))),
    )
  )
    return P.sendError(req, res, 422, 'E-VALIDATION');
  const current = now(config);
  const visible = P.iso(
    new Date(current.getTime() + Number(activeSetting('ui.undo_window_seconds').value || 10) * 1000),
  );
  const info = db
    .prepare(
      "INSERT INTO care_messages(patient_id,clinician_id,sender_id,sender_role,body,visible_from,status,created_at) VALUES (?,?,?,'clinician',?,?,'sent',?)",
    )
    .run(patientId, req.user.id, req.user.id, String(req.body.text || ''), visible, P.iso(current));
  for (const fileId of uploadIds)
    db.prepare(
      "UPDATE stored_files SET purpose='message_attachment',linked_type='care_message',linked_id=?,patient_id=?,status='linked',expires_at=NULL WHERE id=?",
    ).run(Number(info.lastInsertRowid), patientId, fileId);
  db.prepare(
    "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'message',?,'care_message',?,'Новое сообщение специалиста',?,?,'active',?)",
  ).run(patientId, `message:${info.lastInsertRowid}`, info.lastInsertRowid, patientId, visible, P.iso(current));
  res.status(201).json({
    message: { id: Number(info.lastInsertRowid) },
    undo: makeUndo(req.user.id, 'message.send', 'care_message', Number(info.lastInsertRowid)),
  });
});

app.post('/api/v1/undo/:key', (req, res) => {
  const row = db
    .prepare('SELECT * FROM undo_actions WHERE key_hash=? AND author_id=?')
    .get(P.sha(req.params.key), req.user.id);
  if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
  if (row.state === 'undone') return res.json({ undone: true });
  if (now(config).getTime() > new Date(row.window_until).getTime() + 5000)
    return P.sendError(req, res, 410, 'E-UNDO-EXPIRED');
  const current = P.iso(now(config));
  if (
    row.object_type.startsWith('v3_') &&
    require('./modules/v3/undo').reverse({ db, P, config, now, activeSetting, auditPatient }, req, res, row)
  )
    return;
  if (row.object_type === 'mood_entry')
    db.prepare('UPDATE mood_entries SET hidden_at=? WHERE id=?').run(current, row.object_id);
  if (row.object_type === 'mood_entry_restore')
    db.prepare('UPDATE mood_entries SET hidden_at=NULL WHERE id=?').run(row.object_id);
  if (row.object_type === 'visit') {
    db.prepare("UPDATE visits SET status='cancelled' WHERE id=?").run(row.object_id);
    db.prepare("UPDATE previsit_forms SET status='cancelled' WHERE visit_id=?").run(row.object_id);
  }
  if (row.object_type === 'care_message') {
    db.prepare("UPDATE care_messages SET status='cancelled' WHERE id=?").run(row.object_id);
    // T-041: уведомление об отменённом сообщении не должно остаться у адресата.
    db.prepare("DELETE FROM notifications WHERE object_type='care_message' AND object_id=?").run(row.object_id);
  }
  if (row.object_type === 'crisis_take') {
    const signal = db.prepare('SELECT patient_id FROM crisis_escalations WHERE id=?').get(row.object_id);
    db.prepare("UPDATE crisis_escalations SET status='new',taken_by=NULL,taken_at=NULL WHERE id=? AND taken_by=?").run(
      row.object_id,
      req.user.id,
    );
    if (signal)
      db.prepare(
        "INSERT INTO crisis_incident_log(escalation_id,patient_id,event_type,actor_id,detail_json,created_at) VALUES (?,?, 'undo', ?, '{}', ?)",
      ).run(row.object_id, signal.patient_id, req.user.id, current);
  }
  if (row.object_type === 'ae_decision')
    db.prepare(
      "UPDATE adverse_events SET status='submitted',decision_by=NULL,decision_at=NULL,serious=NULL WHERE id=? AND decision_by=?",
    ).run(row.object_id, req.user.id);
  if (row.object_type === 'instrument_assignment')
    // Пакет отменяется целиком: все назначения одной выдачи (batch_code).
    db.prepare(
      "UPDATE instrument_assignments SET status='cancelled',cancelled_at=? WHERE id=? OR (batch_code IS NOT NULL AND batch_code=(SELECT batch_code FROM instrument_assignments WHERE id=?))",
    ).run(current, row.object_id, row.object_id);
  if (row.object_type === 'instrument_assignment_restore')
    db.prepare("UPDATE instrument_assignments SET status='pending',cancelled_at=NULL,cancelled_by=NULL WHERE id=?").run(
      row.object_id,
    );
  // W-49: «Отменить» выдачи заключения пациенту (F-68) — выдача сбрасывается,
  // пациент снова не видит документ.
  if (row.object_type === 'document_release')
    db.prepare(
      'UPDATE conclusions SET released_to_patient=0, released_version=NULL, released_visible_from=NULL, released_at=NULL WHERE id=? AND author_id=?',
    ).run(row.object_id, req.user.id);
  if (row.object_type === 'package_template')
    db.prepare('UPDATE package_templates SET hidden_at=NULL WHERE id=?').run(row.object_id);
  if (row.object_type === 'ai_thread') db.prepare('UPDATE ai_threads SET hidden_at=NULL WHERE id=?').run(row.object_id); // W-30: «Отменить» стирание треда (F-17)
  // W-39 (T-243): «Отменить» после создания сотрудника — деактивация до первого входа.
  if (row.object_type === 'staff_deactivate')
    db.prepare("UPDATE users SET status='deactivated', sessions_valid_from=? WHERE id=?").run(current, row.object_id);
  if (row.object_type === 'consent_ai' && row.action_type === 'consent.ai.revoke') {
    // W-34 (T-031): «Отменить» выключения ИИ-согласия — новое событие «given», журнал только дописывается.
    const version = registration.service.current('ai');
    const cur = db
      .prepare("SELECT action FROM consent_current WHERE user_id=? AND consent_kind='ai'")
      .get(row.author_id);
    if (version && cur && cur.action !== 'given')
      db.prepare(
        'INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (?,?,?,?,?,?)',
      ).run(row.author_id, 'ai', 'given', version.id, version.body_sha256, version.sign_method || 'demo_click');
  }
  db.prepare("UPDATE undo_actions SET state='undone',undone_at=? WHERE key_hash=?").run(current, row.key_hash);
  res.json({ undone: true });
});

function notificationItems(userId) {
  return db
    .prepare(
      "SELECT * FROM notifications WHERE recipient_id=? AND status='active' AND visible_from<=? ORDER BY id DESC",
    )
    .all(userId, P.iso(now(config)))
    .map((n) => ({ ...n, object: n.object_id ? { type: n.object_type, id: n.object_id } : null }));
}
app.get('/api/v1/notifications', (req, res) => {
  const items = notificationItems(req.user.id);
  res.json({ items, page: 1, page_size: 50, total: items.length });
});
app.get('/api/v1/notifications/count', (req, res) =>
  res.json({ unread: notificationItems(req.user.id).filter((n) => !n.read_at).length }),
);
app.post('/api/v1/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET read_at=? WHERE recipient_id=? AND read_at IS NULL').run(
    P.iso(now(config)),
    req.user.id,
  );
  res.json({ ok: true });
});

app.post('/api/v1/patients/:patientId/assignments', (req, res) => {
  const patientId = Number(req.params.patientId);
  const requested = req.body.instrument_code;
  const codes = req.body.package_id
    ? JSON.parse(
        db
          .prepare('SELECT items_json FROM package_templates WHERE id=? AND hidden_at IS NULL')
          .get(Number(req.body.package_id))?.items_json || 'null',
      )
    : [requested];
  if (!Array.isArray(codes) || !codes.length) return P.sendError(req, res, 422, 'E-VALIDATION');
  for (const code of codes) {
    const available = db
      .prepare("SELECT 1 FROM instruments WHERE code=? AND status NOT IN ('blocked','withdrawn') AND online_allowed=1")
      .get(code);
    const policy = require('./modules/clinical/instruments/gad_registry').policyForCode(code);
    if (!available || policy?.assignable === false)
      return P.sendError(req, res, 403, 'E-INSTRUMENT-LICENSE', { fields: [{ key: 'msg.tests.not_assignable' }] });
    if (
      db
        .prepare(
          "SELECT 1 FROM instrument_assignments WHERE patient_id=? AND instrument=? AND status IN ('pending','in_progress','waiting_entry')",
        )
        .get(patientId, code)
    )
      return P.sendError(req, res, 409, 'E-ASSIGN-DUPLICATE');
  }
  const current = now(config);
  const visible = new Date(current.getTime() + 10 * 1000);
  const batch = req.body.package_id ? P.token(8) : null;
  const created = [];
  for (const code of codes) {
    const info = db
      .prepare(
        "INSERT INTO instrument_assignments(patient_id,assigned_by,instrument,instrument_version,status,visible_from,assigned_at,batch_code,package_template_id) VALUES (?,? ,?,(SELECT current_version FROM instruments WHERE code=?),'pending',?,?,?,?)",
      )
      .run(patientId, req.user.id, code, code, P.iso(visible), P.iso(current), batch, req.body.package_id || null);
    const id = Number(info.lastInsertRowid);
    created.push({ id, instrument_code: code, package_id: req.body.package_id || null });
    db.prepare(
      "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'assignment',?,'assignment',?,'Новое действие',?,?,'active',?)",
    ).run(patientId, `assignment:${id}`, id, patientId, P.iso(visible), P.iso(current));
  }
  const id = created[0].id;
  res.status(201).json({
    items: created,
    undo: makeUndo(req.user.id, 'assignment.send', 'instrument_assignment', id),
  });
});

app.get('/api/v1/patients/:patientId', (req, res) => {
  const patientId = Number(req.params.patientId);
  const tab = req.query.tab || 'overview';
  if (req.user.role === 'psychologist' && tab === 'treatment') return P.sendError(req, res, 403, 'E-ACCESS');
  try {
    auditPatient(req, patientId, 'allow', tab);
  } catch (_) {
    return P.sendError(req, res, 500, 'E-INTERNAL');
  }
  const payload = { patient: { id: patientId }, tab };
  if (tab === 'overview') {
    payload.overview = require('./modules/patients/overview').buildOverview(
      db,
      patientId,
      req.user,
      P.iso(now(config)),
      activeSetting('org.timezone_hours').value?.timezone || 'Europe/Moscow',
    );
  }
  if (tab === 'diary') {
    const visibility = require('./modules/diary/visibility');
    payload.items = db
      .prepare(
        'SELECT id,mood,sleep,anxiety,triggers_json,note,entry_date FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL ORDER BY id DESC',
      )
      .all(patientId)
      .map((entry) => visibility.redactEntry(db, patientId, req.user, entry));
    payload.analytics = visibility.scoresVisible(db, patientId, req.user)
      ? analyticsFacts.clinicianInsights(db, patientId, P.iso(now(config)).slice(0, 10))
      : null;
  }
  if (tab === 'tests') {
    payload.results = db
      .prepare(
        'SELECT id,instrument,total_score,band,subscales_json,self_initiated,shared_at,created_at FROM online_results WHERE patient_id=? AND (self_initiated=0 OR shared_at IS NOT NULL) ORDER BY created_at DESC, id DESC',
      )
      .all(patientId);
    // SCL-90-R: полный блок для специалиста (шкалы, нормы, интерпретации, критические пункты, динамика).
    const sclRows = db
      .prepare(
        "SELECT id,total_score,subscales_json,answers_json,instrument_version,created_at FROM online_results WHERE patient_id=? AND instrument='scl90r' AND invalid_at IS NULL AND (self_initiated=0 OR shared_at IS NOT NULL) ORDER BY created_at DESC, id DESC",
      )
      .all(patientId);
    // ИТТ (СТ-Л и СТ-С): блок для специалиста — станайны по обеим группам норм, интерпретации, сравнение, динамика.
    const ittRows = db
      .prepare(
        "SELECT id,instrument,total_score,subscales_json,instrument_version,created_at FROM online_results WHERE patient_id=? AND instrument IN ('itt_l','itt_s') AND invalid_at IS NULL AND (self_initiated=0 OR shared_at IS NOT NULL) ORDER BY created_at DESC, id DESC",
      )
      .all(patientId);
    payload.results = payload.results.map((r) => {
      if (r.instrument === 'stai') return { ...r, stai: JSON.parse(r.subscales_json || '{}') };
      const full = r.instrument === 'scl90r' && sclRows.find((x) => x.id === r.id);
      const ittFull = (r.instrument === 'itt_l' || r.instrument === 'itt_s') && ittRows.find((x) => x.id === r.id);
      if (ittFull) return { ...r, itt: require('./modules/clinical/instruments/itt_view').buildView(ittFull, ittRows) };
      return full
        ? { ...r, scl90r: require('./modules/clinical/instruments/scl90r_view').buildView(full, sclRows) }
        : r;
    });
    payload.offline_results = db
      .prepare(
        'SELECT id,instrument,total_score,band,risk_flag,test_date,entry_method,source_file_id,status,invalid_at,invalid_reason FROM offline_results WHERE patient_id=? ORDER BY test_date DESC, id DESC',
      )
      .all(patientId)
      .map((row) => ({ ...row, erroneous: Boolean(row.invalid_at) }));
  }
  if (tab === 'treatment') {
    payload.patient_meds = db
      .prepare(
        'SELECT pm.id,pm.current_version,pm.reviewed_version,pm.doctor_comment_enc comment,pv.dose_value dose,pv.dose_unit unit,pv.times_json,dp.trade_name,i.name inn_name FROM patient_meds pm JOIN patient_med_versions pv ON pv.patient_med_id=pm.id AND pv.version=pm.current_version JOIN drug_products dp ON dp.id=pv.product_id JOIN inn i ON i.id=pv.inn_id WHERE pm.patient_id=? AND pm.hidden_at IS NULL',
      )
      .all(patientId)
      .map(({ times_json, ...m }) => ({ ...m, times: JSON.parse(times_json || '[]') }));
    payload.purchases = db
      .prepare(
        "SELECT pm.item_key,dp.trade_name,i.name inn_name FROM purchase_marks pm JOIN drug_products dp ON dp.id=pm.product_id JOIN inn i ON i.id=dp.inn_id WHERE pm.patient_id=? AND pm.status IN ('current','needs_clarification')",
      )
      .all(patientId);
  }
  res.json(payload);
});

app.post('/api/v1/crisis/help', async (req, res) => {
  const record = recordCrisis(req.user.id, String(req.body.source || 'button'), req.body.text || '');
  const clinician = db
    .prepare('SELECT clinician_id FROM care_assignments WHERE patient_id=? AND ended_at IS NULL LIMIT 1')
    .get(req.user.id);
  const appeal = db
    .prepare(
      "INSERT INTO patient_appeals(patient_id,clinician_id,routed_to,kind,message_enc,escalation_id,created_at) VALUES (?,?,?,'need_help',?,?,?)",
    )
    .run(
      req.user.id,
      clinician?.clinician_id || null,
      clinician ? 'clinician' : 'service_queue',
      String(req.body.text || '').slice(0, 300),
      record.id || null,
      P.iso(now(config)),
    );
  // Пациент попадает в кризисный разговор (src/ai/crisisFlow.js): сценарное первое сообщение, затем ИИ с оценкой для врача.
  // Любой сбой режима ответ не ломает: карточка 112 и обращение уже созданы.
  let crisisChat = null;
  if (req.user.role === 'patient' && app.locals.crisisFlow) {
    try {
      const opened = await app.locals.crisisFlow.open({
        user: req.user,
        escalationId: record.id || null,
        delivered: record.delivered,
        text: req.body.text || '',
      });
      crisisChat = {
        thread_id: opened.thread.id,
        ...opened.view,
        message: opened.message ? { id: opened.message.id, text: opened.message.text } : null,
      };
    } catch (e) {
      console.error('crisis help: chat not opened', e && e.message);
    }
  }
  res.status(record.delivered ? 201 : 200).json({
    appeal_id: Number(appeal.lastInsertRowid),
    crisis: { ...crisisCard(record.delivered), id: record.id || null },
    ...(crisisChat ? { crisis_chat: crisisChat } : {}),
  });
});

app.post('/api/v1/ai/patient/messages', (req, res) => {
  const text = String(req.body.text || '');
  const uploadIds = Array.isArray(req.body.upload_ids) ? req.body.upload_ids : [];
  if (uploadIds.length > 5) return P.sendError(req, res, 422, 'E-VALIDATION');
  if (crisisText(text)) {
    const record = recordCrisis(req.user.id, 'ai_chat', text);
    return res.json({
      crisis: { ...crisisCard(record.delivered), id: record.id || null },
      reply: { status: 'crisis' },
    });
  }
  const ai = db.prepare("SELECT action FROM consent_current WHERE user_id=? AND consent_kind='ai'").get(req.user.id);
  if (ai?.action !== 'given') return P.sendError(req, res, 403, 'E-CONSENT-AI');
  const current = P.iso(now(config));
  const threadInfo = db
    .prepare(
      "INSERT INTO ai_threads(owner_user_id,role,purpose,patient_id,title,title_auto,last_message_at,created_at,updated_at) VALUES (?,'patient','patient_assistant',?,'Новый диалог',1,?,?,?)",
    )
    .run(req.user.id, req.user.id, current, current, current);
  const threadId = Number(threadInfo.lastInsertRowid);
  db.prepare(
    "INSERT INTO ai_messages(thread_id,role,text,kind,ai_generated,created_at) VALUES (?,'user',?,'text',0,?)",
  ).run(threadId, text, current);
  res.status(201).json({ thread: { id: threadId }, message: { role: 'assistant', text: 'STAND-IN: ответ помощника' } });
});

app.get('/api/v1/crisis/contacts', (_req, res) => {
  // W-41 (S-17): контакты — действующая настройка crisis.contacts; 112 первым
  // гарантируется проверкой значения, при сомнении — встроенный минимум.
  const setting = activeSetting('crisis.contacts').value;
  const contacts =
    Array.isArray(setting) && setting.length && setting[0] && setting[0].phone === '112'
      ? setting
      : crisisCard().contacts;
  return res.json({ contacts });
});

function multipartFile(req, fieldName = 'file') {
  const match = /boundary=([^;]+)/i.exec(req.headers['content-type'] || '');
  if (!match || !Buffer.isBuffer(req.body)) return null;
  const boundary = Buffer.from(`--${match[1]}`);
  const chunks = [];
  let cursor = 0;
  while (cursor < req.body.length) {
    const next = req.body.indexOf(boundary, cursor);
    if (next < 0) break;
    chunks.push(req.body.subarray(cursor, next));
    cursor = next + boundary.length;
  }
  for (const chunk of chunks) {
    const headEnd = chunk.indexOf(Buffer.from('\r\n\r\n'));
    if (headEnd < 0) continue;
    const head = chunk.subarray(0, headEnd).toString('utf8');
    if (!new RegExp(`name="${fieldName}"`).test(head)) continue;
    const name = /filename="([^"]*)"/.exec(head)?.[1] || 'upload';
    const mime = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] || 'application/octet-stream';
    let data = chunk.subarray(headEnd + 4);
    if (data.subarray(-2).equals(Buffer.from('\r\n'))) data = data.subarray(0, -2);
    return { name, mime, data };
  }
  return null;
}

function multipartFields(req) {
  const match = /boundary=([^;]+)/i.exec(req.headers['content-type'] || '');
  if (!match || !Buffer.isBuffer(req.body)) return {};
  const boundary = Buffer.from(`--${match[1]}`);
  const chunks = [];
  let cursor = 0;
  while (cursor < req.body.length) {
    const next = req.body.indexOf(boundary, cursor);
    if (next < 0) break;
    chunks.push(req.body.subarray(cursor, next));
    cursor = next + boundary.length;
  }
  const fields = {};
  for (const chunk of chunks) {
    const headEnd = chunk.indexOf(Buffer.from('\r\n\r\n'));
    if (headEnd < 0) continue;
    const head = chunk.subarray(0, headEnd).toString('utf8');
    if (/filename="/.test(head)) continue;
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    let data = chunk.subarray(headEnd + 4);
    if (data.subarray(-2).equals(Buffer.from('\r\n'))) data = data.subarray(0, -2);
    fields[name] = data.toString('utf8');
  }
  return fields;
}

function fileType(data) {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return { mime: 'image/jpeg', ext: 'jpg', image: true };
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: 'image/png', ext: 'png', image: true };
  if (data.subarray(0, 5).toString() === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', image: false };
  return null;
}
// W-41: содержимое целиком разбирается как JSON (перенос настроек, F-97).
function looksLikeJson(data) {
  try {
    const text = data.toString('utf8');
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    JSON.parse(text);
    return true;
  } catch (_) {
    return false;
  }
}
app.post('/api/v1/uploads', async (req, res) => {
  if (bumpRate(`uploads:${req.user.id}`, 20, 10 * 60 * 1000)) return P.sendError(req, res, 429, 'E-RATE-LIMIT');
  const release = await require('./modules/files/service').lock(`${req.user.id}:${req.headers['idempotency-key']}`);
  let storedPath;
  let storedId;
  try {
    const part = multipartFile(req);
    if (!part) return P.sendError(req, res, 422, 'E-VALIDATION');
    const state = idemCached(
      {
        headers: req.headers,
        body: {
          route: req.path,
          hash: P.sha(part.data),
          nameHash: P.sha(part.name),
          fieldsHash: P.sha(JSON.stringify(multipartFields(req))),
        },
      },
      req.user.id,
    );
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) {
      const previous = db
        .prepare(
          "SELECT id FROM stored_files WHERE id=? AND owner_user_id=? AND status NOT IN ('deleted','hidden') AND (expires_at IS NULL OR expires_at>?)",
        )
        .get(state.cached.id, req.user.id, P.iso(now(config)));
      if (!previous) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      return res.status(201).json(state.cached);
    }
    if (part.data.length > 10 * 1024 * 1024) return P.sendError(req, res, 413, 'E-FILE-SIZE');
    const kind = fileType(part.data);
    // W-41: перенос настроек (F-97) — settings.json принимается как JSON-файл
    // только для служебной цели reference_import; обычные загрузки — прежние типы.
    const uploadFields = multipartFields(req);
    const isSettingsJson = !kind && uploadFields.purpose === 'reference_import' && looksLikeJson(part.data);
    // F-15: DOCX/TXT — имя/расширение и реальное содержимое должны совпадать.
    // Текст извлекается локально (extract.inspect / безопасный ZIP reader), произвольный
    // ZIP не принимается как docx, бинарный txt и SVG/HTML-прослойка отклоняются.
    let documentInfo = null;
    if (!kind && !isSettingsJson) {
      const extract = require('./ai/workspace/extract');
      try {
        const info = extract.inspect(part.name, part.data);
        if (info.ext === 'txt' || info.ext === 'docx' || info.ext === 'csv')
          documentInfo = {
            mime:
              info.ext === 'docx'
                ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                : 'text/plain',
            ext: info.ext,
            text: info.text,
          };
      } catch (e) {
        if (e && e.code === 'size') return P.sendError(req, res, 413, 'E-FILE-SIZE');
        return P.sendError(req, res, 415, 'E-FILE-TYPE');
      }
    }
    if (!kind && !isSettingsJson && !documentInfo) return P.sendError(req, res, 415, 'E-FILE-TYPE');
    const kindOrJson = kind || documentInfo || { mime: 'application/json', ext: 'json', image: false };
    // В демо разрешён только локальный режим none. В real отсутствие готового
    // clamd-коннектора закрывает загрузку, а не пропускает файл непроверенным.
    if (config.dataMode === 'real' || config.fileScanner === 'clamd') return P.sendError(req, res, 503, 'E-FILE-SCAN');
    let data = part.data;
    if (kindOrJson.image) {
      try {
        data = await require('./modules/files/service').sanitize(part.data, kindOrJson.mime);
      } catch (_) {
        return P.sendError(req, res, 422, 'E-VALIDATION');
      }
    }
    const dir = path.join(config.dataDir, 'files');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const storage = `${crypto.randomUUID()}.${kindOrJson.ext}`;
    storedPath = path.join(dir, storage);
    fs.writeFileSync(storedPath, data, { mode: 0o600 });
    const current = P.iso(now(config));
    const info = db
      .prepare(
        "INSERT INTO stored_files(owner_user_id,patient_id,purpose,storage_name,original_name_enc,mime,size_bytes,sha256,scan_status,exif_stripped,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?, 'not_required',?,'temp',?,?)",
      )
      .run(
        req.user.id,
        req.user.role === 'patient' ? req.user.id : null,
        'temp_upload',
        storage,
        part.name,
        kindOrJson.mime,
        data.length,
        crypto.createHash('sha256').update(data).digest('hex'),
        kindOrJson.image ? 1 : 0,
        P.iso(new Date(now(config).getTime() + 20 * 60 * 1000)),
        current,
      );
    storedId = Number(info.lastInsertRowid);
    let ocr_status = null;
    let ocr_text = null;
    let warnings = [];
    if (kindOrJson.image) {
      const { forwardFile } = require('./modules/voice');
      const ocr = await forwardFile(config, '/ocr', data, kindOrJson.mime, part.name);
      if (ocr.ok && ocr.data.status === 'printed') {
        ocr_status = 'done';
        ocr_text = ocr.data.text;
      } else {
        ocr_status = 'failed';
        warnings.push('E-OCR-FAILED');
      }
    } else if (documentInfo) {
      // F-15: локально извлечённый текст из DOCX/TXT — в ответе, но не в safe replay.
      ocr_status = 'done';
      ocr_text = documentInfo.text;
    }
    // F-15: PDF с текстовым слоем — локальное извлечение для кризисной проверки пациента.
    let pdfText = '';
    if (kind && kind.ext === 'pdf' && !isSettingsJson) {
      try {
        pdfText = require('./ai/workspace/extract').inspect(part.name, data).text || '';
      } catch (_) {
        pdfText = '';
      }
    }
    const response = { id: Number(info.lastInsertRowid), status: 'ready', ocr_status, ocr_text, warnings };
    if (req.user.role === 'patient' && crisisText(ocr_text || pdfText || '')) {
      const record = recordCrisis(req.user.id, 'ocr', ocr_text || pdfText);
      response.crisis = crisisCard(record.delivered);
    }
    saveIdem(req.user.id, state, {
      id: response.id,
      status: 'ready',
      ocr_status: null,
      ocr_text: null,
      warnings: [],
      ...(response.crisis ? { crisis: response.crisis } : {}),
    });
    res.status(201).json(response);
  } catch (_) {
    if (storedId) {
      try {
        db.prepare('DELETE FROM stored_files WHERE id=?').run(storedId);
      } catch (_) {
        /* deny dangling upload */
      }
    }
    if (storedPath) {
      try {
        fs.unlinkSync(storedPath);
      } catch (_) {
        /* missing file already unavailable */
      }
    }
    return P.sendError(req, res, 500, 'E-INTERNAL');
  } finally {
    release();
  }
});
app.post('/api/v1/stt', async (req, res) => {
  if (bumpRate(`stt:${req.user.id}`, 10, 10 * 60 * 1000)) return P.sendError(req, res, 429, 'E-RATE-LIMIT');
  const part = multipartFile(req, 'audio');
  if (!part) return P.sendError(req, res, 422, 'E-VALIDATION');
  const fields = multipartFields(req);
  const roleLimit = req.user.role === 'patient' ? 'patient' : 'clinician';
  const limits = activeSetting('voice.max_seconds').value || { patient: 180, clinician: 900 };
  const limit = limits[roleLimit] || limits.patient || 180;
  const duration = Number(fields.duration_s || 0);
  if (duration > limit) return P.sendError(req, res, 413, 'E-STT-TOO-LONG');
  if (!part.data.length) return P.sendError(req, res, 422, 'E-STT-EMPTY');
  const { forwardFile } = require('./modules/voice');
  const r = await forwardFile(config, '/stt', part.data, part.mime || 'audio/webm', 'audio');
  if (!r.ok) return P.sendError(req, res, 503, 'E-STT-UNAVAILABLE');
  if (r.data.status === 'empty') return P.sendError(req, res, 422, 'E-STT-EMPTY');
  const response = { text: r.data.text, segments: r.data.segments };
  if (req.user.role === 'patient' && crisisText(r.data.text || '')) {
    const record = recordCrisis(req.user.id, 'stt', r.data.text);
    response.crisis = crisisCard(record.delivered);
  }
  return res.json(response);
});

app.get('/api/v1/files/:fileId', (req, res) => {
  const row = db.prepare("SELECT * FROM stored_files WHERE id=? AND status<>'deleted'").get(Number(req.params.fileId));
  if (!require('./modules/files/service').readable(db, row, req.user, P.iso(now(config))))
    return P.sendError(req, res, 404, 'E-NOT-FOUND');
  if (req.user.role !== 'patient' && row.patient_id) {
    try {
      auditPatient(req, row.patient_id, 'allow', 'files');
    } catch (_) {
      return P.sendError(req, res, 500, 'E-INTERNAL');
    }
  }
  const file = path.join(config.dataDir, 'files', row.storage_name);
  if (!fs.existsSync(file)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(fs.readFileSync(file));
});

const demoRouteDefault = [
  { title: 'Пациент', url: '/app' },
  { title: 'Врач', url: '/work' },
  { title: 'Сигналы', url: '/work?tab=signals' },
];
function activeSetting(key) {
  const row = db
    .prepare("SELECT * FROM setting_versions WHERE key=? AND status='active' ORDER BY version DESC LIMIT 1")
    .get(key);
  if (row) return { version: row.version, value: JSON.parse(row.value_json) };
  const defaults = {
    'demo.route': demoRouteDefault,
    'previsit.questions': [
      { id: 'sleep', type: 'text_long', text: 'Как вы себя чувствуете?', required: false },
      {
        id: 'changes',
        type: 'multi',
        text: 'Что изменилось?',
        options: [{ value: 'sleep', label: 'Сон' }],
        required: false,
      },
    ],
  };
  return { version: 0, value: defaults[key] ?? null };
}
// W-39: люди и доступ — модульные API-маршруты (F-88…F-94).
// Монтируются ДО clinicalRoutes (см. install ниже): staffRouter перехватывает
// /api/v1/admin/care-assignments раньше каркасного обработчика В3, чтобы F-93
// возвращал предупреждения и создавал запрос «пациент без специалиста» (T-247).
const peopleRoutes = require('./modules/admin/people/routes');
app.use('/api/v1/admin/people', peopleRoutes);
app.use('/api/v1/admin', peopleRoutes.staffRouter);
app.use('/api/v1/admin', require('./modules/admin/people/invites'));

// W-36: разбор фразы врача моделью order_parse (F-35, этап 14). Монтируется ДО правил В2 (clinicalRoutes),
// чтобы дополнить их ответом модели; файл В3 (src/modules/clinical/routes.js) не меняется.
require('./modules/plan/parse').install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
});
clinicalRoutes.install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
  makeUndo,
  crisis: (text, source, patientId) => {
    const record = recordCrisis(patientId, source, text);
    return { ...crisisCard(record.delivered), id: record.id || null };
  },
});
require('./modules/analytics/reporting_routes').install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
  baseConsentGiven,
  auditPatient,
});
require('./modules/analytics/routes').install(app, { db, P, config, now, activeSetting });
require('./modules/analytics/export_routes').install(app, { db, P, config, now, activeSetting });
require('./modules/insights/routes').install(app, { db, P, config, now, activeSetting, auditPatient });
require('./modules/admin/dashboard/routes').install(app, { db, P, config, now, activeSetting });
require('./modules/diary/routes').install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
  baseConsentGiven,
  recordCrisis,
  auditPatient,
  getMedications: (patientId) =>
    require('./modules/diary/medications').getMedicationDays(
      db,
      patientId,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: activeSetting('org.timezone_hours').value?.timezone || 'Europe/Moscow',
      }).format(now(config)),
      activeSetting('org.timezone_hours').value?.timezone || 'Europe/Moscow',
      P.iso(now(config)),
    ),
});
v3Routes.install(app, {
  auditPatient,
  baseConsentGiven,
  db,
  P,
  config,
  now,
  activeSetting,
  makeUndo,
  crisis: (text, source, patientId) => {
    if (!crisisText(text)) return null;
    const record = recordCrisis(patientId, source, text);
    return { ...crisisCard(record.delivered), id: record.id || null };
  },
});
// W-41: прежние inline-маршруты /api/v1/admin/settings/:key (GET/PUT) удалены —
// их обслуживает модуль src/modules/settings/routes.js (версии, откат,
// «Кто утвердил», E-CONFLICT; регистрация выше, сразу после контрактного
// контроля доступа). activeSetting ниже по-прежнему читает действующую версию
// из базы для страниц и модулей, объявленных раньше службы настроек.

app.get('/api/v1/demo/route', (_req, res) => res.json({ steps: activeSetting('demo.route').value }));
app.post('/api/v1/demo/login-as', (req, res) => {
  const role = String(req.body.role || '');
  if (!['patient', 'psychiatrist', 'psychologist', 'admin', 'demo_host'].includes(role))
    return P.sendError(req, res, 422, 'E-VALIDATION');
  P.closeSession(db, config, req.session, 'demo_switch');
  const user = role === 'demo_host' ? null : require('./modules/demo/scenario').selectDemoUser(db, role);
  if (role !== 'demo_host' && !user) return P.sendError(req, res, 409, 'E-STATUS');
  P.createSession(db, config, res, { userId: user?.id || null, role, data: { role } });
  action(user || { role: 'host' }, `demo.login.${role}`);
  res.json({
    user: { id: user?.id || null, role, display_name: user?.full_name || 'Ведущий' },
    next: role === 'demo_host' ? 'demo' : role === 'patient' ? 'app' : role === 'admin' ? 'admin' : 'work',
  });
});
app.get('/api/v1/demo/state', (_req, res) =>
  res.json({ route: activeSetting('demo.route').value, data_mode: config.dataMode }),
);
let resetting = false;
app.post('/api/v1/demo/reset', async (req, res) => {
  if (!req.body.confirm)
    return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'confirm', key: 'err.e-validation' }] });
  if (resetting) return P.sendError(req, res, 409, 'E-STATUS');
  resetting = true;
  try {
    db.prepare("DELETE FROM mood_entries WHERE note LIKE 'Синтетическая запись до сброса%'").run();
    db.prepare("DELETE FROM stored_files WHERE purpose='temp_upload'").run();
    db.prepare("UPDATE setting_versions SET status='previous' WHERE key='demo.route' AND status='active'").run();
    action(req.user, 'demo.reset');
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.prepare("UPDATE sessions SET closed_at=?,close_reason='demo_reset' WHERE closed_at IS NULL").run(
      P.iso(now(config)),
    );
    res.json({ ok: true });
  } finally {
    resetting = false;
  }
});

// W-39: старый обработчик списка людей удалён — теперь маршрут обслуживает
// модуль src/modules/admin/people/routes.js (см. монтирование ниже, F-88).

// W-39: данные «моего аккаунта» — журнал доступа пациента (F-22, PD-03) и запросы субъекта (F-84).
// Тест T-242 читает access_log и проверяет запись от «Показать» (section=account);
// T-207 ждёт ответ администратора в requests и id строки журнала для «Это странно».
app.get('/api/v1/me/data', (req, res) => {
  if (!req.user || req.user.role !== 'patient') return P.sendError(req, res, 403, 'E-ACCESS');
  // W-50 (T-200): строка «кто смотрел» — кто (имя), роль, раздел, дата; без IP (PD-03).
  const rows = db
    .prepare(
      `SELECT l.id, l.section, l.action, l.decision, l.created_at AS at, u.full_name AS who, u.role AS role
       FROM phi_access_log l JOIN users u ON u.id = l.actor_id
       WHERE l.patient_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT 500`,
    )
    .all(req.user.id);
  const field = require('./crypto/field');
  const requests = db
    .prepare(
      'SELECT id, request_type, status, due_at, requested_at, answer_enc, answer_visible_from FROM data_subject_requests WHERE patient_id = ? ORDER BY id DESC LIMIT 100',
    )
    .all(req.user.id)
    .map((r) => {
      let answer = null;
      if (r.answer_enc) {
        const d = field.decrypt(process.env.PII_ENC_KEY, r.answer_enc);
        if (d.ok) {
          try {
            answer = JSON.parse(d.value);
          } catch (_) {
            answer = null;
          }
        }
      }
      return {
        id: r.id,
        kind: r.request_type,
        status: r.status,
        due_at: r.due_at,
        requested_at: r.requested_at,
        answer,
        answer_visible_from: r.answer_visible_from,
      };
    });
  // Сводка по категориям — только числа записей, без содержимого (F-84, PD-18).
  const categories = [
    ['diary', 'mood_entries', 'patient_id'],
    ['messages', 'care_messages', 'patient_id'],
    ['assignments', 'instrument_assignments', 'patient_id'],
    ['files', 'stored_files', 'owner_user_id'],
    ['ai_threads', 'ai_threads', 'owner_user_id'],
    ['visits', 'visits', 'patient_id'],
    ['episodes', 'care_episodes', 'patient_id'],
    ['clinicians', 'care_assignments', 'patient_id'],
    ['notifications', 'notifications', 'recipient_id'],
    ['consents', 'consent_events', 'user_id'],
    ['adverse_events', 'adverse_events', 'patient_id'],
  ]
    .filter(([, table]) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table))
    .map(([key, table, col]) => ({
      key,
      count: db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${col}" = ?`).get(req.user.id).n,
    }))
    .filter((c) => c.count > 0);
  res.json({ categories, access_log: rows, requests });
});

function genericApi(req, res) {
  const op = req.operation;
  if (!op) return P.sendError(req, res, 404, 'E-NOT-FOUND');
  if (req.user?.role === 'patient' && /\/(diary|threads|uploads|files)\/[0-9]+/.test(req.path))
    return P.sendError(req, res, 404, 'E-NOT-FOUND');
  if (req.method === 'GET') return res.json({ items: [], page: 1, page_size: 50, total: 0 });
  return res.status(req.method === 'POST' ? 201 : 200).json({ ok: true });
}
// W-38: очередь запросов администратора и запросы субъекта (F-82…F-85). Маршруты до genericApi.
const queueService = require('./modules/admin/queue').install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
  core: require('./admin_core'),
  deletion: require('./admin_deletion'),
  encKey: process.env.PII_ENC_KEY,
});

// W-40: замещение специалиста (F-70/F-87) и постоянная передача (F-86).
require('./modules/admin/logs/routes').install(app, { db, P, config });
require('./modules/admin/agent/routes').install(app, { db, P });
require('./modules/admin/prompts/routes').install(app, { db, P, keys: require('./ai/registry').PROMPT_KEYS });
const substitutionService = require('./modules/substitutions/routes').install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
  core: require('./admin_core'),
});
require('./modules/admin/queue/substituteRoutes').install(app, {
  db,
  P,
  config,
  now,
  activeSetting,
  core: require('./admin_core'),
});

// W-48: библиотека психообразования (F-50) и публикация материалов (F-109).
// Монтируется до genericApi; сид синтетического STAND-IN-контента — идемпотентный,
// выполняется на старте (в тестах мир уже загружен, admin существует).
const libraryRoutes = require('./modules/library/routes').install(app, {
  db,
  P,
  config,
  now,
  idemCached,
  saveIdem,
});

// Журнал: отдельный раздел со своим оформлением (/journal), лайки, управление статьями в админке.
require('./modules/journal/routes').install(app, { db, P, config, now, action, flower });

// W-49: документы по пациенту (F-67) и заключения психолога (F-68).
// Монтируется до genericApi; роли до handler'а проверяет контрактный контроль.
require('./modules/documents/routes').install(app, {
  db,
  P,
  config,
  now,
  makeUndo,
  idemCached,
  saveIdem,
  auditPatient,
  baseConsentGiven,
});

// W-50: «Мои данные» — выгрузка, стирание, исправления (F-51…F-54).
require('./modules/privacy/routes').install(app, {
  db,
  P,
  config,
  now,
  idemCached,
  saveIdem,
});

// W-51: завершение наблюдения и архив (F-69).
require('./modules/patients/routes').install(app, {
  db,
  P,
  config,
  now,
  idemCached,
  saveIdem,
  auditPatient,
});

registration.install(app);
careLinks.install(app);

app.all('/api/*', genericApi);

function protectedPage(req, res, roles, render) {
  if (!req.user) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!roles.includes(req.user.role)) return res.status(404).send(errorPage({ user: req.user, demo: config.demoMode }));
  return render();
}

const AUTH_FOOT =
  '<p class="page-foot"><a href="/legal">Политика и соглашение</a> · <a href="/account/help">Справка</a> · Если тяжело — 112</p>';

function loginForm(message = '') {
  const tabs = `<nav class="seg reg-seg" aria-label="${esc(t('msg.login.tabs', 'Вход или регистрация'))}"><a href="/login" aria-current="page" data-testid="msg.login.tab.login">${esc(t('msg.login.tab.login', 'Войти'))}</a><a href="/register" data-testid="msg.login.tab.register">${esc(t('msg.login.tab.register', 'Зарегистрироваться'))}</a></nav>`;
  return `<h1 data-testid="msg.login.title">Вход</h1>${tabs}${message}<p class="form-error warn" data-testid="msg.login.session_expired" hidden>Сессия истекла — введённое сохранено</p><form id="login-form" class="form" action="/login" method="post"><label>Почта<input data-testid="msg.login.email" name="email" type="email" autocomplete="username"></label><label>Пароль<input data-testid="msg.login.password" name="password" type="password" autocomplete="current-password"></label><input type="hidden" name="restore_diary" value="0"><button class="btn primary wide-btn" data-testid="msg.login.submit" type="submit">Войти</button><p class="form-error" aria-live="polite"></p><p class="auth-links"><a href="/password/reset" data-testid="msg.login.forgot">Забыли пароль?</a> · <a href="/register" data-testid="msg.login.have_code">Есть код приглашения</a></p></form><p class="auth-links login-specialist"><a href="/register?as=specialist" data-testid="msg.login.specialist">${esc(t('msg.login.specialist', 'Я специалист — подать заявку'))}</a></p>${AUTH_FOOT}`;
}
const ROLE_CARDS = {
  patient: ['🙂', 'Чат с ИИ-помощником, лекарства, тесты, дневник'],
  psychiatrist: ['🩺', 'Пациенты, сигналы, назначения, документы'],
  psychologist: ['💬', 'Тесты, заключения, кризисные сигналы'],
  admin: ['⚙️', 'Запросы, люди, настройки — без медицинских данных'],
};
app.get('/', (req, res) => {
  // Вошедший попадает к своим страницам, остальные — в окно входа и регистрации; быстрый вход — на /demo.
  if (req.user?.role === 'host') return res.redirect(302, '/demo');
  if (req.user?.id)
    return res.redirect(302, req.user.role === 'patient' ? '/app' : req.user.role === 'admin' ? '/admin' : '/work');
  return res.send(shell({ page: 'P-02', demo: config.demoMode, styles: ['/css/register.css'], body: loginForm() }));
});
// /demo: ведущий (сессия demo_host) попадает на страницу показа ниже, остальные видят быстрый вход по ролям.
app.get('/demo', (req, res, next) => {
  if (!config.demoMode) return res.status(404).send(errorPage({ user: req.user, demo: false }));
  if (req.user?.role === 'host') return next();
  const roleCards = `<div class="roles">${['patient', 'psychiatrist', 'psychologist', 'admin']
    .map(
      (r) =>
        `<button type="button" class="role role-button" data-testid="msg.p01.role.${r}" data-demo-role="${r}"><span class="emo" aria-hidden="true">${ROLE_CARDS[r][0]}</span><span><b>${esc(t(`msg.p01.role.${r}`, r))}</b><small>${esc(t(`msg.p01.role.${r}.desc`, ROLE_CARDS[r][1]))}</small></span></button>`,
    )
    .join(
      '',
    )}</div><section class="demo-entry"><h2 class="sec-h" data-testid="msg.p01.route.title">Маршрут показа</h2><p class="lead">Пройдите по порядку — каждый шаг сам войдёт под нужной ролью.</p>${demoRouteHtml()}</section><p class="auth-links"><button type="button" class="link" data-testid="msg.p01.link.host" data-demo-role="demo_host">Ведущему демонстрации</button> · <a href="/login" data-testid="msg.p01.link.login">К входу</a></p>`;
  res.send(
    shell({
      page: 'P-01',
      demo: config.demoMode,
      body: `<h1 class="kicker" data-testid="msg.p01.title">Clinical Compass</h1><h2 class="big" data-testid="msg.p01.enter">Войти как</h2><p class="lead">Пациент и специалисты попадают сразу в чат.</p>${roleCards}${AUTH_FOOT}`,
    }),
  );
});
app.get('/login', (_req, res) =>
  res.send(shell({ page: 'P-02', demo: config.demoMode, styles: ['/css/register.css'], body: loginForm() })),
);
app.post('/login', (req, res) => {
  const { fail, user } = authenticate(req, res);
  if (fail?.code === 'E-AUTH-BLOCKED') return res.redirect(303, '/blocked');
  if (fail?.application) return res.status(200).send(registration.applicationPage(fail.application));
  if (fail) {
    // Одно общее сообщение: страница не различает неверный пароль, неизвестную почту и временную блокировку.
    return res.status(fail.status).send(
      shell({
        page: 'P-02',
        demo: config.demoMode,
        styles: ['/css/register.css'],
        body: loginForm('<p>Неверная почта или пароль</p>'),
      }),
    );
  }
  const target =
    user.role === 'patient'
      ? req.body.restore_diary === '1'
        ? '/app?tab=diary'
        : '/app'
      : user.role === 'admin'
        ? '/admin'
        : '/work';
  return res.redirect(303, target);
});
app.post('/onboarding/done', (req, res) => {
  if (!req.user) return res.redirect(303, '/login');
  db.prepare('UPDATE user_prefs SET onboarding_done_at=? WHERE user_id=?').run(P.iso(now(config)), req.user.id);
  return res.redirect(303, '/app');
});

app.get('/blocked', (_req, res) => {
  // W-39 (T-245, R-07): на экране блокировки видны причины из списка S-54.
  const reasons = [
    'msg.blocked.reason.list.staff_leave',
    'msg.blocked.reason.list.suspicious',
    'msg.blocked.reason.list.owner_request',
    'msg.blocked.reason.list.rules',
    'msg.blocked.reason.list.other',
  ]
    .map((k) => `<li data-testid="${k}">${esc(t(k))}</li>`)
    .join('');
  return res.send(
    shell({
      page: 'P-02',
      demo: config.demoMode,
      body: `<h1 data-testid="msg.blocked.title">Доступ ограничен</h1><p data-testid="msg.blocked.reason">Обратитесь в клинику</p><ul data-testid="msg.blocked.reasons">${reasons}</ul><a href="tel:112" data-testid="msg.blocked.emergency">Позвонить 112</a>`,
    }),
  );
});
app.get('/password/reset', (_req, res) =>
  res.send(
    shell({
      page: 'P-08',
      demo: config.demoMode,
      body: `<h1 data-testid="msg.reset.title">Сброс пароля</h1><p class="lead">Укажите почту — пришлём ссылку для нового пароля.</p><form id="reset-request-form" class="form"><label>Почта<input data-testid="msg.reset.email" name="email" type="email" autocomplete="email"></label><button class="btn primary wide-btn" data-testid="msg.reset.submit">Отправить</button><p class="sub" data-testid="msg.reset.sent" hidden>Если адрес существует, письмо отправлено</p><p class="small muted">Нет доступа к почте? Попросите администратора клиники сбросить пароль.</p><p class="auth-links"><a href="/login">← Вернуться ко входу</a></p></form>${AUTH_FOOT}`,
    }),
  ),
);
app.get('/password/reset/:token', (req, res) => {
  const tokenRow = db
    .prepare("SELECT 1 FROM password_reset_tokens WHERE token_hash=? AND status='active' AND expires_at>=?")
    .get(P.sha(req.params.token), P.iso(now(config)));
  const invalid = tokenRow ? 'hidden' : '';
  res.send(
    shell({
      page: 'P-08',
      demo: config.demoMode,
      body: `<h1 data-testid="msg.reset.new.title">Новый пароль</h1><form id="reset-confirm-form" data-token="${esc(req.params.token)}"><label>Пароль<input data-testid="msg.reset.new.password" name="password" type="password"></label><label>Повторите пароль<input data-testid="msg.reset.new.repeat" name="password_repeat" type="password"></label><button data-testid="msg.reset.new.submit">Сохранить</button><p data-testid="msg.reset.new.done" hidden>Пароль изменён</p><p data-testid="err.e-reset-token" ${invalid}>Ссылка недействительна</p></form>`,
    }),
  );
});
// Раздел аккаунта: вкладки-«пилюли» как в прототипе (профиль, данные, уведомления, справка, документы).
function accountTabs(user, active) {
  const tabs = [
    ['profile', 'Профиль', '/account'],
    ...(user && user.role === 'patient' ? [['data', 'Мои данные и согласия', '/account/data']] : []),
    ...(user && ['psychiatrist', 'psychologist'].includes(user.role)
      ? [['professional', 'Профессиональный профиль', '/account/professional']]
      : []),
    ['notifications', 'Уведомления', '/account/notifications'],
    ['help', 'Справка', '/account/help'],
    ['legal', 'Документы', '/account/legal'],
  ];
  return `<nav class="sec-tabs" aria-label="Раздел аккаунта">${tabs.map(([k, label, href]) => `<a class="pill${k === active ? ' on' : ''}" href="${href}"${k === active ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav>`;
}
const HELP_FAQ = [
  [
    'Как начать',
    'Чат открыт сразу. Нажмите подсказку над полем — например, лекарство — и задайте вопрос.',
    'msg.help.faq.start',
  ],
  [
    'Что видит ИИ',
    'Только то, что вы прикрепили: чипы в поле ввода — это и есть всё, что уйдёт ИИ.',
    'msg.help.faq.ai',
  ],
  [
    'Кто видит мой чат с ИИ',
    'Только вы. Если сервис заметит опасность, врач увидит короткую фразу и краткую оценку ИИ, но не сам разговор.',
    'msg.help.faq.who_sees',
  ],
  ['Как связаться с врачом', 'Вкладка «Врач». Ответ обычно в течение 2 рабочих дней.', null],
];
app.get('/account/help', (req, res) => {
  const contacts = (() => {
    const list = activeSetting('crisis.contacts').value;
    return Array.isArray(list) ? list : [];
  })();
  const contactsHtml = contacts.length
    ? `<h2 class="sec-h" data-testid="msg.help.contacts.title">Телефоны клиники и доверия</h2><div class="list">${contacts.map((c) => `<a class="li" href="tel:${esc(String(c.phone).replace(/[^+\d]/g, ''))}"><div class="grow"><b>${esc(c.title)}</b><small>${esc(c.phone)}</small></div><span class="go">Позвонить</span></a>`).join('')}</div>`
    : '';
  return res.send(
    shell({
      page: 'P-27',
      user: req.user,
      demo: config.demoMode,
      body: `${req.user ? accountTabs(req.user, 'help') : ''}<a class="help-112" href="tel:112" data-testid="msg.help.call_112">Позвонить 112</a>${req.user?.role === 'patient' ? `<section class="callout" data-testid="msg.help.talk_now.box"><button type="button" class="btn primary" data-crisis-talk data-testid="msg.help.talk_now">${esc(t('msg.help.talk_now'))}</button><p class="small muted">${esc(t('msg.help.talk_now.note'))}</p></section><script src="/js/patient_crisis.js" defer></script>` : ''}<h1 data-testid="msg.help.title">Справка</h1><section class="callout"><h3>Если тяжело прямо сейчас</h3><p>Звоните 112. Чат и сообщения врачу — не срочная помощь.</p></section>${contactsHtml}<div class="list help-faq">${[...HELP_FAQ, ...(req.user?.role === 'patient' ? [[t('msg.help.flower.q'), t('msg.help.flower.a'), 'flower']] : [])].map(([q, a, key]) => `<div class="li"${key === 'flower' ? ' id="flower"' : ''}><div class="grow"><b>${esc(q)}</b><small class="wrap">${esc(a)}</small></div></div>`).join('')}</div><p class="footnote" data-standin>Тексты — заглушки, требуют проверки специалистом.</p>`,
    }),
  );
});

// Документы сервиса (P-09, F-100): списком, тексты — заглушки до юридической проверки.
const LEGAL_DOCS = [
  ['about', 'О программе', 'что сервис делает и чего не делает'],
  ['privacy', 'Политика обработки персональных данных', 'текст и версия'],
  ['agreement', 'Пользовательское соглашение', 'текст и версия'],
  ['cookie', 'Cookie', 'только необходимые'],
  ['org', 'Сведения о медицинской организации', 'заполняются перед боевым запуском'],
];
const legalPage = (req, res) =>
  res.send(
    shell({
      page: 'P-09',
      user: req.user,
      demo: config.demoMode,
      body: `${req.user ? accountTabs(req.user, 'legal') : ''}<h1 data-testid="msg.legal.title">Документы сервиса</h1><div class="list">${LEGAL_DOCS.map(([k, title, sub]) => `<a class="li" href="/legal/${k}"><div class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></div><span class="go">Открыть</span></a>`).join('')}</div><p class="footnote" data-standin>В демо документы — черновики, юрист их не проверял.</p>`,
    }),
  );
app.get('/legal', legalPage);
app.get('/account/legal', legalPage);
app.get('/legal/:kind', (req, res) => {
  const doc = LEGAL_DOCS.find(([k]) => k === req.params.kind);
  if (!doc) return res.status(404).send(errorPage({ user: req.user, demo: config.demoMode }));
  return res.send(
    shell({
      page: 'P-09',
      user: req.user,
      demo: config.demoMode,
      body: `<p class="muted"><a href="/legal">← Документы сервиса</a></p><h1>${esc(doc[1])}</h1><p data-standin class="muted">STAND-IN: текст документа не утверждён юристом. Демо-клиника Т13.</p><section class="card"><p>Здесь будет полный текст документа. В демо-версии он заменён заглушкой и не имеет юридической силы.</p></section>`,
    }),
  );
});

// W-48: библиотека специалиста (F-50, S-50) — тот же опубликованный список, что у
// пациента; пациент переадресуется на свою вкладку /app?tab=library.
app.get('/account/library', (req, res) => {
  if (req.user && req.user.role === 'patient') return res.redirect(302, '/app?tab=library');
  if (req.user && ['psychiatrist', 'psychologist'].includes(req.user.role))
    return res.redirect(302, '/work?tab=library');
  return protectedPage(req, res, ['psychiatrist', 'psychologist'], () => {
    const libKind = libraryRoutes.KIND_TO_MEDIA[String(req.query.kind || '')] ? String(req.query.kind) : '';
    const libQ = String(req.query.q || '')
      .trim()
      .slice(0, 50);
    const libArgs = [req.user.id];
    const libConds = [];
    if (libKind) {
      libConds.push('li.media = ?');
      libArgs.push(libraryRoutes.KIND_TO_MEDIA[libKind]);
    }
    if (libQ) {
      libConds.push('li.id IN (SELECT rowid FROM library_fts WHERE library_fts MATCH ?)');
      libArgs.push(`"${libQ.replace(/"/g, '""')}"`);
    }
    const libWhere = libConds.length ? ` AND ${libConds.join(' AND ')}` : '';
    const items = db
      .prepare(`${libraryRoutes.SELECT_PUBLISHED}${libWhere} ORDER BY li.id LIMIT 100`)
      .all(...libArgs)
      .map(libraryRoutes.toItem);
    return res.send(
      shell({
        page: 'P-15',
        user: req.user,
        demo: config.demoMode,
        body: libraryPage.renderLibrary({ items, q: libQ, kind: libKind, base: '/account/library' }),
      }),
    );
  });
});
app.get('/error/404', (req, res) => res.send(errorPage({ user: req.user, demo: config.demoMode })));
app.get('/robots.txt', (_req, res) =>
  res.type('text/plain').send('User-agent: *\nDisallow: /app\nDisallow: /work\nDisallow: /admin\nDisallow: /account\n'),
);

app.get('/app', (req, res) =>
  protectedPage(req, res, ['patient'], () => {
    const pref = db.prepare('SELECT onboarding_done_at FROM user_prefs WHERE user_id=?').get(req.user.id);
    const tab = String(req.query.tab || 'chat');
    // Статьи переехали в журнал: старые ссылки /app?tab=library&id=N ведут на статью.
    if (tab === 'library' && Number(req.query.id)) return res.redirect(302, `/journal/${Number(req.query.id)}`);
    const pages = {
      chat: 'P-13',
      meds: 'P-12',
      tests: 'P-11',
      diary: 'P-29',
      library: 'P-15',
      visits: 'P-30',
      doctor: 'P-31',
    };
    const diaryPage = require('./modules/diary/page');
    const diary = tab === 'diary' ? diaryPage.render({ t }) : '';
    const replyDays = activeSetting('messages.channel').value?.reply_days || 2;
    // W-40: в период замещения пациент видит, кто его ведёт (F-87, T-214).
    const substitution = substitutionService.activeForPatient(req.user.id);
    const substitutionNote = substitution
      ? `<p data-testid="msg.doctor.substitution">${esc(substitution.absent_name)} в отпуске до ${esc(substitution.date_to)}, вас ведёт ${esc(substitution.substitute_name)}.</p>`
      : '';
    const doctor = `<section class="chat-tab doctor-tab"><div class="pane"><div class="dhead"><span class="avatar-sm" data-doctor-avatar>·</span><div class="who"><h1 data-testid="msg.doctor.header">Связь со специалистом</h1><small class="muted" data-doctor-role></small></div><span data-doctor-pick></span><a class="btn sm" href="/app?tab=visits" data-testid="msg.nav.patient.visits"><svg class="i i--16" aria-hidden="true" focusable="false"><use href="/icons.svg#i-calendar-blank"/></svg>${esc(t('msg.nav.patient.visits'))}</a></div>${substitutionNote}<div class="scroll" tabindex="0" role="region" aria-label="Сообщения специалисту"><div class="col feed"><div id="v3-doctor"></div></div></div><div class="dock"><div class="col"><div class="chat-input"><textarea data-testid="msg.doctor.placeholder" rows="2" placeholder="Сообщение врачу" aria-label="Сообщение врачу"></textarea><button type="button" data-testid="msg.composer.send">Отправить</button></div><p class="footnote" data-testid="msg.doctor.channel">Не срочно: ответ обычно в течение ${replyDays} рабочих дней. Если тяжело — 112.</p><p data-testid="msg.shell.offline" hidden>Нет сети. Повторить</p></div></div></div></section><script src="/js/mic.js" defer></script>`;
    const aeFlow = req.query.flow === 'ae';
    const meds = aeFlow
      ? `<section class="pt-form"><p class="pt-back"><a class="btn sm" href="/app?tab=meds"><svg class="i i--16" aria-hidden="true" focusable="false"><use href="/icons.svg#i-arrow-left"/></svg>${esc(t('msg.pt.back_to_meds'))}</a></p><h1>Плохо переношу препарат</h1><div id="v3-ae" class="card"></div></section>`
      : `<section class="chat-tab meds-tab"><aside class="side" aria-label="${esc(t('msg.meds.side'))}"><div class="side-head"><button type="button" class="new" data-meds-add>${esc(t('msg.meds.side.add'))}</button></div><h4>${esc(t('msg.meds.now'))}</h4><div data-meds-now></div><h4 data-meds-past-h hidden>${esc(t('msg.meds.past'))}</h4><div data-meds-past></div></aside><div class="pane"><div class="scroll"><div class="col"><h1>${esc(t('msg.nav.patient.meds'))}</h1><p data-standin>Справочник лекарств — STAND-IN, требует клинического ревью.</p><div id="v2-meds"></div></div></div></div></section>`;
    const testsRun = Boolean(req.query.run);
    // Без боковой панели: сверху методики самопомощи с картинками, ниже тесты двумя группами («Назначено врачом» и
    // «Можно пройти без врача»), затем недавние результаты. Во время прохождения теста на странице только он.
    const tests = testsRun
      ? `<section class="chat-tab tests-tab"><div class="pane"><div class="scroll"><div class="col tests-col"><h1>Методики</h1><div id="v2-tests"></div></div></div></div></section>`
      : `<section class="chat-tab tests-tab"><div class="pane"><div class="scroll"><div class="col tests-col"><h1>Методики</h1><div class="seg seg--sm segmented tests-tabs" id="tests-tabs" role="group" aria-label="Раздел методик"><button type="button" data-ttab="exercises" aria-pressed="true">Упражнения</button><button type="button" data-ttab="tests" aria-pressed="false">Тесты</button></div><div id="tests-notice"></div>${techniques.section('', { compact: true })}<section class="tech-section tests-block" id="tests" aria-label="Тесты" hidden><p class="tests-intro">Тесты помогают вам и специалисту видеть, как меняется самочувствие. Это не диагноз.</p><div class="tests-groups"><div class="tests-group" id="tests-assigned"></div><div class="tests-group" id="v2-tests"></div></div></section></div></div></div></section>`;
    // W-34: чат пациента P-13 — шаблон прототипа v5; без ИИ-согласия поле заменяет строка (T-415).
    const aiConsent = db
      .prepare("SELECT action FROM consent_current WHERE user_id=? AND consent_kind='ai'")
      .get(req.user.id);
    const aiOff = !aiConsent || aiConsent.action !== 'given';
    // Возврат в тот же чат: вернулись на вкладку в пределах окна давности — открывается последний тред, а не пустой экран.
    // «Новый чат» ведёт на /app?tab=chat&new=1, ссылки с ask/thread/flow не перенаправляются.
    if (tab === 'chat' && !aiOff && Object.keys(req.query).every((k) => k === 'tab')) {
      const resume = chatResume.activeThread(db, req.user.id, now(config).getTime());
      if (resume) return res.redirect(302, `/app?tab=chat&thread=${resume.id}`);
    }
    const chatThreads = aiOff
      ? []
      : db
          .prepare(
            "SELECT id, title, updated_at FROM ai_threads WHERE owner_user_id=? AND purpose='patient_assistant' AND hidden_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 30",
          )
          .all(req.user.id);
    const todayIso = P.iso(now(config)).slice(0, 10);
    const chatToday = [];
    const chatEarlier = [];
    for (const th of chatThreads)
      (String(th.updated_at || '').slice(0, 10) === todayIso ? chatToday : chatEarlier).push(th);
    const chat = patientChatPage.render({
      t,
      aiOff,
      today: chatToday,
      earlier: chatEarlier,
      reminders: req.reminders || [],
      pausedUntil: app.locals.chatConduct
        ? (app.locals.chatConduct.activeBlock(req.user.id) || {}).blocked_until || null
        : null,
    });
    const visits = `<section class="chat-tab visits-tab"><aside class="side" aria-label="Визиты"><div data-visits-side></div></aside><div class="pane"><div class="scroll"><div class="col"><p class="pt-back"><a class="btn sm" href="/app?tab=doctor"><svg class="i i--16" aria-hidden="true" focusable="false"><use href="/icons.svg#i-arrow-left"/></svg>${esc(t('msg.nav.patient.doctor'))}</a></p><h1>Визиты</h1><div id="v3-visits"></div></div></div></div></section>`;
    const standin = `<h1>${esc(t(`msg.nav.patient.${tab}`, tab))}</h1><p data-standin>STAND-IN</p>`;
    // W-48: «Библиотека» пациента — аудио и видео (S-50). Статьи живут в журнале (/journal).
    const libKind = libraryRoutes.KIND_TO_MEDIA[String(req.query.kind || '')] ? String(req.query.kind) : '';
    const libQ = String(req.query.q || '')
      .trim()
      .slice(0, 50);
    const libConds = ["li.media <> 'read'"];
    const libArgs = [req.user.id];
    if (libKind) {
      libConds.push('li.media = ?');
      libArgs.push(libraryRoutes.KIND_TO_MEDIA[libKind]);
    }
    if (libQ) {
      libConds.push('li.id IN (SELECT rowid FROM library_fts WHERE library_fts MATCH ?)');
      libArgs.push(`"${libQ.replace(/"/g, '""')}"`);
    }
    const libItems = db
      .prepare(`${libraryRoutes.SELECT_PUBLISHED} AND ${libConds.join(' AND ')} ORDER BY li.id LIMIT 100`)
      .all(...libArgs)
      .map(libraryRoutes.toItem);
    const libraryHtml = `<p class="sub"><a href="/journal" data-testid="msg.library.to_journal">${esc(t('msg.library.to_journal'))}</a></p>${libraryPage.renderLibrary({ items: libItems, q: libQ, kind: libKind })}`;
    res.send(
      shell({
        page: aeFlow ? 'P-14' : pages[tab] || 'P-13',
        styles: tab === 'diary' ? diaryPage.styles : [],
        scripts: tab === 'diary' ? diaryPage.scripts : [],
        layout:
          (tab === 'chat' && !aiOff) ||
          tab === 'doctor' ||
          (['meds', 'tests', 'visits', 'diary'].includes(tab) && !aeFlow)
            ? 'app'
            : '',
        user: req.user,
        demo: config.demoMode,
        onboarding: !pref?.onboarding_done_at,
        body:
          tab === 'diary'
            ? diary
            : tab === 'doctor'
              ? doctor
              : tab === 'meds'
                ? meds
                : tab === 'tests'
                  ? tests
                  : tab === 'chat'
                    ? chat
                    : tab === 'visits'
                      ? visits
                      : tab === 'library'
                        ? libraryHtml
                        : standin,
      }),
    );
  }),
);

// «Ещё» специалиста: остальные разделы рабочего пространства.
function workMorePage() {
  const items = [
    ['/work?tab=tools', 'msg.nav.clinician.more.tools', 'Назначить опросники и пакеты пациентам'],
    ['/notifications', 'msg.notifications.title', 'Что нового по пациентам'],
    ['/account', 'msg.profile.title', 'Пароль и сеансы'],
  ];
  return `<h1>Ещё</h1><section class="more-list">${items
    .map(
      ([href, key, hint]) =>
        `<a class="more-item" href="${href}"><b>${esc(t(key, key))}</b><span class="muted">${esc(hint)}</span></a>`,
    )
    .join('')}</section>`;
}

// P-23: вкладка «Шаблоны и документы» — личные шаблоны текстов врача (список слева, текст по центру, кнопка «ИИ» внизу);
// клиентская часть — public/js/work_docs.js, API — src/ai/workspace/templatesApi.js.
function workDocsPage(user, patients) {
  return require('./modules/templates/work_page').render(patients, { documents: user.role === 'psychiatrist' });
}

// Пациенты специалиста: список слева, карточка справа (раскладка прототипа v5, P-18/P-19).
const initials = (name) =>
  String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase() || '·';
function patientsSplit({ user, patients, selected = null, ptab = 'overview' }) {
  const rows = patients
    .map(
      (p) =>
        `<a class="pi p-row${selected && selected.id === p.id ? ' on' : ''}" href="/work/patients/${p.id}" data-id="${p.id}"${selected && selected.id === p.id ? ' aria-current="true"' : ''}><span class="avatar-sm ava">${esc(initials(p.full_name))}</span><span class="grow p-meta"><b>${esc(p.full_name)}</b><small class="st" data-last>Загружаем…</small></span><time data-when></time><span class="dotc n" data-dot aria-label="Нет данных"></span></a>`,
    )
    .join('');
  const list = `<aside class="plist" aria-label="Пациенты"><label class="search"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-magnifying-glass"/></svg><input data-testid="msg.patients.search" type="search" placeholder="Поиск по вашим пациентам" aria-label="Поиск по вашим пациентам"></label><div class="filters"><button type="button" class="pill on" data-filter="all">Все</button><button type="button" class="pill" data-filter="signal">С сигналом</button><button type="button" class="pill" data-filter="visit">Визит скоро</button><button type="button" class="pill" data-filter="archive">Архив</button></div><div class="items" data-items>${rows || '<p class="muted small pad">Пока нет закреплённых пациентов</p>'}</div></aside>`;
  let card =
    '<div class="pcard empty-card"><div class="empty"><svg class="i i--32" aria-hidden="true" focusable="false"><use href="/icons.svg#i-users"/></svg><b>Выберите пациента</b><p>слева — список ваших пациентов, справа появится карточка</p></div></div>';
  if (selected) {
    const tabs = [
      'overview',
      ...(user.role === 'psychiatrist' ? ['treatment'] : []),
      'tests',
      'diary',
      'messages',
      'docs',
    ];
    const tabLinks = tabs
      .map(
        (tab) =>
          `<a class="pill${tab === ptab ? ' on' : ''}" data-testid="msg.card.tab.${tab}" href="?ptab=${tab}"${tab === ptab ? ' aria-current="page"' : ''}>${esc(t(`msg.card.tab.${tab}`, tab))}</a>`,
      )
      .join('');
    card = `<div class="pcard"><div class="phead"><a class="back link" href="/work?tab=patients"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-caret-left"/></svg><span>${esc(t('msg.card.back', 'Пациенты'))}</span></a><div class="phead-main"><span class="avatar-sm ava ava--lg">${esc(initials(selected.full_name))}</span><div class="grow"><h1>${esc(selected.full_name) || 'Карточка пациента'}</h1><div class="st-line" data-pstatus></div></div></div><div class="btn-row phead-act"><a class="btn primary btn-sm sm" data-testid="msg.card.write" href="?ptab=messages">${esc(t('msg.card.write', 'Написать'))}</a><a class="btn sm" href="/work?tab=chat&p=${selected.id}"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-sparkle"/></svg><span class="lbl">Спросить ИИ</span></a><span class="menu-wrap"><button type="button" class="round round--sm" data-testid="msg.card.menu" aria-haspopup="true" aria-label="Ещё действия" data-card-menu-btn><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-dots-three-vertical"/></svg></button><div class="menu card-menu" data-card-menu hidden><a href="/account#vacation" data-testid="msg.card.menu.vacation">Передать коллеге на время отпуска</a>${user.role === 'psychiatrist' ? '<button type="button" class="danger" data-testid="msg.card.menu.archive" data-archive-open>Завершить наблюдение</button>' : ''}</div></span></div></div><nav class="seg seg--sm ptabs" aria-label="Разделы карточки">${tabLinks}</nav><div class="scroll"><div class="pbody"><div class="ae-bar"${user.role === 'psychiatrist' ? '' : ' hidden'}><button type="button" class="btn sm" data-testid="msg.ae.clinician.add" data-ae-open aria-expanded="false"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-plus"/></svg><span class="lbl">${esc(t('msg.ae.clinician.add', 'Нежелательное явление'))}</span></button></div><div id="v2-card" data-patient-id="${selected.id}" data-tab="${esc(ptab)}"></div></div></div></div>`;
  }
  return `<section class="split ${selected ? 'has-p' : 'no-p'}">${list}${card}</section>`;
}

app.get('/work', (req, res) =>
  protectedPage(req, res, ['psychiatrist', 'psychologist'], () => {
    const tab = String(req.query.tab || 'chat');
    const pages = {
      chat: 'P-20',
      patients: 'P-18',
      signals: 'P-22',
      docs: 'P-23',
      tools: 'P-21',
      analytics: 'P-24',
      library: 'P-15',
    };
    const patients = db
      .prepare(
        "SELECT u.id,u.full_name FROM care_assignments ca JOIN users u ON u.id=ca.patient_id WHERE ca.clinician_id=? AND ca.ended_at IS NULL AND COALESCE(ca.end_reason,'')<>'signal_only' ORDER BY u.full_name",
      )
      .all(req.user.id);
    const patientList = patientsSplit({ user: req.user, patients });
    const tools = `<section class="chat-tab tools-tab"><div class="pane"><div class="scroll"><div class="col"><h1>Методики</h1><p class="lead">Методики для самопомощи, которые пациенты видят сразу, и тесты, которые вы назначаете.</p>${techniques.section('Эти методики сразу доступны всем пациентам во вкладке «Методики», назначать их не нужно: рекомендуйте по ситуации.')}<div id="work-tools" data-patients="${encodeURIComponent(JSON.stringify(patients.map((p) => ({ id: p.id, name: p.full_name }))))}"><p class="muted">Загружаю…</p></div><h2 class="sec-h" id="offline">Внести очный результат</h2><section class="card" aria-labelledby="offline"><p class="sub">Шкала, выбранная выше в «Тестах для назначения», откроется пустой — отметьте ответы пациента с приёма, и результат сохранится в его карточке. Для бумажного бланка (в том числе с рисунком или письмом от руки) — «Фото бланка»: снимок сохранится в карточке пациента.</p><div class="acts"><button type="button" class="btn primary" data-testid="msg.nav.clinician.more.offline" data-offline-open>Заполнить бланк</button><label class="btn file-btn">Фото бланка<input type="file" data-testid="msg.composer.attach.photo" accept="image/jpeg,image/png,application/pdf" hidden></label></div><div id="offline-form"></div><div id="v2-offline"></div></section></div></div></div></section>`;
    // W-41: ответственный по фармаконадзору S-27 — действующее значение сразу (T-189).
    const pv = activeSetting('pv.responsible').value || {};
    const pvWho = pv && pv.name ? `${pv.name}${pv.contact ? `, ${String(pv.contact)}` : ''}` : '';
    const pvLine = pvWho
      ? `<p data-testid="msg.ae.pv_responsible">${esc(t('msg.ae.pv_responsible').replace('{who}', pvWho))}</p>`
      : `<p data-testid="msg.ae.pv_responsible.empty" data-standin>${esc(t('msg.ae.pv_responsible.empty'))}</p>`;
    const signals = `<section class="work-page signals-page"><div class="scroll"><div class="work-wrap"><h1>Сигналы</h1><div class="sig-guide"><p>Сюда попадает всё, на что специалист должен отреагировать. Сигналы бывают двух видов:</p><ul><li><b>Кризис.</b> Пациент написал фразу о нежелании жить или об опасности. Нужно срочно связаться с человеком.</li>${req.user.role === 'psychiatrist' ? '<li><b>Побочный эффект.</b> Пациент пожаловался, что ему хуже после лекарства. Нужно решить, связано ли это с препаратом.</li>' : ''}</ul><p class="muted small">Обработанный сигнал уходит во вкладку «Обработанные».</p></div><div class="sub-line">${pvLine}</div><div id="v3-signals" data-can-ae="${req.user.role === 'psychiatrist' ? '1' : '0'}"></div></div></div></section>`;
    res.send(
      shell({
        page: pages[tab] || 'P-20',
        layout: ['chat', 'patients', 'docs', 'library', 'signals', 'tools', 'analytics'].includes(tab) ? 'app' : '',
        user: req.user,
        demo: config.demoMode,
        body:
          tab === 'patients'
            ? patientList
            : tab === 'tools'
              ? tools
              : tab === 'signals'
                ? signals
                : tab === 'analytics'
                  ? `<section class="chat-tab analytics-tab"><aside class="side" aria-label="Аналитика"><div data-analytics-side></div></aside><div class="pane"><div class="scroll"><div class="col"><h1>Аналитика</h1><div id="work-analytics" data-research="${req.user.flag_research ? '1' : '0'}" data-patients="${encodeURIComponent(JSON.stringify(patients.map((p) => ({ id: p.id, name: p.full_name }))))}"><p class="muted">Загружаю…</p></div></div></div></div></section>`
                  : tab === 'more'
                    ? workMorePage()
                    : tab === 'library'
                      ? libraryWorkPage.render(req.user)
                      : tab === 'docs'
                        ? workDocsPage(req.user, patients)
                        : tab === 'chat'
                          ? workChatPage.render({
                              t,
                              patients: patients.map((p) => ({ id: p.id, name: p.full_name })),
                              isPsychiatrist: req.user.role === 'psychiatrist',
                              hintsEnabled: Boolean(
                                db.prepare('SELECT hints_enabled FROM user_prefs WHERE user_id=?').get(req.user.id)
                                  ?.hints_enabled,
                              ),
                            })
                          : '<h1 data-testid="msg.nav.clinician.patients">Рабочее пространство</h1><p data-standin>STAND-IN</p>',
      }),
    );
  }),
);
// Пустой бланк теста для печати: специалист даёт его пациенту заполнить вручную.
app.get('/print/test/:code', (req, res) =>
  protectedPage(req, res, ['psychiatrist', 'psychologist'], () => {
    const code = String(req.params.code || '').slice(0, 60);
    const row = db.prepare('SELECT title FROM instruments WHERE code=?').get(code);
    const preview = row && require('./modules/clinical/instruments/preview').preview(db, code);
    if (!preview || !preview.questions.length)
      return res.status(404).send(errorPage({ user: req.user, demo: config.demoMode }));
    res.set('Cache-Control', 'no-store');
    return res.send(require('./modules/print/testSheet').render({ title: row.title || code, preview }));
  }),
);
app.get('/methods/:slug', (req, res) =>
  protectedPage(req, res, ['patient', 'psychiatrist', 'psychologist'], () => {
    const technique = techniques.bySlug(req.params.slug);
    if (!technique) return res.status(404).send(errorPage({ user: req.user, demo: config.demoMode }));
    const patient = req.user.role === 'patient';
    return res.send(
      shell({
        page: patient ? 'P-11' : 'P-21',
        title: technique.title,
        user: req.user,
        demo: config.demoMode,
        body: techniques.page(technique, patient ? '/app?tab=tests' : '/work?tab=tools', patient),
        styles: ['/techniques.css'],
        scripts: ['/techniques.js'],
      }),
    );
  }),
);
app.get('/work/approvals', (req, res) =>
  protectedPage(req, res, ['psychiatrist', 'psychologist'], () =>
    res.send(
      shell({
        page: 'P-51',
        layout: 'app',
        user: req.user,
        demo: config.demoMode,
        body: approvalsPage.render({
          t,
          items: settings.approvalsList().map((a) => ({
            ...a,
            author_name: a.author ? db.prepare('SELECT full_name FROM users WHERE id=?').get(a.author)?.full_name : '',
          })),
        }),
      }),
    ),
  ),
);
const ADMIN_TABS = {
  dashboard: ['P-34', 'Обзор'],
  requests: ['P-35', 'Запросы'],
  people: ['P-36', 'Люди'],
  settings: ['P-38', 'Настройки'],
  log: ['P-47', 'Аудит'],
  more: ['P-34', 'Ещё'],
  content: ['P-52', 'Контент'],
  program: ['P-48', 'Программа'],
  analytics: ['P-48', 'Аналитика'],
  service: ['P-49', 'Сервис'],
};
app.get('/admin', (req, res) =>
  protectedPage(req, res, ['admin'], () => {
    // Чата администратора больше нет: старые ссылки ведут на обзор.
    if (req.query.tab === 'chat') return res.redirect(302, '/admin');
    const tab = ADMIN_TABS[String(req.query.tab || 'dashboard')] ? String(req.query.tab || 'dashboard') : 'dashboard';
    const sub = String(req.query.s || '');
    const [pageId, title] = ADMIN_TABS[tab];
    res.send(
      shell({
        page:
          sub === 'ai' && tab === 'settings'
            ? 'P-39'
            : sub === 'prompt' && tab === 'settings'
              ? 'P-40'
              : sub === 'drug_review' && tab === 'content'
                ? 'P-52'
                : pageId,
        user: req.user,
        demo: config.demoMode,
        styles: tab === 'dashboard' ? ['/css/dashboard.css'] : tab === 'requests' ? ['/css/register.css'] : [],
        scripts:
          tab === 'dashboard' ? ['/js/admin_dashboard.js'] : tab === 'requests' ? ['/js/admin_staff_apps.js'] : [],
        body: `<div class="adm-head"><div><h1 data-testid="msg.admin.shell.title">${esc(title)}</h1><p class="sub">${esc(t(`msg.admin.sub.${tab}`, ''))}</p></div></div>${tab === 'requests' ? '<section id="staff-apps" class="staff-apps" aria-labelledby="staff-apps-h"></section>' : ''}<div id="admin-app" data-tab="${esc(tab)}" data-s="${esc(sub)}" data-me="${Number(req.user.id)}" data-prompt-keys="${esc(require('./ai/registry').PROMPT_KEYS.join(','))}"><p class="muted">Загружаю…</p></div><script src="/js/admin_invites.js" defer></script><script src="/admin.js" defer></script>`,
      }),
    );
  }),
);
app.get('/account', (req, res) =>
  protectedPage(req, res, ['patient', 'psychiatrist', 'psychologist', 'admin'], () => {
    const clinician = ['psychiatrist', 'psychologist'].includes(req.user.role);
    const patient = req.user.role === 'patient';
    res.send(
      shell({
        page: 'P-17',
        user: req.user,
        demo: config.demoMode,
        body: `${accountTabs(req.user, 'profile')}<h1 data-testid="msg.profile.title">Профиль и безопасность</h1>
<div id="acc-profile" data-role="${esc(req.user.role)}" data-name="${esc(req.user.full_name || '')}" data-email="${esc(req.user.email || '')}">
  <section class="card acc-block"><h3>Основное</h3><div class="li"><div class="grow"><b>Имя</b><small>${esc(req.user.full_name || '—')}</small></div></div><div class="li"><div class="grow"><b>Почта</b><small>${esc(req.user.email || '—')}</small></div><span class="soon" title="Интерфейс готов, серверная часть в работе">смена почты — скоро</span></div></section>
  <section class="card acc-block"><h3>Пароль</h3><div class="row-fields"><label>Текущий пароль<input data-testid="msg.profile.current_password" type="password" autocomplete="current-password"></label><label>Новый пароль<input data-testid="msg.profile.new_password" type="password" autocomplete="new-password"></label><label>Повторите пароль<input data-testid="msg.profile.repeat_password" type="password" autocomplete="new-password"></label></div><div class="acts"><button class="btn primary" data-testid="msg.profile.save_password" type="button">Сохранить пароль</button></div><p class="sub" data-testid="msg.profile.password_changed" hidden>Пароль изменён. На других устройствах нужно войти заново.</p></section>
  <section class="card acc-block"><h3 data-testid="msg.profile.sessions">Активные сеансы</h3><div class="list" data-sessions tabindex="0" role="region" aria-label="Активные сеансы"><p class="muted small">Загружаем…</p></div><div class="acts"><button class="btn" data-testid="msg.profile.logout_all" type="button">Выйти на всех устройствах</button></div></section>
  ${patient ? '<section class="card acc-block" data-doctor-block><h3>Ваш врач</h3><div class="li"><div class="grow"><b data-doctor-name>—</b><small data-doctor-role></small></div><button class="btn" data-testid="msg.profile.change_doctor" type="button">Попросить сменить</button></div><section class="change-doctor" hidden><label>Причина — необязательно. Её увидит только администратор.<textarea data-testid="msg.profile.change_doctor.reason"></textarea></label><div class="acts"><button class="btn primary" data-testid="msg.profile.change_doctor.send" type="button">Отправить просьбу</button></div><p class="sub" data-testid="msg.profile.change_doctor.sent" hidden>Просьба отправлена. Пока всё работает как раньше.</p></section></section>' : ''}
  ${clinician ? `<section class="card acc-block"><h3>Работа</h3>${req.user.role === 'psychiatrist' ? '<div class="li"><div class="grow"><b>Подсказки ИИ: гипотезы с источниками</b><small>Можно выключить, если не нужны</small></div><button type="button" class="switch" role="switch" aria-checked="false" data-testid="msg.profile.hints" aria-label="Подсказки ИИ"></button></div>' : ''}<div class="li" data-vacation id="vacation"><div class="grow"><b>Отпуск</b><small>Передать пациентов коллеге на время отпуска</small></div><button type="button" class="btn" data-testid="msg.profile.vacation" data-vac-open>Оформить</button></div><div class="vac-form" hidden><div class="row-fields"><label>Кто замещает<select data-testid="msg.profile.vacation.who" data-vac-who></select></label><label>С<input type="date" data-testid="msg.profile.vacation.from" data-vac-from></label><label>По<input type="date" data-testid="msg.profile.vacation.to" data-vac-to></label></div><div class="acts"><button type="button" class="btn primary" data-testid="msg.profile.vacation.send" data-vac-send>Отправить на подтверждение</button></div><p class="sub" data-testid="msg.profile.vacation.waiting" data-vac-waiting hidden>Ждёт подтверждения администратора</p><p class="sub" data-vac-out aria-live="polite"></p></div></section>` : ''}
  <section class="card acc-block"><h3>Второй фактор входа</h3><div class="li"><div class="grow"><b>Подтверждение кодом</b><small>${req.user.role === 'admin' ? 'для администраторов — включается настройкой сервиса' : 'дополнительная защита входа'}</small></div><span class="soon" title="Интерфейс готов, серверная часть в работе">скоро</span></div></section>
</div><script src="/account.js" defer></script>${patient ? '<script src="/js/care_links.js" defer></script>' : ''}`,
      }),
    );
  }),
);
app.get('/account/professional', (req, res) =>
  protectedPage(req, res, ['psychiatrist', 'psychologist'], () =>
    res.send(
      shell({
        page: 'P-17',
        user: req.user,
        demo: config.demoMode,
        body: `${accountTabs(req.user, 'professional')}<h1 data-testid="msg.profile.professional.title">Профессиональный профиль</h1><p class="lead">Необязательно. Специальность, место работы, журналы и конференции помогают сервису рассказывать, как устроена работа с пациентами. Сервис не требует эти данные и ничего не блокирует, если они не заполнены.</p><div id="clin-profile"><p class="muted">Загружаю…</p></div><script src="/js/clinician_profile.js" defer></script>`,
      }),
    ),
  ),
);
app.get('/account/data', (req, res) =>
  protectedPage(req, res, ['patient'], () =>
    res.send(
      shell({
        page: 'P-16',
        user: req.user,
        demo: config.demoMode,
        body: `${accountTabs(req.user, 'data')}<h1 data-testid="msg.mydata.title">Мои данные и согласия</h1><p class="lead">Что о вас хранится, кто это видел и что можно сделать.</p><div id="my-data"><p class="muted">Загружаю…</p></div><script src="/account.js" defer></script><script src="/js/care_links.js" defer></script>`,
      }),
    ),
  ),
);
const notificationPage = (req, res) =>
  protectedPage(req, res, ['patient', 'psychiatrist', 'psychologist', 'admin'], () =>
    res.send(
      shell({
        page: 'P-32',
        user: req.user,
        demo: config.demoMode,
        body: `${accountTabs(req.user, 'notifications')}<h1 data-testid="msg.notifications.title">Уведомления</h1><div class="acts head-acts"><button class="btn" data-testid="msg.notifications.read_all" type="button">Прочитать все</button></div><div id="acc-notes" class="list"><p class="muted small">Загружаем…</p></div>${req.user.role === 'patient' ? '<h2 class="sec-h">Напоминания</h2><div class="list" id="acc-reminders"></div><h2 class="sec-h">Цветок и тёплые слова</h2><div class="list" id="acc-flower"></div>' : ''}<p class="footnote">Уведомления приходят сюда и, если включить пуши на устройстве, коротким «Есть напоминание» — без SMS и писем. Хранятся 90 дней.</p><script src="/js/push.js" defer></script><script src="/account.js" defer></script>`,
      }),
    ),
  );
app.get('/notifications', notificationPage);
app.get('/account/notifications', notificationPage);
// Маршрут показа (P-26): шаги с входом под нужной ролью; переход выполняет public/views.js.
const SHOW_ROUTE = [
  ['patient', '/app?tab=chat', 'Пациент', 'Чат с ИИ-помощником: поддержка, вопросы о лекарствах и тестах'],
  ['patient', '/app?tab=diary', 'Пациент', 'Дневник настроения: запись за минуту, график и история'],
  ['patient', '/app?tab=tests', 'Пациент', 'Тесты: назначенные врачом и самостоятельные, динамика результатов'],
  ['patient', '/app?tab=meds', 'Пациент', 'Лекарства: план от врача и «Принять», когда куплено'],
  ['patient', '/app?tab=visits', 'Пациент', 'Визиты и анкета перед приёмом'],
  ['patient', '/account/data', 'Пациент', 'Мои данные: кто смотрел, выгрузка, удаление аккаунта'],
  ['psychiatrist', '/work?tab=patients', 'Психиатр', 'Список пациентов со «светофором» и динамикой'],
  ['psychiatrist', '/work?tab=signals', 'Психиатр', 'Сигналы безопасности и побочные эффекты'],
  ['psychiatrist', '/work?tab=chat', 'Психиатр', 'ИИ-чат специалиста: выбор пациента через «@»'],
  ['psychiatrist', '/work?tab=docs', 'Психиатр', 'Документы: черновик из данных пациента, экспорт PDF/DOCX/TXT'],
  ['psychiatrist', '/work?tab=analytics', 'Психиатр', 'Аналитика по своим пациентам'],
  ['psychologist', '/work?tab=docs', 'Психолог', 'Заключения психолога'],
  ['admin', '/admin', 'Администратор', 'Обзор (полная админка на паузе)'],
];
function demoRouteHtml() {
  return `<ol class="show-route">${SHOW_ROUTE.map(([role, url, who, text]) => `<li><button type="button" class="route-step" data-route-role="${role}" data-route-url="${esc(url)}"><b>${esc(who)}</b><span>${esc(text)}</span></button></li>`).join('')}</ol>`;
}
app.get('/demo', (req, res) => {
  if (!config.demoMode) return res.status(404).send(errorPage({ demo: false }));
  return protectedPage(req, res, ['host'], () =>
    res.send(
      shell({
        page: 'P-26',
        user: req.user,
        demo: true,
        body: `<div class="adm-head"><div><h1 data-testid="msg.host.route.title">Показ</h1><p class="sub">${esc(t('msg.host.route.sub', 'Шаги показа по ролям: нажмите шаг, и сервис войдёт под нужной ролью'))}</p></div></div><div class="adm-stack host-steps"><section class="card">${demoRouteHtml()}</section><section class="card host-reset"><div><h2>${esc(t('msg.host.data.title', 'Демо-данные'))}</h2><p>${esc(t('msg.host.data.lead', 'Вернуть демо-данные к исходному состоянию перед новым показом'))}</p></div><button type="button" class="btn danger" data-testid="msg.host.data.reset">${esc(t('msg.host.data.reset', 'Сбросить демо-данные'))}</button></section></div><dialog id="demo-reset"><h3>${esc(t('msg.host.reset.title', 'Сбросить демо-данные?'))}</h3><p data-testid="msg.host.reset.sessions_warning">${esc(t('msg.host.reset.sessions_warning', 'Все активные демо-сеансы будут завершены.'))}</p><div class="acts"><form method="dialog"><button type="submit" class="btn ghost">${esc(t('msg.host.reset.cancel', 'Не сбрасывать'))}</button></form><button type="button" class="btn primary" data-testid="msg.host.reset.confirm">${esc(t('msg.host.reset.confirm', 'Сбросить'))}</button></div></dialog><p data-testid="msg.host.reset.done" hidden>${esc(t('msg.host.reset.done', 'Демо-данные сброшены'))}</p>`,
      }),
    ),
  );
});
app.get('/work/patients/:id', (req, res) =>
  protectedPage(req, res, ['psychiatrist', 'psychologist'], () => {
    const own = isFullyAssigned(db, Number(req.params.id), req.user.id);
    if (!own) return res.status(404).send(errorPage({ user: req.user, demo: config.demoMode }));
    const patients = db
      .prepare(
        "SELECT u.id,u.full_name FROM care_assignments ca JOIN users u ON u.id=ca.patient_id WHERE ca.clinician_id=? AND ca.ended_at IS NULL AND COALESCE(ca.end_reason,'')<>'signal_only' ORDER BY u.full_name",
      )
      .all(req.user.id);
    const selected = db.prepare('SELECT id,full_name FROM users WHERE id=?').get(Number(req.params.id));
    return res.send(
      shell({
        page: 'P-19',
        user: req.user,
        demo: config.demoMode,
        layout: 'app',
        scripts: ['/js/ae_wizard.js', '/js/ae_clinician.js'],
        body: patientsSplit({ user: req.user, patients, selected, ptab: String(req.query.ptab || 'overview') }),
      }),
    );
  }),
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return P.sendError(req, res, 404, 'E-NOT-FOUND');
  return res.status(404).send(errorPage({ user: req.user, demo: config.demoMode }));
});

// Необработанная ошибка: ответ в формате API вместо HTML Express и запись в журнал (стандартный
// обработчик Express в NODE_ENV=test молчит). Текст ошибки пишем только для SQLite: в сообщениях
// JSON.parse и прочих бывает кусок данных пациента.
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') return P.sendError(req, res, 422, 'E-VALIDATION');
  if (error.type === 'entity.too.large') return P.sendError(req, res, 413, 'E-FILE-SIZE');
  console.error(
    JSON.stringify({
      event: 'http.error',
      method: req.method,
      route: req.route?.path || null,
      name: error.name,
      code: error.code || null,
      ...(error.name === 'SqliteError' ? { message: error.message } : {}),
      at:
        String(error.stack || '')
          .split('\n')[1]
          ?.trim() || null,
    }),
  );
  if (res.headersSent) return undefined;
  return P.sendError(req, res, 500, 'E-INTERNAL');
});

const mailer = nodemailer.createTransport({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpSecure,
  disableFileAccess: true,
  disableUrlAccess: true,
  name: 'clinical-compass.local',
});

function smtpSend(to, text) {
  return mailer.sendMail({ from: config.mailFrom, to, subject: 'Сброс пароля', text });
}

let jobRunning = false;
const patientPush = require('./modules/patient/push').createPush({ db, config, now: () => now(config) });
app.locals.push = patientPush;

async function jobs() {
  if (jobRunning) return;
  jobRunning = true;
  try {
    const current = now(config);
    const currentIso = P.iso(current);
    try {
      queueService.returnExpiredToQueue(); // W-38: возврат взятых и не закрытых запросов по сроку S-63
      substitutionService.endExpired(); // W-40: замещение — по окончании периода доступ пропадает (T-214)
    } catch (_) {
      /* сбой возврата не останавливает остальные задачи планировщика */
    }
    require('./jobs/aiRetention').runPurge({ db, nowIso: () => currentIso }); // W-30: стирание ИИ-тредов старше S-23
    // Резервная копия базы раз в сутки; идёт в фоне и не держит остальные задачи.
    require('./jobs/dbBackup')
      .runBackup({ db, config, current })
      .then((made) => made && console.log(JSON.stringify({ event: 'db.backup', file: path.basename(made.file) })))
      .catch((error) => console.error(JSON.stringify({ event: 'db.backup_failed', code: error.code || 'error' })));
    db.prepare('DELETE FROM notifications WHERE created_at<?').run(P.iso(new Date(current.getTime() - 90 * 86400000)));
    const expiredFiles = db
      .prepare("SELECT id,storage_name FROM stored_files WHERE status='temp' AND expires_at<=?")
      .all(currentIso);
    for (const file of expiredFiles) {
      const fullPath = path.join(config.dataDir, 'files', file.storage_name);
      try {
        fs.unlinkSync(fullPath);
      } catch (error) {
        if (error.code !== 'ENOENT') continue;
      }
      db.prepare("UPDATE stored_files SET status='deleted' WHERE id=?").run(file.id);
    }
    for (const s of db.prepare("SELECT * FROM crisis_escalations WHERE status='in_work'").all()) {
      const stillAssigned = db
        .prepare('SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL')
        .get(s.patient_id, s.taken_by);
      const backupAllowed =
        s.escalated_to_backup_at && (activeSetting('crisis.backup').value || []).map(Number).includes(s.taken_by);
      if (!stillAssigned && !backupAllowed) {
        db.prepare("UPDATE crisis_escalations SET status='new',taken_by=NULL,taken_at=NULL WHERE id=?").run(s.id);
        db.prepare(
          "INSERT INTO crisis_incident_log(escalation_id,patient_id,event_type,detail_json,created_at) VALUES (?,?,'returned_to_new','{}',?)",
        ).run(s.id, s.patient_id, currentIso);
        for (const peer of db
          .prepare('SELECT clinician_id FROM care_assignments WHERE patient_id=? AND ended_at IS NULL')
          .all(s.patient_id))
          db.prepare(
            "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'crisis',?,'crisis',?,'Новый сигнал безопасности',?,?,'active',?)",
          ).run(
            peer.clinician_id,
            `crisis-return:${s.id}:${crypto.randomUUID()}`,
            s.id,
            s.patient_id,
            currentIso,
            currentIso,
          );
      } else if (
        s.taken_at &&
        new Date(s.taken_at).getTime() + Number(activeSetting('crisis.outcome_due_hours').value || 24) * 3600000 <=
          current.getTime()
      ) {
        const key = `crisis-outcome:${s.id}`;
        if (!db.prepare('SELECT 1 FROM notifications WHERE event_key=?').get(key))
          db.prepare(
            "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'crisis_outcome',?,'crisis',?,'Запишите исход сигнала',?,?,'active',?)",
          ).run(s.taken_by, key, s.id, s.patient_id, currentIso, currentIso);
      }
    }
    for (const signal of db
      .prepare("SELECT * FROM crisis_escalations WHERE status='new' AND due_at<=?")
      .all(currentIso)) {
      if (!signal.escalated_to_backup_at) {
        const backups = activeSetting('crisis.backup').value || [];
        for (const recipient of backups) {
          const backup = db
            .prepare("SELECT id FROM users WHERE id=? AND role IN ('psychiatrist','psychologist') AND status='active'")
            .get(Number(recipient));
          if (!backup) continue;
          const key = `crisis-backup:${signal.id}:${recipient}`;
          db.prepare(
            "INSERT OR IGNORE INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'crisis',?,'crisis',?,'Новый сигнал безопасности',?,?,'active',?)",
          ).run(Number(recipient), key, signal.id, signal.patient_id, currentIso, currentIso);
        }
        const sla = activeSetting('crisis.sla').value || {};
        const minutes = Number(sla.work_minutes || sla.off_minutes || 60);
        db.prepare('UPDATE crisis_escalations SET escalated_to_backup_at=?,due_at=? WHERE id=?').run(
          currentIso,
          P.iso(new Date(current.getTime() + minutes * 60000)),
          signal.id,
        );
      } else if (
        !db
          .prepare(
            "SELECT 1 FROM service_queue WHERE kind='crisis_manual_review' AND ref_type='crisis' AND ref_id=? AND status IN ('new','taken','waiting')",
          )
          .get(signal.id)
      ) {
        db.prepare(
          "INSERT INTO service_queue(kind,patient_id,ref_type,ref_id,status,created_at) VALUES ('crisis_manual_review',?,'crisis',?,'new',?)",
        ).run(signal.patient_id, signal.id, currentIso);
      }
    }
    const previsitWindow = activeSetting('previsit.days_before').value || { days: 14, reminders: 1 };
    for (const form of db
      .prepare(
        "SELECT pf.*,v.starts_at,v.visible_from FROM previsit_forms pf JOIN visits v ON v.id=pf.visit_id WHERE pf.status='open' AND v.status='scheduled' AND v.previsit_enabled=1 AND v.visible_from<=?",
      )
      .all(currentIso)) {
      const remaining = new Date(form.starts_at).getTime() - current.getTime();
      if (remaining < 0 || remaining > Number(previsitWindow.days || 14) * 86400000) continue;
      db.prepare(
        "INSERT OR IGNORE INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'previsit_open',?,'visit',?,'Можно заполнить анкету перед визитом',?,?,'active',?)",
      ).run(form.patient_id, `previsit-open:${form.id}`, form.visit_id, form.patient_id, currentIso, currentIso);
      if (Number(previsitWindow.reminders || 0) > 0 && remaining <= 86400000 && !form.reminded_at) {
        db.prepare(
          "INSERT OR IGNORE INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'previsit_reminder',?,'visit',?,'Напоминание об анкете перед визитом',?,?,'active',?)",
        ).run(form.patient_id, `previsit-reminder:${form.id}`, form.visit_id, form.patient_id, currentIso, currentIso);
        db.prepare('UPDATE previsit_forms SET reminded_at=? WHERE id=? AND reminded_at IS NULL').run(
          currentIso,
          form.id,
        );
      }
    }
    db.prepare("INSERT OR IGNORE INTO job_marks(job,item_key,done_at) VALUES ('retention',?,?)").run(
      currentIso.slice(0, 10),
      currentIso,
    );
    const queue = db
      .prepare(
        "SELECT * FROM mail_queue WHERE status IN ('queued','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY id LIMIT 10",
      )
      .all(currentIso);
    for (const item of queue) {
      try {
        await smtpSend(item.to_enc, `Вы запросили сброс пароля.\n${item.ref_type}`);
        db.prepare("UPDATE mail_queue SET status='sent',sent_at=?,attempts=attempts+1 WHERE id=?").run(
          currentIso,
          item.id,
        );
      } catch (_) {
        db.prepare("UPDATE mail_queue SET status='retry',attempts=attempts+1,next_attempt_at=? WHERE id=?").run(
          P.iso(new Date(current.getTime() + 60000)),
          item.id,
        );
      }
    }
    // Пуши о напоминаниях на подписанные устройства пациентов (src/modules/patient/push.js).
    try {
      await patientPush.deliverDue({
        timezone: activeSetting('org.timezone_hours').value?.timezone || 'Europe/Moscow',
        labelOf: (code) => require('./format').instrumentLabelFor('patient', code) || code,
      });
    } catch (e) {
      console.error(JSON.stringify({ event: 'push.failed', message: String(e.message || e) }));
    }
    for (const reminder of db.prepare('SELECT id,patient_id FROM reminders WHERE active=1').all()) {
      const eventKey = `reminder:${reminder.id}:${currentIso.slice(0, 10)}`;
      const exists = db.prepare('SELECT 1 FROM notifications WHERE event_key=?').get(eventKey);
      if (!exists)
        db.prepare(
          "INSERT INTO notifications(recipient_id,type,event_key,title,visible_from,status,created_at) VALUES (?,'med_remind',?,'Напоминание',?,'active',?)",
        ).run(reminder.patient_id, eventKey, currentIso, currentIso);
    }
    const support = activeSetting('course_support.rules').value;
    if (Array.isArray(support))
      for (const rule of support) {
        for (const patient of db
          .prepare(
            'SELECT DISTINCT p.patient_id FROM plan_item_acceptance p JOIN user_prefs u ON u.user_id=p.patient_id WHERE p.hidden_at IS NULL AND u.course_support_enabled=1',
          )
          .all()) {
          const accepted = db
            .prepare('SELECT min(accepted_at) at FROM plan_item_acceptance WHERE patient_id=? AND hidden_at IS NULL')
            .get(patient.patient_id)?.at;
          const dueAfterWeeks = Math.max(0, Number(rule.week || 0) - 1);
          if (!accepted || current.getTime() < new Date(accepted).getTime() + dueAfterWeeks * 7 * 86400000) continue;
          db.prepare(
            'INSERT OR IGNORE INTO course_support_shown(patient_id,rule_key,week,shown_at) VALUES (?,?,?,?)',
          ).run(patient.patient_id, `week:${rule.week}`, Number(rule.week), currentIso);
        }
      }
  } finally {
    jobRunning = false;
  }
}
const timer = setInterval(jobs, config.schedulerTickMs);
timer.unref();
jobs().catch(() => {});

for (const patient of db.prepare("SELECT id FROM users WHERE role='patient' AND status='active'").all()) {
  db.prepare(
    "INSERT OR IGNORE INTO notifications(recipient_id,type,event_key,title,visible_from,status,created_at) VALUES (?,'service',?,'Добро пожаловать',?,'active',?)",
  ).run(patient.id, `welcome:${patient.id}`, P.iso(now(config)), P.iso(now(config)));
}

// W-48: стартовый синтетический контент библиотеки (F-50). Идемпотентно: только
// если library_items пуста и в системе есть хотя бы один пользователь (владелец
// файла медиа). В demo-потоке admin создаётся scripts/admin-create.js до старта.
try {
  if (require('./modules/library/seed').ensureLibrarySeed(db, config, P))
    console.log(JSON.stringify({ event: 'library.seed', stand_in: true }));
} catch (error) {
  console.error(JSON.stringify({ event: 'library.seed.failed', message: String(error.message || error) }));
}
// Примеры статей о препаратах (STAND-IN, ждут ревью): по тегам подтягиваются в карточку лекарства.
try {
  const added = require('./modules/library/med_seed').ensureMedArticles(db, P);
  if (added) console.log(JSON.stringify({ event: 'library.med_seed', added, stand_in: true }));
} catch (error) {
  console.error(JSON.stringify({ event: 'library.med_seed.failed', message: String(error.message || error) }));
}

// Журнал: демо-статьи с картинками и лайками (STAND-IN), идемпотентно по slug.
try {
  const added = require('./modules/journal/seed').ensureJournalSeed(db, P, now(config));
  if (added) console.log(JSON.stringify({ event: 'journal.seed', added, stand_in: true }));
} catch (error) {
  console.error(JSON.stringify({ event: 'journal.seed.failed', message: String(error.message || error) }));
}

const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'server.started', port: config.port, data_mode: config.dataMode }));
});
function shutdown() {
  clearInterval(timer);
  server.close(() => {
    require('./modules/knowledge/service')
      .closeKnowledge()
      .catch(() => {})
      .finally(() => {
        db.close();
        process.exit(0);
      });
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
