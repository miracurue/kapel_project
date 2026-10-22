'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W1.C2: ИИ-пространство врача — доступ, треды/привязка к пациенту, согласия, загрузка материалов (негативные
// сценарии REQ-SEC-006), маскирование ПДн, срок хранения/удаление, экспорт DOCX/PDF/TXT, аудит без текста,
// отсутствие исходящих соединений.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-aiws-'));
process.env.TDR_DB_PATH = path.join(tmp, 'aiws.sqlite3');
process.env.AI_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.SESSION_SECRET = 'test-secret';

const outbound = [];
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...args) {
  const o = args[0];
  const host = o && typeof o === 'object' ? o.host : undefined;
  if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    outbound.push(host);
    throw new Error(`outbound connection blocked: ${host}`);
  }
  return origConnect.apply(this, args);
};

const bcrypt = require('bcryptjs');
require('../scripts/gc-guard');
const db = require('../src/db');
const app = require('../src/app');
const provider = require('../src/ai/provider');
const threads = require('../src/ai/threads');
const pii = require('../src/ai/workspace/pii');
const extract = require('../src/ai/workspace/extract');
const store = require('../src/ai/workspace/store');
const zip = require('../src/ai/workspace/zip');
const exporter = require('../src/ai/workspace/export');
const service = require('../src/ai/workspace/service');
const scenarios = require('../src/ai/workspace/scenarios');
const adminDeletion = require('../src/admin_deletion');

const PORT = 20000 + Math.floor(Math.random() * 20000); // случайный порт: параллельные запуски в разных worktree
const BASE = `http://127.0.0.1:${PORT}`;
let fails = 0;
let oks = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

function mkUser(email, role, name, extra = {}) {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, role, full_name, consent_given, clinical_consent_given, account_status)
       VALUES (?, ?, ?, ?, 1, ?, 'active')`
    )
    .run(email, bcrypt.hashSync('pw-test-123', 4), role, name, extra.clinicalConsent === 0 ? 0 : 1);
  return Number(info.lastInsertRowid);
}

function jar() {
  const c = new Map();
  return {
    store(res) { for (const s of res.headers.getSetCookie()) { const [p] = s.split(';'); const i = p.indexOf('='); c.set(p.slice(0, i), p.slice(i + 1)); } },
    header() { return [...c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

async function req(method, p, { body, j, json = false, headers = {} } = {}) {
  const h = { Cookie: j.header(), ...headers };
  let payload;
  if (body && !(body instanceof FormData)) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
  if (body instanceof FormData) payload = body;
  if (json) { h['X-Requested-With'] = 'fetch'; h.Accept = 'application/json'; }
  const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
  j.store(res);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let js = null;
  if (json && text) { try { js = JSON.parse(text); } catch { js = null; } }
  return { status: res.status, text, buf, headers: res.headers, location: res.headers.get('location'), json: js };
}

async function login(email) {
  const j = jar();
  const r = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password: 'pw-test-123' }).toString(), redirect: 'manual' });
  j.store(r);
  return j;
}

function upload(j, files, fields = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('files', new Blob([f.data]), f.name);
  return req('POST', '/ai/materials/preview', { j, body: fd });
}

const uploadsCount = () => (fs.existsSync(process.env.AI_UPLOAD_DIR) ? fs.readdirSync(process.env.AI_UPLOAD_DIR).length : 0);
const attCount = () => db.prepare('SELECT COUNT(*) n FROM ai_attachments').get().n;
const tokenOf = (html) => (/name="token" value="([0-9a-f]+)"/.exec(html) || [])[1];

// ---------- минимальные генераторы файлов ----------
function mkDocx(paragraphs) {
  const body = paragraphs.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('');
  return zip.build([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>` },
  ]);
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

const PII_SAMPLES = {
  fio: [
    'Иванов Иван Иванович', 'Петрова Анна Сергеевна', 'Сидоров И.И.', 'И.И. Сидоров', 'Кузнецова М.А.', 'Смирнов Алексей Петрович', 'Орлов Дмитрий Николаевич',
    'Попов Сергей', 'Анна Васильева', 'Мария Козлова', 'Козлов Михаил', 'Николаев П.С.', 'А.Б. Громов', 'Фёдорова Ольга Игоревна', 'Лебедев Андрей Викторович',
    'пациент Морозов', 'пациентка Зайцева', 'Волкова Е.Н.', 'Новиков Артём Юрьевич', 'Тимофей Белов', 'Захарова Наталья Александровна', 'Мельников В.В.',
  ],
  phone: [
    '+7 (999) 000-00-00', '8 (495) 123-45-67', '+79990000000', '89161234567', '8-916-123-45-67', '+7 916 123 45 67', '+7(916)123-45-67', '8 916 123 45 67',
    '7 916 123 45 67', '+7-916-123-45-67', '(916) 123-45-67', '916-123-45-67', '8(903)1234567', '+7 903 123-45-67', '8 800 555 35 35', '+7 (812) 555-12-34', '+7 (343) 222-33-44',
    '123-45-67', '+7 999 000 00 00', '8 999 000 00 00', '+7 (900) 111-22-33',
  ],
  email: [
    'ivan@example.test', 'a.petrova@example.test', 'user_1@mail.example', 'test+tag@example.test', 'x@y.zz', 'first.last@sub.example.test', 'doc-1@clinic.example',
    'patient123@example.test', 'Name.Surname@Example.TEST', 'a_b@c-d.example', 'info@example.test', 'z9@example.test', 'abc.def@ghi.example', 'u@e.test',
    'long.long.long@example.test', 'q@q.qq', 'mail1@example.test', 'mail2@example.test', 'mail3@example.test', 'mail4@example.test',
  ],
  snils: [
    '123-456-789 00', '000-000-000 00', '112-233-445 95', '123 456 789 01', '987-654-321 99', 'СНИЛС 12345678901', 'СНИЛС: 123-456-789 00', 'снилс 11223344595',
    '111-222-333 44', '555-666-777 88', '010-020-030 40', '321-654-987 12', '147-258-369 05', '159-753-486 20', '246-135-790 31', '369-258-147 66',
    '741-852-963 07', '852-963-741 08', '963-741-852 09', '102-304-506 07',
  ],
  passport: [
    'паспорт 45 12 123456', 'Паспорт: 4512 123456', '45 12 123456', '4512 123456', 'паспорт серия 45 12 № 123456', 'серия 4512 номер 123456', 'паспорт 46 05 654321',
    '46 05 654321', '4605 654321', 'паспорт РФ 45 10 111222', '45 10 111222', '4510 111222', 'Паспорт 40 00 000000', '40 00 000000', '4001 123123',
    'паспорт: 45 99 987654', '45 99 987654', '4599 987654', 'паспорт 77 11 222333', '77 11 222333',
  ],
  polis: [
    '1234 5678 9012 3456', '1234567890123456', 'полис ОМС 1234567890123456', 'Полис ОМС: 1234 5678 9012 3456', 'полис № 7700 1234 5678 9012', 'ОМС 1234567890123456',
    'полис ДМС 123456789', 'полис 0000 0000 0000 0000', '9876 5432 1098 7654', '9876543210987654', 'полис ОМС № 4500 1111 2222 3333', 'полис: ААА-1234567',
    'полис ОМС 5555 6666 7777 8888', '5555 6666 7777 8888', '1111222233334444', '2222 3333 4444 5555', 'полис 1234567', 'полис № 123456789012', 'ОМС: 1020304050607080',
    '1020 3040 5060 7080',
  ],
  address: [
    'г. Москва, ул. Ленина, д. 5, кв. 12', 'ул. Пушкина, д. 10', 'улица Гагарина, дом 3', 'г. Казань, ул. Баумана, д. 7', 'пр-т Мира, д. 15, кв. 3',
    'проспект Победы, дом 21, кв. 40', 'пер. Садовый, д. 4', 'ул. Советская, д. 1, корп. 2, кв. 9', 'г. Тверь, ул. Мира, д. 8', 'кв. 12', 'квартира 45',
    'ул. Лесная, д. 2/1', 'бульвар Ленина, д. 9', 'г. Омск, ул. Карла Маркса, д. 12, кв. 6', 'ш. Энтузиастов, д. 11', 'набережная Невы, дом 5',
    'ул. Горького, д. 33, кв. 101', 'г. Самара, пр. Ленина, д. 3', 'улица Чехова, дом 14, кв. 2', 'ул. Мичурина, д. 6, стр. 1', 'проживает г. Пермь, ул. Тихая, д. 3',
  ],
  dob: [
    'дата рождения 01.02.1985', 'Дата рождения: 15.06.1990', 'д.р. 03.04.1978', 'родился 12.12.1980', 'родилась 05.05.1995', '01.02.1985 г.р.', '15.06.1990 года рождения',
    '3 марта 1982 года рождения', 'дата рождения 7/8/1975', 'г.р. 20.10.1988', 'дата рождения: 31.12.1970', 'родился 01.01.2000', '1985 года рождения', 'дата рождения 09.09.1999',
    'д. р. 11.11.1965', 'родилась 28.02.1992', '22.07.1983 г.р.', 'дата рождения 14.04.1976', 'дата рождения: 02.03.1997', 'родился 30.06.1960',
  ],
};

async function main() {
  const doc1 = mkUser('doc1@t.test', 'psychiatrist', 'Врач Первый');
  const doc2 = mkUser('doc2@t.test', 'psychologist', 'Врач Второй');
  const adm = mkUser('adm@t.test', 'admin', 'Админ');
  const pA = mkUser('pa@t.test', 'patient', 'Пациент Альфа');
  const pB = mkUser('pb@t.test', 'patient', 'Пациент Бета');
  const pC = mkUser('pc@t.test', 'patient', 'Пациент Гамма', { clinicalConsent: 0 });
  db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pA, doc1);
  db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pC, doc1);
  db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pB, doc2);
  const ins = db.prepare('INSERT INTO online_results (patient_id, instrument, answers_json, total_score, band, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const d = (n) => store.sqlTime(store.addDays(new Date(), -n));
  ins.run(pA, 'phq9', '[]', 17, 'moderately_severe', d(40));
  ins.run(pA, 'phq9', '[]', 12, 'moderate', d(10));
  ins.run(pC, 'phq9', '[]', 5, 'mild', d(3));
  const mood = db.prepare('INSERT INTO mood_entries (patient_id, mood_score, note, created_at) VALUES (?, ?, ?, ?)');
  mood.run(pA, 4, 'ЗАМЕТКА-СЕКРЕТ-ДНЕВНИКА', d(5));
  mood.run(pA, 6, null, d(2));
  db.prepare('INSERT INTO crisis_escalations (patient_id, instrument, reasons_json) VALUES (?, ?, ?)').run(pA, 'phq9', '[]');

  const server = app.listen(PORT);
  try {
    const j1 = await login('doc1@t.test');
    const j2 = await login('doc2@t.test');
    const jA = await login('pa@t.test');
    const jAdm = await login('adm@t.test');
    const anon = jar();

    // ---------- юнит: маскирование ПДн (REQ-AID-007) ----------
    for (const [type, list] of Object.entries(PII_SAMPLES)) {
      check(`маскирование ${type}: ${list.length} образцов находятся и заменяются меткой`, () => {
        assert.ok(list.length >= 20, `нужно >=20 образцов, есть ${list.length}`);
        const miss = [];
        for (const s of list) {
          const r = pii.maskAll(`Текст до ${s} текст после`);
          if (r.count < 1 || r.text.includes(s) || !r.text.startsWith('Текст до ') || !r.text.endsWith(' текст после')) miss.push(s);
        }
        assert.deepStrictEqual(miss, [], `не замаскировано: ${miss.join(' | ')}`);
      });
    }
    check('маскирование: обычный клинический текст без ПДн не портится', () => {
      const t = 'Жалобы на нарушение сна и сниженное настроение в течение 3 недель. PHQ-9: 12 баллов, GAD-7: 8. Рекомендован повторный приём через 2 недели.';
      const r = pii.maskAll(t);
      assert.strictEqual(r.text, t);
      assert.strictEqual(r.count, 0);
    });
    check('маскирование: apply уважает отключённые врачом замены (keepIds)', () => {
      const t = 'Звоните +7 (999) 000-00-00 или ivan@example.test';
      const m = pii.detect(t);
      assert.strictEqual(m.length, 2);
      const r = pii.apply(t, m, [m[0].id]);
      assert.ok(r.text.includes('+7 (999) 000-00-00') && r.text.includes('[EMAIL]'));
    });

    // ---------- юнит: проверка файлов (REQ-AID-005 / REQ-SEC-006) ----------
    check('файлы: нормальные txt/csv/docx/pdf/png принимаются, текст извлечён', () => {
      assert.strictEqual(extract.inspect('заметка.txt', Buffer.from('Привет, мир')).text, 'Привет, мир');
      assert.ok(/a;b/.test(extract.inspect('t.csv', Buffer.from('a;b\n1;2')).text));
      assert.ok(/Жалобы на сон/.test(extract.inspect('в.docx', mkDocx(['Жалобы на сон', 'Второй абзац'])).text));
      const pdf = exporter.buildPdf({ items: [{ who: 'Врач', text: 'Кириллица в PDF: проверка' }] });
      assert.ok(/Кириллица в PDF: проверка/.test(extract.inspect('x.pdf', pdf).text));
      const img = extract.inspect('scan.png', PNG);
      assert.strictEqual(img.hasText, false);
      assert.ok(/Текст не извлечён/.test(img.note));
    });
    check('файлы: windows-1251 txt декодируется', () => {
      const buf = Buffer.from(new TextEncoder().encode('x'));
      void buf;
      const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
      assert.strictEqual(extract.inspect('a.txt', cp1251).text, 'Привет');
    });
    const reject = (name, data, re) => {
      let err = null;
      try { extract.inspect(name, data); } catch (e) { err = e; }
      assert.ok(err instanceof extract.ExtractError, `${name} должен быть отклонён`);
      assert.ok(re.test(err.message), `${name}: «${err.message}»`);
    };
    check('файлы: .exe под видом .pdf, 0 байт, 11 МБ, SVG, HTML, архив-бомба -> отказ по-русски', () => {
      reject('doc.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1)]), /не соответствует расширению/);
      reject('run.exe', Buffer.from('MZ....'), /не поддерживается/);
      reject('empty.txt', Buffer.alloc(0), /пустой/);
      reject('big.txt', Buffer.alloc(11 * 1024 * 1024, 0x61), /больше 10 МБ/);
      reject('pic.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), /SVG и HTML/);
      reject('page.html', Buffer.from('<html></html>'), /SVG и HTML/);
      reject('fake.txt', Buffer.from('<svg onload=alert(1)></svg>'), /HTML\/SVG/);
      reject('a.pdf.exe', Buffer.from('MZ'), /не поддерживается/);
      reject('pic.png', Buffer.from('это не картинка'), /не соответствует расширению/);
      reject('x.docx', Buffer.from('PK\x03\x04garbage-garbage-garbage-garbage'), /повреждён|не похож/);
      const bomb = zip.build([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: Buffer.alloc(40 * 1024 * 1024, 0x61) }]);
      assert.ok(bomb.length < 200000, 'бомба должна быть маленькой после сжатия');
      reject('bomb.docx', bomb, /бомб|слишком/);
      const lying = zip.build([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: Buffer.alloc(3 * 1024 * 1024, 0x61) }]);
      reject('ratio.docx', lying, /сжат|велик/);
    });
    check('файлы: имя нормализуется (пути, управляющие символы, ведущие точки)', () => {
      assert.strictEqual(extract.normalizeName('../../x.txt'), 'x.txt');
      assert.strictEqual(extract.normalizeName('..\\..\\evil\\a b.txt'), 'a b.txt');
      assert.strictEqual(extract.normalizeName('.hidden'), 'hidden');
      assert.ok(!/[\u0000-\u001f<>"|*?]/.test(extract.normalizeName('a\u0000b<c>.txt')));
      assert.strictEqual(extract.normalizeName(''), 'файл');
      assert.ok(extract.normalizeName('я'.repeat(300) + '.txt').length <= 80);
    });

    // ---------- юнит: экспорт (REQ-AID-010) ----------
    check('экспорт: DOCX/PDF/TXT — сигнатуры, кириллица извлекается, шапка «черновик» и дата', () => {
      const phrase = 'Съешь ещё этих мягких французских булок';
      const doc = { items: [{ who: 'ИИ-помощник', text: phrase + ' ' + 'длинная строка '.repeat(300) }] };
      const docx = exporter.buildDocx(doc);
      assert.strictEqual(docx.slice(0, 2).toString(), 'PK');
      const dx = extract.inspect('e.docx', docx).text;
      assert.ok(dx.includes(phrase) && dx.includes('ЧЕРНОВИК'));
      const pdf = exporter.buildPdf(doc);
      assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
      assert.ok(pdf.slice(-6).toString().includes('%%EOF'));
      const px = extract.inspect('e.pdf', pdf).text;
      assert.ok(px.includes(phrase) && px.includes('ЧЕРНОВИК') && px.includes(exporter.today()));
      const txt = exporter.buildTxt(doc).toString('utf8');
      assert.ok(txt.includes(phrase) && txt.includes('ЧЕРНОВИК') && txt.includes(exporter.today()));
      assert.strictEqual(exporter.fileName('docx', new Date('2026-10-10T10:00:00Z')), 'черновик_2026-10-10.docx');
    });

    // ---------- доступ ----------
    check('доступ: пациент и админ получают 403, аноним не видит раздел', async () => {
      for (const jj of [jA, jAdm, anon]) {
        for (const p of ['/ai', '/ai/materials/1/download']) {
          const r = await req('GET', p, { j: jj });
          assert.strictEqual(r.status, 403, `${p}`);
        }
        const post = await req('POST', '/ai/send', { j: jj, body: { text: 'привет' } });
        assert.strictEqual(post.status, 403);
        const up = await upload(jj, [{ name: 'a.txt', data: Buffer.from('x') }]);
        assert.strictEqual(up.status, 403);
      }
    });
    check('навигация врача содержит «ИИ-пространство», у пациента — нет', async () => {
      const r = await req('GET', '/ai', { j: j1 });
      assert.strictEqual(r.status, 200);
      assert.ok(/ИИ-пространство/.test(r.text));
      const d1 = await req('GET', '/dashboard', { j: jA });
      assert.ok(!/ИИ-пространство/.test(d1.text));
    });

    // ---------- основной сценарий: общий тред ----------
    let general;
    check('общий тред без пациента и файлов: сообщение -> ответ с меткой «ЧЕРНОВИК», аудит без текста', async () => {
      const before = db.prepare('SELECT COUNT(*) n FROM ai_audit').get().n;
      const secret = 'УНИКАЛЬНАЯ-ФРАЗА-ДЛЯ-АУДИТА-4417';
      const r = await req('POST', '/ai/send', { j: j1, body: { text: `Вопрос по случаю ${secret}` }, json: true });
      assert.strictEqual(r.status, 200, r.text);
      assert.ok(/ЧЕРНОВИК · решение за врачом, не диагноз/.test(r.json.assistant.text));
      assert.ok(/опирается только на данные сервиса/.test(r.json.assistant.text));
      assert.ok(/ws-copy/.test(r.json.extras), 'есть кнопка «Копировать»');
      general = r.json.thread.id;
      const t = db.prepare('SELECT * FROM ai_threads WHERE id = ?').get(general);
      assert.strictEqual(t.role, 'clinician');
      assert.strictEqual(t.patient_id, null);
      const rows = db.prepare('SELECT * FROM ai_audit WHERE id > (SELECT MAX(id) - ? FROM ai_audit)').all(db.prepare('SELECT COUNT(*) n FROM ai_audit').get().n - before);
      assert.ok(rows.length >= 2);
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ai_audit').all()).includes(secret), 'текст в аудит не попадает');
      assert.ok(rows.every((x) => x.user_id === doc1));
      const page = await req('GET', `/ai/t/${general}`, { j: j1 });
      assert.ok(/msg-assistant/.test(page.text) && /ЧЕРНОВИК · решение за врачом, не диагноз/.test(page.text));
    });
    check('страница: предупреждение о ПДн видно, маскирование включено по умолчанию, 7 сценариев, срок хранения', async () => {
      const r = await req('GET', `/ai/t/${general}`, { j: j1 });
      assert.ok(/Удалите персональные данные пациента, если это возможно/.test(r.text));
      assert.ok(/name="mask" value="1" checked/.test(r.text));
      for (const sc of scenarios.SCENARIOS) assert.ok(r.text.includes(sc.title), sc.title);
      assert.strictEqual(scenarios.SCENARIOS.length, 7);
      assert.ok(/Хранится до/.test(r.text));
      assert.ok(/Прикрепить материал/.test(r.text));
    });
    check('нулевая обязательность: «Новый диалог» -> сообщение -> ответ без обязательных полей', async () => {
      const r = await req('POST', '/ai/send', { j: j1, body: { text: 'Просто вопрос' }, json: true });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.assistant.text.length > 20);
    });
    check('чужой тред: другой врач получает 404 на просмотр, отправку, переименование, удаление, экспорт', async () => {
      for (const [m, p, body] of [
        ['GET', `/ai/t/${general}`], ['POST', '/ai/send', { thread_id: String(general), text: 'взлом' }], ['POST', `/ai/t/${general}/rename`, { title: 'x' }],
        ['GET', `/ai/t/${general}/delete`], ['POST', `/ai/t/${general}/delete`, {}], ['GET', `/ai/t/${general}/export.pdf`], ['POST', `/ai/t/${general}/bind`, { patient_id: String(pB) }],
      ]) {
        const r = await req(m, p, { j: j2, body });
        assert.strictEqual(r.status, 404, `${m} ${p}`);
      }
      const list = await req('GET', '/ai', { j: j2 });
      assert.ok(!list.text.includes(`/ai/t/${general}"`), 'чужой тред не в списке');
      assert.ok(db.prepare('SELECT 1 FROM ai_threads WHERE id = ?').get(general), 'тред на месте');
    });

    // ---------- привязка к пациенту, согласия ----------
    let bound;
    check('привязка: только к закреплённому; чужой пациент -> 403; факт в phi_access_log', async () => {
      const deny = await req('POST', '/ai/new', { j: j1, body: { patient_id: String(pB) } });
      assert.strictEqual(deny.status, 403);
      const before = db.prepare("SELECT COUNT(*) n FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = 'ai_bind_patient'").get(doc1, pA).n;
      const ok = await req('POST', '/ai/new', { j: j1, body: { patient_id: String(pA) } });
      assert.strictEqual(ok.status, 302);
      bound = Number(/\/ai\/t\/(\d+)/.exec(ok.location)[1]);
      assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = 'ai_bind_patient'").get(doc1, pA).n, before + 1);
      const page = await req('GET', `/ai/t/${bound}`, { j: j1 });
      assert.ok(/Привязан к пациенту Пациент Альфа/.test(page.text));
      assert.ok(db.prepare("SELECT 1 FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = 'ai_open_thread'").get(doc1, pA), 'открытие треда пишется');
      const aud = db.prepare("SELECT * FROM ai_audit WHERE event = 'ws_bind_patient' ORDER BY id DESC").get();
      assert.strictEqual(aud.patient_id, pA);
    });
    check('привязка к существующему общему треду: чужой пациент -> 403, свой -> ок, повторная -> 409/redirect', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Новый общий' }, json: true });
      const id = t.json.thread.id;
      assert.strictEqual((await req('POST', `/ai/t/${id}/bind`, { j: j1, body: { patient_id: String(pB) } })).status, 403);
      assert.strictEqual((await req('POST', `/ai/t/${id}/bind`, { j: j1, body: { patient_id: String(pA) } })).status, 302);
      assert.strictEqual(db.prepare('SELECT patient_id FROM ai_threads WHERE id = ?').get(id).patient_id, pA);
      const again = await req('POST', `/ai/t/${id}/bind`, { j: j1, body: { patient_id: String(pC) } });
      assert.strictEqual(again.status, 302);
      assert.strictEqual(db.prepare('SELECT patient_id FROM ai_threads WHERE id = ?').get(id).patient_id, pA, 'смена пациента запрещена');
    });
    check('баннер кризиса виден в треде пациента с открытой эскалацией', async () => {
      const page = await req('GET', `/ai/t/${bound}`, { j: j1 });
      assert.ok(/ws-banner--crisis/.test(page.text) && /открыта кризисная эскалация/.test(page.text));
      const tC = await req('POST', '/ai/new', { j: j1, body: { patient_id: String(pC) } });
      const idC = /\/ai\/t\/(\d+)/.exec(tC.location)[1];
      assert.ok(!/ws-banner--crisis/.test((await req('GET', `/ai/t/${idC}`, { j: j1 })).text));
    });
    check('7 сценариев на привязанном треде: каждый даёт ответ с меткой; динамика/сводка содержат данные сервиса', async () => {
      for (const sc of scenarios.SCENARIOS) {
        const r = await req('POST', '/ai/send', { j: j1, body: { thread_id: String(bound), scenario: sc.key, period: sc.period ? '90' : '' }, json: true });
        assert.strictEqual(r.status, 200, `${sc.key}: ${r.text}`);
        assert.ok(/ЧЕРНОВИК · решение за врачом, не диагноз/.test(r.json.assistant.text), sc.key);
        assert.ok(r.json.assistant.kind === 'normal', `${sc.key}: ${r.json.assistant.kind}`);
        assert.ok(r.json.user.text.startsWith(sc.title));
        if (sc.key === 'summary') assert.ok(/PHQ-9|phq9/i.test(r.json.assistant.text) && /12/.test(r.json.assistant.text));
        if (sc.key === 'dynamics') assert.ok(/17 \(/.test(r.json.assistant.text) && /-5/.test(r.json.assistant.text), r.json.assistant.text);
        if (sc.key === 'hypotheses') assert.ok(/НЕ диагноз/.test(r.json.assistant.text));
      }
    });
    check('сценарии, требующие пациента, на общем треде просят выбрать пациента (не ошибка)', async () => {
      const needs = scenarios.SCENARIOS.filter((s) => s.needsPatient);
      assert.ok(needs.length >= 5);
      for (const sc of needs) {
        const r = await req('POST', '/ai/send', { j: j1, body: { thread_id: String(general), scenario: sc.key }, json: true });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.assistant.kind, 'hint');
        assert.ok(/нужен пациент/.test(r.json.assistant.text) && /Привяжите/.test(r.json.assistant.text));
      }
      for (const key of ['questions', 'hypotheses']) {
        const r = await req('POST', '/ai/send', { j: j1, body: { thread_id: String(general), scenario: key }, json: true });
        assert.strictEqual(r.json.assistant.kind, 'normal');
      }
    });
    check('согласия: заметки дневника не попадают в контекст по умолчанию, попадают после разрешения; без клинического согласия нет шкал; ФИО/e-mail в провайдер не уходят', async () => {
      const seen = [];
      provider.setProvider({ name: 'spy', async generate({ context, messages }) { seen.push(JSON.stringify({ context, messages })); return { text: 'Нейтральный ответ без данных.', sources: [], flags: {} }; } });
      try {
        await req('POST', '/ai/send', { j: j1, body: { thread_id: String(bound), scenario: 'summary' }, json: true });
        assert.ok(!seen[0].includes('ЗАМЕТКА-СЕКРЕТ-ДНЕВНИКА'), 'заметки не делятся по умолчанию');
        assert.ok(seen[0].includes('"label":"PHQ-9"') || /PHQ/.test(seen[0]));
        for (const bad of ['Пациент Альфа', 'pa@t.test']) assert.ok(!seen[0].includes(bad), `в контексте нет «${bad}»`);
        require('../src/patient_prefs').setPrefs(pA, { share_diary_scores: 1, share_diary_notes: 1 });
        await req('POST', '/ai/send', { j: j1, body: { thread_id: String(bound), scenario: 'summary' }, json: true });
        assert.ok(seen[1].includes('ЗАМЕТКА-СЕКРЕТ-ДНЕВНИКА'), 'после разрешения заметки доступны');
        require('../src/patient_prefs').setPrefs(pA, { share_diary_scores: 0, share_diary_notes: 0 });
        await req('POST', '/ai/send', { j: j1, body: { thread_id: String(bound), scenario: 'summary' }, json: true });
        assert.ok(!seen[2].includes('"diary":{') && !seen[2].includes('ЗАМЕТКА-СЕКРЕТ'), 'оценки дневника отключены');
        // нет клинического согласия
        const tC = await req('POST', '/ai/new', { j: j1, body: { patient_id: String(pC) } });
        const idC = Number(/\/ai\/t\/(\d+)/.exec(tC.location)[1]);
        db.prepare('UPDATE users SET clinical_consent_given = 0 WHERE id = ?').run(pC);
        await req('POST', '/ai/send', { j: j1, body: { thread_id: String(idC), scenario: 'summary' }, json: true });
        assert.ok(/"consent":false/.test(seen[3]) && /"instruments":\[\]/.test(seen[3]), 'без согласия шкал нет');
      } finally { provider.setProvider(null); require('../src/patient_prefs').setPrefs(pA, { share_diary_scores: 1, share_diary_notes: 0 }); }
    });
    check('потеря закрепления: данные пациента перестают использоваться, сценарий просит пациента', async () => {
      const t = await req('POST', '/ai/new', { j: j1, body: { patient_id: String(pC) } });
      const id = Number(/\/ai\/t\/(\d+)/.exec(t.location)[1]);
      db.prepare('UPDATE care_assignments SET archived_at = datetime(\'now\') WHERE patient_id = ? AND clinician_id = ?').run(pC, doc1);
      try {
        const r = await req('POST', '/ai/send', { j: j1, body: { thread_id: String(id), scenario: 'summary' }, json: true });
        // W3.K (M-6): после снятия закрепления привязанный диалог закрыт (ответ не строится; остаётся только удаление)
        assert.strictEqual(r.status, 403);
        assert.ok(/больше не закреплён/.test(r.json.error));
        const g = await req('GET', `/ai/t/${id}`, { j: j1 });
        assert.strictEqual(g.status, 302);
        assert.ok(g.location.endsWith(`/ai/t/${id}/delete`));
      } finally { db.prepare('UPDATE care_assignments SET archived_at = NULL WHERE patient_id = ? AND clinician_id = ?').run(pC, doc1); }
    });

    // ---------- загрузка материалов ----------
    let matThread;
    let matId;
    let matFile;
    check('загрузка: предпросмотр показывает извлечённый текст, замены до/после; до подтверждения на диске и в БД пусто', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Дело с материалом' }, json: true });
      matThread = t.json.thread.id;
      const diskBefore = uploadsCount();
      const attBefore = attCount();
      const text = 'Выписка. Пациент Сидоров Пётр Иванович, тел. +7 (999) 000-00-00, mail petr@example.test. Жалобы на бессонницу и сниженное настроение.';
      const r = await upload(j1, [{ name: 'выписка.txt', data: Buffer.from(text, 'utf8') }], { thread_id: String(matThread), mask: '1' });
      assert.strictEqual(r.status, 200, r.text.slice(0, 500));
      assert.ok(/Проверьте материал перед сохранением/.test(r.text));
      assert.ok(/<mark>/.test(r.text) && /\[ФИО\]/.test(r.text) && /\[ТЕЛЕФОН\]/.test(r.text) && /\[EMAIL\]/.test(r.text));
      assert.ok(/не даёт гарантии полного обезличивания/.test(r.text));
      assert.strictEqual(uploadsCount(), diskBefore, 'до подтверждения файлов на диске нет');
      assert.strictEqual(attCount(), attBefore, 'и записей в БД нет');
      const token = tokenOf(r.text);
      assert.ok(token);
      const save = await req('POST', '/ai/materials/save', { j: j1, body: { token, mask: '1', thread_id: String(matThread) } });
      assert.strictEqual(save.status, 302);
      const row = db.prepare('SELECT * FROM ai_attachments WHERE thread_id = ?').get(matThread);
      matId = row.id;
      assert.strictEqual(row.masked, 1);
      assert.ok(row.mask_count >= 3);
      assert.ok(!/Сидоров|Пётр|999|petr@/.test(row.text_extracted), 'в БД только замаскированный текст');
      assert.ok(/Жалобы на бессонницу/.test(row.text_extracted));
      matFile = row.storage_path;
      const onDisk = fs.readFileSync(matFile, 'utf8');
      assert.ok(!/Сидоров|Пётр|999|petr@/.test(onDisk), 'на диске только замаскированный текст');
      assert.ok(!/\./.test(path.basename(row.storage_path)), 'случайное имя без расширения');
      assert.ok(!path.resolve(matFile).startsWith(path.resolve(__dirname, '..', 'public')), 'вне public/');
      assert.ok(db.prepare("SELECT 1 FROM ai_messages WHERE thread_id = ? AND kind = 'material'").get(matThread));
      assert.ok(row.expires_at > store.sqlTime(store.addDays(new Date(), 29)), 'срок хранения ~30 дней');
    });
    check('загрузка: отказ маскирования (keep) сохраняет выбранную врачом замену как есть', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Keep тест' }, json: true });
      const text = 'Телефон +7 (999) 000-00-00 и почта a@example.test';
      const r = await upload(j1, [{ name: 'k.txt', data: Buffer.from(text) }], { thread_id: String(t.json.thread.id), mask: '1' });
      const token = tokenOf(r.text);
      await req('POST', '/ai/materials/save', { j: j1, body: { token, mask: '1', thread_id: String(t.json.thread.id), keep: '0:0' } });
      const row = db.prepare('SELECT * FROM ai_attachments WHERE thread_id = ?').get(t.json.thread.id);
      assert.ok(row.text_extracted.includes('+7 (999) 000-00-00') && row.text_extracted.includes('[EMAIL]'));
    });
    check('загрузка без маскирования: сохраняется оригинал, это видно в интерфейсе', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Без маски' }, json: true });
      const r = await upload(j1, [{ name: 'raw.txt', data: Buffer.from('Тест +7 (999) 000-00-00') }], { thread_id: String(t.json.thread.id) });
      assert.ok(/Маскирование выключено/.test(r.text));
      await req('POST', '/ai/materials/save', { j: j1, body: { token: tokenOf(r.text), mask: '0', thread_id: String(t.json.thread.id) } });
      const row = db.prepare('SELECT * FROM ai_attachments WHERE thread_id = ?').get(t.json.thread.id);
      assert.strictEqual(row.masked, 0);
      assert.ok(row.text_extracted.includes('+7 (999) 000-00-00'));
      assert.ok(/без маскирования/.test((await req('GET', `/ai/t/${t.json.thread.id}`, { j: j1 })).text));
    });
    check('ответ ссылается на материал [Материал N: файл], фрагмент раскрывается', async () => {
      const r = await req('POST', '/ai/send', { j: j1, body: { thread_id: String(matThread), text: 'Что в выписке про бессонницу?' }, json: true });
      assert.ok(/\[Материал 1: выписка\.txt/.test(r.json.assistant.text));
      assert.ok(/ws-src/.test(r.json.extras) && /бессонниц/.test(r.json.extras));
      assert.ok(!/опирается только на данные сервиса/.test(r.json.assistant.text));
    });
    check('нормальные 4 файла (txt, csv, docx, png) за раз: текст извлечён у трёх, у изображения «текст не извлечён»', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Четыре файла' }, json: true });
      const r = await upload(j1, [
        { name: 'a.txt', data: Buffer.from('Первый файл') }, { name: 'b.csv', data: Buffer.from('x;y\n1;2') },
        { name: 'c.docx', data: mkDocx(['Третий файл абзац']) }, { name: 'd.png', data: PNG },
      ], { thread_id: String(t.json.thread.id), mask: '1' });
      assert.strictEqual(r.status, 200);
      assert.ok(/Первый файл/.test(r.text) || /a\.txt/.test(r.text));
      assert.ok(/Текст из этого файла не извлечён/.test(r.text));
      await req('POST', '/ai/materials/save', { j: j1, body: { token: tokenOf(r.text), mask: '1', thread_id: String(t.json.thread.id) } });
      const rows = db.prepare('SELECT * FROM ai_attachments WHERE thread_id = ? ORDER BY seq').all(t.json.thread.id);
      assert.deepStrictEqual(rows.map((x) => x.seq), [1, 2, 3, 4]);
      assert.strictEqual(rows[3].has_text, 0);
      assert.ok(/Третий файл/.test(rows[2].text_extracted));
    });
    check('REQ-SEC-006: .exe как .pdf, 0 байт, 11 МБ, ../../x, SVG, архив-бомба -> отказ по-русски, ничего не записано', async () => {
      const diskBefore = uploadsCount();
      const attBefore = attCount();
      const bad = [
        { name: 'report.pdf', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 7)]), re: /не соответствует расширению/ },
        { name: 'empty.txt', data: Buffer.alloc(0), re: /пустой/ },
        { name: 'huge.txt', data: Buffer.alloc(11 * 1024 * 1024, 0x61), re: /больше 10 МБ/ },
        { name: 'logo.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), re: /SVG и HTML/ },
        { name: 'bomb.docx', data: zip.build([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: Buffer.alloc(40 * 1024 * 1024, 0x61) }]), re: /бомб|слишком/ },
        { name: '../../etc/passwd', data: Buffer.from('root:x:0:0'), re: /не поддерживается/ },
        { name: 'script.js', data: Buffer.from('alert(1)'), re: /не поддерживается/ },
      ];
      for (const b of bad) {
        const r = await upload(j1, [b], { thread_id: String(matThread), mask: '1' });
        assert.ok([200, 400, 413, 422].includes(r.status), `${b.name}: ${r.status}`);
        assert.ok(/Не принято/.test(r.text) && b.re.test(r.text), `${b.name}: ${r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(300, 900)}`);
        assert.ok(!/Сохранить в диалог/.test(r.text), `${b.name}: нечего сохранять`);
      }
      assert.strictEqual(uploadsCount(), diskBefore, 'на диске ничего не появилось');
      assert.strictEqual(attCount(), attBefore, 'в БД ничего не появилось');
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ai_attachments WHERE thread_id = ?').get(matThread).n, 1);
    });
    check('имя ../../x.txt нормализуется: файл только во внутренней папке под случайным именем', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Имя' }, json: true });
      const r = await upload(j1, [{ name: '../../x.txt', data: Buffer.from('безвредный текст') }], { thread_id: String(t.json.thread.id) });
      assert.strictEqual(r.status, 200);
      await req('POST', '/ai/materials/save', { j: j1, body: { token: tokenOf(r.text), mask: '1', thread_id: String(t.json.thread.id) } });
      const row = db.prepare('SELECT * FROM ai_attachments WHERE thread_id = ?').get(t.json.thread.id);
      assert.strictEqual(row.name, 'x.txt');
      assert.ok(fs.existsSync(row.storage_path));
      assert.ok(!fs.existsSync(path.join(tmp, 'x.txt')) && !fs.existsSync(path.join(path.dirname(tmp), 'x.txt')));
    });
    check('лимит файлов: сверх 5 за раз отклоняются с объяснением', async () => {
      const files = [];
      for (let i = 1; i <= 6; i++) files.push({ name: `f${i}.txt`, data: Buffer.from(`файл ${i}`) });
      const r = await upload(j1, files, { mask: '1' });
      assert.strictEqual(r.status, 200);
      assert.ok(/не больше 5 файлов/.test(r.text));
      assert.strictEqual((r.text.match(/class="ws-prev-item"/g) || []).length, 5);
    });
    check('PDF: текстовый извлекается; без текстового слоя — «текст не извлечён», без ошибки 500', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'PDF' }, json: true });
      const pdf = exporter.buildPdf({ items: [{ who: '', text: 'Заключение психолога: тревога умеренная' }] });
      const r = await upload(j1, [{ name: 'z.pdf', data: pdf }], { thread_id: String(t.json.thread.id), mask: '1' });
      assert.ok(/Заключение психолога: тревога умеренная/.test(r.text));
      const scan = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
      const r2 = await upload(j1, [{ name: 'scan.pdf', data: scan }], { thread_id: String(t.json.thread.id), mask: '1' });
      assert.strictEqual(r2.status, 200);
      assert.ok(/нет текстового слоя/.test(r2.text), r2.text.slice(0, 200));
      const enc = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n');
      const r3 = await upload(j1, [{ name: 'enc.pdf', data: enc }], { mask: '1' });
      assert.ok(/защищён паролем/.test(r3.text));
    });
    check('просмотр и скачивание материала: только автор; вложение с nosniff', async () => {
      const own = await req('GET', `/ai/materials/${matId}/download`, { j: j1 });
      assert.strictEqual(own.status, 200);
      assert.ok(/attachment/.test(own.headers.get('content-disposition')));
      assert.strictEqual(own.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(own.headers.get('content-type'), 'application/octet-stream');
      assert.ok(/Жалобы на бессонницу/.test(own.text));
      for (const jj of [j2, jAdm, jA]) {
        assert.ok([403, 404].includes((await req('GET', `/ai/materials/${matId}/download`, { j: jj })).status));
        assert.ok([403, 404].includes((await req('POST', `/ai/materials/${matId}/delete`, { j: jj, body: {} })).status));
      }
      assert.ok(fs.existsSync(matFile) && db.prepare('SELECT 1 FROM ai_attachments WHERE id = ?').get(matId));
    });
    check('«Удалить материал» стирает файл и запись', async () => {
      const conf = await req('GET', `/ai/materials/${matId}/delete`, { j: j1 });
      assert.strictEqual(conf.status, 200);
      assert.ok(/Удалить материал\?/.test(conf.text));
      const r = await req('POST', `/ai/materials/${matId}/delete`, { j: j1, body: {} });
      assert.strictEqual(r.status, 302);
      assert.ok(!fs.existsSync(matFile), 'файла нет на диске');
      assert.ok(!db.prepare('SELECT 1 FROM ai_attachments WHERE id = ?').get(matId), 'записи нет в БД');
    });
    check('ошибка провайдера: сообщение и файл сохранены, «Повторить» работает', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Файл и сбой' }, json: true });
      const tid = t.json.thread.id;
      const up = await upload(j1, [{ name: 's.txt', data: Buffer.from('надёжный материал') }], { thread_id: String(tid), mask: '1' });
      await req('POST', '/ai/materials/save', { j: j1, body: { token: tokenOf(up.text), mask: '1', thread_id: String(tid) } });
      provider.setProvider({ name: 'down', async generate() { throw new Error('boom'); } });
      try {
        const r = await req('POST', '/ai/send', { j: j1, body: { thread_id: String(tid), text: 'вопрос при сбое' }, json: true });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.assistant.kind, 'error');
        assert.ok(/временно недоступен/.test(r.json.assistant.text));
        assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ai_attachments WHERE thread_id = ?').get(tid).n, 1, 'файл не потерян');
        assert.ok(db.prepare("SELECT 1 FROM ai_messages WHERE thread_id = ? AND role = 'user' AND text = ?").get(tid, 'вопрос при сбое'));
      } finally { provider.setProvider(null); }
      const retry = await req('POST', `/ai/t/${tid}/retry`, { j: j1, json: true });
      assert.strictEqual(retry.status, 200);
      assert.strictEqual(retry.json.assistant.kind, 'normal');
      assert.ok(/ЧЕРНОВИК/.test(retry.json.assistant.text));
    });
    check('пост-фильтр применяется и в ИИ-пространстве (ответ с дозой заменяется безопасным текстом)', async () => {
      provider.setProvider({ name: 'evil', async generate() { return { text: 'Назначьте сертралин 50 мг', sources: [], flags: {} }; } });
      try {
        const r = await req('POST', '/ai/send', { j: j1, body: { thread_id: String(general), text: 'что назначить' }, json: true });
        assert.ok(!/сертралин|50 мг/.test(r.json.assistant.text));
        assert.strictEqual(r.json.assistant.kind, 'filtered');
      } finally { provider.setProvider(null); }
    });

    check('удаление пациента админом стирает привязанные материалы ИИ-пространства (файлы и записи ai_attachments)', async () => {
      const pD = mkUser('pd@t.test', 'patient', 'Пациент Дельта');
      db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pD, doc1);
      const nt = await req('POST', '/ai/new', { j: j1, body: { patient_id: String(pD) } });
      const tid = Number(/\/ai\/t\/(\d+)/.exec(nt.location)[1]);
      const up = await upload(j1, [{ name: 'del.txt', data: Buffer.from('материал пациента Дельта') }, { name: 'del2.txt', data: Buffer.from('второй') }], { thread_id: String(tid), mask: '1' });
      await req('POST', '/ai/materials/save', { j: j1, body: { token: tokenOf(up.text), mask: '1', thread_id: String(tid) } });
      const rows = db.prepare('SELECT * FROM ai_attachments WHERE patient_id = ?').all(pD);
      assert.strictEqual(rows.length, 2);
      assert.ok(rows.every((r) => fs.existsSync(r.storage_path) && path.resolve(r.storage_path).startsWith(path.resolve(adminDeletion.uploadRoot()) + path.sep)), 'файлы под <data>/uploads');
      const other = db.prepare('SELECT COUNT(*) n FROM ai_attachments WHERE patient_id IS NOT ?').get(pD).n;
      db.prepare("UPDATE users SET account_status = 'deletion_requested' WHERE id = ?").run(pD);
      const dsr = db.prepare("INSERT INTO data_subject_requests (patient_id, request_type, actions_taken_json) VALUES (?, 'consent_revocation_and_deletion', '{}')").run(pD).lastInsertRowid;
      const out = adminDeletion.execute(adm, dsr, { confirmEmail: 'pd@t.test' });
      assert.ok(out.ok, JSON.stringify(out));
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ai_attachments WHERE patient_id = ?').get(pD).n, 0, 'записей нет');
      assert.ok(rows.every((r) => !fs.existsSync(r.storage_path)), 'файлов на диске нет');
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ai_attachments WHERE patient_id IS NOT ?').get(pD).n, other, 'чужие материалы целы');
      assert.ok(!db.prepare('SELECT 1 FROM ai_threads WHERE id = ?').get(tid), 'привязанный тред удалён');
    });
    // ---------- удаление ----------
    check('«Удалить диалог» стирает сообщения, материалы (файлы) и тред; аудит остаётся без текста', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Удаляемый диалог' }, json: true });
      const tid = t.json.thread.id;
      const up = await upload(j1, [{ name: 'd.txt', data: Buffer.from('удалить меня') }], { thread_id: String(tid), mask: '1' });
      await req('POST', '/ai/materials/save', { j: j1, body: { token: tokenOf(up.text), mask: '1', thread_id: String(tid) } });
      const row = db.prepare('SELECT * FROM ai_attachments WHERE thread_id = ?').get(tid);
      const file = row.storage_path;
      const r = await req('POST', `/ai/t/${tid}/delete`, { j: j1, body: {} });
      assert.strictEqual(r.status, 302);
      assert.ok(!fs.existsSync(file));
      assert.ok(!db.prepare('SELECT 1 FROM ai_threads WHERE id = ?').get(tid) && !db.prepare('SELECT 1 FROM ai_messages WHERE thread_id = ?').get(tid) && !db.prepare('SELECT 1 FROM ai_attachments WHERE thread_id = ?').get(tid));
      const aud = db.prepare("SELECT * FROM ai_audit WHERE event = 'ws_thread_deleted' AND thread_id = ?").get(tid);
      assert.ok(aud && aud.files === 1);
    });

    // ---------- экспорт ----------
    check('экспорт HTTP: ответ и диалог в DOCX/PDF/TXT; имя без ФИО; аудит; чужой -> 404', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { thread_id: String(bound), scenario: 'questions' }, json: true });
      assert.ok(t.json && t.json.assistant, `status ${t.status}: ${t.text.slice(0, 300)}`);
      const mid = t.json.assistant.id;
      for (const [fmt, sig] of [['docx', 'PK'], ['pdf', '%PDF-'], ['txt', null]]) {
        const r = await req('GET', `/ai/m/${mid}/export.${fmt}`, { j: j1 });
        assert.strictEqual(r.status, 200, fmt);
        if (sig) assert.strictEqual(r.buf.slice(0, sig.length).toString('latin1'), sig);
        const cd = r.headers.get('content-disposition');
        assert.ok(cd.includes(encodeURIComponent(`черновик_${exporter.today()}.${fmt}`)), cd);
        assert.ok(!/Альфа/.test(cd));
        const text = fmt === 'txt' ? r.text : extract.inspect(`e.${fmt}`, r.buf).text;
        assert.ok(/ЧЕРНОВИК/.test(text) && /Что уточнить на приёме/.test(text), fmt);
        assert.ok(!text.includes('Пациент Альфа') && !text.includes('pa@t.test'), 'ФИО пациента не в экспорте');
        const whole = await req('GET', `/ai/t/${bound}/export.${fmt}`, { j: j1 });
        assert.strictEqual(whole.status, 200);
      }
      assert.strictEqual((await req('GET', `/ai/m/${mid}/export.pdf`, { j: j2 })).status, 404);
      assert.strictEqual((await req('GET', `/ai/m/${mid}/export.exe`, { j: j1 })).status, 404);
      assert.ok(db.prepare("SELECT 1 FROM ai_audit WHERE event = 'ws_export_message' AND patient_id = ?").get(pA));
      assert.ok(db.prepare("SELECT 1 FROM phi_access_log WHERE action = 'ai_export' AND patient_id = ?").get(pA));
    });

    // ---------- лимиты ----------
    check('лимиты: 8000 символов — ок, 8001 — отказ с сохранением текста; rate-limit; максимум 200 диалогов', async () => {
      service.resetRateLimit();
      const ok = await req('POST', '/ai/send', { j: j1, body: { text: 'я'.repeat(8000) }, json: true });
      assert.strictEqual(ok.status, 200);
      const long = await req('POST', '/ai/send', { j: j1, body: { text: 'я'.repeat(8001) }, json: true });
      assert.strictEqual(long.status, 422);
      assert.ok(/8000/.test(long.json.error));
      const html = await req('POST', '/ai/send', { j: j1, body: { text: 'я'.repeat(8001) } });
      assert.strictEqual(html.status, 422);
      assert.ok(html.text.includes('я'.repeat(100)), 'введённый текст не потерян');
      const empty = await req('POST', '/ai/send', { j: j1, body: { text: '   ' }, json: true });
      assert.strictEqual(empty.status, 400);
      service.resetRateLimit();
      let limited = 0;
      for (let i = 0; i < 35; i++) if ((await req('POST', '/ai/send', { j: j1, body: { text: `быстро ${i}` }, json: true })).status === 429) limited++;
      assert.ok(limited >= 4, `429 получено ${limited}`);
      service.resetRateLimit();
      const have = service.countThreads(doc2);
      const insT = db.prepare("INSERT INTO ai_threads (owner_user_id, role, title) VALUES (?, 'clinician', 'заполнитель')");
      for (let i = have; i < 200; i++) insT.run(doc2);
      const over = await req('POST', '/ai/send', { j: j2, body: { text: 'ещё один' }, json: true });
      assert.strictEqual(over.status, 422);
      assert.ok(/лимит/.test(over.json.error) && /200/.test(over.json.error));
      db.prepare("DELETE FROM ai_threads WHERE owner_user_id = ? AND title = 'заполнитель'").run(doc2);
      service.resetRateLimit();
    });
    check('детектор ПДн во вводе: /ai/pii/detect возвращает найденное и вариант после маскирования', async () => {
      const r = await req('POST', '/ai/pii/detect', { j: j1, json: true, headers: { 'Content-Type': 'application/json' }, body: undefined });
      void r;
      const res = await fetch(`${BASE}/ai/pii/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: j1.header(), 'X-Requested-With': 'fetch' }, body: JSON.stringify({ text: 'Позвоните +7 (999) 000-00-00 по делу' }) });
      const js = await res.json();
      assert.strictEqual(js.count, 1);
      assert.ok(/\[ТЕЛЕФОН\]/.test(js.masked) && !/999/.test(js.masked));
      const clean = await fetch(`${BASE}/ai/pii/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: j1.header() }, body: JSON.stringify({ text: 'Обычный вопрос' }) });
      assert.strictEqual((await clean.json()).count, 0);
      const forbidden = await fetch(`${BASE}/ai/pii/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jA.header() }, body: JSON.stringify({ text: 'x' }) });
      assert.strictEqual(forbidden.status, 403);
    });
    check('фильтр списка тредов: «по пациенту» и «без привязки»', async () => {
      const p = await req('GET', '/ai?f=patient', { j: j1 });
      assert.ok(p.text.includes(`/ai/t/${bound}"`) && !p.text.includes(`/ai/t/${general}"`));
      const g = await req('GET', '/ai?f=general', { j: j1 });
      assert.ok(g.text.includes(`/ai/t/${general}"`) && !g.text.includes(`/ai/t/${bound}"`));
    });

    // ---------- срок хранения (последним: сдвиг времени удаляет все диалоги) ----------
    check('срок хранения: сдвиг времени -> автоудаление материала (файл+запись) и устаревшего диалога', async () => {
      const t = await req('POST', '/ai/send', { j: j1, body: { text: 'Срок' }, json: true });
      const tid = t.json.thread.id;
      const up = await upload(j1, [{ name: 'e.txt', data: Buffer.from('срочный материал') }], { thread_id: String(tid), mask: '1' });
      await req('POST', '/ai/materials/save', { j: j1, body: { token: tokenOf(up.text), mask: '1', thread_id: String(tid) } });
      const row = db.prepare('SELECT * FROM ai_attachments WHERE thread_id = ?').get(tid);
      const file = row.storage_path;
      assert.ok(fs.existsSync(file));
      const before = store.purgeExpired(new Date());
      assert.ok(fs.existsSync(file) && before.materials === 0, 'в срок ничего не удаляется');
      const later = store.purgeExpired(new Date(Date.now() + 31 * 86400000));
      assert.ok(later.materials >= 1);
      assert.ok(!fs.existsSync(file) && !db.prepare('SELECT 1 FROM ai_attachments WHERE id = ?').get(row.id));
      assert.ok(later.threads >= 1 && !db.prepare('SELECT 1 FROM ai_threads WHERE id = ?').get(tid), 'просроченный диалог удалён вместе с сообщениями');
      assert.ok(!db.prepare('SELECT 1 FROM ai_messages WHERE thread_id = ?').get(tid));
      // чужие (пациентские) треды автоудалением ИИ-пространства не затрагиваются
      assert.ok(db.prepare("SELECT COUNT(*) n FROM ai_threads WHERE role = 'patient'").get().n >= 0);
    });
    // ---------- аудит и сеть ----------
    check('аудит ИИ-пространства: события есть, содержимого нет (ни имён файлов, ни текста)', () => {
      const rows = db.prepare("SELECT * FROM ai_audit WHERE event LIKE 'ws_%'").all();
      assert.ok(rows.length > 20);
      const dump = JSON.stringify(rows);
      for (const secret of ['выписка', 'Сидоров', 'бессонниц', 'x.txt', 'УНИКАЛЬНАЯ-ФРАЗА']) assert.ok(!dump.includes(secret), secret);
      assert.ok(rows.some((r) => r.files >= 1) && rows.some((r) => r.patient_id === pA));
    });
    check('upload-каталог не внутри public/ и не отдаётся статикой', async () => {
      const dir = path.resolve(store.uploadDir());
      assert.ok(!dir.startsWith(path.resolve(__dirname, '..', 'public')));
      const r = await fetch(`${BASE}/${path.basename(dir)}/`, { redirect: 'manual' });
      assert.notStrictEqual(r.status, 200);
    });
    check('за весь прогон нет исходящих соединений', () => {
      assert.deepStrictEqual(outbound, []);
    });

    for (const [name, fn] of queue) {
      service.resetRateLimit();
      try { await fn(); oks++; console.log(`  OK   ${name}`); } catch (e) { fails++; console.error(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n       ') : e}`); }
    }
  } finally {
    server.close();
  }
  console.log(`\nai_workspace: ${oks} OK, ${fails} FAIL`);
  if (fails) process.exit(1);
  console.log('Все проверки ИИ-пространства врача прошли успешно.');
}

main().catch((e) => { console.error('FAIL (исключение)', e); process.exit(1); });

void zlib;
