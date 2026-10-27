'use strict';

/**
 * Бланк «Извещение о нежелательной реакции или отсутствии терапевтического эффекта лекарственного препарата»
 * (Приложение № 1 к Порядку осуществления фармаконадзора, Росздравнадзор). Форма и тексты — review-required.
 *
 * Вёрстка бланка не пересобирается: в src/modules/documents/assets/notice_form.template.docx лежит копия
 * оригинала с метками {{...}} (собирается scripts/documents/build_notice_template.js). Здесь значения полей
 * вписываются на место подчёркиваний, выбранные «□» становятся «☑», строки таблиц препаратов заполняются
 * по массивам. Пустое поле остаётся пустой линией бланка: ничего не выдумывается и не подставляется само.
 *
 *   validate(fields)         -> { fields, missing, warnings }   нормализованные поля, незаполненные обязательные
 *   renderDocx(fields)       -> Buffer                          docx (синхронно)
 *   render(fields, format)   -> Promise<Buffer>                 'docx' | 'pdf'
 *   blank(format)            -> Promise<Buffer>                 пустой бланк без подстановок
 *
 * PDF делается из того же docx внешним конвертером (LibreOffice, см. pdfConverter): без него render('pdf')
 * бросает ошибку с кодом E-PDF-UNAVAILABLE, а docx работает всегда.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const zip = require('../../ai/workspace/zip');

const TEMPLATE_PATH = path.join(__dirname, 'assets', 'notice_form.template.docx');

const MAX_SUSPECT = 3;
const MAX_OTHER = 5;

const ENUMS = {
  report_type: ['primary', 'additional'],
  sex: ['m', 'f'],
  allergy: ['none', 'yes'],
  treatment_setting: ['outpatient', 'inpatient', 'self'],
  outcome: ['recovered', 'improved', 'unchanged', 'recovered_sequelae', 'death', 'unknown', 'not_applicable'],
  dechallenge: ['no', 'yes', 'not_withdrawn', 'not_applicable'],
  rechallenge: ['no', 'yes'],
  reporter_category: ['doctor', 'other_hcp', 'patient', 'other'],
};
const MULTI = {
  seriousness: [
    'death',
    'life_threat',
    'hospitalization',
    'disability',
    'congenital',
    'clinically_significant',
    'not_applicable',
  ],
  measures: ['none', 'withdrawal', 'dose_reduction', 'non_drug', 'drug'],
};

// Предельная длина текстов. Бланк рассчитан на короткие записи; длиннее — обрезается с «…» и предупреждением.
const MAX_LEN = {
  previous_report_number: 20,
  previous_report_date: 10,
  patient_code: 35,
  weight_kg: 8,
  age: 24,
  pregnancy_weeks: 8,
  allergy_to: 200,
  reaction_started_on: 10,
  reaction_resolved_on: 10,
  measures_drug_text: 200,
  outcome_sequelae_text: 200,
  rechallenge_result: 40,
  region: 150,
  contact: 150,
  reporter_name: 150,
  reporter_position: 200,
  report_date: 10,
  description: 2000,
};
const DATE_KEYS = ['previous_report_date', 'reaction_started_on', 'reaction_resolved_on', 'report_date'];
const DRUG_COLS = ['trade_name', 'manufacturer', 'batch', 'dose_route', 'started_on', 'stopped_on', 'indication'];
const DRUG_MAX = {
  trade_name: 80,
  manufacturer: 80,
  batch: 30,
  dose_route: 80,
  started_on: 10,
  stopped_on: 10,
  indication: 100,
};
// Ширина столбцов таблицы препаратов (twips) — по ней выбирается кегль длинных значений.
const DRUG_WIDTH = {
  trade_name: 2320,
  manufacturer: 1760,
  batch: 960,
  dose_route: 1214,
  started_on: 1200,
  stopped_on: 1200,
  indication: 1946,
};

const REQUIRED = ['patient_code', 'suspect_drugs.0.trade_name', 'description', 'region', 'contact'];

// ---------- нормализация и проверка ----------

// Символы, недопустимые в XML 1.0, и непарные суррогаты.
function cleanText(v) {
  return String(v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function oneLine(v, max, warn, name) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  let s = cleanText(v).replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    warn.push({ field: name, code: 'truncated' });
    s = `${s.slice(0, max - 1).trimEnd()}…`;
  }
  return s;
}

function multiLine(v, max, warn, name) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  let s = cleanText(v)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length > max) {
    warn.push({ field: name, code: 'truncated' });
    s = `${s.slice(0, max - 1).trimEnd()}…`;
  }
  return s;
}

function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Дата в хранении — YYYY-MM-DD, в бланке — ДД.ММ.ГГГГ. Неверная дата пустой остаётся: подставлять нечего.
function dateField(v, warn, name) {
  const s = oneLine(v, 10, [], name);
  if (!s) return '';
  if (!isoDate(s)) {
    warn.push({ field: name, code: 'bad_date' });
    return '';
  }
  return s;
}

function enumField(v, list, warn, name) {
  if (v === null || v === undefined || v === '') return '';
  if (list.includes(v)) return v;
  warn.push({ field: name, code: 'bad_value' });
  return '';
}

function multiField(v, list, warn, name) {
  if (!Array.isArray(v)) return [];
  const set = new Set();
  for (const x of v) {
    if (list.includes(x)) set.add(x);
    else warn.push({ field: name, code: 'bad_value' });
  }
  return list.filter((x) => set.has(x));
}

function drugRows(v, limit, warn, name) {
  if (!Array.isArray(v)) return [];
  if (v.length > limit) warn.push({ field: name, code: 'too_many' });
  const rows = v.slice(0, limit).map((row, i) => {
    const out = {};
    for (const c of DRUG_COLS) {
      const raw = row && typeof row === 'object' ? row[c] : '';
      out[c] = c.endsWith('_on')
        ? dateField(raw, warn, `${name}.${i}.${c}`)
        : oneLine(raw, DRUG_MAX[c], warn, `${name}.${i}.${c}`);
    }
    return out;
  });
  while (rows.length && DRUG_COLS.every((c) => !rows[rows.length - 1][c])) rows.pop();
  return rows;
}

/** Нормализует поля по контракту v1 и перечисляет незаполненные обязательные. Не бросает ошибок. */
function validate(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const warnings = [];
  const f = {};
  for (const k of Object.keys(ENUMS)) f[k] = enumField(src[k], ENUMS[k], warnings, k);
  for (const k of Object.keys(MULTI)) f[k] = multiField(src[k], MULTI[k], warnings, k);
  for (const k of Object.keys(MAX_LEN)) {
    if (k === 'description') f[k] = multiLine(src[k], MAX_LEN[k], warnings, k);
    else if (DATE_KEYS.includes(k)) f[k] = dateField(src[k], warnings, k);
    else f[k] = oneLine(typeof src[k] === 'number' ? String(src[k]) : src[k], MAX_LEN[k], warnings, k);
  }
  f.pregnant = typeof src.pregnant === 'boolean' ? src.pregnant : null;
  f.rechallenge_not_applicable = src.rechallenge_not_applicable === true;
  f.suspect_drugs = drugRows(src.suspect_drugs, MAX_SUSPECT, warnings, 'suspect_drugs');
  f.other_drugs = drugRows(src.other_drugs, MAX_OTHER, warnings, 'other_drugs');
  const missing = REQUIRED.filter((k) => {
    if (k === 'suspect_drugs.0.trade_name') return !(f.suspect_drugs[0] && f.suspect_drugs[0].trade_name);
    return !f[k];
  });
  return { fields: f, missing, warnings };
}

// ---------- подстановка ----------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NBSP = ' ';

function ruDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

// Значение поля с учётом того, что даты хранятся как ISO.
function fieldValue(f, key) {
  if (DATE_KEYS.includes(key)) return ruDate(f[key]);
  const v = f[key];
  return typeof v === 'string' ? v : '';
}

// Вписанное значение — обычным начертанием: жирный и цвет остаются только у подписей бланка.
function withUnderline(rPr) {
  const base = (rPr || '<w:rPr></w:rPr>').replace(/<w:(?:b|bCs|color)\b[^>]*\/>/g, '');
  if (/<w:u\b/.test(base)) return base;
  if (/<w:szCs\b[^>]*\/>/.test(base)) return base.replace(/(<w:szCs\b[^>]*\/>)/, '$1<w:u w:val="single"/>');
  return base.replace('</w:rPr>', '<w:u w:val="single"/></w:rPr>');
}

function withSize(rPr, sz) {
  const base = rPr || '<w:rPr></w:rPr>';
  if (/<w:sz\b/.test(base))
    return base
      .replace(/<w:sz w:val="\d+"\/>/, `<w:sz w:val="${sz}"/>`)
      .replace(/<w:szCs w:val="\d+"\/>/, `<w:szCs w:val="${sz}"/>`);
  return base.replace('</w:rPr>', `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`);
}

const SYMBOL_FONT =
  '<w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:eastAsia="Segoe UI Symbol" w:cs="Segoe UI Symbol"/>';
function withSymbolFont(rPr) {
  const base = rPr || '<w:rPr></w:rPr>';
  if (/<w:rFonts\b[^>]*\/>/.test(base)) return base.replace(/<w:rFonts\b[^>]*\/>/, SYMBOL_FONT);
  return base.replace('<w:rPr>', `<w:rPr>${SYMBOL_FONT}`);
}

const run = (rPr, text) => `<w:r>${rPr || ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

// Строки описания (с учётом переносов) → run-ы с <w:br/> между ними.
function multilineRuns(rPr, text) {
  return text
    .split('\n')
    .map((line, i) => (i ? `<w:r>${rPr || ''}<w:br/></w:r>` : '') + (line ? run(rPr, line) : ''))
    .join('');
}

// Кегль описания: целиком в отведённую область, пока читается (не меньше 8 пт); дальше строка таблицы растёт.
const DESC_CHARS_PER_LINE_10PT = 84;
const DESC_LINES_10PT = 10;
function describeLayout(text) {
  const paras = text.split('\n');
  for (const sz of [20, 18, 16]) {
    const perLine = Math.floor((DESC_CHARS_PER_LINE_10PT * 20) / sz);
    const lines = paras.reduce((n, p) => n + Math.max(1, Math.ceil(p.length / perLine)), 0);
    if (lines * sz <= DESC_LINES_10PT * 20 || sz === 16) return { sz, lines };
  }
  return { sz: 16, lines: paras.length };
}

function checked(f, spec) {
  const m = /^([a-z_]+)([=~]?)(.*)$/.exec(spec);
  const [, key, op, val] = m;
  if (op === '=') return f[key] === val;
  if (op === '~') return Array.isArray(f[key]) && f[key].includes(val);
  return f[key] === true;
}

function drugCell(f, spec) {
  const m = /^([so])(\d)\.([a-z_]+)$/.exec(spec);
  const list = m[1] === 's' ? f.suspect_drugs : f.other_drugs;
  const row = list[Number(m[2]) - 1];
  if (!row) return '';
  const v = row[m[3]];
  return m[3].endsWith('_on') ? ruDate(v) : v;
}

function fillTemplate(xml, f) {
  const desc = f.description;
  const layout = desc ? describeLayout(desc) : { sz: 20, lines: 1 };

  // 1. Пустые строки под описание убираются по мере его заполнения (высота области остаётся прежней).
  const drop = desc ? Math.min(9, Math.max(0, Math.ceil((layout.lines * layout.sz) / 20) - 1)) : 0;
  let dropped = 0;
  xml = xml.replace(/<w:p(?: [^>]*)?>(?:(?!<\/w:p>)[\s\S])*?\{\{pad\}\}(?:(?!<\/w:p>)[\s\S])*<\/w:p>/g, (p) => {
    if (dropped < drop) {
      dropped++;
      return '';
    }
    return p.replace(
      /<w:r><w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr><w:t xml:space="preserve">\{\{pad\}\}<\/w:t><\/w:r>/,
      '',
    );
  });

  // 2. Все остальные метки — за один проход, вписанные значения повторно не просматриваются.
  const RUN =
    /<w:r>(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?<w:t xml:space="preserve">\{\{([^{}]+)\}\}<\/w:t><\/w:r>/g;
  return xml.replace(RUN, (all, rPr, token) => {
    const colon = token.indexOf(':');
    const kind = colon < 0 ? token : token.slice(0, colon);
    const spec = colon < 0 ? '' : token.slice(colon + 1);
    switch (kind) {
      case 'cb': {
        const on = checked(f, spec);
        return run(on ? withSymbolFont(rPr) : rPr, on ? '☑' : '□');
      }
      case 'tick': {
        const on = checked(f, spec);
        return on ? run(rPr, '✓') : '';
      }
      case 'f': {
        const [key, n] = spec.split('|');
        const v = fieldValue(f, key);
        if (!v) return run(rPr, '_'.repeat(Number(n)));
        // Значение пишется поверх линии: подчёркнутый текст, добитый до длины исходной линии (пробел вдвое уже «_»).
        const pad = NBSP.repeat(Math.max(0, (Number(n) - v.length) * 2));
        return run(withUnderline(rPr), v + pad);
      }
      case 'a': {
        const v = fieldValue(f, spec);
        return v ? run(rPr, ` ${v}`) : '';
      }
      case 'c': {
        const v = drugCell(f, spec);
        if (!v) return '';
        const col = spec.split('.')[1];
        const cap = Math.floor((DRUG_WIDTH[col] / 20 - 5) / 4.9);
        const sz = v.length <= cap ? 20 : v.length <= cap * 1.25 ? 18 : 16;
        return run(withSize(rPr, sz), v);
      }
      case 'desc':
        return desc ? multilineRuns(withSize(rPr, layout.sz), desc) : '';
      default:
        return all;
    }
  });
}

let templateCache = null;
function loadTemplate() {
  if (templateCache) return templateCache;
  const buf = fs.readFileSync(TEMPLATE_PATH);
  const state = { total: 0 };
  const files = zip
    .readEntries(buf)
    .filter((e) => !e.name.endsWith('/'))
    .map((e) => ({ name: e.name, data: zip.readEntry(buf, e, state) }));
  templateCache = files;
  return files;
}

/** Заполненный бланк в docx. Поля нормализуются через validate, так что принимает и «сырой» объект. */
function renderDocx(fields) {
  const { fields: f } = validate(fields);
  const files = loadTemplate().map((file) =>
    file.name === 'word/document.xml'
      ? { name: file.name, data: Buffer.from(fillTemplate(file.data.toString('utf8'), f), 'utf8') }
      : file,
  );
  return zip.build(files);
}

// ---------- PDF ----------

function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/opt/libreoffice/program/soffice',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function pdfError(message, cause) {
  const e = new Error(message);
  e.code = 'E-PDF-UNAVAILABLE';
  if (cause) e.cause = cause;
  return e;
}

// docx → pdf через LibreOffice. Отдельный профиль и временная папка на вызов, таймаут 60 с.
async function libreOfficeConvert(docx) {
  const exe = findSoffice();
  if (!exe)
    throw pdfError('Для PDF нужен LibreOffice (soffice): задайте SOFFICE_PATH или установите libreoffice-writer');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'notice-'));
  try {
    const input = path.join(dir, 'notice.docx');
    await fs.promises.writeFile(input, docx);
    await new Promise((resolve, reject) => {
      execFile(
        exe,
        [
          '--headless',
          '--norestore',
          '--nolockcheck',
          `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
          '--convert-to',
          'pdf',
          '--outdir',
          dir,
          input,
        ],
        { timeout: 60000 },
        (err) => (err ? reject(pdfError('Не удалось собрать PDF', err)) : resolve()),
      );
    });
    return await fs.promises.readFile(path.join(dir, 'notice.pdf'));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

let pdfConverter = libreOfficeConvert;
/** Подмена конвертера docx → pdf: async (Buffer) => Buffer. Без аргумента возвращает LibreOffice. */
function setPdfConverter(fn) {
  pdfConverter = fn || libreOfficeConvert;
}

function pdfAvailable() {
  return pdfConverter !== libreOfficeConvert || Boolean(findSoffice());
}

async function render(fields, format = 'docx') {
  if (format !== 'docx' && format !== 'pdf') throw new Error(`Неизвестный формат: ${format}`);
  const docx = renderDocx(fields);
  return format === 'docx' ? docx : pdfConverter(docx);
}

/** Пустой бланк: все поля — пустые линии, все квадраты — «□». */
function blank(format = 'docx') {
  return render({}, format);
}

module.exports = {
  validate,
  render,
  renderDocx,
  blank,
  setPdfConverter,
  pdfAvailable,
  REQUIRED,
  MAX_SUSPECT,
  MAX_OTHER,
  ENUMS,
  MULTI,
  TEMPLATE_PATH,
};
