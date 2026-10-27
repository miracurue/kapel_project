'use strict';

/**
 * Лекарства в общем чате специалиста (/work?tab=chat): поиск по каталогу, карточка препарата и ИИ-чат о нём.
 * Клиент — public/js/work_chat.js (выбор «пациент или лекарство» вверху левой панели).
 * Пути — вне замороженного /api/v1: только психиатр и психолог, изменения — с CSRF-токеном сессии.
 *  GET  /work/api/drugs?q=&group=         — поиск по МНН и торговым названиям (без запроса — весь каталог);
 *  GET  /work/api/drugs/threads           — история: ИИ-чаты по препаратам (purpose = 'drug_chat');
 *  GET  /work/api/drugs/:inn_id           — карточка: группа, АТХ, торговые названия, материалы журнала;
 *  POST /work/api/drugs/:inn_id/open      — открыть препарат = новый чат (пустой чат без вопроса тоже остаётся в истории);
 *  POST /work/api/drugs/threads/:id/messages — вопрос ИИ о препарате этого чата (+ выдержки из инструкций, sources[]).
 * Инструкции, оглавление, разделы и поиск по хранилищу знаний — instructions.js.
 * Чат — обычный ai_threads/ai_messages: переименование, удаление, срок хранения и чтение сообщений идут общими
 * путями /api/v1/ai/threads. Данных пациентов в запросе к модели нет; текст врача проходит псевдонимизацию F-80.
 */

const { t } = require('../../i18n');
const { articlesForInn } = require('../library/authoring');
const instructions = require('./instructions');
const { createNumbering, snippetOf, stripMarkers } = require('../../ai/workspace/sources');

const PURPOSE = 'drug_chat';
const TEXT_MAX = 2000;
const SEARCH_MAX = 80;
const LIST_MAX = 60;
const BODY_FOR_MODEL_MAX = 1800;
const REUSE_EMPTY_MS = 60 * 60 * 1000;

const GROUPS = [
  'antidepressant',
  'anxiolytic',
  'antipsychotic',
  'mood_stabilizer',
  'hypnotic_sedative',
  'corrector',
  'other',
];
const groupLabel = (g) => t(`msg.drugs.group.${g}`, g);

const norm = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');

function install(app, h) {
  const { db, P, pii, gateway, config, now } = h;

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

  const innRow = (id) => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    return db.prepare("SELECT * FROM inn WHERE id=? AND status='in_catalog'").get(n) || null;
  };

  const brief = (r, trades = []) => ({
    id: r.id,
    name: r.name,
    group: r.drug_group,
    group_label: groupLabel(r.drug_group),
    atc: r.atc_code || null,
    trade_names: trades,
  });

  function card(inn) {
    const byName = new Map();
    for (const p of db
      .prepare(
        "SELECT trade_name,dosage_form,strength,manufacturer FROM drug_products WHERE inn_id=? AND status='in_catalog' ORDER BY id",
      )
      .all(inn.id)) {
      const entry = byName.get(p.trade_name) || {
        name: p.trade_name,
        form: p.dosage_form || '',
        manufacturer: p.manufacturer || '',
        strengths: [],
      };
      if (p.strength && !entry.strengths.includes(p.strength)) entry.strengths.push(p.strength);
      byName.set(p.trade_name, entry);
    }
    const arts = articlesForInn(db, inn.name);
    const bodyOf = db.prepare(
      'SELECT lv.body_md FROM library_items li JOIN library_versions lv ON lv.item_id=li.id AND lv.version=li.current_version WHERE li.id=?',
    );
    const withBody = (a) => ({
      id: a.id,
      title: a.title,
      summary: a.summary,
      author: a.author,
      stand_in: a.stand_in,
      ai_assisted: a.ai_assisted,
      body_md: (bodyOf.get(a.id) || {}).body_md || '',
    });
    return {
      ...brief(inn),
      rx_only: inn.rx_only === null || inn.rx_only === undefined ? null : Boolean(inn.rx_only),
      stand_in: inn.source === 'stand_in',
      products: [...byName.values()],
      articles: {
        specific: arts.specific.map(withBody),
        general: arts.general.map((a) => ({ id: a.id, title: a.title, summary: a.summary })),
      },
    };
  }

  /** Короткая справочная карточка для модели: только каталог и материалы журнала по этому препарату. */
  function contextFor(inn) {
    const c = card(inn);
    const lines = [
      '[справочник препарата]',
      `Препарат: ${c.name}`,
      `Группа: ${c.group_label}`,
      c.atc ? `АТХ: ${c.atc}` : '',
      c.rx_only === null ? '' : `Отпуск: ${c.rx_only ? 'по рецепту' : 'без рецепта'}`,
      c.products.length
        ? `Торговые названия: ${c.products.map((p) => `${p.name}${p.strengths.length ? ` (${p.strengths.join(', ')})` : ''}`).join('; ')}`
        : '',
    ].filter(Boolean);
    if (c.articles.specific.length) {
      lines.push('Материалы журнала о препарате:');
      for (const a of c.articles.specific)
        lines.push(`— ${a.title}: ${a.summary || ''}\n${String(a.body_md).slice(0, BODY_FOR_MODEL_MAX)}`);
    } else {
      lines.push('Материалов журнала о препарате нет.');
    }
    return lines.join('\n');
  }

  function threadItem(r) {
    return {
      id: r.id,
      title: r.title,
      drug_inn_id: r.drug_inn_id,
      updated_at: r.updated_at,
      expires_at: r.expires_at || null,
    };
  }

  const ownDrugThread = (userId, id) => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    return (
      db
        .prepare('SELECT * FROM ai_threads WHERE id=? AND owner_user_id=? AND purpose=? AND hidden_at IS NULL')
        .get(n, userId, PURPOSE) || null
    );
  };

  // Инструкции из хранилища знаний: список, оглавление, разделы, поиск (см. instructions.js).
  const ins = instructions.install(app, h, { guard, innRow, invalid });
  require('./clinrecs').install(app, h, { guard, invalid });

  // Препарат, которого нет в каталоге (например, глицин): врач вносит его сам, дальше он виден всем врачам.
  app.post('/work/api/drugs/custom', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const name = String((req.body && req.body.name) || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} .,'()-]*$/u.test(name))
      return invalid(req, res, 'name');
    const nameNorm = norm(name);
    const known =
      db.prepare("SELECT id,name FROM inn WHERE status='in_catalog' AND name_norm=?").get(nameNorm) ||
      db
        .prepare(
          "SELECT i.id,i.name FROM drug_products p JOIN inn i ON i.id=p.inn_id WHERE p.status='in_catalog' AND i.status='in_catalog' AND p.trade_name_norm=?",
        )
        .get(nameNorm);
    if (known) return res.json({ id: known.id, name: known.name, created: false });
    const info = db
      .prepare(
        "INSERT INTO inn(name,name_norm,drug_group,rx_only,status,source,source_date,author_id,created_at) VALUES (?,?,'other',NULL,'in_catalog','entered_by_clinician',?,?,?)",
      )
      .run(name, nameNorm, P.iso(now(config)).slice(0, 10), user.id, P.iso(now(config)));
    return res.status(201).json({ id: Number(info.lastInsertRowid), name, created: true });
  });

  app.get('/work/api/drugs', (req, res) => {
    if (!guard(req, res, false)) return undefined;
    const q = norm(String(req.query.q || '').slice(0, SEARCH_MAX));
    const group = String(req.query.group || '');
    if (group && !GROUPS.includes(group)) return invalid(req, res, 'group');
    const inns = db
      .prepare("SELECT * FROM inn WHERE status='in_catalog' ORDER BY name_norm")
      .all()
      .filter((r) => !group || r.drug_group === group);
    const trades = new Map();
    for (const p of db
      .prepare("SELECT inn_id,trade_name,trade_name_norm FROM drug_products WHERE status='in_catalog' ORDER BY id")
      .all()) {
      const list = trades.get(p.inn_id) || [];
      if (!list.some((x) => x.name === p.trade_name)) list.push({ name: p.trade_name, norm: norm(p.trade_name) });
      trades.set(p.inn_id, list);
    }
    const rank = (r) => {
      if (!q) return 3;
      const own = norm(r.name);
      const tn = (trades.get(r.id) || []).map((x) => x.norm);
      if (own === q || tn.includes(q)) return 0;
      if (own.startsWith(q) || tn.some((x) => x.startsWith(q))) return 1;
      if (own.includes(q) || tn.some((x) => x.includes(q)) || norm(r.atc_code) === q) return 2;
      return -1;
    };
    const items = inns
      .map((r) => ({ r, k: rank(r) }))
      .filter((x) => x.k >= 0)
      .sort((a, b) => a.k - b.k || a.r.name.localeCompare(b.r.name, 'ru'))
      .slice(0, LIST_MAX)
      .map((x) =>
        brief(
          x.r,
          (trades.get(x.r.id) || []).map((y) => y.name),
        ),
      );
    return res.json({ items });
  });

  app.get('/work/api/drugs/threads', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const rows = db
      .prepare(
        'SELECT * FROM ai_threads WHERE owner_user_id=? AND purpose=? AND hidden_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 50',
      )
      .all(user.id, PURPOSE);
    return res.json({ items: rows.map(threadItem) });
  });

  app.get('/work/api/drugs/:inn_id', (req, res) => {
    if (!guard(req, res, false)) return undefined;
    const inn = innRow(req.params.inn_id);
    if (!inn) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    return res.json(card(inn));
  });

  // Открыть препарат = новый чат. Если последний чат по нему ещё пуст и свежий, берём его: повторные клики не плодят пустые чаты.
  app.post('/work/api/drugs/:inn_id/open', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const inn = innRow(req.params.inn_id);
    if (!inn) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const last = db
      .prepare(
        'SELECT * FROM ai_threads WHERE owner_user_id=? AND purpose=? AND drug_inn_id=? AND hidden_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get(user.id, PURPOSE, inn.id);
    if (last) {
      const empty = !db.prepare('SELECT 1 FROM ai_messages WHERE thread_id=?').get(last.id);
      const fresh =
        now(config).getTime() - new Date(`${String(last.created_at).replace(' ', 'T').replace(/Z?$/, 'Z')}`).getTime() <
        REUSE_EMPTY_MS;
      if (empty && fresh) return res.json({ thread: threadItem(last), drug: card(inn), reused: true });
    }
    const thread = h.createThread({ userId: user.id, role: user.role, purpose: PURPOSE, patientId: null });
    db.prepare('UPDATE ai_threads SET title=?, title_auto=0, drug_inn_id=? WHERE id=?').run(
      inn.name.charAt(0).toUpperCase() + inn.name.slice(1),
      inn.id,
      thread.id,
    );
    const row = db.prepare('SELECT * FROM ai_threads WHERE id=?').get(thread.id);
    return res.status(201).json({ thread: threadItem(row), drug: card(inn), reused: false });
  });

  app.post('/work/api/drugs/threads/:id/messages', async (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const thread = ownDrugThread(user.id, req.params.id);
    if (!thread) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const inn = innRow(thread.drug_inn_id);
    if (!inn) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const text = String((req.body && req.body.text) || '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .trim();
    if (!text || text.length > TEXT_MAX) return invalid(req, res, 'text');

    const scope = h.scopeFor(thread, user.id);
    let userMsg = null;
    try {
      gateway.limits.check('clinician_chat', user.id);
      const ner = await pii.nerDetect(text);
      const pseudo = pii.pseudonymize(text, scope, { nerEntities: ner.entities, nerOk: ner.ok });
      userMsg = h.addMessage(thread.id, { role: 'user', text: pseudo.text });
      // Выдержки из инструкций: область поиска — только документы МНН этого треда, задаёт сервер.
      const numbering = createNumbering();
      // Выдержки получают номера [n]; карточка — только у процитированных (как в основном чате психиатра).
      const rag = await instructions.retrieveForChat({
        knowledge: ins.knowledge,
        query: pseudo.text,
        innName: inn.name,
        register: (r) =>
          numbering.add(`med|${r.document_id}|${r.section_id}`, {
            kind: 'drug',
            drug: true,
            document_id: r.document_id,
            label: r.label,
            section_id: r.section_id,
            chunk_id: r.chunk_id || null,
            snippet: snippetOf(r.text),
            path: r.path || '',
            page: r.page || null,
            inn_id: inn.id,
          }),
      });
      if (rag.mode !== 'off') ins.audit(user, 'knowledge.retrieve', 'ai_thread', thread.id);
      const out = await gateway.run({
        purpose: 'clinician_chat',
        promptKey: 'task.drug_chat',
        user,
        patientId: null,
        threadId: thread.id,
        text: `${contextFor(inn)}${rag.block ? `\n\n${rag.block}` : ''}\n\nВопрос специалиста: ${pseudo.text}`,
        question: pseudo.text,
        history: h.historyFor(thread.id, userMsg.id).map((m) => (m.role === 'assistant' ? { ...m, text: stripMarkers(m.text) } : m)),
        piiCounts: pseudo.counts || {},
        piiMode: pseudo.mode,
      });
      const final = numbering.finish(out.text);
      const asMsg = h.addMessage(thread.id, {
        role: 'assistant',
        text: final.text,
        kind: out.status === 'filtered' ? 'filtered' : 'normal',
        aiGenerated: 1,
        modelId: out.model.id,
        bindingVersion: out.bindingVersion,
        promptVersion: out.promptVersion,
        flags: { provider: out.model.adapter },
      });
      if (final.sources.length)
        db.prepare('UPDATE ai_messages SET sources_json=? WHERE id=?').run(JSON.stringify(final.sources), asMsg.id);
      if (gateway.attachTraceMessage) gateway.attachTraceMessage(out.traceId, asMsg.id);
      const shown = pii.reveal(asMsg.text, scope);
      return res.status(201).json({
        thread: threadItem(db.prepare('SELECT * FROM ai_threads WHERE id=?').get(thread.id)),
        reply: { ...h.replyView(asMsg, shown.text), sources: final.sources },
        warnings: h.warningsOf(shown.warnings),
        sources: final.sources,
        knowledge: { mode: rag.mode },
      });
    } catch (e) {
      if (userMsg) db.prepare("UPDATE ai_messages SET kind='error' WHERE id=?").run(userMsg.id);
      if (h.isGatewayError(e)) return h.sendGatewayError(res, e);
      throw e;
    }
  });
}

module.exports = { install, PURPOSE, GROUPS };
