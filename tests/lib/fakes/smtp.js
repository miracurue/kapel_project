'use strict';

// Подделка почтового сервера (вместо Mailpit/Postbox): принимает письма по SMTP
// без TLS и пароля и держит их в памяти теста. Приложение получает её адрес
// через SMTP_HOST/SMTP_PORT (12, «Config»). Ничего наружу не отправляется.

const net = require('net');

function startFakeSmtp() {
  const messages = [];
  let failNext = 0; // сколько следующих писем отклонить кодом 451 (проверка повторов F-20)

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    let inData = false;
    let current = { from: null, to: [], data: '' };
    const reply = (s) => socket.write(`${s}\r\n`);
    reply('220 fake-smtp.test ESMTP');
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            if (failNext > 0) {
              failNext -= 1;
              reply('451 temporary failure (fake)');
            } else {
              messages.push({ ...current, receivedAt: Date.now() });
              reply('250 OK queued');
            }
            current = { from: null, to: [], data: '' };
          } else {
            current.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') { reply('250-fake-smtp.test'); reply('250 8BITMIME'); }
        else if (cmd === 'HELO') reply('250 fake-smtp.test');
        else if (cmd === 'MAIL') { current.from = line.replace(/^MAIL FROM:\s*/i, ''); reply('250 OK'); }
        else if (cmd === 'RCPT') { current.to.push(line.replace(/^RCPT TO:\s*/i, '')); reply('250 OK'); }
        else if (cmd === 'DATA') { inData = true; reply('354 end with .'); }
        else if (cmd === 'RSET') { current = { from: null, to: [], data: '' }; reply('250 OK'); }
        else if (cmd === 'NOOP') reply('250 OK');
        else if (cmd === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('502 not implemented');
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        host: '127.0.0.1',
        port: server.address().port,
        messages,
        failNextMessages(n) { failNext = n; },
        // Письмо на адрес (последнее), с декодированием quoted-printable/base64 тела «в лоб».
        lastTo(addr) {
          const m = [...messages].reverse().find((x) => x.to.some((t) => t.toLowerCase().includes(addr.toLowerCase())));
          return m ? { ...m, text: decodeBody(m.data) } : null;
        },
        clear() { messages.length = 0; },
        close() { return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

function decodeBody(raw) {
  let out = raw;
  // quoted-printable
  out = out.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  try { out = Buffer.from(out, 'latin1').toString('utf8'); } catch (_) { /* как есть */ }
  // base64-блоки
  const b64 = raw.match(/\n\n([A-Za-z0-9+/=\n]{40,})\n/);
  if (b64) {
    try { out += '\n' + Buffer.from(b64[1].replace(/\n/g, ''), 'base64').toString('utf8'); } catch (_) { /* не base64 */ }
  }
  return out;
}

// Ссылка сброса пароля из письма.
function extractLink(text) {
  const m = String(text).match(/https?:\/\/[^\s"'<>]+\/password\/reset\/[A-Za-z0-9_\-]+/);
  return m ? m[0] : null;
}

module.exports = { startFakeSmtp, extractLink };
