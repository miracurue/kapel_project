'use strict';

// Минимальный ZIP: безопасное чтение (для docx) и запись (для экспорта DOCX). Без зависимостей, только zlib.
// Чтение рассчитано на недоверенные файлы: лимиты числа записей, размера распаковки и степени сжатия
// (защита от архива-бомбы), распаковка с жёстким maxOutputLength независимо от того, что заявлено в заголовке.

const zlib = require('zlib');

class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const LIMITS = { maxEntries: 2000, maxEntryBytes: 25 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024, maxRatio: 200 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Оглавление ZIP: [{name, method, compSize, size, offset, flags}] без распаковки. */
function readEntries(buf) {
  if (buf.length < 22) throw new ZipError('corrupt', 'Файл повреждён');
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('corrupt', 'Не найден конец архива');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total > LIMITS.maxEntries) throw new ZipError('bomb', 'Слишком много вложенных файлов');
  if (cdOff + cdSize > buf.length) throw new ZipError('corrupt', 'Оглавление архива повреждено');
  const entries = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('corrupt', 'Оглавление архива повреждено');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, size, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Распаковывает одну запись; бросает ZipError('bomb') при превышении лимитов. */
function readEntry(buf, entry, state = { total: 0 }) {
  if (entry.flags & 1) throw new ZipError('encrypted', 'Архив защищён паролем');
  if (entry.size > LIMITS.maxEntryBytes) throw new ZipError('bomb', 'Файл внутри архива слишком большой');
  if (entry.compSize > 0 && entry.size / entry.compSize > LIMITS.maxRatio && entry.size > 1024 * 1024) {
    throw new ZipError('bomb', 'Подозрительная степень сжатия');
  }
  const o = entry.offset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new ZipError('corrupt', 'Запись архива повреждена');
  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const start = o + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compSize);
  let out;
  if (entry.method === 0) out = raw;
  else if (entry.method === 8) {
    try {
      out = zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.maxEntryBytes });
    } catch (e) {
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError('bomb', 'Файл внутри архива слишком большой');
      throw new ZipError('corrupt', 'Запись архива повреждена');
    }
  } else throw new ZipError('unsupported', 'Неподдерживаемый способ сжатия');
  state.total += out.length;
  if (state.total > LIMITS.maxTotalBytes) throw new ZipError('bomb', 'Суммарный размер распаковки слишком велик');
  return out;
}

/** Собирает ZIP из [{name, data: Buffer|string}] (deflate). */
function build(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // имена в UTF-8
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

module.exports = { readEntries, readEntry, build, crc32, ZipError, LIMITS };
