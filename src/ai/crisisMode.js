'use strict';

/**
 * Кризисный режим чата пациента: сценарные тексты, оценка ИИ внутри разговора и её запись.
 *
 * Принципы (решение владельца 2026-10-26, .agents/tasks/2026-10-26-patient-crisis-mode.md):
 *  - сигнал врачу создаёт код (crisisGate / кнопка), раньше модели и независимо от неё;
 *  - телефоны и первое сообщение — из кода; модель телефоны не выдумывает;
 *  - если модель недоступна, нет согласия на ИИ или ответ отфильтрован, разговор идёт по сценарию ниже;
 *  - оценка ИИ (assess_crisis) только ДОПОЛНЯЕТ карточку врача и может ПОДНЯТЬ уровень сигнала; она не отменяет и
 *    не закрывает сигнал, это делает только врач;
 *  - ВСЕ формулировки review-required: их утверждает клинический владелец.
 */

const { computeDueAt } = require('../crisisProtocol');

const LEVELS = [
  'accidental',
  'distress_no_risk',
  'passive_ideation',
  'active_ideation',
  'plan_or_intent',
  'attempt_in_progress',
];
const TRI = ['yes', 'no', 'unknown'];
const CONFIDENCE = ['low', 'medium', 'high'];
// Уровни, при которых код добавляет к ответу прямое «звони 112» и поднимает сигнал до уровня 3.
const URGENT_LEVELS = new Set(['plan_or_intent', 'attempt_in_progress']);

const LEVEL_LABELS = {
  accidental: 'похоже на случайное срабатывание',
  distress_no_risk: 'тяжело, прямой угрозы жизни не видно',
  passive_ideation: 'пассивные мысли о нежелании жить',
  active_ideation: 'активные мысли о самоубийстве',
  plan_or_intent: 'есть план или намерение',
  attempt_in_progress: 'попытка идёт или только что была',
};

// ---- Тексты сценария (пациенту, на «ты», без форм рода) ----
// Шаги ведут разговор только словами и вопросами: без упражнений, методик и ссылок на разделы (решение 2026-10-26, review-required).
const OPENING_WITH_CLINICIAN =
  'Я здесь, с тобой. Мне важно, что тебе сейчас тяжело. Сигнал уже передан твоему врачу: он увидит его в своём кабинете, ' +
  'но может ответить не сразу. Если опасность прямо сейчас, позвони 112 — номер всегда наверху. ' +
  'Скажи, это вышло случайно или тебе правда так тяжело? И ты сейчас в безопасности?';
const OPENING_NO_CLINICIAN =
  'Я здесь, с тобой. Мне важно, что тебе сейчас тяжело. Сигнал передан дежурному администратору сервиса — это не служба ' +
  'экстренной помощи, и ответ может прийти не сразу. Если опасность прямо сейчас, позвони 112 — номер всегда наверху. ' +
  'Скажи, это вышло случайно или тебе правда так тяжело? И ты сейчас в безопасности?';
const OPENING_NOT_DELIVERED =
  'Я здесь, с тобой. Мне не удалось передать сигнал внутри сервиса. Если опасность прямо сейчас, позвони 112 или обратись ' +
  'к врачу напрямую. Скажи, это вышло случайно или тебе правда так тяжело? И ты сейчас в безопасности?';

const STEPS = [
  'Спасибо, что говоришь об этом. Тебе не нужно справляться в одиночку. Есть ли рядом человек, которому можно позвонить или ' +
    'попросить побыть с тобой?',
  'Я здесь и никуда не ухожу. Расскажи, где ты сейчас находишься и что видишь вокруг себя? Можно просто назвать пару ' +
    'предметов, мне важно слышать тебя.',
  'Спасибо, что отвечаешь. Как ты сейчас себя чувствуешь: что в теле, что в мыслях? Можно сказать одним словом или ' +
    'длинно, как получится.',
  'Если рядом есть то, чем можно навредить себе, постарайся убрать это подальше или попроси кого-то забрать. ' +
    'Я здесь. Что сейчас происходит?',
];
const STEP_TAIL = ' Если станет опаснее, звони 112.';

const URGENT_LINE =
  'Мне важна твоя безопасность прямо сейчас. Позвони 112 или попроси того, кто рядом, позвонить. Я остаюсь с тобой в чате.';

// Что видит пациент о судьбе сигнала: честно, без обещаний срока.
const WATCH = {
  new: 'Сигнал передан, врач его пока не открыл.',
  in_work: 'Врач увидел сигнал и взялся за него.',
  handled: 'Врач отметил сигнал как обработанный.',
};

function openingText({ hasClinician, delivered }) {
  if (!delivered) return OPENING_NOT_DELIVERED;
  return hasClinician ? OPENING_WITH_CLINICIAN : OPENING_NO_CLINICIAN;
}

/** Ответ по сценарию: n — сколько сообщений ассистента уже в треде (включая первое). */
function scriptedReply(assistantCount) {
  const i = Math.max(0, assistantCount - 1) % STEPS.length;
  // «Звони 112» не в каждом шаге: карточка с номером закреплена вверху, повтор в каждом ответе звучит как отписка.
  return i % 2 === 0 ? STEPS[i] + STEP_TAIL : STEPS[i];
}

// Отказ самого провайдера на чувствительную тему (канцелярская заглушка вместо ответа): пациенту её не показываем.
const PROVIDER_REFUSAL_RE =
  /генеративные языковые модели|чувствительные темы|временно ограничен|не могу обсуждать эту тему/i;
const isProviderRefusal = (text) => PROVIDER_REFUSAL_RE.test(String(text || ''));

// Вопрос о случайности и безопасности (серверная гарантия: ответ модели без него дополняется одним из вариантов).
const CLARIFY_QUESTIONS = [
  'Скажи, это вышло случайно или ты правда так думаешь? И ты сейчас в безопасности?',
  'Ты сейчас в безопасности? Расскажи, это было сказано в моменте или такие мысли с тобой сейчас?',
  'Эти мысли про смерть сейчас с тобой всерьёз или это был порыв? Ты в безопасности?',
];
const SAFETY_QUESTION_RE = /[^.!?]*(безопасн|случайно|всерь[её]з|правда так|мысли про смерть)[^.!?]*\?/i;
const hasClarifyingQuestion = (text) => SAFETY_QUESTION_RE.test(String(text || ''));

/**
 * Дописывает вопрос только если в ответе модели вообще нет вопроса и это один из первых двух ответов модели в треде
 * (assistantCount — сколько сообщений ассистента уже есть, включая сценарное первое). Если о случайности уже
 * спрашивали (askedBefore), дописывается только вопрос о безопасности. accidental — человек сам сказал, что случайно.
 */
function withClarifyingQuestion(reply, assistantCount, level, askedBefore = false) {
  if (level === 'accidental' || assistantCount > 2 || /\?/.test(String(reply))) return reply;
  const question = askedBefore ? 'Ты сейчас в безопасности?' : CLARIFY_QUESTIONS[0];
  return `${String(reply).trim()}\n\n${question}`;
}

// В ответе уже есть призыв к экстренной помощи: код не добавляет свою строку.
const mentionsEmergency = (text) => /112|скор(ая|ую|ой)\b|экстренн/i.test(String(text || ''));

/** Убирает из ответа предложения с «112», если номер уже звучал в последних ответах (карточка наверху остаётся). */
function withoutRepeated112(reply, recentAssistantTexts) {
  if (!recentAssistantTexts.some((t) => /112/.test(t))) return reply;
  const parts = String(reply).match(/[^.!?\n]+[.!?]*\s*/g) || [];
  const kept = parts
    .filter((x) => !/112/.test(x))
    .join('')
    .trim();
  return kept || reply;
}

// ---- Оценка ИИ ----
const ASSESS_TOOL = {
  name: 'assess_crisis',
  description:
    'Записать оценку ситуации собеседника для врача. Вызывай в начале каждого ответа. Это заметка для врача, собеседник её не видит, она не отменяет сигнал.',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: LEVELS, description: 'Уровень по всему разговору на сейчас' },
      safe_now: { type: 'string', enum: TRI, description: 'Безопасен ли собеседник прямо сейчас' },
      alone: { type: 'string', enum: TRI, description: 'Один ли собеседник' },
      means: { type: 'string', enum: TRI, description: 'Есть ли под рукой средства для самоповреждения' },
      confidence: { type: 'string', enum: CONFIDENCE, description: 'Уверенность в уровне' },
      note: {
        type: 'string',
        maxLength: 300,
        description: 'Одно-два предложения для врача: на чём основана оценка. Без имён и контактов.',
      },
    },
    required: ['level', 'safe_now', 'confidence', 'note'],
  },
};

const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);

/** Приводит аргументы вызова к допустимому виду; null, если уровня нет вовсе. */
function normalizeAssessment(args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!LEVELS.includes(a.level)) return null;
  return {
    level: a.level,
    safe_now: oneOf(a.safe_now, TRI, 'unknown'),
    alone: oneOf(a.alone, TRI, 'unknown'),
    means: oneOf(a.means, TRI, 'unknown'),
    confidence: oneOf(a.confidence, CONFIDENCE, 'low'),
    // Метки псевдонимизации #ТИП-N# врачу ни к чему: имён в заметке быть не должно.
    note: String(a.note || '')
      .replace(/#[A-Za-zА-Яа-я_]+-\d+#/g, '[имя]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300),
  };
}

const isUrgent = (a) => Boolean(a) && (URGENT_LEVELS.has(a.level) || a.safe_now === 'no');

/**
 * Записывает оценку и, если она тяжёлая, поднимает уровень сигнала до 3 (срок реакции только сокращается).
 * Понижать уровень и закрывать сигнал оценка не может.
 */
function recordAssessment(
  db,
  { escalationId, patientId, threadId, assessment, modelId = null, promptVersion = null, now = new Date() },
) {
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const info = db
    .prepare(
      'INSERT INTO crisis_ai_assessments(escalation_id,patient_id,thread_id,level,safe_now,alone,means,confidence,note_enc,model_id,prompt_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      escalationId,
      patientId,
      threadId,
      assessment.level,
      assessment.safe_now,
      assessment.alone,
      assessment.means,
      assessment.confidence,
      assessment.note || null,
      modelId,
      promptVersion,
      at,
    );
  let raised = false;
  if (URGENT_LEVELS.has(assessment.level)) {
    const row = db.prepare('SELECT tier, due_at, status FROM crisis_escalations WHERE id=?').get(escalationId);
    if (row && row.tier < 3 && row.status !== 'handled') {
      const due = computeDueAt(3, now);
      db.prepare(
        'UPDATE crisis_escalations SET tier=3, due_at=CASE WHEN ? IS NOT NULL AND (due_at IS NULL OR ? < due_at) THEN ? ELSE due_at END WHERE id=?',
      ).run(due, due, due, escalationId);
      const clinicians = db
        .prepare(
          "SELECT ca.clinician_id FROM care_assignments ca JOIN users c ON c.id=ca.clinician_id WHERE ca.patient_id=? AND ca.ended_at IS NULL AND c.status='active'",
        )
        .all(patientId);
      for (const { clinician_id: recipient } of clinicians) {
        db.prepare(
          "INSERT OR IGNORE INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'crisis',?,'crisis',?,'Уровень сигнала безопасности повышен',?,?,'active',?)",
        ).run(recipient, `crisis_ai:${escalationId}:${recipient}`, escalationId, patientId, at, at);
      }
      raised = true;
    }
  }
  return { id: Number(info.lastInsertRowid), raised };
}

/** Последняя оценка по сигналу в виде для карточки врача; null, если оценки нет. */
function latestAssessment(db, escalationId) {
  const row = db
    .prepare('SELECT * FROM crisis_ai_assessments WHERE escalation_id=? ORDER BY id DESC LIMIT 1')
    .get(escalationId);
  if (!row) return null;
  return {
    level: row.level,
    level_label: LEVEL_LABELS[row.level],
    safe_now: row.safe_now,
    alone: row.alone,
    means: row.means,
    confidence: row.confidence,
    note: row.note_enc || '',
    created_at: row.created_at,
    count: db.prepare('SELECT COUNT(*) n FROM crisis_ai_assessments WHERE escalation_id=?').get(escalationId).n,
  };
}

/** Состояние сигнала для пациента (опрос из чата). */
function statusOf(db, escalationId) {
  const row = escalationId
    ? db.prepare('SELECT status, taken_at, handled_at FROM crisis_escalations WHERE id=?').get(escalationId)
    : null;
  if (!row) return null;
  return {
    status: row.status,
    taken_at: row.taken_at || null,
    handled_at: row.handled_at || null,
    text: WATCH[row.status] || WATCH.new,
  };
}

/**
 * Набор инструментов для gateway.run: один вызов assess_crisis в начале ответа.
 * onAssessed получает уже записанную и приведённую оценку.
 */
function createTools({ db, escalationId, patientId, threadId, now = () => new Date(), onAssessed = () => {} }) {
  return {
    definitions: [ASSESS_TOOL],
    maxCalls: 1,
    rulesKey: 'tools.crisis',
    card: '',
    execute(name, args) {
      if (name !== 'assess_crisis') throw new Error(`unknown tool ${name}`);
      const assessment = normalizeAssessment(args);
      if (!assessment) return 'Оценка не записана: укажи допустимый уровень. Теперь ответь собеседнику.';
      const saved = recordAssessment(db, { escalationId, patientId, threadId, assessment, now: now() });
      onAssessed(assessment, saved);
      return 'Оценка записана. Теперь ответь собеседнику.';
    },
  };
}

module.exports = {
  LEVELS,
  LEVEL_LABELS,
  URGENT_LEVELS,
  URGENT_LINE,
  openingText,
  scriptedReply,
  isProviderRefusal,
  withClarifyingQuestion,
  hasClarifyingQuestion,
  mentionsEmergency,
  withoutRepeated112,
  normalizeAssessment,
  isUrgent,
  recordAssessment,
  latestAssessment,
  statusOf,
  createTools,
};
