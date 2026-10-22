'use strict';

/**
 * Экспорт ответа/диалога ИИ-пространства в TXT, DOCX и PDF (REQ-AID-010). Всё локально, без библиотек:
 *  - DOCX — минимальный OOXML-пакет (zip.js);
 *  - PDF — собственный генератор: Type0/Identity-H со встроенным подмножеством шрифта DejaVu Sans
 *    (src/ai/workspace/fonts, кириллица), ToUnicode для копирования/поиска текста.
 * В шапке — дата, «черновик», дисклеймер. Имя файла без ФИО: черновик_YYYY-MM-DD.<ext>.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const zip = require('./zip');

const DRAFT_LABEL = 'ЧЕРНОВИК · решение за врачом, не диагноз';
const DISCLAIMER = 'Документ сформирован ИИ-пространством (локальная заглушка, модель не подключена). Это не диагноз и не рекомендация лечения; тексты ожидают проверки специалистом. Окончательное решение принимает врач.';
const TITLE = 'Черновик ИИ-пространства врача';

function today(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function fileName(ext, d) {
  return `черновик_${today(d)}.${ext}`;
}

/** doc: {date, items:[{who, text}], note?} */
function normalize(doc) {
  // title/label(draftLabel)/disclaimer/watermark — необязательные переопределения шапки (W2.G шаблоны, W2.E заключения)
  const label = doc.label || doc.draftLabel || DRAFT_LABEL;
  return {
    title: doc.title || TITLE,
    label,
    draftLabel: label,
    disclaimer: doc.disclaimer || DISCLAIMER,
    watermark: doc.watermark || '',
    date: doc.date || today(),
    items: (doc.items || []).map((i) => ({ who: i.who || '', text: String(i.text || '') })),
    note: doc.note || '',
  };
}

// ---------- TXT ----------

function buildTxt(docIn) {
  const doc = normalize(docIn);
  const out = [doc.title, doc.draftLabel, `Дата: ${doc.date}`, doc.disclaimer];
  if (doc.note) out.push(doc.note);
  out.push('', '='.repeat(40), '');
  for (const it of doc.items) {
    if (it.who) out.push(`${it.who}:`);
    out.push(it.text, '');
  }
  return Buffer.from('﻿' + out.join('\n'), 'utf8');
}

// ---------- DOCX ----------

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function para(text, { bold = false, size = 22, color = null, after = 120 } = {}) {
  const rpr = `<w:rPr>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/></w:rPr>`;
  const lines = String(text).split('\n');
  const runs = lines.map((l, i) => `${i ? '<w:r><w:br/></w:r>' : ''}<w:r>${rpr}<w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r>`).join('');
  return `<w:p><w:pPr><w:spacing w:after="${after}"/></w:pPr>${runs}</w:p>`;
}

function buildDocx(docIn) {
  const doc = normalize(docIn);
  const body = [
    para(doc.title, { bold: true, size: 32 }),
    para(doc.draftLabel, { bold: true, size: 24, color: 'B00020' }),
    para(`Дата: ${doc.date}`, { size: 20 }),
    para(doc.disclaimer, { size: 18, color: '555555', after: 240 }),
  ];
  if (doc.note) body.push(para(doc.note, { size: 20 }));
  for (const it of doc.items) {
    if (it.who) body.push(para(it.who, { bold: true, size: 22, after: 60 }));
    body.push(para(it.text, { size: 22, after: 200 }));
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  return zip.build([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

// ---------- PDF ----------

let fontCache = null;

function loadFont() {
  if (fontCache) return fontCache;
  const buf = fs.readFileSync(path.join(__dirname, 'fonts', 'DejaVuSans-subset.ttf'));
  const nTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < nTables; i++) {
    const o = 12 + i * 16;
    tables[buf.toString('latin1', o, o + 4)] = { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) };
  }
  const head = tables.head.offset;
  const upm = buf.readUInt16BE(head + 18);
  const bbox = [buf.readInt16BE(head + 36), buf.readInt16BE(head + 38), buf.readInt16BE(head + 40), buf.readInt16BE(head + 42)];
  const ascent = buf.readInt16BE(tables.hhea.offset + 4);
  const descent = buf.readInt16BE(tables.hhea.offset + 6);
  const nHm = buf.readUInt16BE(tables.hhea.offset + 34);
  const hmtx = tables.hmtx.offset;
  const advance = (gid) => buf.readUInt16BE(hmtx + 4 * Math.min(gid, nHm - 1));
  // cmap format 4
  const cm = tables.cmap.offset;
  const nSub = buf.readUInt16BE(cm + 2);
  let sub = -1;
  for (let i = 0; i < nSub; i++) {
    const o = cm + 4 + i * 8;
    const pid = buf.readUInt16BE(o);
    const eid = buf.readUInt16BE(o + 2);
    const off = cm + buf.readUInt32BE(o + 4);
    if (buf.readUInt16BE(off) === 4 && ((pid === 3 && eid === 1) || pid === 0)) { sub = off; break; }
  }
  if (sub < 0) throw new Error('font: no cmap format 4');
  const segX2 = buf.readUInt16BE(sub + 6);
  const segs = segX2 / 2;
  const endO = sub + 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;
  const glyphFor = (cp) => {
    if (cp > 0xffff) return 0;
    for (let i = 0; i < segs; i++) {
      const end = buf.readUInt16BE(endO + i * 2);
      if (cp > end) continue;
      const start = buf.readUInt16BE(startO + i * 2);
      if (cp < start) return 0;
      const delta = buf.readInt16BE(deltaO + i * 2);
      const ro = buf.readUInt16BE(rangeO + i * 2);
      if (ro === 0) return (cp + delta) & 0xffff;
      const gAddr = rangeO + i * 2 + ro + (cp - start) * 2;
      const g = buf.readUInt16BE(gAddr);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  let capHeight = Math.round(upm * 0.73);
  if (tables['OS/2'] && tables['OS/2'].length >= 90) capHeight = buf.readInt16BE(tables['OS/2'].offset + 88) || capHeight;
  fontCache = { buf, upm, bbox, ascent, descent, capHeight, advance, glyphFor };
  return fontCache;
}

const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();

function pdfStream(dictExtra, data) {
  const comp = zlib.deflateSync(data);
  return Buffer.concat([
    Buffer.from(`<< ${dictExtra} /Filter /FlateDecode /Length ${comp.length} >>\nstream\n`, 'latin1'),
    comp,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

/** Раскладка строк по ширине. blocks: [{text,size,gap}] -> страницы [[{x,y,size,gids[]}]] */
function layout(blocks, font) {
  const W = 595;
  const H = 842;
  const M = 56;
  const maxW = W - 2 * M;
  const pages = [[]];
  let y = H - M;
  const widthOf = (str, size) => {
    let w = 0;
    for (const ch of str) w += font.advance(font.glyphFor(ch.codePointAt(0)) || 0);
    return (w * size) / font.upm;
  };
  const newPage = () => { pages.push([]); y = H - M; };
  for (const b of blocks) {
    const size = b.size || 11;
    const lead = size * 1.35;
    const paras = String(b.text).split('\n');
    for (const p of paras) {
      const words = p.split(/(\s+)/).filter((x) => x.length);
      let line = '';
      const flush = () => {
        if (y - lead < M) newPage();
        y -= lead;
        pages[pages.length - 1].push({ x: M, y, size, text: line.replace(/\s+$/, ''), color: b.color });
        line = '';
      };
      if (!words.length) { if (y - lead < M) newPage(); y -= lead; continue; }
      for (let w of words) {
        if (/^\s+$/.test(w)) { if (line) line += ' '; continue; }
        // слишком длинное слово — разбиваем по символам
        while (widthOf(w, size) > maxW) {
          let cut = w.length;
          while (cut > 1 && widthOf(w.slice(0, cut), size) > maxW) cut--;
          if (line) flush();
          line = w.slice(0, cut);
          flush();
          w = w.slice(cut);
        }
        if (line && widthOf(line + w, size) > maxW) flush();
        line += w;
      }
      if (line) flush();
    }
    y -= b.gap == null ? 6 : b.gap;
  }
  return pages;
}

function buildPdf(docIn) {
  const doc = normalize(docIn);
  const font = loadFont();
  const blocks = [
    { text: doc.title, size: 17, gap: 4 },
    { text: doc.draftLabel, size: 12, gap: 2, color: [0.69, 0, 0.13] },
    { text: `Дата: ${doc.date}`, size: 10, gap: 2 },
    { text: doc.disclaimer, size: 9, gap: 14, color: [0.33, 0.33, 0.33] },
  ];
  if (doc.note) blocks.push({ text: doc.note, size: 10, gap: 10 });
  for (const it of doc.items) {
    if (it.who) blocks.push({ text: it.who, size: 11, gap: 1, color: [0.1, 0.2, 0.45] });
    blocks.push({ text: it.text, size: 11, gap: 12 });
  }
  const pages = layout(blocks, font);

  const used = new Map(); // gid -> unicode
  const content = pages.map((lines) => {
    const ops = [];
    if (doc.watermark) {
      // диагональная светло-серая метка (напр. «ЧЕРНОВИК») под текстом страницы
      let wm = '';
      for (const ch of doc.watermark) {
        const cp = ch.codePointAt(0);
        const g = font.glyphFor(cp) || font.glyphFor(0x20);
        if (!used.has(g)) used.set(g, cp);
        wm += hex4(g);
      }
      ops.push(`0.88 0.88 0.88 rg BT /F1 90 Tf 0.7071 0.7071 -0.7071 0.7071 130 250 Tm <${wm}> Tj ET`);
    }
    for (const ln of lines) {
      let hex = '';
      for (const ch of ln.text) {
        const cp = ch.codePointAt(0);
        let g = font.glyphFor(cp);
        if (!g) g = font.glyphFor(0x20);
        if (!used.has(g)) used.set(g, cp);
        hex += hex4(g);
      }
      const c = ln.color || [0, 0, 0];
      ops.push(`${c[0]} ${c[1]} ${c[2]} rg BT /F1 ${ln.size} Tf 1 0 0 1 ${ln.x.toFixed(2)} ${ln.y.toFixed(2)} Tm <${hex}> Tj ET`);
    }
    return Buffer.from(ops.join('\n'), 'latin1');
  });

  const objs = []; // индекс i -> Buffer тела объекта (i+1)
  const add = (b) => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')); return objs.length; };
  const pageCount = pages.length;
  // нумерация: 1 Catalog, 2 Pages, 3 Type0, 4 CIDFont, 5 Descriptor, 6 FontFile2, 7 ToUnicode, далее пары Page/Content
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${8 + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  add('<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 7 0 R >>');
  const wEntries = [...used.keys()].sort((a, b) => a - b).map((g) => `${g} [${Math.round((font.advance(g) * 1000) / font.upm)}]`).join(' ');
  add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /CIDToGIDMap /Identity /DW 600 /W [${wEntries}] >>`);
  const sc = 1000 / font.upm;
  add(`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [${font.bbox.map((v) => Math.round(v * sc)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(font.ascent * sc)} /Descent ${Math.round(font.descent * sc)} /CapHeight ${Math.round(font.capHeight * sc)} /StemV 80 /FontFile2 6 0 R >>`);
  add(pdfStream(`/Length1 ${font.buf.length}`, font.buf));
  // ToUnicode
  const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
  const chunks = [];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.map(([g, cp]) => `<${hex4(g)}> <${cp > 0xffff ? '' : hex4(cp)}>`).join('\n')}\nendbfchar`);
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  add(pdfStream('', Buffer.from(cmap, 'latin1')));
  pages.forEach((_, i) => {
    const pageNum = 8 + i * 2;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNum + 1} 0 R >>`);
    add(pdfStream('', content[i]));
  });

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b);
    pos += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const FORMATS = {
  txt: { build: buildTxt, mime: 'text/plain; charset=utf-8' },
  docx: { build: buildDocx, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pdf: { build: buildPdf, mime: 'application/pdf' },
};

module.exports = { buildTxt, buildDocx, buildPdf, FORMATS, fileName, today, normalize, DRAFT_LABEL, DISCLAIMER, TITLE };
