'use strict';
// covers: бланк «Извещение о нежелательной реакции» (Росздравнадзор): подстановка в копию оригинала, проверка полей, PDF-конвертер.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zip = require('../../src/ai/workspace/zip');
const nf = require('../../src/modules/documents/notice_form');

const ORIGINAL = path.join(
  __dirname,
  '../../research-tools/sources/guidelines/ru/roszdravnadzor_karta-izveschenie_NR_2024-01-09.docx',
);

function readDocx(buf) {
  const entries = zip.readEntries(buf);
  const state = { total: 0 };
  const files = {};
  for (const e of entries) if (!e.name.endsWith('/')) files[e.name] = zip.readEntry(buf, e, state);
  return files;
}
const documentXml = (buf) => readDocx(buf)['word/document.xml'].toString('utf8');
// Видимый текст: все w:t подряд, сущности раскрыты.
const visibleText = (xml) =>
  [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)]
    .map((m) => m[1])
    .join('')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const count = (s, ch) => s.split(ch).length - 1;

// Грубая проверка well-formed: открывающие и закрывающие теги сходятся.
function assertBalanced(xml) {
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `закрывающий тег ${m[2]} без пары`);
    else stack.push(m[2]);
  }
  assert.deepEqual(stack, [], 'остались незакрытые теги');
}

const FULL = {
  report_type: 'additional',
  previous_report_number: '12-45',
  previous_report_date: '2026-09-30',
  patient_code: 'ПСИ-0042',
  sex: 'f',
  weight_kg: 62.5,
  age: '34',
  pregnant: true,
  pregnancy_weeks: '12',
  allergy: 'yes',
  allergy_to: 'пенициллин',
  treatment_setting: 'outpatient',
  suspect_drugs: [
    {
      trade_name: 'Авиандр & <Ко>',
      manufacturer: 'Завод',
      batch: '123A',
      dose_route: '50 мг',
      started_on: '2026-08-01',
      stopped_on: '2026-09-20',
      indication: 'Депрессия',
    },
    { trade_name: 'Сертралин' },
  ],
  reaction_started_on: '2026-09-15',
  description: 'Тремор рук.\nПотливость.',
  reaction_resolved_on: '2026-09-25',
  seriousness: ['hospitalization', 'clinically_significant'],
  measures: ['withdrawal', 'drug'],
  measures_drug_text: 'пропранолол',
  outcome: 'recovered_sequelae',
  outcome_sequelae_text: 'тремор',
  dechallenge: 'yes',
  rechallenge: 'no',
  other_drugs: [{ trade_name: 'Омепразол', started_on: '2026-01-10' }],
  reporter_category: 'doctor',
  region: 'г. Москва',
  contact: '+7 900 000-00-00',
  reporter_name: 'Иванова А. Б.',
  reporter_position: 'врач-психиатр',
  report_date: '2026-10-26',
};

test('пустой бланк: все поля — линии, все квадраты — «□», метки не остаются', async () => {
  const xml = documentXml(await nf.blank('docx'));
  assert.ok(!xml.includes('{{'), 'в бланке не должно быть меток');
  assert.equal(count(xml, '☑'), 0);
  assert.equal(count(xml, '✓'), 0);
  assert.equal(count(visibleText(xml), '□'), 38);
  assertBalanced(xml);
  const text = visibleText(xml);
  for (const s of [
    'ИЗВЕЩЕНИЕ О НЕЖЕЛАТЕЛЬНОЙ РЕАКЦИИ',
    'Инициалы пациента',
    'Критерии серьезности НР',
    'поле обязательно к заполнению',
    'external.roszdravnadzor.ru',
  ]) {
    assert.ok(text.includes(s), s);
  }
});

test(
  'пустой бланк повторяет оригинал: тот же видимый текст, включая линии и квадраты',
  { skip: !fs.existsSync(ORIGINAL) },
  async () => {
    const orig = visibleText(readDocx(fs.readFileSync(ORIGINAL))['word/document.xml'].toString('utf8'));
    const blank = visibleText(documentXml(await nf.blank('docx')));
    assert.equal(blank, orig);
  },
);

test('остальные части docx (стили, колонтитулы, настройки) не меняются', async () => {
  const filled = readDocx(await nf.render(FULL, 'docx'));
  const tpl = readDocx(fs.readFileSync(nf.TEMPLATE_PATH));
  assert.deepEqual(Object.keys(filled), Object.keys(tpl));
  for (const name of Object.keys(tpl))
    if (name !== 'word/document.xml') assert.ok(filled[name].equals(tpl[name]), name);
});

test('заполненный бланк: значения на местах, выбранные квадраты — «☑», остальные «□»', async () => {
  const xml = documentXml(await nf.render(FULL, 'docx'));
  assert.ok(!xml.includes('{{'));
  assertBalanced(xml);
  const text = visibleText(xml);
  // выбрано: Ж, беременность, аллергия есть, амбулаторное, 2 критерия, 2 меры, исход с последствиями,
  // отмена ЛС исчезла (да), повторно не назначалось (нет), врач
  assert.equal(count(text, '☑'), 12);
  assert.equal(count(text, '☑') + count(text, '□'), 38);
  assert.equal(count(xml, '✓'), 2, 'галочка в нарисованном квадрате: вместе с запасной веткой VML');
  for (const s of [
    'ПСИ-0042',
    '62.5',
    '30.09.2026',
    '15.09.2026',
    '25.09.2026',
    '26.10.2026',
    'Сертралин',
    '01.08.2026',
    '20.09.2026',
    'Омепразол',
    '10.01.2026',
    'врач-психиатр',
    'Иванова А. Б.',
    '+7 900 000-00-00',
    'г. Москва',
  ]) {
    assert.ok(text.includes(s), `нет «${s}»`);
  }
  // поле подчёркнуто, пустые поля остались линиями
  assert.ok(
    /<w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">ПСИ-0042/.test(xml) ||
      /<w:u w:val="single"\/>[^]*?ПСИ-0042/.test(xml),
  );
  assert.ok(text.includes('Дата начала НР15.09.2026'));
  assert.ok(text.includes('_'), 'незаполненные поля — линии');
});

test('текст экранируется и не может подставить метки или разметку', async () => {
  const xml = documentXml(
    await nf.render(
      {
        ...FULL,
        description: 'x </w:t></w:r> {{pad}} {{desc}} {{cb:sex=m}} <w:br/> & y',
        patient_code: '{{f:region|3}}',
        suspect_drugs: [{ trade_name: '{{c:s1.batch}}' }],
      },
      'docx',
    ),
  );
  assertBalanced(xml);
  const text = visibleText(xml);
  assert.ok(text.includes('x </w:t></w:r> {{pad}} {{desc}} {{cb:sex=m}} <w:br/> & y'));
  assert.ok(text.includes('{{f:region|3}}'));
  assert.ok(text.includes('{{c:s1.batch}}'));
  assert.ok(!xml.includes('</w:t></w:r> {{pad}}'));
});

test('длинное описание: кегль уменьшается, пустые строки убираются, перенос — <w:br/>', async () => {
  const short = documentXml(await nf.render({ description: 'Одна строка' }, 'docx'));
  assert.equal(count(short, 'w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">Одна строка'), 1);
  const long = documentXml(await nf.render({ description: 'слово '.repeat(300) }, 'docx'));
  assert.ok(
    /<w:sz w:val="16"\/><w:szCs w:val="16"\/><\/w:rPr><w:t xml:space="preserve">слово/.test(long),
    '8 пт для очень длинного',
  );
  const multi = documentXml(await nf.render({ description: 'а\nб\nв' }, 'docx'));
  assert.equal(count(multi, '<w:br/>'), 2);
  const paragraphs = (x) => count(x, '</w:p>');
  const blank = documentXml(await nf.blank('docx'));
  assert.ok(paragraphs(multi) < paragraphs(blank), 'пустые строки области описания заменены текстом');
});

test('validate: обязательные поля, перечисления, лимиты 3/5, длина, даты', () => {
  const empty = nf.validate({});
  assert.deepEqual(empty.missing, ['patient_code', 'suspect_drugs.0.trade_name', 'description', 'region', 'contact']);
  assert.deepEqual(nf.validate(null).missing, empty.missing);
  assert.deepEqual(nf.validate(FULL).missing, []);

  const many = nf.validate({
    suspect_drugs: [1, 2, 3, 4].map((i) => ({ trade_name: `ЛС${i}` })),
    other_drugs: [1, 2, 3, 4, 5, 6].map((i) => ({ trade_name: `Д${i}` })),
    sex: 'x',
    outcome: 'cured',
    seriousness: ['death', 'bogus', 'death'],
    measures: 'none',
    report_date: '2026-02-30',
    reaction_started_on: '15.09.2026',
    pregnant: 'yes',
    patient_code: 'К'.repeat(100),
    description: `${'д'.repeat(2500)}`,
  });
  assert.equal(many.fields.suspect_drugs.length, nf.MAX_SUSPECT);
  assert.equal(many.fields.other_drugs.length, nf.MAX_OTHER);
  assert.equal(many.fields.sex, '');
  assert.equal(many.fields.outcome, '');
  assert.deepEqual(many.fields.seriousness, ['death']);
  assert.deepEqual(many.fields.measures, []);
  assert.equal(many.fields.report_date, '');
  assert.equal(many.fields.reaction_started_on, '');
  assert.equal(many.fields.pregnant, null);
  assert.ok(many.fields.patient_code.length <= 35 && many.fields.patient_code.endsWith('…'));
  assert.ok(many.fields.description.length <= 2000);
  const codes = new Set(many.warnings.map((w) => `${w.field}:${w.code}`));
  for (const c of [
    'suspect_drugs:too_many',
    'other_drugs:too_many',
    'sex:bad_value',
    'report_date:bad_date',
    'patient_code:truncated',
    'description:truncated',
  ]) {
    assert.ok(codes.has(c), c);
  }
});

test('validate: управляющие символы убираются, повторный прогон ничего не меняет', () => {
  const v = nf.validate({
    patient_code: 'a\u0000b\u0008c\uD800d',
    description: 'строка\r\n\r\n\r\n\r\nещё\u000B',
    region: '  много   пробелов \n ',
  });
  assert.equal(v.fields.patient_code, 'abcd');
  assert.equal(v.fields.description, 'строка\n\nещё');
  assert.equal(v.fields.region, 'много пробелов');
  assert.deepEqual(nf.validate(v.fields).fields, v.fields);
  assert.deepEqual(nf.validate(FULL).fields, nf.validate(nf.validate(FULL).fields).fields);
});

test('ничего не выдумывается: пустые поля не получают значений и квадраты не отмечаются', async () => {
  const empty = documentXml(await nf.render({ patient_code: 'А-1' }, 'docx'));
  const blank = documentXml(await nf.blank('docx'));
  // отличие от пустого бланка — только вписанное значение и добивка под линию
  const strip = (x) => x.replace(/\u00A0/g, '').replace(/_/g, '');
  assert.equal(strip(visibleText(empty)).replace('А-1', ''), strip(visibleText(blank)));
  assert.equal(count(empty, '☑'), 0);
});

test('PDF: без конвертера — понятная ошибка, с подставленным конвертером получает именно docx', async (t) => {
  t.after(() => nf.setPdfConverter());
  if (!nf.pdfAvailable()) {
    await assert.rejects(() => nf.render(FULL, 'pdf'), { code: 'E-PDF-UNAVAILABLE' });
  }
  let seen = null;
  nf.setPdfConverter(async (docx) => {
    seen = docx;
    return Buffer.from('%PDF-stub');
  });
  const pdf = await nf.render(FULL, 'pdf');
  assert.equal(pdf.toString(), '%PDF-stub');
  assert.ok(documentXml(seen).includes('ПСИ-0042'));
  assert.equal((await nf.blank('pdf')).toString(), '%PDF-stub');
  await assert.rejects(() => nf.render(FULL, 'odt'), /формат/i);
});
