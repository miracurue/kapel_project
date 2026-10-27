'use strict';

// Собирает шаблон-копию бланка «Извещение о нежелательной реакции» (Приложение № 1 Росздравнадзора)
// с метками {{...}} из исходного docx. Исходные стили, колонтитулы, размеры и рамки не меняются:
// правятся только места полей (подчёркивания), символы «□» и пустые ячейки таблиц препаратов.
//
//   node scripts/documents/build_notice_template.js [исходный.docx] [результат.docx]
//
// Метки (подставляет src/modules/documents/notice_form.js):
//   {{cb:ключ=значение}}  «□» одиночного выбора;  {{cb:ключ~значение}} — множественного;  {{cb:ключ}} — флажок
//   {{tick:ключ=значение}} галочка внутри нарисованного квадрата (тип сообщения)
//   {{f:ключ|N}}          поле-линия из N подчёркиваний
//   {{a:ключ}}            значение дописывается после подписи поля без линии
//   {{c:s1.trade_name}}   ячейка таблицы препаратов (s — подозреваемые, o — прочие)
//   {{desc}} / {{pad}}    описание реакции и пустые строки под него

const fs = require('fs');
const path = require('path');
const zip = require('../../src/ai/workspace/zip');

const ROOT = path.join(__dirname, '..', '..');
const SRC =
  process.argv[2] ||
  path.join(ROOT, 'research-tools/sources/guidelines/ru/roszdravnadzor_karta-izveschenie_NR_2024-01-09.docx');
const OUT = process.argv[3] || path.join(ROOT, 'src/modules/documents/assets/notice_form.template.docx');

// Все «□» и линии из подчёркиваний в таблицах, в порядке следования в документе.
const TOKENS = [
  ['_', 'f:previous_report_number'],
  ['_', 'f:previous_report_date'],
  ['_', 'f:patient_code'],
  ['□', 'cb:sex=m'],
  ['□', 'cb:sex=f'],
  ['_', 'f:weight_kg'],
  ['_', 'f:age'],
  ['□', 'cb:pregnant'],
  ['_', 'f:pregnancy_weeks'],
  ['□', 'cb:allergy=none'],
  ['□', 'cb:allergy=yes'],
  ['_', 'f:allergy_to'],
  ['□', 'cb:treatment_setting=outpatient'],
  ['□', 'cb:treatment_setting=inpatient'],
  ['□', 'cb:treatment_setting=self'],
  ['_', 'f:reaction_started_on'],
  ['_', 'f:reaction_resolved_on'],
  ['□', 'cb:seriousness~death'],
  ['□', 'cb:seriousness~life_threat'],
  ['□', 'cb:seriousness~hospitalization'],
  ['□', 'cb:seriousness~disability'],
  ['□', 'cb:seriousness~congenital'],
  ['□', 'cb:seriousness~clinically_significant'],
  ['□', 'cb:seriousness~not_applicable'],
  ['□', 'cb:measures~none'],
  ['□', 'cb:measures~withdrawal'],
  ['□', 'cb:measures~dose_reduction'],
  ['□', 'cb:measures~non_drug'],
  ['□', 'cb:measures~drug'],
  ['_', 'f:measures_drug_text'],
  ['□', 'cb:outcome=recovered'],
  ['□', 'cb:outcome=improved'],
  ['□', 'cb:outcome=unchanged'],
  ['□', 'cb:outcome=recovered_sequelae'],
  ['_', 'f:outcome_sequelae_text'],
  ['□', 'cb:outcome=death'],
  ['□', 'cb:outcome=unknown'],
  ['□', 'cb:outcome=not_applicable'],
  ['□', 'cb:dechallenge=no'],
  ['□', 'cb:dechallenge=yes'],
  ['□', 'cb:dechallenge=not_withdrawn'],
  ['□', 'cb:dechallenge=not_applicable'],
  ['□', 'cb:rechallenge=no'],
  ['□', 'cb:rechallenge=yes'],
  ['_', 'f:rechallenge_result'],
  ['□', 'cb:rechallenge_not_applicable'],
  ['□', 'cb:reporter_category=doctor'],
  ['□', 'cb:reporter_category=other_hcp'],
  ['□', 'cb:reporter_category=patient'],
  ['□', 'cb:reporter_category=other'],
  ['_', 'f:region'],
  ['_', 'f:report_date'],
];

// Подписи без линии: значение дописывается в конец абзаца.
const APPENDS = [
  ['Контактный телефон/e-mail:', 'a:contact'],
  ['Ф.И.О', 'a:reporter_name'],
  ['Должность и место работы', 'a:reporter_position'],
];

const DRUG_COLS = ['trade_name', 'manufacturer', 'batch', 'dose_route', 'started_on', 'stopped_on', 'indication'];

const P_RE = /<w:p(?: [^>]*)?>(?:(?!<\/w:p>)[\s\S])*<\/w:p>/g;
const R_RE = /<w:r(?: [^>]*)?>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g;
const SIMPLE_RUN = /^<w:r(?: [^>]*)?>(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?<w:t(?: [^>]*)?>([^<]*)<\/w:t><\/w:r>$/;

const run = (rPr, text) => `<w:r>${rPr || ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const paraText = (p) => [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
// Свойства знака абзаца без жирного и цвета: так выглядит вписанное значение.
function plainRPr(p) {
  const m = /<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*?<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(p);
  const inner = m ? m[1].replace(/<w:(?:b|bCs|color|rFonts)\b[^>]*\/>/g, '') : '';
  return `<w:rPr>${inner}</w:rPr>`;
}

function substituteTokens(tail) {
  let idx = 0;
  const out = tail.replace(P_RE, (p) => {
    const text = paraText(p);
    if (!/□|_{2,}/.test(text)) return p;
    return p.replace(R_RE, (r) => {
      if (!/□|_{2,}/.test(r)) return r;
      const m = SIMPLE_RUN.exec(r);
      if (!m) throw new Error(`Сложный run с полем: ${r.slice(0, 200)}`);
      const rPr = m[1] || '';
      let pieces = '';
      let last = 0;
      const t = m[2];
      for (const hit of t.matchAll(/□|_{2,}/g)) {
        const tok = TOKENS[idx++];
        if (!tok) throw new Error('Меток больше, чем описано');
        const kind = hit[0] === '□' ? '□' : '_';
        if (tok[0] !== kind) throw new Error(`Метка №${idx}: ожидалось ${tok[0]}, в документе ${kind}`);
        if (hit.index > last) pieces += run(rPr, t.slice(last, hit.index));
        pieces += run(rPr, `{{${tok[1]}${kind === '_' ? `|${hit[0].length}` : ''}}}`);
        last = hit.index + hit[0].length;
      }
      if (last < t.length) pieces += run(rPr, t.slice(last));
      return pieces;
    });
  });
  if (idx !== TOKENS.length) throw new Error(`Найдено меток ${idx}, описано ${TOKENS.length}`);
  return out;
}

function addAppends(tail) {
  let n = 0;
  const out = tail.replace(P_RE, (p) => {
    const text = paraText(p).trim();
    const hit = APPENDS.find(([start]) => text.startsWith(start));
    if (!hit) return p;
    n++;
    return p.replace(/<\/w:p>$/, `${run(plainRPr(p), `{{${hit[1]}}}`)}</w:p>`);
  });
  if (n !== APPENDS.length) throw new Error(`Подписей без линии: ${n}, ожидалось ${APPENDS.length}`);
  return out;
}

// Ячейки препаратов: строки, у которых первая ячейка «1»…«N» и восемь ячеек.
function fillDrugCells(tail) {
  const tables = tail.split(/(?=<w:tbl>)/);
  // tables[0] — таблица типа сообщения, [1] — пациент и подозреваемые ЛС, [2] — остальное
  const named = [
    [1, 's', 3],
    [2, 'o', 5],
  ];
  for (const [ti, prefix, count] of named) {
    tables[ti] = tables[ti].replace(/<w:tr[ >](?:(?!<\/w:tr>)[\s\S])*<\/w:tr>/g, (tr) => {
      const cells = tr.match(/<w:tc>(?:(?!<\/w:tc>)[\s\S])*<\/w:tc>/g) || [];
      if (cells.length !== 8) return tr;
      const label = paraText(cells[0]).trim();
      if (!/^[1-9]$/.test(label) || Number(label) > count) return tr;
      let col = 0;
      return tr.replace(/<w:tc>(?:(?!<\/w:tc>)[\s\S])*<\/w:tc>/g, (tc) => {
        const c = col++;
        if (c === 0) return tc;
        if (paraText(tc) !== '' || (tc.match(/<w:p[ >]/g) || []).length !== 1)
          throw new Error('Ячейка препарата не пустая');
        return tc.replace(
          /<\/w:p><\/w:tc>$/,
          `${run(plainRPr(tc.match(P_RE)[0]), `{{c:${prefix}${label}.${DRUG_COLS[c - 1]}}}`)}</w:p></w:tc>`,
        );
      });
    });
  }
  // Фиксированная раскладка: ширины столбцов остаются теми же, но длинное слово без пробелов
  // переносится внутри ячейки, а не растягивает столбец и не ломает бланк.
  for (const ti of [1, 2]) {
    tables[ti] = tables[ti].replace(/<w:tblPr>[\s\S]*?<\/w:tblPr>/, (pr) => {
      const at = pr.search(/<w:tblCellMar>|<w:tblLook/);
      if (at < 0) throw new Error('В tblPr нет места для tblLayout');
      return `${pr.slice(0, at)}<w:tblLayout w:type="fixed"/>${pr.slice(at)}`;
    });
  }
  return tables.join('');
}

// Описание реакции: первая пустая строка получает {{desc}}, остальные девять — {{pad}} (их убирают по мере заполнения).
function markDescription(tail) {
  const start = tail.indexOf('Описание реакции');
  if (start < 0) throw new Error('Нет ячейки «Описание реакции»');
  const cellEnd = tail.indexOf('</w:tc>', start);
  let cell = tail.slice(start, cellEnd);
  let n = 0;
  cell = cell.replace(P_RE, (p) => {
    if (p.includes('<w:r>') || p.includes('<w:r ')) return p;
    n++;
    return p.replace(/<\/w:p>$/, `${run(plainRPr(p), n === 1 ? '{{desc}}' : '{{pad}}')}</w:p>`);
  });
  if (n !== 10) throw new Error(`Пустых строк описания ${n}, ожидалось 10`);
  return tail.slice(0, start) + cell + tail.slice(cellEnd);
}

// Квадраты «Первичное» / «Дополнительная информация» нарисованы фигурами: галочка кладётся текстом внутрь.
function addTicks(xml) {
  // только таблицы бланка: верхняя надпись приложения (в голове документа) не затрагивается
  const keys = ['primary', 'additional'];
  let n = 0;
  const para = (key) =>
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' +
    `<w:r><w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:cs="Segoe UI Symbol"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">{{tick:report_type=${key}}}</w:t></w:r></w:p>`;
  // современная ветка (wps)
  xml = xml.replace(/<wps:wsp>(?:(?!<\/wps:wsp>)[\s\S])*<\/wps:wsp>/g, (all) => {
    if (n >= 2) return all;
    const key = keys[n++];
    return all
      .replace('</wps:spPr>', `</wps:spPr><wps:txbx><w:txbxContent>${para(key)}</w:txbxContent></wps:txbx>`)
      .replace('lIns="91440" tIns="45720" rIns="91440" bIns="45720"', 'lIns="0" tIns="0" rIns="0" bIns="0"');
  });
  if (n !== 2) throw new Error(`Квадратов типа сообщения (wps): ${n}`);
  // запасная ветка (VML) для старых программ
  let m = 0;
  xml = xml.replace(/<v:stroke joinstyle="round"\/><\/v:rect>/g, () => {
    const key = keys[m++];
    return `<v:stroke joinstyle="round"/><v:textbox inset="0,0,0,0"><w:txbxContent>${para(key)}</w:txbxContent></v:textbox></v:rect>`;
  });
  if (m !== 2) throw new Error(`Квадратов типа сообщения (vml): ${m}`);
  return xml;
}

function build(srcPath, outPath) {
  const buf = fs.readFileSync(srcPath);
  const entries = zip.readEntries(buf);
  const state = { total: 0 };
  const files = entries
    .filter((e) => !e.name.endsWith('/'))
    .map((e) => ({ name: e.name, data: zip.readEntry(buf, e, state) }));
  const doc = files.find((f) => f.name === 'word/document.xml');
  let xml = doc.data.toString('utf8');
  const cut = xml.indexOf('<w:tbl>');
  const head = xml.slice(0, cut);
  let tail = xml.slice(cut);
  tail = substituteTokens(tail);
  tail = addAppends(tail);
  tail = fillDrugCells(tail);
  tail = markDescription(tail);
  tail = addTicks(tail);
  xml = head + tail;
  doc.data = Buffer.from(xml, 'utf8');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, zip.build(files));
  return outPath;
}

if (require.main === module) console.log('Шаблон записан:', build(SRC, OUT));
module.exports = { build, TOKENS };
