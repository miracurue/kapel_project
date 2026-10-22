'use strict';

/**
 * W-49 (этап 14, веха В6): документы по пациенту (F-67) и заключения психолога
 * (F-68). Шаблоны разделов, нумерация <тип>-<год>-<номер> (S-54) и экспорт
 * PDF/DOCX/TXT (F-80) без ФИО в имени файла. Разделы документов хранятся
 * шифротекстом (sections_enc, AES-256-GCM); заключения — в таблицах
 * conclusions/conclusion_versions (подпись с паролем, контрольная сумма,
 * неизменяемость подписанного — триггером базы).
 */

const crypto = require('crypto');

// Типы документов UC-20 (S-54). Выдать пациенту можно только памятку и итоговую
// сводку (и подписанное заключение психолога) — решение владельца (T-221).
const DOC_TYPES = {
  mis_summary: { prefix: 'MIS', title: 'Итоговая сводка', releasable: true },
  visit_summary: { prefix: 'VIS', title: 'Сводка визита', releasable: false },
  memo: { prefix: 'MEM', title: 'Памятка', releasable: true },
  conclusion: { prefix: 'CON', title: 'Заключение психолога', releasable: true },
};

// Разделы шаблонов. Психологу лекарственные разделы не создаются (F-58, T-221):
// ключи treatment/plan/meds — только у психиатра.
const SECTIONS = {
  psychiatrist: {
    mis_summary: ['anamnesis', 'status', 'course', 'treatment', 'plan', 'summary'],
    visit_summary: ['visit', 'findings', 'treatment', 'recommendations'],
    memo: ['topic', 'advice'],
  },
  psychologist: {
    mis_summary: ['anamnesis', 'status', 'course', 'recommendations', 'summary'],
    visit_summary: ['visit', 'findings', 'recommendations'],
    memo: ['topic', 'advice'],
    conclusion: ['status', 'dynamics', 'recommendations'],
  },
};

// Ключи, запрещённые психологу (F-58): ничего о лекарственной терапии и диагнозе.
const MEDS_KEY_RE = /treatment|plan|meds|лекарств|диагноз/i;

function sectionsFor(role, type) {
  const keys = (SECTIONS[role] && SECTIONS[role][type]) || [];
  return keys.map((key) => ({ key, text: '' }));
}

function nextNumber(db, year) {
  const a = db.prepare("SELECT count(*) n FROM patient_documents WHERE substr(created_at,1,4) = ?").get(year).n;
  const b = db.prepare("SELECT count(*) n FROM conclusions WHERE substr(created_at,1,4) = ?").get(year).n;
  return a + b + 1;
}

function makeNumber(prefix, year, seq) {
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

// --- Экспорт (F-80) ---------------------------------------------------------

// PDF со стандартным шрифтом не несёт кириллицу — текст транслитерируется;
// содержимое детерминировано: повторный экспорт той же версии даёт тот же файл.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function translit(text) {
  return String(text || '')
    .split('')
    .map((ch) => {
      const low = ch.toLowerCase();
      if (TRANSLIT[low] === undefined) return ch;
      const rep = TRANSLIT[low];
      return ch === low ? rep : rep.charAt(0).toUpperCase() + rep.slice(1);
    })
    .join('');
}

function plainText(doc) {
  const lines = [`${doc.typeTitle} ${doc.number}`, `Versiya: ${doc.version}`, ''];
  for (const s of doc.sections) {
    lines.push(`[${s.key}]`);
    lines.push(s.text || '');
    lines.push('');
  }
  return lines.join('\n');
}

function pdfEscape(text) {
  return translit(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Минимальный одностраничный PDF (Helvetica, WinAnsi) — без внешних зависимостей.
function renderPdf(doc) {
  const lines = [pdfEscape(`${doc.typeTitle} ${doc.number}`), pdfEscape(`Versiya: ${doc.version}`), ''];
  for (const s of doc.sections) {
    lines.push(pdfEscape(`[${s.key}]`));
    for (const raw of String(s.text || '').split('\n')) lines.push(pdfEscape(raw));
    lines.push('');
  }
  let content = 'BT /F1 11 Tf 14 TL 44 800 Td';
  for (const line of lines) content += ` (${line}) Tj T*`;
  content += ' ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

// Минимальный DOCX (ZIP без сжатия, CRC32 вручную) — без внешних зависимостей.
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function xmlEscape(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// ZIP «store»: локальный заголовок 30 байт + имя + данные, центральный каталог, EOCD.
function storedZip(files) {
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length + data.length);
    local.write('PK\x03\x04', 0, 'latin1');
    local.writeUInt16LE(20, 4); // версия
    local.writeUInt16LE(0, 6); // флаги
    local.writeUInt16LE(0, 8); // метод: store (без сжатия)
    local.writeUInt16LE(0, 10); // время
    local.writeUInt16LE(0, 12); // дата (детерминировано)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // имя не в extra
    nameBuf.copy(local, 30);
    data.copy(local, 30 + nameBuf.length);
    central.push({ nameBuf, crc, size: data.length, offset });
    localParts.push(local);
    offset += local.length;
  }
  const centralStart = offset;
  const centralParts = [];
  for (const e of central) {
    const h = Buffer.alloc(46 + e.nameBuf.length);
    h.write('PK\x01\x02', 0, 'latin1');
    h.writeUInt16LE(20, 4); // версия автора
    h.writeUInt16LE(20, 6); // версия нужна
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.size, 20);
    h.writeUInt32LE(e.size, 24);
    h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt32LE(e.offset, 42);
    e.nameBuf.copy(h, 46);
    centralParts.push(h);
    offset += h.length;
  }
  const end = Buffer.alloc(22);
  end.write('PK\x05\x06', 0, 'latin1');
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function renderDocx(doc) {
  const paras = [
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEscape(doc.typeTitle)} ${xmlEscape(doc.number)}</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t xml:space="preserve">Versiya ${doc.version}</w:t></w:r></w:p>`,
  ];
  for (const s of doc.sections) {
    paras.push(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEscape(s.key)}</w:t></w:r></w:p>`);
    for (const raw of String(s.text || '').split('\n'))
      paras.push(`<w:p><w:r><w:t xml:space="preserve">${xmlEscape(raw)}</w:t></w:r></w:p>`);
  }
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paras.join('')}</w:body></w:document>`;
  const types =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  return storedZip([
    ['[Content_Types].xml', Buffer.from(types, 'utf8')],
    ['_rels/.rels', Buffer.from(rels, 'utf8')],
    ['word/document.xml', Buffer.from(document, 'utf8')],
  ]);
}

function renderExport(doc, format) {
  if (format === 'txt') return { mime: 'text/plain; charset=utf-8', ext: 'txt', body: Buffer.from(plainText(doc), 'utf8') };
  if (format === 'pdf') return { mime: 'application/pdf', ext: 'pdf', body: renderPdf(doc) };
  if (format === 'docx')
    return {
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ext: 'docx',
      body: renderDocx(doc),
    };
  return null;
}

function checksum(doc) {
  return crypto.createHash('sha256').update(plainText(doc)).digest('hex');
}

module.exports = { DOC_TYPES, SECTIONS, MEDS_KEY_RE, sectionsFor, nextNumber, makeNumber, renderExport, plainText, checksum, storedZip };