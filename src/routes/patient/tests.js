'use strict';

// Тесты пациента: список (назначено/пройдено/динамика), пошаговое прохождение с
// черновиком на сервере (REQ-PAT-007/008/009), экран результата (REQ-PAT-010),
// график динамики (REQ-PAT-011). Кризисный протокол при отправке перенесён
// из прежнего routes/patient.js без изменений логики.

const express = require('express');

const db = require('../../db');
const { INSTRUMENTS } = require('../../instruments');
const crisisProtocol = require('../../crisisProtocol');
const escalation = require('../../escalation');
const charts = require('../../../public/charts');
const text = require('../../patient_text');
const { RESULT_DISCLAIMER } = require('../../disclaimers');
const { flash } = require('../../middleware');
const { requirePermission } = require('../../permissions');
const { patientPage, notFound, criticalHit, criticalIndexes, itemText, clinicianLink, catalog } = require('./common');

const router = express.Router();

function ownAssignment(req) {
  // W1.B2: отменённое врачом назначение для пациента не существует (REQ-CAT-012)
  return db.prepare("SELECT * FROM instrument_assignments WHERE id = ? AND patient_id = ? AND status != 'cancelled'").get(req.params.id, req.session.user.id);
}

function readDraft(assignmentId) {
  const row = db.prepare('SELECT answers_json FROM assignment_drafts WHERE assignment_id = ?').get(assignmentId);
  if (!row) return {};
  try {
    return JSON.parse(row.answers_json) || {};
  } catch (e) {
    return {};
  }
}

function saveDraft(assignment, answers) {
  db.prepare(
    `INSERT INTO assignment_drafts (assignment_id, patient_id, answers_json, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(assignment_id) DO UPDATE SET answers_json = excluded.answers_json, updated_at = datetime('now')`
  ).run(assignment.id, assignment.patient_id, JSON.stringify(answers));
}

function firstUnanswered(instrument, answers) {
  for (let i = 0; i < instrument.items.length; i += 1) {
    if (answers[i] === undefined || answers[i] === null) return i;
  }
  return -1;
}

function minutesFor(instrument) {
  return Math.max(1, Math.ceil(instrument.items.length / 4));
}

// ---------- Список ----------

router.get('/tests', patientPage, (req, res) => {
  const id = req.session.user.id;
  const tab = ['assigned', 'done', 'progress'].includes(req.query.tab) ? req.query.tab : 'assigned';

  const pendingRows = db
    .prepare(
      `SELECT ia.*, u.full_name AS assigned_by_name FROM instrument_assignments ia
       LEFT JOIN users u ON u.id = ia.assigned_by
       WHERE ia.patient_id = ? AND ia.status = 'pending' ORDER BY ia.assigned_at DESC, ia.id DESC`
    )
    .all(id);
  const pending = pendingRows
    .map((p) => {
      const ins = catalog.getTakeable(p.instrument);
      if (!ins) return null;
      const draft = readDraft(p.id);
      return {
        ...p,
        questions: ins.items.length,
        minutes: minutesFor(ins),
        answered: Object.keys(draft).length,
        hasDraft: Object.keys(draft).length > 0,
      };
    })
    .filter(Boolean);

  const done = db
    .prepare(
      `SELECT ia.id AS assignment_id, ia.instrument, r.total_score, r.created_at AS result_at
       FROM instrument_assignments ia JOIN online_results r ON r.assignment_id = ia.id
       WHERE ia.patient_id = ? AND ia.status = 'completed' ORDER BY r.created_at DESC, r.id DESC`
    )
    .all(id);

  const codes = [...new Set(done.map((d) => d.instrument))];
  let selected = codes.includes(req.query.instrument) ? req.query.instrument : codes[0] || null;
  let chart = null;
  if (tab === 'progress' && selected) {
    const rows = db
      .prepare('SELECT total_score, created_at FROM online_results WHERE patient_id = ? AND instrument = ? ORDER BY created_at ASC, id ASC')
      .all(id, selected);
    const ins = catalog.getTakeable(selected);
    const max = ins && ins.maxPerItem !== undefined && selected !== 'cssrs' ? ins.items.length * ins.maxPerItem : undefined;
    const points = rows.map((r) => ({ t: r.created_at, v: r.total_score, label: `${r.created_at.slice(0, 10)}: ${r.total_score}` }));
    chart = {
      points: rows,
      svg: points.length >= 2 ? charts.lineChart(points, { min: 0, max, title: `Динамика: ${selected}` }) : '',
      single: points.length === 1,
    };
  }

  res.render('patient/tests', {
    title: 'Тесты',
    tab,
    pending,
    done,
    codes,
    selected,
    chart,
    linked: clinicianLink(id).length > 0,
    RESULT_DISCLAIMER,
  });
});

// ---------- Прохождение ----------

function loadTakeable(req, res) {
  const assignment = ownAssignment(req);
  if (!assignment) {
    notFound(res, 'Назначение не найдено.');
    return null;
  }
  const instrument = catalog.getTakeable(assignment.instrument);
  if (!instrument) {
    notFound(res, 'Методика недоступна для самостоятельного прохождения.');
    return null;
  }
  return { assignment, instrument };
}

router.get('/assignments/:id/take', requirePermission('test.take'), (req, res) => {
  const ctx = loadTakeable(req, res);
  if (!ctx) return;
  const { assignment, instrument } = ctx;
  if (assignment.status === 'completed') return res.redirect(`/assignments/${assignment.id}/result`);
  const answers = readDraft(assignment.id);
  const total = instrument.items.length;
  let i = Number.parseInt(req.query.i, 10);
  if (!Number.isInteger(i)) {
    const first = firstUnanswered(instrument, answers);
    return res.redirect(first === -1 ? `/assignments/${assignment.id}/review` : `/assignments/${assignment.id}/take?i=${first}`);
  }
  if (i < 0 || i >= total) return res.redirect(`/assignments/${assignment.id}/review`);
  res.render('patient/take', {
    title: instrument.code === 'cssrs' ? require('../../format').instrumentLabelFor('patient', 'cssrs') : instrument.title,
    assignment,
    instrument,
    isStub: instrument.status === 'stub',
    i,
    total,
    item: itemText(instrument.items[i]),
    current: answers[i],
    isCritical: criticalIndexes(assignment.instrument).includes(i),
    showSupportInline: criticalHit(assignment.instrument, answers),
    answeredCount: Object.keys(answers).length,
  });
});

// Сохранение ответа на каждом шаге (REQ-PAT-008): работает без JS.
router.post('/assignments/:id/answer', requirePermission('test.take'), (req, res) => {
  const ctx = loadTakeable(req, res);
  if (!ctx) return;
  const { assignment, instrument } = ctx;
  if (assignment.status === 'completed') return res.redirect(`/assignments/${assignment.id}/result`);
  const i = Number.parseInt(req.body.i, 10);
  const v = Number.parseInt(req.body.value, 10);
  const allowed = instrument.options.map((o) => o.value);
  if (!Number.isInteger(i) || i < 0 || i >= instrument.items.length) return res.redirect(`/assignments/${assignment.id}/take`);
  if (!allowed.includes(v)) {
    flash(req, 'Выберите один из вариантов ответа.', 'error');
    return res.redirect(`/assignments/${assignment.id}/take?i=${i}`);
  }
  const answers = readDraft(assignment.id);
  answers[i] = v;
  saveDraft(assignment, answers);
  const next = i + 1;
  res.redirect(next >= instrument.items.length ? `/assignments/${assignment.id}/review` : `/assignments/${assignment.id}/take?i=${next}`);
});

router.get('/assignments/:id/review', requirePermission('test.take'), (req, res) => {
  const ctx = loadTakeable(req, res);
  if (!ctx) return;
  const { assignment, instrument } = ctx;
  if (assignment.status === 'completed') return res.redirect(`/assignments/${assignment.id}/result`);
  const answers = readDraft(assignment.id);
  const rows = instrument.items.map((it, idx) => {
    const opt = instrument.options.find((o) => o.value === answers[idx]);
    return { idx, text: itemText(it), answer: opt ? opt.label : null };
  });
  res.render('patient/review', {
    title: 'Проверьте ответы',
    assignment,
    instrument,
    rows,
    missing: rows.filter((r) => r.answer === null),
    showSupportInline: criticalHit(assignment.instrument, answers),
  });
});

function finalize(assignment, instrument, answers) {
  const scored = catalog.scoreAny(assignment.instrument, answers);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const current = db.prepare('SELECT status FROM instrument_assignments WHERE id = ?').get(assignment.id);
    if (!current || current.status !== 'pending') return null; // идемпотентность
    const resultInfo = db
      .prepare(
        `INSERT INTO online_results
           (assignment_id, patient_id, instrument, answers_json, total_score, subscales_json, band, risk_flag, risk_reasons_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        assignment.id,
        assignment.patient_id,
        assignment.instrument,
        JSON.stringify(answers),
        scored.total,
        scored.subscales ? JSON.stringify(scored.subscales) : null,
        scored.band,
        scored.riskFlag ? 1 : 0,
        JSON.stringify(scored.riskReasons)
      );

    db.prepare("UPDATE instrument_assignments SET status = 'completed', completed_at = ? WHERE id = ?").run(now, assignment.id);
    db.prepare('DELETE FROM assignment_drafts WHERE assignment_id = ?').run(assignment.id);

    // Кризисный протокол (RES-2 "crisis-protocol" §2-3): Tier вычисляется
    // по сигналам конкретной шкалы, эскалация создаётся автоматически в той
    // же транзакции, что и сохранение результата. Логика перенесена без изменений.
    let tierResult = null;

    if (assignment.instrument === 'phq9') {
      const item9 = answers[INSTRUMENTS.phq9.criticalItemIndex];
      tierResult = crisisProtocol.evaluateCrisisTier({ phq9Item9: item9, severeMoodScreen: item9 === 0 && scored.total >= 20 });
      if (item9 >= 1) {
        const existingCssrs = db
          .prepare("SELECT 1 FROM instrument_assignments WHERE patient_id = ? AND instrument = 'cssrs' AND status = 'pending'")
          .get(assignment.patient_id);
        if (!existingCssrs) {
          const primaryClinician = escalation.resolvePrimaryClinician(assignment.patient_id);
          if (primaryClinician) {
            db.prepare('INSERT INTO instrument_assignments (patient_id, assigned_by, instrument, auto_assigned) VALUES (?, ?, ?, 1)').run(
              assignment.patient_id,
              primaryClinician,
              'cssrs'
            );
          }
        }
      }
    } else if (assignment.instrument === 'cssrs') {
      const { ideationLevel, behavior } = scored.subscales;
      const lastPhq9 = db
        .prepare("SELECT answers_json FROM online_results WHERE patient_id = ? AND instrument = 'phq9' ORDER BY created_at DESC LIMIT 1")
        .get(assignment.patient_id);
      const phq9Item9 = lastPhq9 ? JSON.parse(lastPhq9.answers_json)[INSTRUMENTS.phq9.criticalItemIndex] : null;
      tierResult = crisisProtocol.evaluateCrisisTier({ phq9Item9, cssrsIdeationLevel: ideationLevel, cssrsBehavior: behavior });
    } else if ((assignment.instrument === 'gad7' || assignment.instrument === 'hads') && scored.riskFlag) {
      tierResult = crisisProtocol.evaluateCrisisTier({ severeMoodScreen: true });
    }

    if (tierResult && tierResult.tier > crisisProtocol.TIERS.ROUTINE) {
      escalation.createEscalation({
        patientId: assignment.patient_id,
        onlineResultId: resultInfo.lastInsertRowid,
        instrument: assignment.instrument,
        reasons: scored.riskReasons.length ? scored.riskReasons : [`Уровень ${tierResult.tier}: ${tierResult.triggers.join(', ')}`],
        tier: tierResult.tier,
        triggers: tierResult.triggers,
      });
    }
    return resultInfo.lastInsertRowid;
  });
  return { scored, resultId: tx() };
}

router.post('/assignments/:id/submit', requirePermission('test.take'), (req, res) => {
  const ctx = loadTakeable(req, res);
  if (!ctx) return;
  const { assignment, instrument } = ctx;
  // повторная/двойная отправка: результат уже один, просто показываем его
  if (assignment.status === 'completed') return res.redirect(`/assignments/${assignment.id}/result`);

  const draft = readDraft(assignment.id);
  const allowed = instrument.options.map((o) => o.value);
  const answers = [];
  for (let idx = 0; idx < instrument.items.length; idx += 1) {
    const raw = req.body[`item_${idx}`];
    let v = raw === undefined || raw === '' ? NaN : Number.parseInt(raw, 10);
    if (Number.isNaN(v) && draft[idx] !== undefined) v = Number(draft[idx]);
    if (Number.isNaN(v) || !allowed.includes(v)) {
      flash(req, `Не заполнен пункт ${idx + 1}. Вернитесь к нему и ответьте — остальные ответы сохранены.`, 'info');
      return res.redirect(`/assignments/${assignment.id}/take?i=${idx}`);
    }
    answers.push(v);
  }

  let outcome;
  try {
    outcome = finalize(assignment, instrument, answers);
  } catch (e) {
    flash(req, `Не удалось обработать ответы: ${e.message}`, 'error');
    return res.redirect(`/assignments/${assignment.id}/take`);
  }
  res.redirect(`/assignments/${assignment.id}/result`);
});

// ---------- Результат ----------

router.get('/assignments/:id/result', patientPage, (req, res) => {
  const assignment = ownAssignment(req);
  if (!assignment) return notFound(res, 'Результат не найден.');
  if (assignment.status !== 'completed') return res.redirect(`/assignments/${assignment.id}/take`);
  const result = db.prepare('SELECT * FROM online_results WHERE assignment_id = ? AND patient_id = ? ORDER BY id DESC').get(assignment.id, req.session.user.id);
  if (!result) return notFound(res, 'Результат не найден.');
  const instrument = catalog.getTakeable(assignment.instrument);
  res.render('patient/result', {
    title: 'Результат',
    assignment,
    result,
    attention: !!result.risk_flag,
    isStub: !!(instrument && instrument.status === 'stub'),
    linked: clinicianLink(req.session.user.id).length > 0,
    text,
    RESULT_DISCLAIMER,
  });
});

module.exports = router;
module.exports.readDraft = readDraft;
