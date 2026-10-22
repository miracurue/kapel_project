'use strict';

/**
 * W-36: разбор фразы специалиста в черновик (F-35, этап 14, В4).
 * Перехватывает POST /api/v1/patients/:patientId/parse ДО правил В2
 * (src/modules/clinical/routes.js — файл В3, не меняется): правила В2 остаются
 * базой («черновик из правил»), модель order_parse дополняет их.
 *
 * Порядок (F-35):
 *  (1) правила кода: МНН из каталога (F-76/F-121, торговое наименование → МНН),
 *      доза с единицей, время приёма, формат визита — как в В2;
 *  (2) если правила не заполнили обязательное поле — модель order_parse через
 *      шлюз F-26 (src/ai/gateway.js, псевдонимизация F-80, таймаут 10 с);
 *  (3) ответ модели проверяется (E-AI-SCHEMA): МНН существует в справочнике
 *      (STAND-IN каталог), доза — число с допустимой единицей, дата не в прошлом,
 *      поля и типы по схеме F-35; иначе отказ модели и черновик из правил;
 *  (4) при таймауте/недоступности модели (E-AI-TIMEOUT / E-AI-UNAVAILABLE) —
 *      черновик из правил (как сейчас);
 *  (5) право: план_предмет — только психиатр (психологу лекарств нет, как в T-137);
 *  (6) журнал ai_audit ведёт шлюз; тексты и значения не журналируются (PD-17).
 */

const { createGateway } = require('../../ai/gateway');
const { createPii } = require('../../ai/pii');
const { createRegistry } = require('../../ai/registry');

const UNITS = new Set(['мг', 'мкг', 'мл']);
const DURATION_DAYS = [
  [/^нед/, 7],
  [/^мес/, 30],
  [/^(дн|день)/, 1],
];
const TIMES = new Set(['утро', 'день', 'вечер', 'на ночь']);

function install(app, h) {
  const { db, P, config, now, activeSetting } = h;

  const registry = createRegistry({ db, config, now, activeSetting });
  const pii = createPii({ db, config, ml: null });
  const gateway = createGateway({ db, config, now, registry, pii, settings: activeSetting });

  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

  function err(req, res, status, code) {
    return P.sendError(req, res, status, code);
  }

  /** Черновик из правил В2 (W-18): источник черновика — только правила. */
  function rulesDraft(phrase) {
    const p = norm(phrase);
    const inns = db.prepare("SELECT id,name FROM inn WHERE status='in_catalog'").all();
    const products = db
      .prepare(
        "SELECT p.inn_id,p.trade_name,i.name FROM drug_products p JOIN inn i ON i.id=p.inn_id WHERE p.status='in_catalog'",
      )
      .all();
    let hit = inns.find((x) => p.includes(norm(x.name)));
    if (!hit) {
      const brand = products.find((x) => p.includes(norm(x.trade_name)));
      if (brand) hit = { id: brand.inn_id, name: brand.name };
    }
    const dose = phrase.match(/(\d+(?:[.,]\d+)?)\s*(мкг|мг|мл)/i);
    const times = [
      /утр/i.test(phrase) && 'утро',
      /(днём|днем|обед)/i.test(phrase) && 'день',
      /вечер/i.test(phrase) && 'вечер',
      /(на\s+ночь|перед\s+сном)/i.test(phrase) && 'на ночь',
    ].filter(Boolean);
    // Срок «4 недели» → дата окончания (в фразе дозу вырезаем, чтобы «75 мг» не принять за срок).
    const rest = dose ? phrase.replace(dose[0], ' ') : phrase;
    const term = rest.match(/(\d+)\s*(нед\S*|мес\S*|дн\S*|день)/i);
    const days = term ? Number(term[1]) * (DURATION_DAYS.find(([re]) => re.test(term[2].toLowerCase()))?.[1] || 1) : 0;
    const until = days > 0 && days <= 3650 ? new Date(now(config).getTime() + days * 86400000).toISOString().slice(0, 10) : undefined;
    const draft = {
      inn_id: hit?.id,
      inn_name: hit?.name,
      dose: dose ? Number(dose[1].replace(',', '.')) : undefined,
      unit: dose?.[2]?.toLowerCase(),
      times,
      ...(until ? { until } : {}),
    };
    const missing = [];
    if (!hit) missing.push('inn');
    if (!dose) missing.push('dose');
    if (!times.length) missing.push('times');
    return { draft, missing };
  }

  /** Валидация ответа модели (E-AI-SCHEMA, F-35). */
  function validateModel(out, draft) {
    if (!out || typeof out !== 'object') return false;
    // МНН — только существующий в справочнике (STAND-IN каталог, F-76).
    if (out.inn_name !== undefined && out.inn_name !== null) {
      const inn = String(out.inn_name).trim();
      const hit = db.prepare("SELECT id FROM inn WHERE status='in_catalog' AND lower(name)=lower(?)").get(inn);
      if (!hit) return false;
      draft.inn_id = hit.id;
      draft.inn_name = db.prepare('SELECT name FROM inn WHERE id=?').get(hit.id).name;
    }
    // Доза — число с допустимой единицей.
    if (out.dose !== undefined && out.dose !== null) {
      const n = Number(out.dose);
      if (!Number.isFinite(n) || n <= 0) return false;
      if (out.unit !== undefined && !UNITS.has(String(out.unit).toLowerCase())) return false;
      draft.dose = n;
      draft.unit = out.unit !== undefined ? String(out.unit).toLowerCase() : draft.unit;
    }
    // Время приёма — из допустимых меток.
    if (out.times !== undefined) {
      if (!Array.isArray(out.times)) return false;
      const times = out.times.map(String).filter((x) => TIMES.has(x.toLowerCase()));
      if (times.length !== out.times.length) return false;
      draft.times = times;
    }
    // Дата не в прошлом.
    if (out.date !== undefined && out.date !== null) {
      const d = new Date(String(out.date));
      if (Number.isNaN(d.getTime()) || d < new Date(now(config).getTime() - 24 * 60 * 60 * 1000)) return false;
      draft.date = String(out.date);
    }
    return true;
  }

  app.post('/api/v1/patients/:patientId/parse', async (req, res) => {
    const phrase = String(req.body.phrase || '');
    const target = req.body.target;
    // Право: назначение лекарства — только психиатр (T-137, UC-33).
    if (target === 'plan_item' && req.user.role !== 'psychiatrist') return err(req, res, 403, 'E-ACCESS');
    if (target === 'visit') {
      return res.json({ draft: { format: /очно/i.test(phrase) ? 'in_person' : 'remote' }, missing: [] });
    }

    const base = rulesDraft(phrase);
    // Правила заполнили все обязательные поля — модель не нужна.
    if (base.missing.length === 0) return res.json(base);

    // Модель order_parse дополняет правила (F-35): шлюз F-26, псевдонимизация F-80.
    try {
      const p = await pii.pseudonymize(phrase, { scopeType: 'plan_item', scopeId: req.params.patientId }, {});
      const out = await gateway.run({
        purpose: 'order_parse',
        user: req.user,
        patientId: Number(req.params.patientId),
        text: p.text,
        piiCounts: p.counts,
      });
      const draft = { ...base.draft };
      if (validateModel(out, draft)) return res.json({ draft, missing: base.missing });
    } catch (_) {
      /* отказ модели → черновик из правил */
    }
    return res.json(base);
  });
}

module.exports = { install };
