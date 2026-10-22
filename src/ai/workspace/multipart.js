'use strict';

// Разбор multipart/form-data без внешних библиотек. Тело читается целиком в память с жёстким потолком
// (загрузки врача ограничены 5 файлами по 10 МБ), поэтому потоковая обработка не нужна.

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TOO_BIG = 'Загрузка слишком большая: за один раз можно отправить не больше установленного объёма файлов.';

function readBody(req, maxBytes) {
  // W2.S: CSRF-middleware уже прочитала тело, чтобы проверить поле _csrf; лимит маршрута применяем к готовому буферу
  if (req.rawBody) {
    return req.rawBody.length > maxBytes ? Promise.reject(new UploadError(413, TOO_BIG)) : Promise.resolve(req.rawBody);
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > maxBytes) {
      req.resume();
      return fail(new UploadError(413, TOO_BIG));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        chunks.length = 0;
        fail(new UploadError(413, TOO_BIG));
        req.resume(); // дочитываем и выбрасываем, чтобы ответить клиенту
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => fail(new UploadError(400, 'Загрузка прервана. Попробуйте ещё раз.')));
  });
}

function parseDisposition(h) {
  const out = {};
  const nameM = /(?:^|[;\s])name="([^"]*)"/i.exec(h);
  if (nameM) out.name = nameM[1];
  const star = /filename\*=(?:UTF-8|utf-8)''([^;\s]+)/.exec(h);
  const plain = /filename="([^"]*)"/i.exec(h);
  if (star) {
    try { out.filename = decodeURIComponent(star[1]); } catch { out.filename = plain ? plain[1] : ''; }
  } else if (plain) out.filename = plain[1];
  return out;
}

/** @returns {{fields: Object<string,string|string[]>, files: {field,filename,contentType,data:Buffer}[]}} */
function parse(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) throw new UploadError(400, 'Неверный формат загрузки.');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const sep = Buffer.concat([Buffer.from('\r\n'), boundary]);
  const fields = {};
  const files = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) throw new UploadError(400, 'Неверный формат загрузки.');
  while (pos >= 0) {
    pos += boundary.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // закрывающая граница
    if (buf[pos] === 0x0d) pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    const next = buf.indexOf(sep, headEnd + 4);
    if (next < 0) break;
    const data = buf.slice(headEnd + 4, next);
    const dispLine = /^content-disposition:\s*(.*)$/im.exec(head);
    const ctLine = /^content-type:\s*(.*)$/im.exec(head);
    if (dispLine) {
      const d = parseDisposition(dispLine[1]);
      if (d.filename !== undefined) {
        if (d.filename !== '' || data.length > 0) files.push({ field: d.name, filename: d.filename, contentType: ctLine ? ctLine[1].trim() : '', data });
      } else if (d.name !== undefined) {
        const v = data.toString('utf8');
        fields[d.name] = fields[d.name] === undefined ? v : [].concat(fields[d.name], v);
      }
    }
    pos = next + 2;
  }
  return { fields, files };
}

module.exports = { readBody, parse, UploadError };
