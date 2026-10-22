'use strict';

const catalog = require('./instruments_catalog');

// Хелперы отображения. Хранимые данные не меняются: только представление.

const INSTRUMENT_LABELS = {
  phq9: 'PHQ-9 — скрининг депрессии',
  gad7: 'GAD-7 — скрининг тревоги',
  hads: 'HADS — тревога и депрессия',
  who5: 'WHO-5 — индекс благополучия',
  cssrs: 'C-SSRS — скрининг суицидального риска',
  bdi2: 'BDI-II — опросник депрессии Бека',
  stai: 'STAI — тревожность (Спилбергер–Ханин)',
  mmpi: 'MMPI/СМИЛ — личностный профиль',
  chatbot: 'Чат-бот',
  diary: 'Дневник настроения (свободный текст)',
  appeal: 'Обращение пациента',
  message: 'Сообщение врачу',
  previsit: 'Опросник перед приёмом',
};

// D24: пациенту не показываем слово «риск» в названии C-SSRS (PAT-004); текст — заглушка, review-required
const PATIENT_LABELS = { cssrs: 'C-SSRS — короткие вопросы о самочувствии' };
function instrumentLabelFor(role, code) {
  const key = String(code || '').toLowerCase();
  if (role === 'patient' && PATIENT_LABELS[key]) return PATIENT_LABELS[key];
  return instrumentLabel(code);
}

function instrumentLabel(code) {
  if (code === null || code === undefined || code === '') return '—';
  const key = String(code).toLowerCase();
  if (INSTRUMENT_LABELS[key]) return INSTRUMENT_LABELS[key];
  const entry = catalog.getEntry(key);
  return entry ? entry.title + (entry.status === 'stub' ? ' (заглушка)' : '') : String(code).toUpperCase();
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// HTML (выводить через <%- %>): читаемое название, а сырой код методики
// сохранён в data-instrument для тестов/скриптов и показывается в подсказке.
function instrumentTag(code, label) {
  if (code === null || code === undefined || code === '') return '—';
  return `<span data-instrument="${escapeHtml(code)}" title="${escapeHtml(code)}">${escapeHtml(label || instrumentLabel(code))}</span>`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

// Формат ДД.ММ.ГГГГ ЧЧ:ММ (или только дата, если времени нет). Часовой пояс
// не пересчитывается: показывается то, что хранится. Нераспознанное — как есть.
function formatDate(value) {
  if (value === null || value === undefined || value === '') return '—';
  const m = DATE_RE.exec(String(value).trim());
  if (!m) return String(value);
  const [, y, mo, d, h, mi] = m;
  return h === undefined ? `${d}.${mo}.${y}` : `${d}.${mo}.${y} ${h}:${mi}`;
}

function middleware(req, res, next) {
  res.locals.formatDate = formatDate;
  const role = req.session && req.session.user ? req.session.user.role : null;
  res.locals.instrumentLabel = (code) => instrumentLabelFor(role, code);
  res.locals.labels = require('./labels');
  res.locals.instrumentTag = (code) => instrumentTag(code, instrumentLabelFor(role, code));
  res.locals.isCatalogStub = catalog.isStub;
  res.locals.STUB_DISCLAIMER = catalog.STUB_DISCLAIMER;
  next();
}

module.exports = { INSTRUMENT_LABELS, instrumentLabelFor, instrumentLabel, instrumentTag, formatDate, middleware };
