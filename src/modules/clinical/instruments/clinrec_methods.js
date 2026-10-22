'use strict';

// Единый реестр методик клинических рекомендаций: один код на методику.
// Данные — clinrec_methods.json (из experiments/поиск_по_оглавлению/methods_registry.json).
// Реализованные методики остаются в gad_registry / INSTRUMENT_DEFS; здесь — их связка с клинреками
// и карточки «Скоро появится» для остальных (без пунктов, ключей, назначения и прохождения).
const METHODS = require('./clinrec_methods.json');
const catalog = require('../../../instruments_catalog');
const gad = require('./gad_registry');

const DOC_TITLES = {
  '01_bipolar': 'Биполярное аффективное расстройство',
  '02_gad': 'Генерализованное тревожное расстройство',
  '04_depression': 'Депрессивный эпизод, рекуррентное депрессивное расстройство',
  '06_ocd': 'Обсессивно-компульсивное расстройство',
  '07_panic': 'Паническое расстройство',
  '08_ptsd': 'Посттравматическое стрессовое расстройство',
  '26_schizophrenia': 'Шизофрения',
  epilepsy: 'Эпилепсия и эпилептический статус у взрослых и детей',
  onco_depression_anxiety: 'Депрессивные и тревожные расстройства',
};
const KIND_TITLES = { scale: 'Шкала', questionnaire: 'Опросник', interview: 'Интервью', test: 'Тест' };
const BY_CODE_ROLE = { self: 'Заполняет пациент', clinician: 'Проводит специалист', unknown: 'Не определено' };

const BY_CODE = new Map(METHODS.map((m) => [m.code, m]));
const hrefFor = (code) => `/work?tab=tools&tool=${code}`;
const normLabel = (label) =>
  String(label || '')
    .trim()
    .replace(/^app:/i, '')
    .replace(/^Приложение\s+/i, '');

// Методики без реализации: новые коды и заглушки каталога (ymrs, hdrs17, madrs).
const soonMethods = () => METHODS.filter((m) => m.status === 'soon');

function view(m, code = m.code) {
  const policy = gad.policyForCode(code);
  let status = 'available';
  let assignable = false;
  if (m.status === 'soon') status = 'soon';
  else if (policy) {
    status = policy.mode === 'reference_only' ? 'reference' : policy.mode === 'awaiting_text' ? 'soon' : 'available';
    assignable = policy.assignable !== false;
  } else if (code === 'hads') status = 'soon'; // заглушка без прохождения: в БД HADS по-прежнему закрыт
  else {
    const entry = catalog.getEntry(code);
    assignable = !!entry && entry.status === 'implemented' && catalog.isOnlineAssignable(code);
  }
  if (status === 'soon') assignable = false;
  return {
    code,
    title: m.title,
    abbreviation: m.abbreviation,
    status,
    assignable,
    href: hrefFor(code),
    codes: policy?.codes ? [...policy.codes] : [code],
  };
}

// Код (в т.ч. itt_s — второй код составного приложения) → методика.
function resolveCode(code) {
  const key = String(code || '').trim();
  const m = BY_CODE.get(key);
  if (m) return view(m);
  const row = gad.policyForCode(key);
  const base = row && BY_CODE.get(row.codes[0]);
  return base ? { ...view(base, key), title: row.title || base.title } : null;
}

// (документ клинрека, метка приложения) → методика. Без doc ищет по метке среди всех клинреков.
function resolveApp(doc, appLabel) {
  const label = normLabel(appLabel);
  if (!label) return null;
  const m = METHODS.find((x) =>
    x.sources.some((s) => normLabel(s.app_label) === label && (doc == null || s.doc === doc)),
  );
  return m ? view(m) : null;
}

// Методики из фрагмента markdown клинрека: ссылки `](app:X "instrument:code")` и метки
// `<!-- id: app:X; kind: method; instrument: code -->`. Составной `itt_l,itt_s` — первый код основной.
function findMethods(markdown, { doc } = {}) {
  const found = new Map();
  const add = (list, appLabel) => {
    const codes = String(list || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const main = codes.length ? resolveCode(codes[0]) : doc !== undefined ? resolveApp(doc, appLabel) : null;
    if (!main) return;
    const prev = found.get(main.code);
    const apps = new Set(prev?.apps || []);
    if (appLabel) apps.add(appLabel);
    const extra = codes.slice(1).filter((c) => resolveCode(c));
    found.set(main.code, { ...main, codes: [...new Set([...main.codes, ...extra])], apps: [...apps] });
  };
  const text = String(markdown || '');
  for (const m of text.matchAll(/\]\(app:([^\s)"]+)(?:\s+"instrument:([^"]*)")?\)/g)) add(m[2], `app:${m[1]}`);
  for (const m of text.matchAll(/<!--\s*id:\s*(app:[^;>]+?)\s*;[^>]*?\binstrument:\s*([^;>]*?)\s*(?:;[^>]*)?-->/g))
    add(m[2], m[1]);
  return [...found.values()];
}

function soonPolicy(code) {
  const m = BY_CODE.get(code);
  if (!m || m.status !== 'soon') return null;
  const label = m.sources[0]?.app_label || null;
  return {
    appendix: normLabel(label),
    label,
    code,
    codes: [code],
    title: m.title,
    mode: 'awaiting_text',
    assignable: false,
    intended_assignable: false,
    href: hrefFor(code),
  };
}

// Определения для seedInstrument (формат gad_registry.REFERENCE_DEFS): карточка без пунктов и ключей.
function soonDefs() {
  return soonMethods().map((m) => ({
    code: m.code,
    title: m.title,
    selfService: false,
    items: [],
    options: [],
    scoring: { type: 'reference' },
    bands: [],
    meta: {
      appendix: m.sources[0]?.app_label || null,
      mode: 'awaiting_text',
      assignable: false,
      intended_assignable: false,
      review_required: true,
      review_status: 'review-required',
      abbreviation: m.abbreviation,
      kind_title: KIND_TITLES[m.kind] || m.kind,
      administered_by: m.administered_by,
      purpose:
        `${KIND_TITLES[m.kind] || 'Методика'} ${m.abbreviation}. ${BY_CODE_ROLE[m.administered_by] || ''}.`.trim(),
      note: 'Скоро появится',
      readiness_note: 'Методика упомянута в клинических рекомендациях. Пунктов, ключа и прохождения пока нет.',
      sources: m.sources.map(
        (s) =>
          `Клинические рекомендации «${DOC_TITLES[s.doc] || s.doc}»${s.appendix_title ? `: ${s.appendix_title}` : ''}.`,
      ),
    },
  }));
}

module.exports = { METHODS, soonMethods, soonPolicy, soonDefs, resolveCode, resolveApp, findMethods, hrefFor };
