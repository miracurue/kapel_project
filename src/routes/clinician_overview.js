'use strict';

// W1.B1: сводка («светофор»), список пациентов, кризисная очередь клинициста.
// Карточка пациента, назначения, заметки — W1.B2 (src/routes/clinician.js).

const express = require('express');

const db = require('../db');
const { flash } = require('../middleware');
const { requirePermission, canAccessPatient, isClinician } = require('../permissions');
const triage = require('../triage_data');
const rules = require('../triage_rules');
const queue = require('../crisis_queue');
const card = require('../patient_card');
const { isBusinessHours } = require('../crisisProtocol');

const router = express.Router();
const PAGE_SIZE = 50;
const STATUSES = ['red', 'yellow', 'gray', 'green'];

function backTo(req, fallback) {
  const b = req.body && req.body.back;
  // только относительные пути внутри кабинета (REQ-SEC-016)
  return typeof b === 'string' && /^\/(dashboard|patients|crisis)(\/|\?|$)/.test(b) && !b.startsWith('//') ? b : fallback;
}

function cleanTag(s) {
  return String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
}

// ---------- Сводка ----------

// D8 (решение OQ-14a): уровни и пороги кризисного протокола не меняются; Сводка явно показывает
// открытые эскалации Tier 1 («Внимание») и среди них ответы на вопрос о суицидальных мыслях (PHQ-9 п.9, BDI-II п.9).
function attentionStats(clinicianId) {
  const rows = db
    .prepare(
      `SELECT ce.instrument, COUNT(DISTINCT ce.id) AS n FROM crisis_escalations ce
       JOIN care_assignments ca ON ca.patient_id = ce.patient_id
       WHERE ca.clinician_id = ? AND ce.status = 'open' AND ce.tier = 1 GROUP BY ce.instrument`
    )
    .all(clinicianId);
  const tier1 = rows.reduce((a, r) => a + r.n, 0);
  const item9 = rows.filter((r) => ['phq9', 'bdi2'].includes(r.instrument)).reduce((a, r) => a + r.n, 0);
  const high = db
    .prepare(
      `SELECT COUNT(DISTINCT ce.id) AS n FROM crisis_escalations ce
       JOIN care_assignments ca ON ca.patient_id = ce.patient_id
       WHERE ca.clinician_id = ? AND ce.status = 'open' AND ce.tier >= 2`
    )
    .get(clinicianId).n;
  return { tier1, item9, high };
}

function summary(req, res) {
  const user = req.session.user;
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const tag = String(req.query.tag || '');
  const all = triage.listPatients(user.id, {});
  const counts = triage.counts(all.patients);
  const filtered = triage.listPatients(user.id, { status, tag: tag || undefined });
  // по умолчанию «спокойных» не показываем: сводка отвечает «кому нужно внимание сейчас»
  const rows = status || tag ? filtered.patients : filtered.patients.filter((p) => p.verdict.color !== 'green');
  card.logViewMany(user.id, rows.map((r) => r.id), 'view_list_dashboard'); // M-5
  res.render('clinician/dashboard', {
    rows,
    counts,
    total: all.patients.length,
    allTags: all.allTags,
    status,
    tag,
    triageConfig: rules.CONFIG,
    openCount: queue.countOpen(user.id),
    attention: attentionStats(user.id),
    repeatDue: require('../tools/repeat').due(user.id).length, // W2.G: мягкое напоминание, необязательно
    now: new Date(),
  });
}

// GET /dashboard для клинициста вызывает summary() из src/routes/dashboard.js.

// ---------- Список пациентов ----------

router.get('/patients', requirePermission('patient.view_card'), (req, res) => {
  const user = req.session.user;
  const q = String(req.query.q || '').slice(0, 100);
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const tag = String(req.query.tag || '');
  const view = req.query.view === 'archive' ? 'only' : undefined;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const { patients, allTags } = triage.listPatients(user.id, { q, status, tag: tag || undefined, archived: view });
  const pages = Math.max(1, Math.ceil(patients.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const archivedCount = triage.listPatients(user.id, { archived: 'only' }).patients.length;
  card.logViewMany(user.id, patients.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE).map((r) => r.id), 'view_list_patients'); // M-5
  res.render('clinician/patients', {
    rows: patients.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE),
    totalFound: patients.length,
    allTags, q, status, tag,
    view: view ? 'archive' : 'active',
    archivedCount,
    page: cur, pages,
  });
});

function ownPatient(req, res) {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) {
    res.status(403).render('error', { message: 'Этот пациент не закреплён за вами.' });
    return null;
  }
  return pid;
}

router.post('/patients/:id/archive', requirePermission('patient.view_card'), (req, res) => {
  const pid = ownPatient(req, res);
  if (!pid) return;
  db.prepare("UPDATE care_assignments SET archived_at = datetime('now') WHERE patient_id = ? AND clinician_id = ?").run(pid, req.session.user.id);
  require('../patient_prefs').noteCareChange(pid, 'ended');
  flash(req, 'Наблюдение завершено: пациент в архиве. Открытые эскалации остаются в очереди до подтверждения. Вернуть можно в разделе «Архив».', 'success');
  res.redirect(backTo(req, '/patients'));
});

router.post('/patients/:id/unarchive', requirePermission('patient.view_card'), (req, res) => {
  const pid = ownPatient(req, res);
  if (!pid) return;
  db.prepare('UPDATE care_assignments SET archived_at = NULL WHERE patient_id = ? AND clinician_id = ?').run(pid, req.session.user.id);
  require('../patient_prefs').clearCareChange(pid);
  flash(req, 'Пациент возвращён в основной список.', 'success');
  res.redirect(backTo(req, '/patients?view=archive'));
});

router.post('/patients/:id/tags', requirePermission('patient.view_card'), (req, res) => {
  const pid = ownPatient(req, res);
  if (!pid) return;
  const uid = req.session.user.id;
  const add = cleanTag(req.body.tag);
  const remove = cleanTag(req.body.remove);
  if (add) db.prepare('INSERT OR IGNORE INTO patient_tags (clinician_id, patient_id, tag) VALUES (?, ?, ?)').run(uid, pid, add);
  if (remove) db.prepare('DELETE FROM patient_tags WHERE clinician_id = ? AND patient_id = ? AND tag = ?').run(uid, pid, remove);
  res.redirect(backTo(req, '/patients'));
});

// Отложить жёлтый флаг (REQ-CLN-004). Кризис (красный) — нельзя.
router.post('/patients/:id/snooze', requirePermission('patient.view_card'), (req, res) => {
  const pid = ownPatient(req, res);
  if (!pid) return;
  const user = req.session.user;
  const row = triage.listPatients(user.id, { archived: 'all' }).patients.find((p) => p.id === pid);
  if (!row || row.verdict.color === 'red') {
    flash(req, 'Кризисные флаги отложить нельзя: сначала подтвердите эскалацию в кризисной очереди.', 'error');
    return res.redirect(backTo(req, '/dashboard'));
  }
  if (row.verdict.color !== 'yellow') {
    flash(req, 'Откладывать нечего: у пациента нет жёлтого флага.', 'info');
    return res.redirect(backTo(req, '/dashboard'));
  }
  const days = Math.min(30, Math.max(1, parseInt(req.body.days, 10) || triage.SNOOZE_DEFAULT_DAYS));
  const until = triage.snooze(user.id, pid, row.verdict, days);
  flash(req, `Флаг отложен до ${until.slice(0, 10)}. Он вернётся раньше, если появится ухудшение или новая причина.`, 'success');
  res.redirect(backTo(req, '/dashboard'));
});

// ---------- Кризисная очередь ----------

router.get('/crisis', requirePermission('crisis.view_queue'), (req, res) => {
  const user = req.session.user;
  queue.sweep(); // просрочка SLA проверяется и вне этой страницы (middleware), здесь — для свежести
  const { open, acked } = queue.listQueue(user.id);
  card.logViewMany(user.id, [...open, ...acked].map((i) => i.patient_id), 'view_list_crisis'); // M-5
  res.render('clinician/crisis', {
    groups: queue.groupByPatient(open),
    openCount: open.length,
    acked,
    outcomes: queue.OUTCOMES,
    businessHours: isBusinessHours(new Date()),
    serverNow: new Date().toISOString(),
  });
});

router.get('/crisis/:ref', requirePermission('crisis.view_queue'), (req, res) => {
  const item = queue.getItem(req.session.user.id, String(req.params.ref));
  if (!item) return res.status(403).render('error', { message: 'Нет доступа к этой эскалации.' });
  db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(req.session.user.id, item.patient_id, 'view_crisis_item');
  res.render('clinician/crisis_item', {
    item,
    events: item.kind === 'tier' ? queue.eventLog(item.id) : [],
    outcomes: queue.OUTCOMES,
    serverNow: new Date().toISOString(),
  });
});

router.post('/crisis/:ref/acknowledge', requirePermission('crisis.acknowledge'), (req, res) => {
  // исход и заметка необязательны: пустое тело — тоже успех
  const done = queue.acknowledge(req.session.user.id, String(req.params.ref), { outcome: req.body.outcome, note: req.body.note });
  if (!done) {
    // D15: различаем «уже обработано» (кем и когда) и «нет доступа»
    const it = queue.getItem(req.session.user.id, String(req.params.ref));
    if (it && it.status !== 'open') {
      const who = it.acknowledged_by ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(it.acknowledged_by) || {}).full_name : null;
      return res.status(403).render('error', { message: `Уже обработано${who ? `: ${who}` : ''}${it.acknowledged_at ? `, ${require('../format').formatDate(it.acknowledged_at)}` : ''}. Повторное действие не нужно. Вернитесь в кризисную очередь.` });
    }
    return res.status(403).render('error', { message: 'Нет доступа к этой записи очереди.' });
  }
  flash(req, 'Отмечено как обработанное.', 'success');
  res.redirect('/crisis');
});

module.exports = router;
module.exports.summary = summary;
