'use strict';

/**
 * Проверка и локальное извлечение текста из материалов врача (REQ-AID-005, REQ-SEC-006).
 * Без внешних сервисов и библиотек: txt/csv — декодирование, docx — свой ZIP-ридер, pdf — упрощённый
 * разбор текстовых операторов (Flate, ToUnicode), изображения принимаются без распознавания (OCR не делаем).
 *
 * Порядок проверок: пустой файл -> размер -> расширение (белый список) -> СИГНАТУРА содержимого
 * (должна соответствовать расширению) -> извлечение. Любой отказ — ExtractError с русским текстом;
 * при отказе вызывающий ничего не записывает.
 */

const zlib = require('zlib');
const zip = require('./zip');

class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const DEFAULTS = {
  maxFileBytes: (Number(process.env.AI_MAX_FILE_MB) || 10) * 1024 * 1024,
  maxFiles: Number(process.env.AI_MAX_FILES) || 5,
  maxTextChars: 200000,
  pdfTimeoutMs: 4000,
};

const ALLOWED = {
  txt: 'txt', csv: 'csv', docx: 'docx', pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};
const TYPES_HUMAN = 'txt, csv, docx, pdf (с текстовым слоем), png, jpg, gif, webp';

const DANGEROUS_EXT = new Set([
  'svg', 'svgz', 'html', 'htm', 'xhtml', 'xml', 'js', 'mjs', 'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'sh', 'php', 'jar', 'vbs', 'ps1', 'lnk',
]);

/** Имя файла для показа и хранения метаданных: без путей, управляющих символов, ведущих точек. */
function normalizeName(raw) {
  let n = String(raw == null ? '' : raw).normalize('NFC');
  n = n.split(/[\\/]/).pop() || '';
  n = n.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '');
  n = n.replace(/[^\p{L}\p{N} ._()\-]/gu, '_');
  n = n.replace(/\s+/g, ' ').trim().replace(/^[.\s_]+/, '');
  if (n.length > 80) {
    const m = /(\.[A-Za-z0-9]{1,5})$/.exec(n);
    const ext = m ? m[1] : '';
    n = n.slice(0, 80 - ext.length).trimEnd() + ext;
  }
  return n || 'файл';
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function startsWith(buf, bytes, at = 0) {
  if (buf.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
  return true;
}

const SIG = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38],
  pk: [0x50, 0x4b, 0x03, 0x04],
  ole: [0xd0, 0xcf, 0x11, 0xe0],
  mz: [0x4d, 0x5a],
  elf: [0x7f, 0x45, 0x4c, 0x46],
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
};

/** Что за содержимое по сигнатуре: pdf | docx_or_zip | png | jpg | gif | webp | exe | ole | unknown. */
function sniff(buf) {
  if (startsWith(buf, SIG.pdf) || buf.slice(0, 1024).includes('%PDF-')) return 'pdf';
  if (startsWith(buf, SIG.pk)) return 'zip';
  if (startsWith(buf, SIG.png)) return 'png';
  if (startsWith(buf, SIG.jpg)) return 'jpg';
  if (startsWith(buf, SIG.gif)) return 'gif';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (startsWith(buf, SIG.mz) || startsWith(buf, SIG.elf)) return 'exe';
  if (startsWith(buf, SIG.ole)) return 'ole';
  return 'unknown';
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function decodeText(buf) {
  let b = buf;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.slice(3);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.slice(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.slice(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1251').decode(b);
  }
}

// ---------- docx ----------

function xmlDecode(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChr(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function safeChr(cp) {
  try { return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; } catch { return ''; }
}

function docxText(buf) {
  if (startsWith(buf, SIG.ole)) throw new ExtractError('encrypted', 'Файл защищён паролем или это старый формат Word (.doc). Снимите защиту и сохраните как .docx.');
  let entries;
  try {
    entries = zip.readEntries(buf);
  } catch (e) {
    if (e instanceof zip.ZipError) throw mapZip(e);
    throw e;
  }
  const declared = entries.reduce((a, x) => a + x.size, 0);
  if (declared > zip.LIMITS.maxTotalBytes) throw new ExtractError('bomb', 'Документ отклонён: после распаковки он оказался бы слишком большим (возможна архивная бомба).');
  const byName = new Map(entries.map((x) => [x.name, x]));
  if (!byName.has('[Content_Types].xml') || !byName.has('word/document.xml')) {
    if (byName.has('EncryptedPackage')) throw new ExtractError('encrypted', 'Документ защищён паролем. Снимите защиту и загрузите снова.');
    throw new ExtractError('type', 'Файл не похож на документ Word (.docx): внутри нет основного текста.');
  }
  const state = { total: 0 };
  let xml;
  try {
    xml = zip.readEntry(buf, byName.get('word/document.xml'), state).toString('utf8');
  } catch (e) {
    if (e instanceof zip.ZipError) throw mapZip(e);
    throw e;
  }
  const text = xml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '');
  return xmlDecode(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function mapZip(e) {
  if (e.code === 'bomb') return new ExtractError('bomb', 'Документ отклонён: он слишком сильно сжат или слишком велик после распаковки (возможна архивная бомба).');
  if (e.code === 'encrypted') return new ExtractError('encrypted', 'Документ защищён паролем. Снимите защиту и загрузите снова.');
  return new ExtractError('corrupt', 'Не удалось прочитать документ: файл повреждён.');
}

// ---------- pdf ----------

function parseCMap(text) {
  const map = new Map();
  let bytes = 1;
  const hexToStr = (h) => {
    let s = '';
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      bytes = Math.max(bytes, Math.ceil(m[1].length / 2));
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
    }
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      bytes = Math.max(bytes, Math.ceil(m[1].length / 2));
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (m[3]) {
        const base = hexToStr(m[3]);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
      } else if (m[4]) {
        let c = lo;
        for (const x of m[4].matchAll(/<([0-9A-Fa-f]+)>/g)) { if (c > hi) break; map.set(c++, hexToStr(x[1])); }
      }
    }
  }
  return { map, bytes };
}

function unescapeLiteral(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n >= '0' && n <= '7') {
      let o = n;
      while (o.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') o += s[++i];
      out += String.fromCharCode(parseInt(o, 8) & 255);
    } else if (n === '\n' || n === '\r') { /* перенос строки */ } else out += n;
  }
  return out;
}

function pdfText(buf, opts) {
  const t0 = Date.now();
  const tick = () => { if (Date.now() - t0 > opts.pdfTimeoutMs) throw new ExtractError('timeout', 'PDF слишком сложный: обработка не уложилась в отведённое время. Загрузите текстовую версию.'); };
  const str = buf.toString('latin1');
  if (/\/Encrypt\b/.test(str.slice(-4096)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(str)) {
    throw new ExtractError('encrypted', 'PDF защищён паролем. Снимите защиту и загрузите снова.');
  }
  const objs = new Map(); // num -> {dict, stream}
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  let guard = 0;
  while ((m = re.exec(str))) {
    if (++guard % 500 === 0) tick();
    const start = re.lastIndex;
    const end = str.indexOf('endobj', start);
    if (end < 0) break;
    const body = str.slice(start, end);
    const sIdx = body.indexOf('stream');
    let dict = body;
    let stream = null;
    if (sIdx >= 0) {
      dict = body.slice(0, sIdx);
      let ds = start + sIdx + 6;
      if (str[ds] === '\r') ds++;
      if (str[ds] === '\n') ds++;
      let de = str.lastIndexOf('endstream', end);
      if (de < ds) de = end;
      stream = buf.slice(ds, de);
      if (stream.length && (stream[stream.length - 1] === 0x0a)) stream = stream.slice(0, stream.length - (stream[stream.length - 2] === 0x0d ? 2 : 1));
    }
    objs.set(Number(m[1]), { dict, stream });
    re.lastIndex = end + 6;
  }
  if (objs.size === 0) throw new ExtractError('corrupt', 'Не удалось прочитать PDF: файл повреждён или имеет неподдерживаемую структуру.');

  const inflate = (o) => {
    if (!o.stream) return null;
    if (/\/FlateDecode\b/.test(o.dict)) {
      try { return zlib.inflateSync(o.stream, { maxOutputLength: 30 * 1024 * 1024 }); } catch { return null; }
    }
    if (/\/Filter\b/.test(o.dict)) return null; // другие фильтры (LZW, DCT и т.д.) не поддерживаем
    return o.stream;
  };

  // шрифты: имя ресурса -> cmap
  const cmapCache = new Map();
  const cmapOf = (fontNum) => {
    if (cmapCache.has(fontNum)) return cmapCache.get(fontNum);
    let res = null;
    const f = objs.get(fontNum);
    const tu = f && /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(f.dict);
    if (tu && objs.get(Number(tu[1]))) {
      const data = inflate(objs.get(Number(tu[1])));
      if (data) res = parseCMap(data.toString('latin1'));
    }
    cmapCache.set(fontNum, res);
    return res;
  };
  const fontRes = new Map(); // /F1 -> obj num
  const addPairs = (txt) => { for (const p of txt.matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g)) fontRes.set(p[1], Number(p[2])); };
  for (const [, o] of objs) {
    const fm = /\/Font\s*<<([\s\S]*?)>>/.exec(o.dict);
    if (fm) addPairs(fm[1]);
    const fr = /\/Font\s+(\d+)\s+\d+\s+R/.exec(o.dict);
    if (fr && objs.get(Number(fr[1]))) addPairs(objs.get(Number(fr[1])).dict);
  }

  const nums = [...objs.keys()].sort((a, b) => a - b);
  const pages = [];
  for (const n of nums) {
    tick();
    const o = objs.get(n);
    if (!o.stream || /\/Type\s*\/(XObject|ObjStm|XRef|Metadata|EmbeddedFile)\b|\/Subtype\s*\/(Image|Form)\b|\/FontFile|\/Length1\b/.test(o.dict)) continue;
    const data = inflate(o);
    if (!data) continue;
    const s = data.toString('latin1');
    if (!/\bBT\b/.test(s) || !/\bET\b/.test(s)) continue;
    pages.push(contentText(s, fontRes, cmapOf, tick));
  }
  return pages.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function contentText(s, fontRes, cmapOf, tick) {
  let out = '';
  let cm = null;
  const dec = (raw, isHex) => {
    let bytes = raw;
    if (isHex) {
      let h = raw.replace(/\s+/g, '');
      if (h.length % 2) h += '0';
      bytes = '';
      for (let i = 0; i < h.length; i += 2) bytes += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    }
    if (cm && cm.map.size) {
      const step = cm.bytes;
      let r = '';
      for (let i = 0; i + step <= bytes.length; i += step) {
        let code = 0;
        for (let k = 0; k < step; k++) code = code * 256 + bytes.charCodeAt(i + k);
        const u = cm.map.get(code);
        r += u !== undefined ? u : '';
      }
      return r;
    }
    return bytes.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  };
  const tokRe = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s\[\]()<>\/]+|[-+]?\d*\.?\d+|[A-Za-z'"*]+/g;
  let arr = null;
  let last = null;
  let prev = null;
  let n = 0;
  for (const t of s.matchAll(tokRe)) {
    if (++n % 20000 === 0) tick();
    const tok = t[0];
    if (tok[0] === '(' ) {
      const val = dec(unescapeLiteral(tok.slice(1, -1)), false);
      if (arr) arr.push(val); else last = val;
    } else if (tok[0] === '<' ) {
      const val = dec(tok.slice(1, -1), true);
      if (arr) arr.push(val); else last = val;
    } else if (tok === '[') arr = [];
    else if (tok === ']') { last = arr; arr = null; }
    else if (/^[-+]?\d*\.?\d+$/.test(tok)) { if (arr) arr.push(Number(tok)); }
    else if (tok[0] === '/') { prev = tok.slice(1); if (!arr) last = tok; }
    else {
      switch (tok) {
        case 'Tf': if (typeof last === 'string' && last[0] === '/') { const num = fontRes.get(last.slice(1)); cm = num ? cmapOf(num) : null; } break;
        case 'Tj': case "'": case '"':
          if (tok !== 'Tj') out += '\n';
          if (typeof last === 'string' && last[0] !== '/') out += last;
          break;
        case 'TJ':
          if (Array.isArray(last)) for (const x of last) out += typeof x === 'number' ? (x < -250 ? ' ' : '') : x;
          break;
        case 'Td': case 'TD': case 'T*': case 'Tm': case 'ET': out += '\n'; break;
        default: break;
      }
      if (tok !== 'Tf') last = null;
    }
  }
  return out;
}

// ---------- общий вход ----------

/**
 * @param {string} rawName имя от клиента
 * @param {Buffer} buf содержимое
 * @param {object} opts переопределение лимитов (тесты)
 * @returns {{name, ext, kind, text, hasText, note, size, truncated}}
 * @throws {ExtractError}
 */
function inspect(rawName, buf, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const name = normalizeName(rawName);
  const ext = extOf(name);
  if (!buf || buf.length === 0) throw new ExtractError('empty', `Файл «${name}» пустой (0 байт), загрузка отклонена.`);
  if (buf.length > o.maxFileBytes) {
    throw new ExtractError('size', `Файл «${name}» больше ${Math.round(o.maxFileBytes / 1048576)} МБ, загрузка отклонена.`);
  }
  if (ext === 'svg' || ext === 'svgz' || ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    throw new ExtractError('type', `Файл «${name}» отклонён: SVG и HTML не принимаются, они могут содержать скрипты. Допустимые типы: ${TYPES_HUMAN}.`);
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, ext) || DANGEROUS_EXT.has(ext)) {
    throw new ExtractError('type', `Файл «${name}» отклонён: тип${ext ? ` «.${ext}»` : ''} не поддерживается. Допустимые типы: ${TYPES_HUMAN}.`);
  }
  const kind = ALLOWED[ext];
  const sig = sniff(buf);
  const mismatch = () => new ExtractError('signature', `Файл «${name}» отклонён: содержимое не соответствует расширению «.${ext}».`);
  let text = '';
  let note = '';
  let hasText = true;

  if (kind === 'image') {
    const want = ext === 'jpeg' ? 'jpg' : ext;
    if (sig !== want) throw mismatch();
    text = '';
    hasText = false;
    note = 'Изображение сохранено как файл. Текст не извлечён: распознавание текста (OCR) в сервисе не используется. Персональные данные на изображении не маскируются.';
  } else if (kind === 'pdf') {
    if (sig !== 'pdf') throw mismatch();
    text = pdfText(buf, o);
    if (!text.trim()) {
      hasText = false;
      note = 'Текст не извлечён: в PDF нет текстового слоя (вероятно, это скан). Распознавание текста (OCR) в сервисе не используется.';
    }
  } else if (kind === 'docx') {
    if (sig !== 'zip' && sig !== 'ole') throw mismatch();
    text = docxText(buf);
    if (!text.trim()) { hasText = false; note = 'В документе нет текста.'; }
  } else {
    // txt / csv
    if (sig !== 'unknown' || looksBinary(buf)) throw mismatch();
    text = decodeText(buf);
    const head = text.slice(0, 2000).trimStart().toLowerCase();
    if (/^(<svg|<\?xml|<html|<!doctype|<script)/.test(head) || /<script[\s>]/i.test(text.slice(0, 200000))) {
      throw new ExtractError('type', `Файл «${name}» отклонён: он похож на HTML/SVG с кодом, а не на текст.`);
    }
    if (!text.trim()) { hasText = false; note = 'В файле нет текста.'; }
  }
  text = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  let truncated = false;
  if (text.length > o.maxTextChars) { text = text.slice(0, o.maxTextChars); truncated = true; note = (note ? note + ' ' : '') + `Текст обрезан до ${o.maxTextChars} символов.`; }
  return { name, ext, kind, text, hasText, note, size: buf.length, truncated };
}

module.exports = { inspect, normalizeName, extOf, sniff, ExtractError, DEFAULTS, ALLOWED, TYPES_HUMAN };
