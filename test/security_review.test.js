'use strict';

// W3.H: регрессии находок независимого ревью безопасности (.agents/spec/acceptance/security-review.md).
//  SR-1 ReDoS в маскировании ПДн (e-mail), SR-2 secure_delete, SR-3 multipart только на маршрутах загрузки.

const { installCsrfFetch, realFetch } = require('./helpers');
installCsrfFetch();

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-secrev-'));
process.env.TDR_DB_PATH = path.join(tmp, 'secrev.sqlite3');
process.env.SESSION_SECRET = 'test-secret';

require('../scripts/gc-guard');
const db = require('../src/db');
const { seedDemo, DEMO_PASSWORD } = require('../scripts/seed-demo');
const pii = require('../src/ai/workspace/pii');

seedDemo();
const app = require('../src/app');

let fails = 0;
let oks = 0;
function check(label, cond) {
  if (cond) { oks++; console.log(`  OK   ${label}`); } else { fails++; console.error(`  FAIL ${label}`); }
}

async function login(base, email) {
  let r = await fetch(`${base}/csrf-token`);
  let ck = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const tok = (await r.json()).token;
  r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie: ck, 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': tok }, body: new URLSearchParams({ email, password: DEMO_PASSWORD }) });
  const sc = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  ck = sc || ck;
  const t = await (await fetch(`${base}/csrf-token`, { headers: { cookie: ck } })).json();
  return { cookie: ck, token: t.token };
}

(async () => {
  // SR-1: линейное время на длинных строках из символов e-mail; обычные адреса маскируются как раньше
  for (const [name, s] of [['цифры', '1'.repeat(60000)], ['точки', '.'.repeat(60000)], ['a@-цепочка', 'a'.repeat(30000) + '@' + 'b.'.repeat(15000)]]) {
    const t0 = Date.now();
    pii.detect(s);
    check(`SR-1 pii.detect(${name}, 60k) < 1.5 c`, Date.now() - t0 < 1500);
  }
  const m = pii.maskAll('Пишите ivan.petrov+x@mail.example.com или anna@ya.ru, тел. не указан');
  check('SR-1 e-mail по-прежнему маскируются', m.count === 2 && !/@/.test(m.text));

  // SR-2: после удаления текст не остаётся в файле БД
  check('SR-2 secure_delete включён', db.pragma('secure_delete', { simple: true }) === 1);
  const marker = 'МАРКЕР-ПД-' + 'Q'.repeat(40);
  const uid = db.prepare("INSERT INTO users (email, password_hash, role, full_name) VALUES ('sr2@example.com','x','patient','p')").run().lastInsertRowid;
  db.prepare('INSERT INTO mood_entries (patient_id, mood_score, note) VALUES (?, 5, ?)').run(uid, marker);
  db.prepare('DELETE FROM mood_entries WHERE patient_id = ?').run(uid);
  db.pragma('wal_checkpoint(TRUNCATE)');
  check('SR-2 удалённый текст не найден в файле БД', !fs.readFileSync(process.env.TDR_DB_PATH).includes(Buffer.from(marker)));

  // SR-3: multipart на произвольный URL отклоняется до чтения тела; загрузка врача работает
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const pat = await login(base, 'patient1.improving@example.com');
    const body = `--B\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${pat.token}\r\n--B--\r\n`;
    const r = await realFetch(`${base}/anything/else`, { method: 'POST', headers: { cookie: pat.cookie, 'content-type': 'multipart/form-data; boundary=B' }, body });
    check('SR-3 multipart на постороннем URL -> 403 (' + r.status + ')', r.status === 403);
    const doc = await login(base, 'psychiatrist1@example.com');
    const body2 = `--B\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${doc.token}\r\n--B\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nпривет\r\n--B--\r\n`;
    const r2 = await fetch(`${base}/ai/materials/preview`, { method: 'POST', headers: { cookie: doc.cookie, 'content-type': 'multipart/form-data; boundary=B' }, body: body2 });
    check('SR-3 загрузка материала врача по-прежнему работает (200)', r2.status === 200);
    const lg = await login(base, 'patient1.improving@example.com');
    const r3 = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie: lg.cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': lg.token }, body: 'email[a]=1&email[]=2&password[]=x' });
    check('SR-4 /login с email-массивом/объектом не даёт 500 (' + r3.status + ')', r3.status < 500);
  } finally {
    srv.close();
  }

  console.log(fails ? `\n${fails} FAIL` : '\nВсе проверки ревью безопасности прошли успешно.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
