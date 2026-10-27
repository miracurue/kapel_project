'use strict';

/**
 * Шаблоны текстов врача (раздел «Документы», P-23). Врач пишет текст, сохраняет его как личный шаблон
 * (таблица tool_templates) и копирует в МИС. Заполненные экземпляры не хранятся. Кнопка «ИИ» составляет
 * шаблон по описанию врача: данных пациента в запросе нет, ответ — только текст с пометками [в скобках].
 * Пути — вне замороженного /api/v1: только психиатр и психолог, изменения — с CSRF-токеном сессии.
 */

const { isFullyAssigned, hasBaseConsent } = require('../../access/assignment');

const TITLE_MAX = 120;
const BODY_MAX = 10000;
const REQUEST_MAX = 1000;

const BUILTIN = {
  psychiatrist: [
    {
      id: 'b-visit',
      title: 'Запись приёма',
      body: [
        'Пациент: [ФИО]',
        'Дата приёма: [дата]',
        '',
        'Жалобы: [жалобы]',
        'Состояние: [психический статус]',
        'Результаты тестов: [результаты тестов]',
        'Лечение и рекомендации: [решение врача]',
        'Следующий визит: [срок]',
        '',
        'Врач: [врач]',
      ].join('\n'),
    },
    {
      id: 'b-referral',
      title: 'Направление на консультацию',
      body: [
        'Пациент: [ФИО]',
        'Дата: [дата]',
        'Направляет: [врач]',
        'Кому: [специалист или организация]',
        'Цель направления: [цель]',
        'Краткие сведения: [вносит врач]',
        'Результаты тестов: [результаты тестов]',
      ].join('\n'),
    },
    {
      id: 'b-memo',
      title: 'Памятка пациенту',
      body: [
        'Памятка пациенту',
        '',
        'Пациент: [ФИО]',
        'Дата: [дата]',
        '',
        '[рекомендации врача]',
        '',
        'Следующий приём: [дата и время]',
        'Если состояние резко ухудшилось или есть мысли о причинении себе вреда — звоните 112.',
        'Врач: [врач]',
      ].join('\n'),
    },
    {
      // Форма (бланк Росздравнадзора): не текст с метками, а заполняемые поля; из неё создаётся документ пациента.
      id: 'b-roszdravnadzor',
      kind: 'form',
      title: 'Извещение о нежелательной реакции (Росздравнадзор)',
      body: '',
    },
  ],
  psychologist: [
    {
      id: 'b-conclusion',
      title: 'Психологическое заключение',
      body: [
        'Психологическое заключение',
        '',
        'Пациент: [ФИО]',
        'Дата: [дата]',
        '',
        'Цель обследования: [цель]',
        'Использованные методики и результаты:',
        '[результаты тестов]',
        '',
        'Анализ результатов: [вносит психолог]',
        'Рекомендации: [рекомендации]',
        '',
        'Психолог: [врач]',
      ].join('\n'),
    },
    {
      // Структура — Приложение Г21 клинических рекомендаций «Паническое расстройство» (шаблон заключения ЭПИ).
      id: 'b-epi',
      title: 'Заключение по результатам ЭПИ',
      body: [
        'Заключение по результатам экспериментально-психологического исследования (ЭПИ)',
        '',
        'Пациент: [ФИО]',
        'Дата рождения: [дата рождения]',
        'Дата обследования: [дата]',
        '',
        'Цель исследования: [цели, поставленные перед психологом]',
        'Методы исследования: [использованные методы]',
        'Жалобы: [жалобы пациента]',
        '',
        'Результаты клинико-психологического обследования:',
        '[контакт, эмоциональный фон, речь, темп, работоспособность]',
        '',
        'Результаты экспериментально-психологического исследования:',
        'Внимание: [результаты по методикам, степень нарушений]',
        'Память: [результаты по методикам, степень нарушений]',
        'Мышление: [результаты по методикам, степень нарушений]',
        'Компоненты мышления: [операциональный; динамический; мотивационно-личностный]',
        'Эмоционально-волевая сфера: [тревожность, депрессия, контроль, фрустрированность]',
        'Личность: [свойства личности, самооценка, совладание, защиты]',
        '',
        'Выводы: [количественная и качественная характеристика нарушений]',
        'Заключение: [обобщённая квалификация нарушений]',
        'Рекомендации: [мишени психокоррекции; повторное ЭПИ; психотерапия]',
        '',
        'Психолог: [врач]',
      ].join('\n'),
    },
    {
      id: 'b-referral',
      title: 'Направление на консультацию',
      body: [
        'Пациент: [ФИО]',
        'Дата: [дата]',
        'Направляет: [врач]',
        'Кому: [специалист или организация]',
        'Цель направления: [цель]',
        'Результаты тестов: [результаты тестов]',
      ].join('\n'),
    },
    {
      id: 'b-memo',
      title: 'Памятка пациенту',
      body: [
        'Памятка пациенту',
        '',
        'Пациент: [ФИО]',
        'Дата: [дата]',
        '',
        '[рекомендации]',
        '',
        'Если тяжело — звоните 112.',
        'Психолог: [врач]',
      ].join('\n'),
    },
  ],
};

const clean = (s, max) =>
  String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, max);

function install(app, h) {
  const { db, P, pii, gateway } = h;

  const guard = (req, res, mutating) => {
    const user = req.user;
    if (!user) {
      P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      return null;
    }
    if (!['psychiatrist', 'psychologist'].includes(user.role)) {
      P.sendError(req, res, 403, 'E-ACCESS');
      return null;
    }
    if (mutating && (!req.session || req.headers['x-csrf-token'] !== req.session.data.csrf)) {
      P.sendError(req, res, 403, 'E-CSRF');
      return null;
    }
    return user;
  };

  const invalid = (req, res, field) =>
    P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field, key: 'err.e-validation' }] });

  const messagesOf = (items) =>
    (Array.isArray(items) ? items : [])
      .slice(-40)
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && ['done', 'error'].includes(m.status))
      .map((m) => ({ role: m.role, text: clean(m.text, REQUEST_MAX), status: m.status }));
  const view = (r) => ({
    id: String(r.id),
    title: r.title,
    body: r.body,
    messages: JSON.parse(r.messages_json || '[]'),
    updated_at: r.updated_at || r.created_at,
  });

  app.get('/work/api/templates', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const own = db
      .prepare(
        'SELECT id,title,body,messages_json,created_at,updated_at FROM tool_templates WHERE owner_id=? ORDER BY id DESC',
      )
      .all(user.id)
      .map(view);
    return res.json({ own, builtin: (BUILTIN[user.role] || []).map((t) => ({ kind: 'text', ...t })) });
  });

  app.post('/work/api/templates', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const title = clean(req.body && req.body.title, TITLE_MAX).trim();
    const body = clean(req.body && req.body.body, BODY_MAX);
    if (!title) return invalid(req, res, 'title');
    if (!body.trim()) return invalid(req, res, 'body');
    const info = db
      .prepare('INSERT INTO tool_templates(owner_id,title,body,messages_json) VALUES (?,?,?,?)')
      .run(user.id, title, body, JSON.stringify(messagesOf(req.body.messages)));
    const row = db.prepare('SELECT * FROM tool_templates WHERE id=?').get(info.lastInsertRowid);
    return res.status(201).json(view(row));
  });

  app.put('/work/api/templates/:id', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const id = Number(req.params.id);
    const title = clean(req.body && req.body.title, TITLE_MAX).trim();
    const body = clean(req.body && req.body.body, BODY_MAX);
    if (!title) return invalid(req, res, 'title');
    if (!body.trim()) return invalid(req, res, 'body');
    const existing = db.prepare('SELECT messages_json FROM tool_templates WHERE id=? AND owner_id=?').get(id, user.id);
    if (!existing) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const messages =
      req.body.messages === undefined ? existing.messages_json : JSON.stringify(messagesOf(req.body.messages));
    const done = db
      .prepare(
        "UPDATE tool_templates SET title=?, body=?, messages_json=?, updated_at=datetime('now') WHERE id=? AND owner_id=?",
      )
      .run(title, body, messages, id, user.id);
    if (!done.changes) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    return res.json(view(db.prepare('SELECT * FROM tool_templates WHERE id=?').get(id)));
  });

  app.delete('/work/api/templates/:id', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const done = db.prepare('DELETE FROM tool_templates WHERE id=? AND owner_id=?').run(Number(req.params.id), user.id);
    if (!done.changes) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    return res.json({ ok: true });
  });

  // Кнопка «ИИ»: шаблон по описанию врача. Данных пациента в запросе нет; описание проходит псевдонимизацию F-80.
  app.post('/work/api/templates/ai', async (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const request = clean(req.body && req.body.request, REQUEST_MAX).trim();
    if (!request) return invalid(req, res, 'request');
    try {
      const scope = { scopeType: 'thread', scopeId: -user.id };
      // User instruction, current draft and conversation are model data, separate from the versioned system prompt.
      const context = req.body.current || {};
      const modelData =
        !context.body && !context.title && !req.body.history?.length
          ? request
          : JSON.stringify({
              request,
              current: { title: clean(context.title, TITLE_MAX), body: clean(context.body, BODY_MAX) },
              history: messagesOf(req.body.history).slice(-12),
            });
      const ner = await pii.nerDetect(modelData);
      const pseudo = pii.pseudonymize(modelData, scope, { nerEntities: ner.entities, nerOk: ner.ok });
      const out = await gateway.run({
        purpose: 'document_draft',
        promptKey: 'task.document_template',
        user,
        text: pseudo.text,
        question: request,
        piiCounts: pseudo.counts || {},
        piiMode: pseudo.mode,
      });
      // Нецелевой запрос (слой guard.scope_clinician): сообщение выводится в чате, шаблон не меняется и не создаётся.
      if (out.offTopic) return res.json({ off_topic: true, message: out.text, ai: true });
      if (out.status === 'filtered' || !String(out.text || '').trim()) return P.sendError(req, res, 502, 'E-AI-EMPTY');
      const body = clean(pii.reveal(out.text, scope).text, BODY_MAX).trim();
      return res.json({ body, ai: true });
    } catch (e) {
      if (h.isGatewayError(e)) return h.sendGatewayError(res, e);
      throw e;
    }
  });

  // Значения для меток [ФИО], [дата], [врач], [результаты тестов] — по явно выбранному закреплённому пациенту.
  app.get('/work/api/templates/patient/:pid', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const pid = Number(req.params.pid);
    if (!isFullyAssigned(db, pid, user.id)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (!hasBaseConsent(db, pid)) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
    const name = db.prepare('SELECT full_name FROM users WHERE id=?').get(pid);
    const results = db
      .prepare(
        'SELECT instrument,total_score,band,created_at FROM online_results WHERE patient_id=? AND invalid_at IS NULL AND (self_initiated=0 OR shared_at IS NOT NULL) ORDER BY id DESC LIMIT 5',
      )
      .all(pid)
      .map(
        (r) =>
          `${r.instrument} (${String(r.created_at).slice(0, 10).split('-').reverse().join('.')}): ${r.total_score}${r.band ? `, ${r.band}` : ''}`,
      );
    db.prepare(
      "INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis) VALUES (?,?,?,'export','view','allow','assignment')",
    ).run(user.id, user.role, pid);
    const today = h.nowIso().slice(0, 10).split('-').reverse().join('.');
    return res.json({
      ФИО: (name && name.full_name) || '',
      дата: today,
      врач: user.full_name || '',
      'результаты тестов': results.join('\n'),
    });
  });
}

module.exports = { install, BUILTIN, TITLE_MAX, BODY_MAX };
