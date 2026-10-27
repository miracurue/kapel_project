'use strict';

// Опрос о побочном эффекте: общие помощники для пациента, психиатра и психолога.
// План: .agents/tasks/2026-10-23-ae-intake.md (пакет B). Ничего наружу не отправляется.

const TEXTS = require('../../../locales/ru.json');

const SEVERITIES = ['mild', 'noticeable', 'severe'];
const DECISIONS = { probable: 'related_likely', unrelated: 'not_related', insufficient: 'insufficient' };
const t = (key, fallback = '') => TEXTS[key] || fallback || key;

/**
 * Коды симптомов-подсказок (msg.ae.chip.*). Свободные слова сюда не попадают: коды выводятся в сводку чата и в историю
 * модели, поэтому остаются только строки вида nausea, dizzy. Не массив - ошибка (null), лишние элементы отбрасываются.
 */
function normalizeSymptoms(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) return null;
  return [...new Set(raw.filter((x) => typeof x === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(x)))].slice(0, 10);
}

/** Действующие препараты опубликованного плана пациента (только для проверок на сервере). */
function activePlanItems(db, patientId, isoNow) {
  const plan = db
    .prepare(
      "SELECT id FROM plan_versions WHERE patient_id=? AND status='published' AND (visible_from IS NULL OR visible_from<=?) ORDER BY version DESC LIMIT 1",
    )
    .get(patientId, isoNow);
  if (!plan) return [];
  return db
    .prepare(
      "SELECT pi.item_key,pi.inn_id,i.name inn_name FROM plan_items pi JOIN inn i ON i.id=pi.inn_id WHERE pi.plan_version_id=? AND pi.status='active' AND (pi.end_date IS NULL OR pi.end_date>=?) ORDER BY pi.id",
    )
    .all(plan.id, isoNow.slice(0, 10));
}

const psychiatristOf = (db, patientId) =>
  db
    .prepare(
      "SELECT ca.clinician_id FROM care_assignments ca JOIN users u ON u.id=ca.clinician_id WHERE ca.patient_id=? AND ca.ended_at IS NULL AND u.role='psychiatrist' ORDER BY ca.id LIMIT 1",
    )
    .get(patientId);

/**
 * Можно ли предлагать карточку опроса в чате.
 * Пациент - всегда; психиатр - если в плане пациента есть действующий препарат;
 * психолог - если у пациента есть закреплённый психиатр И действующий препарат.
 * Отдаёт только булев флаг: состав плана психологу не раскрывается.
 */
function offerEligibility({ db, iso }, { user, patientId }) {
  if (!user) return false;
  if (user.role === 'patient') return true;
  if (!['psychiatrist', 'psychologist'].includes(user.role)) return false;
  const own = db
    .prepare(
      "SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL AND COALESCE(end_reason,'')<>'signal_only'",
    )
    .get(patientId, user.id);
  if (!own) return false;
  if (user.role === 'psychologist' && !psychiatristOf(db, patientId)) return false;
  return activePlanItems(db, patientId, iso()).length > 0;
}

/** Тред чата, из которого пришла запись: свой и по правильному пациенту, иначе null. */
function ownThread(db, user, patientId, threadId) {
  const id = Number(threadId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare('SELECT * FROM ai_threads WHERE id=? AND owner_user_id=? AND hidden_at IS NULL')
    .get(id, user.id);
  if (!row) return null;
  if (user.role === 'patient') return row.purpose === 'patient_assistant' ? row : null;
  return row.purpose === 'clinician_chat' && row.patient_id === patientId ? row : null;
}

function symptomLabel(code) {
  return TEXTS[`msg.ae.chip.${code}`] || String(code);
}

/** Короткая сводка из структурированных полей (свободный текст описания в чат не копируется). */
function summaryText(kind, ae, extra = {}) {
  const parts = [];
  const symptoms = JSON.parse(ae.complaint_codes_json || '[]')
    .map(symptomLabel)
    .filter(Boolean);
  if (symptoms.length) parts.push(symptoms.slice(0, 5).join(', '));
  if (extra.drug) parts.push(`${t('msg.ae.chat.part.drug')} ${extra.drug}`);
  if (ae.severity) parts.push(`${t('msg.ae.chat.part.severity')} ${t(`msg.ae.chat.severity.${ae.severity}`)}`);
  if (ae.onset_date) parts.push(`${t('msg.ae.chat.part.onset')} ${ae.onset_date}`);
  const details = parts.length ? ` (${parts.join('; ')})` : '';
  return t(`msg.ae.chat.summary.${kind}`)
    .replace('{details}', details)
    .replace('{decision}', extra.decision ? t(`msg.ae.chat.decision.${extra.decision}`) : '');
}

function drugName(db, ae) {
  if (ae.item_key || ae.inn_id) {
    const row = ae.inn_id ? db.prepare('SELECT name FROM inn WHERE id=?').get(ae.inn_id) : null;
    if (row) return row.name;
  }
  return ae.med_text_enc || '';
}

/** Пишет сводку в тред; она входит в историю модели (kind не 'error'/'crisis'). */
function writeSummary(db, { threadId, text, iso }) {
  const at = iso();
  const info = db
    .prepare(
      "INSERT INTO ai_messages(thread_id,role,text,kind,ai_generated,created_at) VALUES (?,'assistant',?,'ae_summary',0,?)",
    )
    .run(threadId, text, at);
  db.prepare('UPDATE ai_threads SET last_message_at=?, updated_at=? WHERE id=?').run(at, at, threadId);
  return { id: Number(info.lastInsertRowid), role: 'assistant', kind: 'ae_summary', text, created_at: at };
}

/** Разбор поля med у клинициста: ссылка на план/препарат пациента/МНН или свободный текст. */
function clinicianMed({ db, iso, role, patientId }, med) {
  if (med === undefined || med === null) return { itemKey: null, patientMedId: null, innId: null, medText: null };
  if (typeof med !== 'object' || Array.isArray(med)) return { error: true };
  const name = med.name == null ? null : String(med.name).trim().slice(0, 200) || null;
  if (role === 'psychologist') {
    if (med.item_key || med.patient_med_id || med.inn_id) return { error: true };
    return { itemKey: null, patientMedId: null, innId: null, medText: name };
  }
  if (med.kind === 'none') return { error: true };
  let itemKey = null;
  let patientMedId = null;
  let innId = null;
  if (med.item_key) {
    const item = activePlanItems(db, patientId, iso()).find((x) => x.item_key === String(med.item_key));
    if (!item) return { error: true };
    itemKey = item.item_key;
    innId = item.inn_id;
  } else {
    if (med.patient_med_id) {
      const own = db
        .prepare(
          'SELECT pm.id,pmv.inn_id FROM patient_meds pm JOIN patient_med_versions pmv ON pmv.patient_med_id=pm.id AND pmv.version=pm.current_version WHERE pm.id=? AND pm.patient_id=? AND pm.hidden_at IS NULL',
        )
        .get(Number(med.patient_med_id), patientId);
      if (!own) return { error: true };
      patientMedId = own.id;
      innId = own.inn_id;
    }
    if (med.inn_id) {
      if (!db.prepare('SELECT 1 FROM inn WHERE id=?').get(Number(med.inn_id))) return { error: true };
      innId = Number(med.inn_id);
    }
  }
  return { itemKey, patientMedId, innId, medText: itemKey || patientMedId ? null : name };
}

function install(secured, { db, P, iso, notify, assigned }) {
  secured.get('/api/v1/patients/:patientId/adverse-events/offer', (req, res) => {
    const patientId = Number(req.params.patientId);
    if (!assigned(req.user.id, patientId)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const hasPsychiatrist = Boolean(psychiatristOf(db, patientId));
    res.json({
      offer: offerEligibility({ db, iso }, { user: req.user, patientId }),
      can_report: req.user.role === 'psychiatrist' ? true : hasPsychiatrist,
      mode: req.user.role === 'psychiatrist' ? 'decision' : 'to_psychiatrist',
    });
  });

  secured.post('/api/v1/patients/:patientId/adverse-events', (req, res) => {
    const patientId = Number(req.params.patientId);
    if (!assigned(req.user.id, patientId)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const body = req.body || {};
    const isPsychiatrist = req.user.role === 'psychiatrist';
    const text = String(body.text || '');
    const bad =
      !text.trim() ||
      text.length > 1000 ||
      !SEVERITIES.includes(body.severity) ||
      (body.source !== undefined && !['form', 'ai_chat'].includes(body.source)) ||
      (body.started_on !== undefined &&
        body.started_on !== null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(String(body.started_on))) ||
      normalizeSymptoms(body.symptoms) === null ||
      (isPsychiatrist
        ? !Object.hasOwn(DECISIONS, body.decision) ||
          (body.comment != null && (typeof body.comment !== 'string' || body.comment.length > 1000))
        : body.decision !== undefined || body.serious !== undefined || body.comment !== undefined);
    if (bad) return P.sendError(req, res, 422, 'E-VALIDATION');
    const med = clinicianMed({ db, iso, role: req.user.role, patientId }, body.med);
    if (med.error) return P.sendError(req, res, 422, 'E-VALIDATION');
    let thread = null;
    if (body.thread_id !== undefined && body.thread_id !== null) {
      thread = ownThread(db, req.user, patientId, body.thread_id);
      if (!thread) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    }
    const psychiatrist = isPsychiatrist ? { clinician_id: req.user.id } : psychiatristOf(db, patientId);
    if (!psychiatrist) return P.sendError(req, res, 409, 'E-NO-PSYCHIATRIST');
    const restricted = db
      .prepare(
        "SELECT 1 FROM data_subject_requests WHERE patient_id=? AND request_type='erasure' AND status IN ('submitted','in_work','waiting_crisis')",
      )
      .get(patientId);
    if (restricted) return P.sendError(req, res, 409, 'E-STATUS');

    const at = iso();
    const status = isPsychiatrist ? DECISIONS[body.decision] : 'awaiting_doctor';
    const info = db
      .prepare(
        'INSERT INTO adverse_events(patient_id,complaint_codes_json,description_enc,onset_date,severity,item_key,patient_med_id,inn_id,source,status,visible_from,psychiatrist_id,decision_by,decision_at,serious,decision_comment_enc,reported_by,med_text_enc,thread_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        patientId,
        JSON.stringify(normalizeSymptoms(body.symptoms)),
        text,
        body.started_on || null,
        body.severity,
        med.itemKey,
        med.patientMedId,
        med.innId,
        body.source === 'ai_chat' ? 'ai_chat' : 'form',
        status,
        at,
        psychiatrist.clinician_id,
        isPsychiatrist ? req.user.id : null,
        isPsychiatrist ? at : null,
        isPsychiatrist ? (body.serious ? 1 : 0) : null,
        isPsychiatrist ? body.comment || null : null,
        req.user.id,
        med.medText,
        thread ? thread.id : null,
        at,
        at,
      );
    const id = Number(info.lastInsertRowid);
    if (isPsychiatrist)
      notify(patientId, 'ae_reviewed', 'adverse_event', id, patientId, 'Специалист посмотрел ваше сообщение');
    else
      notify(
        psychiatrist.clinician_id,
        'ae',
        'adverse_event',
        id,
        patientId,
        'Новое наблюдение психолога о переносимости',
      );
    const response = {
      ae: {
        id,
        version: 1,
        status,
        ...(isPsychiatrist ? { decision: body.decision } : {}),
        attached: true,
      },
      notice_available: isPsychiatrist && body.decision === 'probable',
    };
    if (thread) {
      const ae = db.prepare('SELECT * FROM adverse_events WHERE id=?').get(id);
      response.summary = writeSummary(db, {
        threadId: thread.id,
        iso,
        text: summaryText(isPsychiatrist ? 'clinician_decided' : 'to_psychiatrist', ae, {
          drug: isPsychiatrist ? drugName(db, ae) : med.medText || '',
          decision: isPsychiatrist ? body.decision : null,
        }),
      });
    }
    res.status(201).json(response);
  });
}

module.exports = {
  install,
  normalizeSymptoms,
  offerEligibility,
  activePlanItems,
  psychiatristOf,
  ownThread,
  summaryText,
  drugName,
  writeSummary,
  SEVERITIES,
};
