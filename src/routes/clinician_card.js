'use strict';

// W1.B2: карточка пациента клинициста — вкладки, офлайн-ввод и протоколы, заметки, «Лечение», «К приёму».
// Сводка/список/очередь — clinician_overview.js (W1.B1); назначения — clinician_assign.js.

const express = require('express');

const db = require('../db');
const { INSTRUMENTS, scoreClinicianEntry } = require('../instruments');
const crisisProtocol = require('../crisisProtocol');
const escalation = require('../escalation');
const comparison = require('../comparison');
const catalog = require('../instruments_catalog');
const assignments = require('../assignments');
const card = require('../patient_card');
const triage = require('../triage_data');
const { flash } = require('../middleware');
const { requirePermission, canAccessPatient, can } = require('../permissions');

const router = express.Router();
const view = requirePermission('patient.view_card');

const today = () => new Date().toISOString().slice(0, 10);
const NOTE_MAX = 5000;
const TAG_MAX = 120;

function denied(res) {
  return res.status(403).render('error', { message: 'Этот пациент не закреплён за вами.' });
}

/** Доступ + общие данные шапки карточки. null — ответ уже отправлен. */
function open(req, res) {
  const pid = Number(req.params.id);
  const user = req.session.user;
  if (!canAccessPatient(user, pid, db)) { denied(res); return null; }
  const patient = card.patientBase(pid);
  if (!patient) { denied(res); return null; }
  const consent = assignments.consentState(pid);
  const row = triage.verdictFor(user.id, pid);
  return {
    pid, patient, consentOk: consent.ok, consentReason: consent.reason,
    archived: !!(row && row.archived), verdict: row ? row.verdict : null, tags: row ? row.tags : [],
    alsoWith: card.coClinicians(pid, user.id),
  };
}

function render(req, res, base, tab, extra = {}) {
  const t = card.TABS.find((x) => x.key === tab) || { label: 'К приёму' };
  res.render(`clinician/patient_${tab}`, {
    ...base, tab, tabLabel: t.label, tabs: card.TABS, base: `/patients/${base.pid}`, disclaimer: card.CLINICAL_DISCLAIMER,
    canTreat: can(req.session.user.role, 'medication.prescribe_plan'), today: today(), ...extra,
  });
}

// ---------- «Что изменилось» + обзор ----------

router.get('/patients/:id', view, (req, res) => {
  const b = open(req, res);
  if (!b) return;
  const user = req.session.user;
  assignments.runSchedules();
  // «последний просмотр» читаем ДО записи в журнал; запись — одна на 5 минут (REQ-CLN-025)
  const changes = card.changes(b.pid, user.id, { consentOk: b.consentOk });
  card.logView(user.id, b.pid, card.actionFor('overview'));
  const current = assignments.listActive([b.pid]);
  render(req, res, b, 'overview', {
    changes,
    scores: b.consentOk ? card.keyScores(b.pid, b.consentOk) : [],
    escalations: card.openEscalations(b.pid),
    current,
    schedules: assignments.listSchedules([b.pid]),
  });
});

// ---------- «К приёму» (REQ-PSA-002) ----------

router.get('/patients/:id/visit', view, (req, res) => {
  const b = open(req, res);
  if (!b) return;
  card.logView(req.session.user.id, b.pid, 'view_patient_visit');
  const s = card.visitSummary(b.pid, req.session.user);
  const careV = require('../care/visit').forVisit(b.pid, req.session.user, b.consentOk);
  render(req, res, b, 'visit', { s, text: card.visitText(s) + careV.text, careV });
});

router.get('/patients/:id/visit.txt', view, (req, res) => {
  const b = open(req, res);
  if (!b) return;
  // экспорт всегда пишется в журнал (REQ-SEC-007): без окна дедупликации
  db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(req.session.user.id, b.pid, 'export_patient_visit_txt');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="k-priemu-${b.pid}.txt"`);
  res.send(card.visitText(card.visitSummary(b.pid, req.session.user)) + require('../care/visit').forVisit(b.pid, req.session.user, b.consentOk).text);
});

// ---------- вкладки ----------

const TAB_PATH = '/patients/:id/:tab(scales|offline|diary|treatment|notes|materials|journal)';

router.get(TAB_PATH, view, (req, res) => {
  const b = open(req, res);
  if (!b) return;
  const tab = req.params.tab;
  const user = req.session.user;
  card.logView(user.id, b.pid, card.actionFor(tab));
  const q = req.query;
  const extra = {};

  if (tab === 'scales') {
    Object.assign(extra, card.scalesView(b.pid, { scale: String(q.scale || ''), period: String(q.period || '12') }, b.consentOk));
  } else if (tab === 'offline') {
    Object.assign(extra, offlineData(b));
  } else if (tab === 'diary') {
    const d = require('../sharing').diaryForClinician(b.pid, 60);
    const rows = b.consentOk ? d.entries : [];
    const asc = [...rows].reverse();
    extra.rows = rows;
    extra.trend = b.consentOk ? card.diaryTrend(b.pid) : null;
    extra.spark = card.sparkline(asc.map((r) => r.mood_score), { width: 320, height: 60 });
    // настройки «Поделиться с врачом» пациента (REQ-PAT-017, W1.A)
    extra.share = { scores: d.sharesScores, notes: d.sharesNotes, hidden: d.hiddenCount };
  } else if (tab === 'treatment') {
    extra.items = can(user.role, 'medication.prescribe_plan')
      ? db.prepare('SELECT t.*, u.full_name AS author FROM treatment_items t JOIN users u ON u.id = t.author_id WHERE t.patient_id = ? ORDER BY t.id DESC').all(b.pid)
      : [];
    if (can(user.role, 'medication.prescribe_plan')) { // W2.F: план приёма и отметки пациента
      const meds = require('../care').meds;
      extra.plan = meds.planForClinician(b.pid);
      extra.medView = meds.clinicianView(b.pid, b.consentOk);
      extra.editItem = q.edit ? extra.plan.find((i) => i.id === Number(q.edit) && !i.ended_at) || null : null;
    }
  } else if (tab === 'notes') {
    const qq = String(q.q || '').trim().slice(0, 100);
    const tag = String(q.tag || '').trim().slice(0, 40);
    let notes = db.prepare('SELECT * FROM clinician_notes WHERE patient_id = ? AND author_id = ? ORDER BY COALESCE(note_date, substr(created_at,1,10)) DESC, id DESC').all(b.pid, user.id);
    const allTags = [...new Set(notes.flatMap((n) => splitTags(n.tags)))].sort();
    const needle = qq.toLowerCase().replace(/ё/g, 'е');
    if (needle) notes = notes.filter((n) => `${n.body || ''} ${n.tags || ''}`.toLowerCase().replace(/ё/g, 'е').includes(needle));
    if (tag) notes = notes.filter((n) => splitTags(n.tags).includes(tag));
    extra.notes = notes.map((n) => ({ ...n, tagList: splitTags(n.tags) }));
    extra.q = qq; extra.tag = tag; extra.allTags = allTags;
    extra.total = db.prepare('SELECT COUNT(*) AS n FROM clinician_notes WHERE patient_id = ? AND author_id = ?').get(b.pid, user.id).n;
    extra.editing = q.edit ? db.prepare('SELECT * FROM clinician_notes WHERE id = ? AND patient_id = ? AND author_id = ?').get(Number(q.edit), b.pid, user.id) || null : null;
  } else if (tab === 'materials') {
    // D5: материалы ИИ-пространства, привязанные к пациенту. Видны только автору (владелец материала),
    // только при действующем клиническом согласии пациента и пока не истёк срок хранения.
    extra.docs = b.consentOk
      ? db.prepare(
        `SELECT id, thread_id, name, kind, size_bytes, stored_as, masked, mask_count, created_at, expires_at
         FROM ai_attachments WHERE patient_id = ? AND owner_user_id = ? AND expires_at > ? ORDER BY created_at DESC, id DESC`
      ).all(b.pid, user.id, require('../ai/workspace/store').sqlTime(new Date()))
      : [];
  } else if (tab === 'journal') {
    const type = String(q.type || '');
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? String(q.from) : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')) ? String(q.to) : '';
    Object.assign(extra, card.journal(b.pid, { type, from, to }, b.consentOk), { type, from, to });
  }
  render(req, res, b, tab, extra);
});

function splitTags(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function offlineData(b) {
  const pid = b.pid;
  const all = card.gatherResults(pid, { consentOk: b.consentOk, includeInvalid: true });
  return {
    entryGroups: catalog.groupedCatalog((e) => (e.status === 'stub') || (INSTRUMENTS[e.code] && e.code !== 'cssrs')),
    comparisons: b.consentOk ? comparison.listComparisonPairs(pid) : [],
    waiting: db.prepare("SELECT ia.*, u.full_name AS by_name FROM instrument_assignments ia LEFT JOIN users u ON u.id = ia.assigned_by WHERE ia.patient_id = ? AND ia.status = 'waiting_entry' ORDER BY ia.id").all(pid),
    entered: all.filter((r) => r.kind !== 'online').sort((a, c) => c.atMs - a.atMs).slice(0, 40),
    protocolFields: catalog.PROTOCOL_FIELDS,
  };
}

// ---------- ввод результата (единая точка) и прежние маршруты ----------

function back(req, pid, tab = 'offline') {
  return `/patients/${pid}${tab ? '/' + tab : ''}`;
}

router.post('/patients/:id/results', requirePermission('offline_result.enter'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  { const wb = assignments.writeBlocked(pid); if (wb.blocked) { flash(req, wb.reason, 'error'); return res.redirect(back(req, pid)); } }
  const code = String(req.body.instrument || '');
  const entry = catalog.getEntry(code);
  if (INSTRUMENTS[code] && code !== 'cssrs') return saveOffline(req, res, pid);
  if (entry && entry.status === 'stub') return saveProtocol(req, res, pid);
  flash(req, 'Выберите методику из списка. Дату указывать не обязательно — подставится сегодняшняя.', 'error');
  res.redirect(back(req, pid));
});

router.post('/patients/:id/offline-results', requirePermission('offline_result.enter'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  { const wb = assignments.writeBlocked(pid); if (wb.blocked) { flash(req, wb.reason, 'error'); return res.redirect(back(req, pid)); } }
  saveOffline(req, res, pid);
});

function saveOffline(req, res, patientId) {
  const { instrument, notes, subscale_a, subscale_d, item9_score, stai_state, stai_trait, mmpi_scale2, mmpi_scale7, mmpi_scale9 } = req.body;
  const test_date = req.body.test_date || today(); // дата подставляется, не обязательна
  const totalScoreRaw = req.body.total_score;
  if (!INSTRUMENTS[instrument]) {
    flash(req, 'Выберите методику.', 'error');
    return res.redirect(back(req, patientId));
  }
  const i9 = Array.isArray(item9_score) ? item9_score.find((x) => x !== '') : item9_score;

  let scored;
  let item9Score = null;
  try {
    if (instrument === 'bdi2') {
      item9Score = i9 === undefined || i9 === '' ? null : Number(i9);
      scored = scoreClinicianEntry('bdi2', { totalScore: Number(totalScoreRaw), item9Score });
    } else if (instrument === 'stai') {
      scored = scoreClinicianEntry('stai', { subscales: { state: Number(stai_state), trait: Number(stai_trait) } });
    } else if (instrument === 'mmpi') {
      scored = scoreClinicianEntry('mmpi', {
        subscales: {
          scale2: mmpi_scale2 === '' || mmpi_scale2 === undefined ? null : Number(mmpi_scale2),
          scale7: mmpi_scale7 === '' || mmpi_scale7 === undefined ? null : Number(mmpi_scale7),
          scale9: mmpi_scale9 === '' || mmpi_scale9 === undefined ? null : Number(mmpi_scale9),
        },
      });
    } else {
      // phq9/gad7/hads/who5 офлайн-бланк: врач вводит уже подсчитанный итог (это очный бланк, не повтор
      // онлайн-алгоритма), риск по тем же порогам считаем через тот же инструмент, что и онлайн.
      const def = INSTRUMENTS[instrument];
      const bandFor = (t) => (def.bands.find((b) => t <= b.max) || def.bands[def.bands.length - 1]).label;
      let subscales = null;
      let riskReasons;
      let total;
      let band;
      if (instrument === 'hads') {
        // HADS: пороги на каждую субшкалу отдельно, не на общую сумму (RES-2 "scales-and-battery" §1.3).
        subscales = { A: Number(subscale_a) || 0, D: Number(subscale_d) || 0 };
        riskReasons = def.computeRisk(null, null, subscales);
        total = subscales.A + subscales.D;
        band = `A: ${bandFor(subscales.A)}; D: ${bandFor(subscales.D)}`;
      } else {
        if (totalScoreRaw === undefined || totalScoreRaw === '') throw new Error('укажите суммарный балл офлайн-теста');
        total = Number(totalScoreRaw);
        if (instrument === 'phq9') {
          item9Score = i9 === undefined || i9 === '' ? null : Number(i9);
          riskReasons = def.computeRisk([...Array(8).fill(0), item9Score ?? 0], total);
        } else {
          riskReasons = def.computeRisk(null, total);
        }
        band = bandFor(total);
      }
      scored = { total, subscales, band, riskReasons, riskFlag: riskReasons.length > 0 };
    }
  } catch (e) {
    flash(req, `Ошибка ввода офлайн-результата: ${e.message}`, 'error');
    return res.redirect(back(req, patientId));
  }

  const info = db
    .prepare(
      `INSERT INTO offline_results
         (patient_id, entered_by, instrument, total_score, subscales_json, item9_score, band, risk_flag, risk_reasons_json, test_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      patientId, req.session.user.id, instrument, scored.total,
      scored.subscales ? JSON.stringify(scored.subscales) : null, item9Score, scored.band, scored.riskFlag ? 1 : 0,
      JSON.stringify(scored.riskReasons), test_date, notes || null
    );

  const offlineRow = db.prepare('SELECT * FROM offline_results WHERE id = ?').get(info.lastInsertRowid);
  comparison.createComparisonPairIfPossible(offlineRow);
  assignments.completeWaiting(patientId, instrument, null); // очная методика внесена: «ожидает» -> «выполнено»

  // Триггер D (BDI-II п.9 ≥2, введено психологом) — сверка с C-SSRS, =3 критический
  if (instrument === 'bdi2' && item9Score !== null) {
    const { tier, triggers } = crisisProtocol.evaluateCrisisTier({ bdi2Item9: item9Score });
    if (tier > crisisProtocol.TIERS.ROUTINE) {
      escalation.createEscalation({ patientId, instrument: 'bdi2', reasons: scored.riskReasons, tier, triggers });
    }
  } else if (instrument === 'mmpi' && scored.riskFlag) {
    // не критическая эскалация — флаг психиатру для интерпретации профиля (RES-2 "scales-and-battery" §3)
    flash(req, `Офлайн-результат сохранён. ${scored.riskReasons.join('; ')}`, 'error');
    return res.redirect(back(req, patientId));
  }

  flash(req, 'Офлайн-результат сохранён и сопоставлен с онлайн-данными пациента.', 'success');
  res.redirect(back(req, patientId));
}

router.post('/patients/:id/protocols', requirePermission('offline_result.enter'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  { const wb = assignments.writeBlocked(pid); if (wb.blocked) { flash(req, wb.reason, 'error'); return res.redirect(back(req, pid)); } }
  saveProtocol(req, res, pid);
});

function saveProtocol(req, res, patientId) {
  const entry = catalog.getEntry(req.body.instrument);
  if (!entry || entry.status !== 'stub') {
    flash(req, 'Выберите методику из каталога.', 'error');
    return res.redirect(back(req, patientId));
  }
  let protocol;
  try {
    protocol = catalog.normalizeProtocol(req.body);
  } catch (e) {
    flash(req, `Ошибка ввода протокола: ${e.message}`, 'error');
    return res.redirect(back(req, patientId));
  }
  const status = req.body.status === 'ready' ? 'ready' : 'draft';
  const info = db
    .prepare("INSERT INTO catalog_protocols (patient_id, entered_by, instrument, test_date, protocol_json, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(patientId, req.session.user.id, entry.code, req.body.test_date || today(), JSON.stringify(protocol), status);
  const id = Number(info.lastInsertRowid);
  if (status === 'ready') assignments.completeWaiting(patientId, entry.code, id);
  else assignments.linkDraft(patientId, entry.code, id);
  flash(req, status === 'ready'
    ? 'Протокол сохранён как готовый (демонстрационная заглушка). Ожидание ввода закрыто.'
    : 'Протокол сохранён как черновик (демонстрационная заглушка). Отметьте «готово», когда закончите.', 'success');
  res.redirect(back(req, patientId));
}

router.post('/patients/:id/protocols/:prid/ready', requirePermission('offline_result.enter'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  { const wb = assignments.writeBlocked(pid); if (wb.blocked) { flash(req, wb.reason, 'error'); return res.redirect(back(req, pid)); } }
  const p = db.prepare('SELECT * FROM catalog_protocols WHERE id = ? AND patient_id = ?').get(Number(req.params.prid), pid);
  if (!p) return res.status(404).render('error', { message: 'Протокол не найден.' });
  db.prepare("UPDATE catalog_protocols SET status = 'ready' WHERE id = ?").run(p.id);
  assignments.completeWaiting(pid, p.instrument, p.id);
  flash(req, 'Протокол отмечен как готовый.', 'success');
  res.redirect(back(req, pid));
});

router.post('/patients/:id/comparisons/:pairId/note', requirePermission('comparison.note'), (req, res) => {
  const patientId = Number(req.params.id);
  if (!canAccessPatient(req.session.user, patientId, db)) return denied(res);
  // clinician_note (RES-2 "literature-review-methodology" §2.2): комментарий о причине расхождения офлайн/онлайн
  db.prepare('UPDATE comparison_pairs SET clinician_note = ? WHERE id = ? AND patient_id = ?').run(
    req.body.clinician_note || null, req.params.pairId, patientId
  );
  flash(req, 'Комментарий к сопоставлению сохранён.', 'success');
  res.redirect(back(req, patientId));
});

// «Ошибочный ввод»: результат не удаляется, а исключается из динамики и экспорта (REQ-CAT-012)
router.post('/patients/:id/results/:kind/:rid/:action(invalid|valid)', requirePermission('offline_result.enter'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  const r = assignments.markInvalid(req.session.user, pid, req.params.kind, req.params.rid, req.body.reason, req.params.action === 'invalid');
  if (!r.ok) return res.status(404).render('error', { message: 'Результат не найден.' });
  flash(req, req.params.action === 'invalid'
    ? 'Результат помечен как ошибочный ввод: он исключён из динамики и экспорта, запись сохранена в журнале.'
    : 'Пометка «ошибочный ввод» снята.', 'success');
  res.redirect(String(req.body.back || '').startsWith(`/patients/${pid}/`) ? req.body.back : back(req, pid, 'scales'));
});

// ---------- заметки (REQ-CLN-015): всё необязательно; приватны автору (OQ-11) ----------

function noteFields(body) {
  const text = String(body.body || '').slice(0, NOTE_MAX);
  const tags = splitTags(String(body.tags || '').slice(0, TAG_MAX)).map((t) => t.slice(0, 30)).join(', ');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.note_date || '')) ? body.note_date : null;
  return { text: text.trim(), tags, date };
}

router.post('/patients/:id/notes', requirePermission('patient.notes.write'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  const f = noteFields(req.body);
  if (!f.text && !f.tags) {
    flash(req, 'Нечего сохранять: заметка пустая. Заметки необязательны, остальная работа с карточкой не затронута.', 'info');
    return res.redirect(back(req, pid, 'notes'));
  }
  db.prepare('INSERT INTO clinician_notes (patient_id, author_id, body, tags, note_date) VALUES (?, ?, ?, ?, ?)').run(pid, req.session.user.id, f.text || null, f.tags || null, f.date);
  flash(req, 'Заметка сохранена. Она видна только вам.', 'success');
  res.redirect(back(req, pid, 'notes'));
});

router.post('/patients/:id/notes/:nid', requirePermission('patient.notes.write'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  const f = noteFields(req.body);
  const r = db.prepare("UPDATE clinician_notes SET body = ?, tags = ?, note_date = ?, updated_at = datetime('now') WHERE id = ? AND patient_id = ? AND author_id = ?")
    .run(f.text || null, f.tags || null, f.date, Number(req.params.nid), pid, req.session.user.id);
  if (!r.changes) return res.status(404).render('error', { message: 'Заметка не найдена (изменять можно только свои заметки).' });
  flash(req, 'Заметка обновлена.', 'success');
  res.redirect(back(req, pid, 'notes'));
});

router.post('/patients/:id/notes/:nid/delete', requirePermission('patient.notes.write'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  const r = db.prepare('DELETE FROM clinician_notes WHERE id = ? AND patient_id = ? AND author_id = ?').run(Number(req.params.nid), pid, req.session.user.id);
  if (!r.changes) return res.status(404).render('error', { message: 'Заметка не найдена (удалять можно только свои заметки).' });
  flash(req, 'Заметка удалена.', 'success');
  res.redirect(back(req, pid, 'notes'));
});

// ---------- «Лечение»: редактирует только психиатр (REQ-CLN-007); публикация пациенту и журнал приёма — W2.F ----------

router.post('/patients/:id/treatment', requirePermission('medication.prescribe_plan'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  const text = String(req.body.body || '').trim().slice(0, NOTE_MAX);
  if (!text) {
    flash(req, 'Нечего сохранять: запись пустая. Раздел необязателен.', 'info');
    return res.redirect(back(req, pid, 'treatment'));
  }
  db.prepare('INSERT INTO treatment_items (patient_id, author_id, body) VALUES (?, ?, ?)').run(pid, req.session.user.id, text);
  flash(req, 'Запись о лечении сохранена. Пациент её не видит (публикация пациенту — отдельная функция).', 'success');
  res.redirect(back(req, pid, 'treatment'));
});

router.post('/patients/:id/treatment/:tid/delete', requirePermission('medication.prescribe_plan'), (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return denied(res);
  db.prepare('DELETE FROM treatment_items WHERE id = ? AND patient_id = ?').run(Number(req.params.tid), pid);
  flash(req, 'Запись удалена.', 'success');
  res.redirect(back(req, pid, 'treatment'));
});

module.exports = router;
