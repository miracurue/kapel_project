'use strict';

// ИИ-пространство клинициста (W1.C2): /ai. Доступно психиатру и психологу (permission ai_workspace.use);
// пациент и админ получают 403, чужой тред/материал — 404. Сервис автономен от МИС: ничего не обязательно.
// Каркас чата (треды, лента, ввод) — mountChat из routes/ai.js; здесь материалы, привязка к пациенту, экспорт.

const express = require('express');

const db = require('../db');
const { flash } = require('../middleware');
const { requirePermission } = require('../permissions');
const threads = require('../ai/threads');
const { mountChat } = require('./ai');
const service = require('../ai/workspace/service');
const store = require('../ai/workspace/store');
const context = require('../ai/workspace/context');
const scenarios = require('../ai/workspace/scenarios');
const extract = require('../ai/workspace/extract');
const pii = require('../ai/workspace/pii');
const multipart = require('../ai/workspace/multipart');
const limits = require('../security/rate_limit');
const exporter = require('../ai/workspace/export');
const { formatDate } = require('../format');

const router = express.Router();
const BASE = '/ai';
const guard = requirePermission('ai_workspace.use');

const TEXTS = {
  title: 'ИИ-пространство',
  badge: 'ИИ-помощник врача: черновики, решение за врачом',
  intro: {
    can: ['собрать сводку к приёму из данных сервиса', 'сравнить динамику за период', 'подготовить черновики: рекомендации пациенту, направление, вопросы к приёму, план повторного тестирования', 'работать с вашими материалами (txt, docx, pdf, csv, изображения без распознавания)'],
    cannot: ['ставить диагнозы и назначать лечение', 'заменить клиническое решение врача', 'видеть данные пациента без вашей привязки и без согласий пациента'],
  },
  privacy: 'Диалоги и материалы видны только вам (не коллегам и не администратору). Срок хранения — 30 дней, удалить можно в любой момент. В журнал попадает только факт обращения, без текста.',
  disclaimer: 'Ответы ИИ-пространства — черновики: не диагноз и не рекомендация лечения; решение всегда за врачом. Тексты шаблонов в демо-версии — заглушки и ожидают клинического ревью.',
  emptyTitle: 'Чем помочь?',
  emptyHint: 'Начните с вопроса или выберите сценарий над полем ввода. Пациент и файлы не обязательны.',
  deleteNote: 'Диалог, его сообщения и прикреплённые материалы (файлы и извлечённый текст) будут стёрты без возможности восстановления. В журнале останется только запись о факте обращения без текста.',
};

function wantsJson(req) {
  return req.get('X-Requested-With') === 'fetch' || /application\/json/.test(req.get('Accept') || '');
}

// Ленивая проверка срока хранения при любом обращении к разделу.
router.use(BASE, (req, res, next) => {
  try { store.purgeIfDue(); } catch (e) { console.error('ai purge failed:', e && e.message); }
  next();
});

// W3.K (M-6): после снятия закрепления привязанные к пациенту диалоги и материалы недоступны (кроме удаления).
const LOCKED_MSG = 'Пациент больше не закреплён за вами, поэтому диалог и материалы по нему недоступны. Их можно только удалить.';
function lockedThread(user, thread) {
  return !!thread && context.threadLocked(user, thread.patient_id);
}
router.use(BASE, (req, res, next) => {
  const user = req.session && req.session.user;
  if (!user) return next();
  const p = req.path;
  let thread = null;
  let m;
  if (/^\/t\/\d+\/delete$/.test(p) || /^\/materials\/\d+\/delete$/.test(p)) return next();
  if ((m = /^\/t\/(\d+)(\/|$)/.exec(p))) thread = threads.getThread(user.id, m[1], 'clinician');
  else if ((m = /^\/m\/(\d+)\//.exec(p))) {
    const row = db.prepare('SELECT thread_id FROM ai_messages WHERE id = ?').get(Number(m[1]));
    thread = row ? threads.getThread(user.id, row.thread_id, 'clinician') : null;
  } else if ((m = /^\/materials\/(\d+)\//.exec(p))) {
    const mat = store.getMaterial(user.id, m[1]);
    thread = mat ? threads.getThread(user.id, mat.thread_id, 'clinician') : null;
  } else if (p === '/send' && req.method === 'POST' && req.body && req.body.thread_id) thread = threads.getThread(user.id, req.body.thread_id, 'clinician');
  if (!lockedThread(user, thread)) return next();
  if (req.method === 'GET' && /^\/t\/\d+\/?$/.test(p)) {
    flash(req, LOCKED_MSG, 'info');
    return res.redirect(`${BASE}/t/${thread.id}/delete`);
  }
  if (wantsJson(req)) return res.status(403).json({ error: LOCKED_MSG });
  return res.status(403).render('error', { message: LOCKED_MSG });
});

function patientName(id) {
  const r = db.prepare('SELECT full_name FROM users WHERE id = ?').get(id);
  return r ? r.full_name : '';
}

function listFor(req) {
  const user = req.session.user;
  const f = ['patient', 'general'].includes(req.query.f) ? req.query.f : 'all';
  // заголовок закрытого диалога (автоназвание из текста) в списке не показываем
  const all = threads.listThreads(user.id, 'clinician').map((t) => (lockedThread(user, t) ? { ...t, title: 'Диалог по пациенту (недоступен)' } : t));
  return f === 'patient' ? all.filter((t) => t.patient_id) : f === 'general' ? all.filter((t) => !t.patient_id) : all;
}

function localsFor(req, { thread, messages }) {
  const user = req.session.user;
  const f = ['patient', 'general'].includes(req.query.f) ? req.query.f : 'all';
  const ws = {
    base: BASE, filter: f, patients: context.listMyPatients(user.id), scenarios: scenarios.SCENARIOS, periods: scenarios.PERIODS,
    retentionDays: store.RETENTION_DAYS(), maxFileMb: Math.round(extract.DEFAULTS.maxFileBytes / 1048576), maxFiles: extract.DEFAULTS.maxFiles,
    preselect: Number(req.query.patient) || null, sourcesOf: service.sourcesOf, formatDate, texts: TEXTS,
    thread: null, patient: null, patientLost: false, crisis: [], materials: [], expires: null, hasPii: false,
  };
  if (thread) {
    ws.expires = store.threadExpiry(thread);
    ws.materials = store.listMaterials(thread.id, user.id);
    if (thread.patient_id) {
      const acc = context.access(user, thread.patient_id);
      if (acc.ok) {
        ws.patient = { id: acc.patient.id, name: acc.patient.full_name, consent: !!acc.patient.clinical_consent_given, share: context.sharing(acc.patient.id) };
        ws.crisis = context.openCrisis(acc.patient.id);
      } else ws.patientLost = true;
    }
    ws.thread = thread;
  }
  void messages;
  return { ws };
}

mountChat(router, {
  base: BASE,
  permission: 'ai_workspace.use',
  role: 'clinician',
  title: TEXTS.title,
  chips: [],
  contactEnabled: false,
  maxLen: service.MAX_LEN,
  badge: TEXTS.badge,
  intro: TEXTS.intro,
  privacyNote: TEXTS.privacy,
  disclaimer: TEXTS.disclaimer,
  emptyTitle: TEXTS.emptyTitle,
  emptyHint: TEXTS.emptyHint,
  deleteNote: TEXTS.deleteNote,
  listThreads: listFor,
  locals: localsFor,
  send: (req, { threadId, text }) =>
    service.sendMessage({ user: req.session.user, base: BASE, threadId, text, scenarioKey: (req.body && req.body.scenario) || null, periodDays: req.body && req.body.period }),
  retry: (req, threadId) => service.retryLast({ user: req.session.user, base: BASE, threadId }),
  onOpen: (req, thread) => {
    if (thread.patient_id) {
      service.phi(req.session.user, thread.patient_id, 'ai_open_thread');
      service.audit({ user: req.session.user, threadId: thread.id, event: 'ws_open_thread', patientId: thread.patient_id });
    }
  },
  onDelete: (req, thread) => service.deleteThreadFully(req.session.user, thread),
});

// ---------- создание диалога по пациенту / привязка ----------

router.post(`${BASE}/new`, guard, (req, res) => {
  const user = req.session.user;
  const pid = req.body && req.body.patient_id ? Number(req.body.patient_id) : null;
  const r = service.createThread(user, { patientId: pid });
  if (r.error) {
    if (r.status === 403) return res.status(403).render('error', { message: r.error });
    flash(req, r.error, 'error');
    return res.redirect(BASE);
  }
  res.redirect(`${BASE}/t/${r.thread.id}`);
});

router.post(`${BASE}/t/:id/bind`, guard, (req, res) => {
  const user = req.session.user;
  const thread = threads.getThread(user.id, req.params.id, 'clinician');
  if (!thread) return res.status(404).render('error', { message: 'Диалог не найден.' });
  const r = service.bindThread(user, thread, req.body && req.body.patient_id);
  if (r.error) {
    if (r.status === 403) return res.status(403).render('error', { message: r.error });
    flash(req, r.error, 'error');
    return res.redirect(`${BASE}/t/${thread.id}`);
  }
  flash(req, 'Диалог привязан к пациенту. Данные сервиса учитываются только с согласий пациента.', 'success');
  res.redirect(`${BASE}/t/${thread.id}`);
});

// ---------- детектор ПДн в тексте ввода (REQ-AID-018) ----------

router.post(`${BASE}/pii/detect`, guard, (req, res) => {
  const text = String((req.body && req.body.text) || '').slice(0, service.MAX_LEN * 2);
  const matches = pii.detect(text);
  const { segs } = pii.segments(text, matches, [], text.length + 1);
  res.json({
    count: matches.length,
    types: [...new Set(matches.map((m) => m.title))],
    masked: pii.apply(text, matches, []).text,
    segments: segs.map((s) => ({ t: s.text, label: s.match ? s.match.label : null })),
  });
});

// ---------- загрузка материалов ----------

function previewModel(user, token, stage) {
  return {
    token,
    mask: stage.mask,
    threadId: stage.threadId,
    rejected: stage.rejected,
    items: stage.items.map((it, i) => {
      if (stage.mask && it.hasText) {
        const matches = pii.detect(it.text);
        const { segs, truncated } = pii.segments(it.text, matches, [], 20000);
        return { i, name: it.name, kind: it.kind, size: it.size, note: it.note, hasText: it.hasText, masked: true, matches, segs, truncated, preview: null };
      }
      return { i, name: it.name, kind: it.kind, size: it.size, note: it.note, hasText: it.hasText, masked: false, matches: [], segs: null, truncated: it.text.length > 20000, preview: it.text.slice(0, 20000) };
    }),
    user,
  };
}

function renderPreview(req, res, model, status = 200) {
  res.status(status).render('ai/workspace/preview', { ...model, base: BASE, maxFileMb: Math.round(extract.DEFAULTS.maxFileBytes / 1048576), maxFiles: extract.DEFAULTS.maxFiles, types: extract.TYPES_HUMAN });
}

router.post(`${BASE}/materials/preview`, guard, async (req, res) => {
  const user = req.session.user;
  const lim = extract.DEFAULTS;
  let parsed;
  const hit = limits.upload.hit(`u${user.id}`);
  if (!hit.allowed) {
    res.set('Retry-After', String(Math.ceil(hit.retryAfterMs / 1000)));
    return renderPreview(req, res, { token: null, mask: true, threadId: null, rejected: [{ name: 'Загрузка', message: `Слишком много загрузок за короткое время. Повторите через ${limits.waitText(hit.retryAfterMs)}.` }], items: [] }, 429);
  }
  try {
    const buf = await multipart.readBody(req, lim.maxFiles * lim.maxFileBytes + 2 * 1024 * 1024);
    parsed = multipart.parse(buf, req.headers['content-type']);
  } catch (e) {
    const status = e && e.status ? e.status : 400;
    return renderPreview(req, res, { token: null, mask: true, threadId: null, rejected: [{ name: 'Загрузка', message: e && e.status ? e.message : 'Не удалось прочитать загрузку.' }], items: [] }, status);
  }
  const f = parsed.fields;
  let thread = null;
  if (f.thread_id) {
    thread = threads.getThread(user.id, f.thread_id, 'clinician');
    if (!thread) return res.status(404).render('error', { message: 'Диалог не найден.' });
    if (lockedThread(user, thread)) return res.status(403).render('error', { message: LOCKED_MSG });
  }
  const mask = f.mask === '1' || f.mask === 'on';
  const items = [];
  const rejected = [];
  parsed.files.forEach((file, idx) => {
    const shown = extract.normalizeName(file.filename);
    if (idx >= lim.maxFiles) { rejected.push({ name: shown, message: `Файл «${shown}» не принят: за один раз можно прикрепить не больше ${lim.maxFiles} файлов.` }); return; }
    try {
      const it = extract.inspect(file.filename, file.data);
      items.push({ ...it, buf: file.data });
    } catch (e) {
      if (e instanceof extract.ExtractError) rejected.push({ name: shown, message: e.message });
      else { console.error('upload inspect failed:', e && e.message); rejected.push({ name: shown, message: `Файл «${shown}» не удалось обработать.` }); }
    }
  });
  if (!parsed.files.length) rejected.push({ name: 'Файл', message: 'Файл не выбран. Выберите хотя бы один файл.' });
  service.audit({ user, threadId: thread ? thread.id : null, event: items.length ? 'ws_upload_preview' : 'ws_upload_rejected', patientId: thread ? thread.patient_id || null : null, files: parsed.files.length });
  const token = items.length ? store.stagePut(user.id, { threadId: thread ? thread.id : null, mask, items, rejected }) : null;
  const stage = { mask, threadId: thread ? thread.id : null, rejected, items };
  renderPreview(req, res, previewModel(user, token, stage), items.length ? 200 : 422);
});

// Переключить маскирование на странице предпросмотра без повторной загрузки.
router.post(`${BASE}/materials/recheck`, guard, (req, res) => {
  const user = req.session.user;
  const stage = store.stageGet(user.id, req.body && req.body.token);
  if (!stage) {
    flash(req, 'Черновик загрузки устарел. Прикрепите файлы заново.', 'error');
    return res.redirect(BASE);
  }
  stage.mask = req.body.mask === '1';
  renderPreview(req, res, previewModel(user, req.body.token, stage));
});

router.post(`${BASE}/materials/cancel`, guard, (req, res) => {
  store.stageDrop(req.body && req.body.token);
  flash(req, 'Загрузка отменена, ничего не сохранено.', 'info');
  res.redirect(req.body && req.body.thread_id ? `${BASE}/t/${Number(req.body.thread_id)}` : BASE);
});

router.post(`${BASE}/materials/save`, guard, (req, res) => {
  const user = req.session.user;
  const stage = store.stageGet(user.id, req.body && req.body.token);
  if (!stage) {
    flash(req, 'Черновик загрузки устарел. Прикрепите файлы заново.', 'error');
    return res.redirect(BASE);
  }
  let thread;
  if (stage.threadId) {
    thread = threads.getThread(user.id, stage.threadId, 'clinician');
    if (!thread) return res.status(404).render('error', { message: 'Диалог не найден.' });
    if (lockedThread(user, thread)) return res.status(403).render('error', { message: LOCKED_MSG });
  } else {
    const c = service.createThread(user);
    if (c.error) { flash(req, c.error, 'error'); return res.redirect(BASE); }
    thread = c.thread;
  }
  const mask = req.body.mask === '1';
  const keepRaw = [].concat(req.body.keep || []);
  const saved = [];
  try {
    stage.items.forEach((it, i) => {
      const keepIds = keepRaw.map(String).filter((k) => k.startsWith(`${i}:`)).map((k) => Number(k.split(':')[1])).filter(Number.isInteger);
      saved.push(store.saveMaterial({ ownerUserId: user.id, threadId: thread.id, patientId: thread.patient_id || null, item: it, buf: it.buf, mask, keepIds }));
    });
  } catch (e) {
    console.error('material save failed:', e && e.message);
    for (const m of saved) store.deleteMaterial(user.id, m.id); // ничего не остаётся наполовину
    flash(req, 'Не удалось сохранить материалы. Ничего не записано, попробуйте ещё раз.', 'error');
    return res.redirect(`${BASE}/t/${thread.id}`);
  }
  store.stageDrop(req.body.token);
  for (const m of saved) {
    const note = m.masked ? `, замаскировано замен: ${m.mask_count}` : m.has_text ? ', без маскирования' : ', текст не извлечён';
    threads.addMessage(thread.id, { role: 'system', text: `Прикреплён материал ${m.seq}: ${m.name}${note}`, kind: 'material' });
  }
  service.audit({ user, threadId: thread.id, event: 'ws_material_add', patientId: thread.patient_id || null, files: saved.length });
  if (thread.patient_id) service.phi(user, thread.patient_id, 'ai_material_add');
  flash(req, saved.length === 1 ? 'Материал сохранён в диалоге.' : `Материалы сохранены: ${saved.length}.`, 'success');
  res.redirect(`${BASE}/t/${thread.id}#end`);
});

// ---------- скачивание и удаление материала ----------

router.get(`${BASE}/materials/:id/download`, guard, (req, res) => {
  const user = req.session.user;
  const m = store.getMaterial(user.id, req.params.id);
  if (!m) return res.status(404).render('error', { message: 'Материал не найден.' });
  const data = store.readStored(m);
  if (!data) return res.status(404).render('error', { message: 'Файл материала уже удалён.' });
  const base = m.stored_as === 'masked_text' ? `${m.name.replace(/\.[^.]*$/, '')}_замаскировано.txt` : m.name;
  service.audit({ user, threadId: m.thread_id, event: 'ws_material_download', patientId: m.patient_id || null, files: 1 });
  res.set({
    'Content-Type': 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="material"; filename*=UTF-8''${encodeURIComponent(base)}`,
  });
  res.send(data);
});

router.get(`${BASE}/materials/:id/delete`, guard, (req, res) => {
  const m = store.getMaterial(req.session.user.id, req.params.id);
  if (!m) return res.status(404).render('error', { message: 'Материал не найден.' });
  res.render('ai/workspace/confirm_material', { base: BASE, m });
});

router.post(`${BASE}/materials/:id/delete`, guard, (req, res) => {
  const user = req.session.user;
  const m = store.getMaterial(user.id, req.params.id);
  if (!m) return res.status(404).render('error', { message: 'Материал не найден.' });
  store.deleteMaterial(user.id, m.id);
  service.audit({ user, threadId: m.thread_id, event: 'ws_material_delete', patientId: m.patient_id || null, files: 1 });
  flash(req, 'Материал удалён: файл и извлечённый текст стёрты.', 'success');
  res.redirect(`${BASE}/t/${m.thread_id}`);
});

// ---------- экспорт ----------

function sendExport(req, res, user, thread, doc, fmtKey, extraEvent) {
  const fmt = exporter.FORMATS[fmtKey];
  if (!fmt) return res.status(404).render('error', { message: 'Формат экспорта не поддерживается. Доступны: DOCX, PDF, TXT.' });
  const buf = fmt.build(doc);
  service.audit({ user, threadId: thread.id, event: extraEvent, patientId: thread.patient_id || null });
  if (thread.patient_id) service.phi(user, thread.patient_id, 'ai_export');
  const name = exporter.fileName(fmtKey);
  res.set({
    'Content-Type': fmt.mime,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="draft_${exporter.today()}.${fmtKey}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.send(buf);
}

function docFor(thread, msgs) {
  return {
    date: exporter.today(),
    note: thread.patient_id ? 'Диалог привязан к пациенту; идентификаторы пациента в документ не включаются.' : '',
    items: msgs.map((m) => ({ who: m.role === 'assistant' ? 'ИИ-помощник · ЧЕРНОВИК, решение за врачом' : 'Врач', text: m.text })),
  };
}

router.get(`${BASE}/t/:id/export.:fmt`, guard, (req, res) => {
  const user = req.session.user;
  const thread = threads.getThread(user.id, req.params.id, 'clinician');
  if (!thread) return res.status(404).render('error', { message: 'Диалог не найден.' });
  const msgs = threads.listMessages(thread.id).filter((m) => (m.role === 'user' || m.role === 'assistant') && !['error'].includes(m.kind));
  sendExport(req, res, user, thread, docFor(thread, msgs), req.params.fmt, 'ws_export_thread');
});

router.get(`${BASE}/m/:mid/export.:fmt`, guard, (req, res) => {
  const user = req.session.user;
  const row = db
    .prepare('SELECT m.*, t.owner_user_id AS owner, t.role AS trole FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id WHERE m.id = ?')
    .get(Number(req.params.mid));
  if (!row || row.owner !== user.id || row.trole !== 'clinician' || row.role !== 'assistant') return res.status(404).render('error', { message: 'Ответ не найден.' });
  const thread = threads.getThread(user.id, row.thread_id, 'clinician');
  sendExport(req, res, user, thread, docFor(thread, [row]), req.params.fmt, 'ws_export_message');
});

router.use(BASE, (err, req, res, next) => {
  void next;
  console.error('ai workspace error:', err && err.message);
  if (wantsJson(req)) return res.status(500).json({ error: 'Ошибка сервера. Попробуйте ещё раз.' });
  res.status(500).render('error', { message: 'Не удалось выполнить действие. Попробуйте ещё раз.' });
});

module.exports = router;
