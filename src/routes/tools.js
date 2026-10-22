'use strict';

// W2.G: быстрые инструменты врача (/tools). Только психиатр и психолог; пациент и администратор получают 403.
// Сервис автономен от МИС: всё необязательно, ничего не блокируется. Калькулятор ничего не пишет в БД.

const express = require('express');

const db = require('../db');
const { requireRole, flash } = require('../middleware');
const { canAccessPatient } = require('../permissions');
const calc = require('../tools/calculator');
const docs = require('../tools/documents');
const cardExport = require('../tools/card_export');
const csvImport = require('../tools/csv_import');
const cohort = require('../tools/cohort');
const repeat = require('../tools/repeat');
const search = require('../tools/search');
const quicknote = require('../tools/quicknote');
const exporter = require('../ai/workspace/export');
const multipart = require('../ai/workspace/multipart');
const limits = require('../security/rate_limit');
const card = require('../patient_card');

const router = express.Router();
router.use('/tools', requireRole('psychiatrist', 'psychologist'));

const SECTIONS = [
  { href: '/tools/calculator', label: 'Калькулятор шкал', hint: 'Быстрый подсчёт без создания пациента. Ничего не сохраняется.' },
  { href: '/tools/quicknote', label: 'Быстрая заметка', hint: 'Свободный текст в черновик с разделами. Локально, без ИИ.' },
  { href: '/tools/templates', label: 'Шаблоны документов', hint: 'Памятки, рекомендации, направление: DOCX, PDF, TXT, печать.' },
  { href: '/tools/import', label: 'Импорт из CSV', hint: 'Офлайн-результаты ваших пациентов таблицей, с предпросмотром и откатом.' },
  { href: '/tools/cohort', label: 'Отчёт по когорте', hint: 'Агрегаты по вашим пациентам без имён.' },
  { href: '/tools/reminders', label: 'Пора повторить тест', hint: 'Мягкие напоминания. Необязательно.' },
  { href: '/tools/search', label: 'Поиск', hint: 'По вашим заметкам, материалам и шаблонам.' },
];

function myPatients(userId) {
  return db
    .prepare(`SELECT u.id, u.full_name FROM care_assignments ca JOIN users u ON u.id = ca.patient_id
              WHERE ca.clinician_id = ? AND ca.archived_at IS NULL AND u.role = 'patient' ORDER BY u.full_name`)
    .all(userId);
}

function page(res, view, data = {}) {
  res.render(`tools/${view}`, { sections: SECTIONS, toolView: view, ...data });
}

function download(res, fmt, doc, extra = {}) {
  const f = exporter.FORMATS[fmt];
  const name = exporter.fileName(fmt);
  res.set({
    'Content-Type': f.mime,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="document_${exporter.today()}.${fmt}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    ...extra,
  });
  res.send(f.build(doc));
}

const fmtOf = (v) => (['docx', 'pdf', 'txt'].includes(String(v)) ? String(v) : null);

router.get('/tools', (req, res) => page(res, 'index', { title: 'Инструменты' }));

// ---------- калькулятор (REQ-TLS-001) ----------

router.get('/tools/calculator', (req, res) => page(res, 'calculator_list', { title: 'Калькулятор шкал', scales: calc.list() }));

function calcPage(req, res, scale, computed, errorMsg) {
  page(res, 'calculator', {
    title: scale.title, scale, computed: computed && computed.ok ? computed : null, error: errorMsg || (computed && !computed.ok ? computed.error : null),
    answers: computed ? computed.answers : [], patients: myPatients(req.session.user.id), notSaved: calc.NOT_SAVED,
    saveAllowed: scale.code !== 'cssrs', today: new Date().toISOString().slice(0, 10),
  });
}

router.get('/tools/calculator/:code', (req, res) => {
  const scale = calc.get(req.params.code);
  if (!scale) return res.status(404).render('error', { message: 'Для этой шкалы автоматического подсчёта нет.' });
  calcPage(req, res, scale, null);
});

router.post('/tools/calculator/:code', (req, res) => {
  const scale = calc.get(req.params.code);
  if (!scale) return res.status(404).render('error', { message: 'Для этой шкалы автоматического подсчёта нет.' });
  calcPage(req, res, scale, calc.compute(req.params.code, req.body));
});

router.post('/tools/calculator/:code/save', (req, res) => {
  const scale = calc.get(req.params.code);
  if (!scale) return res.status(404).render('error', { message: 'Для этой шкалы автоматического подсчёта нет.' });
  const computed = calc.compute(req.params.code, req.body);
  if (!computed.ok) return calcPage(req, res, scale, computed);
  const r = calc.saveToPatient(req.session.user, req.body.patient_id, req.params.code, computed, req.body.test_date);
  if (!r.ok) return calcPage(req, res, scale, computed, r.error);
  flash(req, 'Итог сохранён в карточку пациента (ответы по пунктам не сохранены).', 'success');
  res.redirect(`/patients/${Number(req.body.patient_id)}/scales`);
});

// ---------- быстрая заметка (REQ-CLN-016) ----------

router.get('/tools/quicknote', (req, res) => page(res, 'quicknote', { title: 'Быстрая заметка', text: '', result: null, patients: myPatients(req.session.user.id) }));

router.post('/tools/quicknote', (req, res) => {
  const text = String(req.body.text || '').slice(0, quicknote.MAX_CHARS);
  page(res, 'quicknote', { title: 'Быстрая заметка', text, result: quicknote.structure(text), patients: myPatients(req.session.user.id) });
});

router.post('/tools/quicknote/save', (req, res) => {
  const pid = Number(req.body.patient_id);
  const body = String(req.body.draft || '').trim().slice(0, 5000);
  if (!canAccessPatient(req.session.user, pid, db)) {
    flash(req, 'Выберите пациента из своего списка. Чтобы не сохранять в карточку, скопируйте текст.', 'error');
    return res.redirect('/tools/quicknote');
  }
  if (!body) { flash(req, 'Нечего сохранять.', 'info'); return res.redirect('/tools/quicknote'); }
  db.prepare('INSERT INTO clinician_notes (patient_id, author_id, body, tags, note_date) VALUES (?, ?, ?, ?, ?)')
    .run(pid, req.session.user.id, `ЧЕРНОВИК (быстрая заметка)\n${body}`, 'черновик', new Date().toISOString().slice(0, 10));
  flash(req, 'Черновик сохранён в заметки пациента. Он виден только вам.', 'success');
  res.redirect(`/patients/${pid}/notes`);
});

// ---------- шаблоны документов (REQ-TLS-002) и библиотека (REQ-TLS-005) ----------

router.get('/tools/templates', (req, res) => page(res, 'templates', { title: 'Шаблоны документов', list: docs.listFor(req.session.user.id), review: docs.REVIEW_NOTE }));

router.get('/tools/templates/new', (req, res) => {
  const src = req.query.copy ? docs.find(req.session.user.id, req.query.copy) : null;
  page(res, 'template_form', { title: 'Новый шаблон', tpl: { id: null, title: src ? `${src.title} (копия)` : '', body: src ? src.body : '' }, error: null, max: docs.BODY_MAX });
});

router.post('/tools/templates', (req, res) => {
  const r = docs.create(req.session.user.id, req.body.title, req.body.body);
  if (!r.ok) return page(res, 'template_form', { title: 'Новый шаблон', tpl: { id: null, title: req.body.title || '', body: req.body.body || '' }, error: r.error, max: docs.BODY_MAX });
  flash(req, 'Шаблон сохранён.', 'success');
  res.redirect(`/tools/templates/${r.id}`);
});

function tplOr404(req, res) {
  const t = docs.find(req.session.user.id, req.params.id);
  if (!t) res.status(404).render('error', { message: 'Шаблон не найден.' });
  return t;
}

function fillData(req, tpl, values) {
  const user = req.session.user;
  const keys = docs.placeholders(tpl.body);
  const defaults = { '[дата]': new Date().toLocaleDateString('ru-RU'), '[врач]': user.full_name };
  return keys.map((k, i) => ({ key: k, name: `f${i}`, value: values && values[`f${i}`] !== undefined ? values[`f${i}`] : (defaults[k] || '') }));
}

router.get('/tools/templates/:id', (req, res) => {
  const tpl = tplOr404(req, res);
  if (!tpl) return;
  page(res, 'template_fill', { title: tpl.title, tpl, fields: fillData(req, tpl), patients: myPatients(req.session.user.id), review: docs.REVIEW_NOTE });
});

router.get('/tools/templates/:id/edit', (req, res) => {
  const tpl = tplOr404(req, res);
  if (!tpl) return;
  if (!tpl.own) return res.redirect(`/tools/templates/new?copy=${encodeURIComponent(tpl.id)}`);
  page(res, 'template_form', { title: 'Правка шаблона', tpl, error: null, max: docs.BODY_MAX });
});

router.post('/tools/templates/:id/update', (req, res) => {
  const tpl = tplOr404(req, res);
  if (!tpl) return;
  const r = docs.update(req.session.user.id, req.params.id, req.body.title, req.body.body);
  if (!r.ok) return page(res, 'template_form', { title: 'Правка шаблона', tpl: { id: tpl.id, title: req.body.title || '', body: req.body.body || '' }, error: r.error, max: docs.BODY_MAX });
  flash(req, 'Шаблон обновлён.', 'success');
  res.redirect(`/tools/templates/${tpl.id}`);
});

router.get('/tools/templates/:id/delete', (req, res) => {
  const tpl = tplOr404(req, res);
  if (!tpl || !tpl.own) return tpl && res.redirect('/tools/templates');
  page(res, 'template_delete', { title: 'Удалить шаблон', tpl });
});

router.post('/tools/templates/:id/delete', (req, res) => {
  if (!docs.remove(req.session.user.id, req.params.id)) return res.status(404).render('error', { message: 'Шаблон не найден (удалять можно только свои).' });
  flash(req, 'Шаблон удалён.', 'success');
  res.redirect('/tools/templates');
});

/** Подстановка и выгрузка: docx/pdf/txt — файл, print — страница для печати. Данные пациента — только по явному выбору. */
router.post('/tools/templates/:id/export', (req, res) => {
  const tpl = tplOr404(req, res);
  if (!tpl) return;
  const fields = fillData(req, tpl, req.body);
  const values = {};
  for (const f of fields) values[f.key] = f.value;
  const pid = Number(req.body.patient_id);
  if (pid && fields.some((f) => f.key === '[ФИО]') && !String(values['[ФИО]'] || '').trim()) {
    const name = docs.patientNameFor(req.session.user, pid);
    if (name) {
      values['[ФИО]'] = name;
      db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(req.session.user.id, pid, 'tools_template_fill');
    }
  }
  const text = docs.fill(tpl.body, values);
  const doc = docs.toDoc(tpl, text);
  const fmt = fmtOf(req.body.fmt);
  if (fmt) return download(res, fmt, doc);
  page(res, 'template_print', { title: tpl.title, doc, text });
});

// ---------- экспорт карточки / «К приёму» (REQ-PSA-003) ----------

function myPatientOr403(req, res) {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) {
    res.status(403).render('error', { message: 'Этот пациент не закреплён за вами.' });
    return null;
  }
  return pid;
}

router.get('/tools/export/:id', (req, res) => {
  const pid = myPatientOr403(req, res);
  if (!pid) return;
  const p = card.patientBase(pid);
  card.logView(req.session.user.id, pid, 'view_export_page'); // M-5
  page(res, 'export_card', { title: 'Экспорт карточки', patient: p, sections: undefined, secList: cardExport.SECTIONS, defaults: cardExport.DEFAULT_SECTIONS });
});

router.get('/tools/export/:id/download', (req, res) => {
  const pid = myPatientOr403(req, res);
  if (!pid) return;
  const fmt = fmtOf(req.query.fmt);
  if (!fmt) return res.status(400).render('error', { message: 'Выберите формат: DOCX, PDF или TXT.' });
  let picked = cardExport.parseSections(req.query.s);
  if (!picked.length) picked = cardExport.DEFAULT_SECTIONS;
  const doc = cardExport.build(pid, req.session.user, picked);
  cardExport.audit(req.session.user.id, pid, fmt);
  download(res, fmt, doc);
});

// ---------- импорт CSV (REQ-TLS-003) ----------

router.get('/tools/import', (req, res) => page(res, 'import', { title: 'Импорт из CSV', batches: csvImport.listBatches(req.session.user.id), limits: { mb: csvImport.MAX_BYTES / 1048576, rows: csvImport.MAX_ROWS, hours: csvImport.ROLLBACK_HOURS } }));

router.get('/tools/import/template.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="import_template.csv"' });
  res.send(csvImport.templateCsv());
});

router.post('/tools/import/upload', async (req, res, next) => {
  const hit = limits.upload.hit(`u${req.session.user.id}`);
  if (!hit.allowed) { flash(req, `Слишком много загрузок за короткое время. Повторите через ${limits.waitText(hit.retryAfterMs)}.`, 'error'); return res.redirect('/tools/import'); }
  try {
    const buf = await multipart.readBody(req, csvImport.MAX_BYTES + 512 * 1024);
    const parsed = multipart.parse(buf, req.headers['content-type']);
    const file = parsed.files.find((f) => f.field === 'file');
    if (!file || !file.data.length) { flash(req, 'Выберите файл CSV.', 'error'); return res.redirect('/tools/import'); }
    if (file.data.length > csvImport.MAX_BYTES) { flash(req, 'Файл больше 2 МБ.', 'error'); return res.redirect('/tools/import'); }
    const a = csvImport.analyze(req.session.user, file.data);
    if (a.fatal) { flash(req, a.fatal, 'error'); return res.redirect('/tools/import'); }
    const id = csvImport.saveDraft(req.session.user.id, a.text, a.encoding);
    res.redirect(`/tools/import/draft/${id}`);
  } catch (e) {
    if (e instanceof multipart.UploadError) { flash(req, e.message, 'error'); return res.redirect('/tools/import'); }
    next(e);
  }
});

function mappingFrom(q) {
  const m = {};
  for (const f of csvImport.FIELDS) if (q[`m_${f.key}`] !== undefined) m[f.key] = q[`m_${f.key}`];
  return Object.keys(m).length ? m : null;
}

router.get('/tools/import/draft/:id', (req, res) => {
  const d = csvImport.getDraft(req.session.user.id, req.params.id);
  if (!d) { flash(req, 'Черновик импорта устарел (хранится 1 час). Загрузите файл заново.', 'info'); return res.redirect('/tools/import'); }
  const mapping = mappingFrom(req.query);
  const a = csvImport.analyze(req.session.user, { text: d.content, encoding: d.encoding }, mapping);
  page(res, 'import_preview', { title: 'Предпросмотр импорта', draftId: d.id, a, fields: csvImport.FIELDS, mapping: a.mapping, overrides: mapping || {} });
});

router.post('/tools/import/draft/:id/confirm', (req, res) => {
  const d = csvImport.getDraft(req.session.user.id, req.params.id);
  if (!d) { flash(req, 'Черновик импорта устарел. Загрузите файл заново.', 'info'); return res.redirect('/tools/import'); }
  const a = csvImport.analyze(req.session.user, { text: d.content, encoding: d.encoding }, mappingFrom(req.body));
  if (a.fatal || a.missing.length || !a.counts.ok) { flash(req, 'Нечего импортировать: нет корректных строк.', 'error'); return res.redirect(`/tools/import/draft/${d.id}`); }
  const r = csvImport.apply(req.session.user, a);
  csvImport.dropDraft(d.id);
  flash(req, `Импортировано строк: ${r.created}. Пропущено: ${a.rows.length - r.created}.${r.escalations ? ` Создано кризисных эскалаций: ${r.escalations}.` : ''} Партию можно отменить в течение ${csvImport.ROLLBACK_HOURS} ч.`, 'success');
  res.redirect('/tools/import');
});

router.post('/tools/import/draft/:id/cancel', (req, res) => {
  const d = csvImport.getDraft(req.session.user.id, req.params.id);
  if (d) csvImport.dropDraft(d.id);
  flash(req, 'Импорт отменён, загруженный файл удалён.', 'info');
  res.redirect('/tools/import');
});

router.post('/tools/import/:batch/rollback', (req, res) => {
  const r = csvImport.rollback(req.session.user, req.params.batch);
  flash(req, r.ok ? `Партия отменена: удалено записей ${r.removed}. Созданные при импорте кризисные эскалации не удаляются.` : r.error, r.ok ? 'success' : 'error');
  res.redirect('/tools/import');
});

// ---------- когорта (REQ-TLS-008) ----------

router.get('/tools/cohort', (req, res) => {
  const s = cohort.summary(req.session.user.id, { scale: String(req.query.scale || 'phq9') });
  page(res, 'cohort', { title: 'Отчёт по когорте', s });
});

router.get('/tools/cohort.csv', (req, res) => {
  const s = cohort.summary(req.session.user.id, { scale: String(req.query.scale || 'phq9') });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cohort_aggregates.csv"' });
  res.send(cohort.toCsv(s));
});

// ---------- напоминания (REQ-TLS-006) ----------

router.get('/tools/reminders', (req, res) => {
  const days = repeat.parseDays(req.query.days);
  const list = repeat.due(req.session.user.id, { days });
  card.logViewMany(req.session.user.id, list.map((x) => x.patient.id), 'view_list_reminders'); // M-5
  page(res, 'reminders', { title: 'Пора повторить тест', days, choices: repeat.CHOICES, list, snoozeDays: repeat.SNOOZE_DAYS });
});

router.post('/tools/reminders/snooze', (req, res) => {
  const ok = repeat.snooze(req.session.user.id, Number(req.body.patient_id));
  flash(req, ok ? `Напоминание отложено на ${repeat.SNOOZE_DAYS} дн.` : 'Пациент не найден.', ok ? 'success' : 'error');
  res.redirect(`/tools/reminders?days=${repeat.parseDays(req.body.days)}`);
});

// ---------- поиск (REQ-TLS-007) ----------

router.get('/tools/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 100);
  const r = search.search(req.session.user, q);
  card.logViewMany(req.session.user.id, [...r.notes.map((n) => n.patientId), ...r.materials.map((m) => m.patientId).filter(Boolean)], 'view_list_search'); // M-5
  page(res, 'search', { title: 'Поиск', q, r });
});

module.exports = router;
