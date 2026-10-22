'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W2.G: быстрые инструменты врача. Калькулятор не пишет в БД; CSV (формулы, чужие пациенты, диапазоны, откат,
// кодировки, дубликаты); экспорт; права (пациент/админ 403); когорта не раскрывает пациентов (порог 4/5).

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tools-'));
process.env.TDR_DB_PATH = path.join(tmp, 'tools.sqlite3');
process.env.SESSION_SECRET = 'test-secret';

require('../scripts/gc-guard');
const db = require('../src/db');
const { seedDemo, DEMO_PASSWORD } = require('../scripts/seed-demo');
const extract = require('../src/ai/workspace/extract');
const cohort = require('../src/tools/cohort');
const csvImport = require('../src/tools/csv_import');
const quicknote = require('../src/tools/quicknote');
const { createUser } = require('./helpers');

seedDemo();
const app = require('../src/app');

let BASE = '';
let failures = 0;
let oks = 0;
function check(label, cond) {
  if (cond) { oks++; console.log(`  OK   ${label}`); } else { failures++; console.error(`  FAIL ${label}`); }
}
async function step(label, fn) {
  try { await fn(); oks++; console.log(`  OK   ${label}`); } catch (e) { failures++; console.error(`  FAIL ${label}: ${e.message}`); }
}

function jar() {
  const cookies = new Map();
  return {
    store(res) { for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); } },
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}
async function req(method, p, { body, j, raw, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (j) headers.Cookie = j.header();
  let payload = raw;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) sp.append(k, x);
    payload = sp.toString();
  }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (j) j.store(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), buf, location: res.headers.get('location'), headers: res.headers };
}
async function login(email) {
  const j = jar();
  const r = await req('POST', '/login', { j, body: { email, password: DEMO_PASSWORD } });
  if (r.status !== 302) throw new Error(`login ${email}: ${r.status}`);
  return j;
}
function multipartFile(name, data) {
  const b = '----tb' + Math.random().toString(16).slice(2);
  const raw = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { raw, headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}
const uid = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
function totalRows() {
  let n = 0;
  // crisis_*: общий middleware очереди (W1.B1) сам дописывает журнал просрочек на любой запрос врача — к калькулятору не относится
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'crisis_%'").all()) n += count(`SELECT COUNT(*) AS n FROM "${t.name}"`);
  return n;
}
const ctrl = (r) => r.text.replace(/\s+/g, ' ');

async function upload(j, name, data) {
  const m = multipartFile(name, data);
  const r = await req('POST', '/tools/import/upload', { j, raw: m.raw, headers: m.headers });
  return r;
}

async function main() {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const psy1 = await login('psychiatrist1@example.com');
    const psy2 = await login('psychiatrist2@example.com');
    const psycho = await login('psychologist1@example.com');
    const patJ = await login('patient1.improving@example.com');
    const admin = await login('admin@example.com');
    const P1 = uid('patient1.improving@example.com'); // у psychiatrist1
    const Z = uid('patient3.crisis@example.com'); // у psychiatrist2, не у psychiatrist1
    const PSY1 = uid('psychiatrist1@example.com');

    console.log('1) Права: пациент и админ получают 403, клиницист видит раздел, пункт меню есть');
    for (const p of ['/tools', '/tools/calculator', '/tools/calculator/phq9', '/tools/templates', '/tools/import', '/tools/cohort', '/tools/reminders', '/tools/search?q=ab', '/tools/quicknote', '/tools/export/' + P1, '/tools/import/template.csv']) {
      for (const [nm, jj] of [['пациент', patJ], ['админ', admin]]) {
        const r = await req('GET', p, { j: jj });
        check(`${nm}: GET ${p} -> 403`, r.status === 403);
      }
      const ok = await req('GET', p, { j: psy1 });
      check(`психиатр: GET ${p} -> 200`, ok.status === 200);
    }
    check('аноним перенаправлен на вход', (await req('GET', '/tools')).status !== 200);
    check('психолог тоже видит /tools; в меню есть «Инструменты»', (await req('GET', '/tools', { j: psycho })).text.includes('href="/tools"'));
    check('POST калькулятора пациентом -> 403', (await req('POST', '/tools/calculator/phq9', { j: patJ, body: { a0: '1' } })).status === 403);

    console.log('2) Калькулятор: расчёт ничего не пишет ни в одну таблицу');
    await step('PHQ-9 с пунктом 9 = 3: итог, уровень, предупреждение без эскалации; число строк во всех таблицах не изменилось', async () => {
      const body = {};
      for (let i = 0; i < 9; i++) body[`a${i}`] = i === 8 ? '3' : '1';
      const before = totalRows();
      const r = await req('POST', '/tools/calculator/phq9', { j: psy1, body });
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('tools-result__total">11<'), 'итог 11');
      assert.ok(/умеренная депрессия/.test(r.text), 'уровень');
      assert.ok(r.text.includes('НЕ создана'), 'предупреждение без эскалации');
      assert.ok(r.text.includes('Ничего не сохраняется'));
      assert.strictEqual(totalRows(), before, 'БД не изменилась');
    });
    await step('неполные ответы -> понятная ошибка, снова без записи', async () => {
      const before = totalRows();
      const r = await req('POST', '/tools/calculator/gad7', { j: psy1, body: { a0: '1' } });
      assert.ok(r.text.includes('Не заполнены пункты'));
      assert.strictEqual(totalRows(), before);
    });
    await step('заглушка: честная пометка, сумма без порогов', async () => {
      const code = 'isi';
      const body = { a0: '1', a1: '1', a2: '1', a3: '1' };
      const r = await req('POST', `/tools/calculator/${code}`, { j: psy1, body });
      assert.ok(r.text.includes('Заглушка'), 'пометка');
      assert.ok(r.text.includes('tools-result__total">4<'));
    });
    await step('шкалы без автоскоринга -> 404', async () => {
      assert.strictEqual((await req('GET', '/tools/calculator/hdrs17', { j: psy1 })).status, 404);
      assert.strictEqual((await req('GET', '/tools/calculator/bdi2', { j: psy1 })).status, 404);
    });
    await step('логи не содержат ответов: журнал phi_access_log не пополнился расчётом', async () => {
      const before = count('SELECT COUNT(*) AS n FROM phi_access_log');
      const body = {}; for (let i = 0; i < 7; i++) body[`a${i}`] = '2';
      await req('POST', '/tools/calculator/gad7', { j: psy1, body });
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM phi_access_log'), before);
    });
    await step('сохранение итога: только закреплённому пациенту; чужому — отказ без записи; C-SSRS не сохраняется', async () => {
      const body = {}; for (let i = 0; i < 7; i++) body[`a${i}`] = '1';
      const n0 = count('SELECT COUNT(*) AS n FROM offline_results');
      const bad = await req('POST', '/tools/calculator/gad7/save', { j: psy1, body: { ...body, patient_id: String(Z), test_date: '2026-10-01' } });
      assert.strictEqual(bad.status, 200);
      assert.ok(bad.text.includes('не закреплён'));
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM offline_results'), n0);
      const ok = await req('POST', '/tools/calculator/gad7/save', { j: psy1, body: { ...body, patient_id: String(P1), test_date: '2026-10-01' } });
      assert.strictEqual(ok.status, 302);
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM offline_results'), n0 + 1);
      const row = db.prepare('SELECT * FROM offline_results ORDER BY id DESC LIMIT 1').get();
      assert.strictEqual(row.total_score, 7); assert.strictEqual(row.entered_by, PSY1);
      const cb = {}; for (let i = 0; i < 6; i++) cb[`a${i}`] = '0';
      const n1 = count('SELECT COUNT(*) AS n FROM offline_results');
      const cs = await req('POST', '/tools/calculator/cssrs/save', { j: psy1, body: { ...cb, patient_id: String(P1) } });
      assert.ok(cs.status === 200 && cs.text.includes('не сохраняется'));
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM offline_results'), n1);
    });

    console.log('3) Шаблоны документов и экспорт');
    await step('встроенные шаблоны помечены заглушками; свой шаблон: создать, подставить, выгрузить DOCX/PDF/TXT/печать', async () => {
      const list = await req('GET', '/tools/templates', { j: psy1 });
      assert.ok(list.text.includes('заглушка'));
      const c = await req('POST', '/tools/templates', { j: psy1, body: { title: 'Моя памятка', body: 'Уважаемый(ая) [ФИО]!\nСъешь ещё этих мягких французских булок, [дата].' } });
      assert.strictEqual(c.status, 302);
      const id = c.location.split('/').pop();
      const fill = await req('GET', `/tools/templates/${id}`, { j: psy1 });
      assert.ok(fill.text.includes('[ФИО]') && fill.text.includes('[дата]'));
      const form = { f0: 'Иванов И. И.', f1: '10.10.2026', fmt: 'docx' };
      const docx = await req('POST', `/tools/templates/${id}/export`, { j: psy1, body: form });
      assert.strictEqual(docx.buf.slice(0, 2).toString(), 'PK');
      assert.ok(!/filename="[^"]*Иванов/.test(docx.headers.get('content-disposition')), 'ФИО не в имени файла');
      const dtext = extract.inspect('x.docx', docx.buf).text;
      assert.ok(dtext.includes('Иванов И. И.') && dtext.includes('мягких французских булок') && dtext.includes('ЧЕРНОВИК'));
      const pdf = await req('POST', `/tools/templates/${id}/export`, { j: psy1, body: { ...form, fmt: 'pdf' } });
      assert.strictEqual(pdf.buf.slice(0, 5).toString(), '%PDF-');
      assert.ok(extract.inspect('x.pdf', pdf.buf).text.includes('мягких французских булок'));
      const txt = await req('POST', `/tools/templates/${id}/export`, { j: psy1, body: { ...form, fmt: 'txt' } });
      assert.ok(txt.text.includes('Иванов И. И.') && txt.text.includes('ЧЕРНОВИК'));
      const pr = await req('POST', `/tools/templates/${id}/export`, { j: psy1, body: { ...form, fmt: 'print' } });
      assert.ok(pr.text.includes('print-banner') && pr.text.includes('Иванов И. И.'));
      // чужой врач не видит и не правит
      assert.strictEqual((await req('GET', `/tools/templates/${id}`, { j: psy2 })).status, 404);
      assert.strictEqual((await req('POST', `/tools/templates/${id}/delete`, { j: psy2 })).status, 404);
      // правка и удаление
      const up = await req('POST', `/tools/templates/${id}/update`, { j: psy1, body: { title: 'Моя памятка 2', body: 'Текст [ФИО]' } });
      assert.strictEqual(up.status, 302);
      assert.ok((await req('GET', '/tools/templates', { j: psy1 })).text.includes('Моя памятка 2'));
      assert.strictEqual((await req('POST', `/tools/templates/${id}/delete`, { j: psy1 })).status, 302);
      assert.strictEqual((await req('GET', `/tools/templates/${id}`, { j: psy1 })).status, 404);
    });
    await step('подстановка ФИО пациента только по выбору и только своего; запись в аудит', async () => {
      const own = await req('POST', '/tools/templates/b-referral/export', { j: psy1, body: { fmt: 'txt', f0: '', f1: '', patient_id: String(P1) } });
      const name = db.prepare('SELECT full_name FROM users WHERE id = ?').get(P1).full_name;
      assert.ok(own.text.includes(name));
      assert.ok(count("SELECT COUNT(*) AS n FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = 'tools_template_fill'", PSY1, P1) >= 1);
      const foreign = await req('POST', '/tools/templates/b-referral/export', { j: psy1, body: { fmt: 'txt', f0: '', patient_id: String(Z) } });
      const zname = db.prepare('SELECT full_name FROM users WHERE id = ?').get(Z).full_name;
      assert.ok(!foreign.text.includes(zname), 'чужой пациент не подставляется');
    });
    await step('экспорт карточки: DOCX/PDF/TXT, кириллица, «черновик», запись в аудит; чужой пациент -> 403', async () => {
      const a0 = count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action LIKE 'export_patient_card_%'");
      for (const fmt of ['docx', 'pdf', 'txt']) {
        const r = await req('GET', `/tools/export/${P1}/download?fmt=${fmt}&s=scores&s=changes&s=results&s=notes`, { j: psy1 });
        assert.strictEqual(r.status, 200, fmt);
        const t = fmt === 'txt' ? r.text : extract.inspect(`c.${fmt}`, r.buf).text;
        assert.ok(t.includes('ЧЕРНОВИК') && t.includes('Светлова'), fmt);
        assert.ok(!/filename="[^"]*Светлова/.test(r.headers.get('content-disposition')));
      }
      assert.strictEqual(count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action LIKE 'export_patient_card_%'"), a0 + 3);
      assert.strictEqual((await req('GET', `/tools/export/${Z}/download?fmt=pdf`, { j: psy1 })).status, 403);
      assert.strictEqual((await req('GET', `/tools/export/${Z}`, { j: psy1 })).status, 403);
      assert.ok((await req('GET', `/patients/${P1}/visit`, { j: psy1 })).text.includes('PDF / DOCX'));
    });

    console.log('4) Импорт CSV');
    const head = 'patient_id;scale;date;score;item9;subscale_a;subscale_d;stai_state;stai_trait;mmpi_2;mmpi_7;mmpi_9;note\n';
    const nOff = () => count('SELECT COUNT(*) AS n FROM offline_results');
    await step('шаблон файла скачивается и содержит заголовок', async () => {
      const r = await req('GET', '/tools/import/template.csv', { j: psy1 });
      assert.ok(r.text.includes('patient_id;scale;date'));
    });
    let draftUrl;
    await step('«грязный» CSV (CP1251, пустые строки, формулы, чужой пациент, диапазоны, дата, дубль): предпросмотр без записи', async () => {
      const csv = head +
        `${P1};phq9;2026-09-01;12;1;;;;;;;;первичный\n` + // ok
        `\n;;;\n` + // пустые
        `${P1};phq9;01.09.2026;12;1;;;;;;;;повтор в файле\n` + // дубль в файле
        `${Z};phq9;2026-09-01;5;;;;;;;;;чужой\n` + // чужой
        `${P1};phq9;2026-09-02;99;;;;;;;;;диапазон\n` + // вне диапазона
        `${P1};gad7;2026-13-45;5;;;;;;;;;дата\n` + // неверная дата
        `=1+1;gad7;2026-09-01;5;;;;;;;;;формула в id\n` +
        `${P1};gad7;2026-09-03;+5;;;;;;;;;знак\n` +
        `${P1};who5;2026-09-04;18;;;;;;;;;=HYPERLINK("http://x")\n` + // формула в заметке: принимается с префиксом '
        `${P1};hads;2026-09-05;;;7;9;;;;;;\n` +
        `${P1};zzz;2026-09-05;5;;;;;;;;;неизвестная\n`;
      const buf = new TextDecoder('windows-1251'); void buf;
      const cp1251 = Buffer.from(require('util').TextEncoder ? encode1251(csv) : csv);
      const n0 = nOff(); const t0 = totalRows();
      const r = await upload(psy1, 'х.csv', cp1251);
      assert.strictEqual(r.status, 302, r.text.slice(0, 200));
      draftUrl = r.location;
      assert.ok(/\/tools\/import\/draft\/\d+/.test(draftUrl));
      const pv = await req('GET', draftUrl, { j: psy1 });
      const t = ctrl(pv);
      assert.ok(t.includes('Windows-1251'), 'кодировка определена');
      assert.ok(t.includes('Пациент не закреплён за вами'), 'чужой пациент');
      assert.ok(t.includes('вне диапазона 0-27'), 'диапазон');
      assert.ok(t.includes('Дата: нужен формат'), 'дата');
      assert.ok(t.includes('формульного символа'), 'формулы отклонены');
      assert.ok(t.includes('дубликат'), 'дубль');
      assert.ok(t.includes('Шкала «zzz»'), 'шкала');
      assert.ok(/к записи: <strong>3<\/strong>/.test(pv.text), 'к записи 3 (phq9, who5, hads)');
      assert.strictEqual(nOff(), n0, 'предпросмотр не пишет в offline_results');
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM tool_import_batches'), 0);
      assert.ok(totalRows() - t0 <= 2, 'добавлены только черновик и аудит просмотра');
    });
    await step('подтверждение: записаны только корректные строки, нейтрализована формула в заметке, аудит, ID партии', async () => {
      const n0 = nOff();
      const r = await req('POST', draftUrl.replace('/tools', '/tools') + '/confirm', { j: psy1, body: {} });
      assert.strictEqual(r.status, 302);
      assert.strictEqual(nOff(), n0 + 3);
      const rows = db.prepare('SELECT * FROM offline_results WHERE id > ? ORDER BY id').all(db.prepare('SELECT MAX(id) - 3 AS m FROM offline_results').get().m);
      assert.ok(rows.every((x) => x.patient_id === P1 && x.entered_by === PSY1));
      const who = rows.find((x) => x.instrument === 'who5');
      assert.ok(who.notes.startsWith("'=HYPERLINK"), 'формула нейтрализована префиксом');
      const hads = rows.find((x) => x.instrument === 'hads');
      assert.strictEqual(hads.total_score, 16); assert.ok(/A: /.test(hads.band));
      assert.strictEqual(count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action = 'tools_csv_import' AND actor_id = ?", PSY1), 1);
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM tool_import_drafts'), 0, 'черновик удалён');
      assert.ok(count('SELECT COUNT(*) AS n FROM tool_import_items') === 3);
    });
    await step('повторный импорт того же файла не плодит дубликаты (UTF-8, запятая)', async () => {
      const csv = `patient_id,scale,date,score\n${P1},phq9,2026-09-01,12\n${P1},who5,2026-09-04,18\n`;
      const r = await upload(psy1, 'again.csv', csv);
      const pv = await req('GET', r.location, { j: psy1 });
      assert.ok(/дубликатов: <strong>2<\/strong>/.test(pv.text) && /к записи: <strong>0<\/strong>/.test(pv.text));
      await req('POST', r.location.replace('/tools', '/tools') + '/cancel', { j: psy1, body: {} });
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM tool_import_drafts'), 0);
    });
    await step('сопоставление столбцов: нестандартные заголовки находятся по синонимам, остальное — вручную', async () => {
      const csv = `ID пациента;Методика;Дата теста;Баллы\n${P1};gad7;2026-09-10;8\n`;
      const r = await upload(psy1, 'syn.csv', csv);
      const pv = await req('GET', r.location, { j: psy1 });
      assert.ok(/к записи: <strong>1<\/strong>/.test(pv.text));
      const bad = await upload(psy1, 'weird.csv', `a;b;c\n1;2;3\n`);
      const pv2 = await req('GET', bad.location, { j: psy1 });
      assert.ok(pv2.text.includes('Не найдены обязательные столбцы'));
      const fixed = await req('GET', `${bad.location}?m_patient_id=0&m_scale=1&m_date=2`, { j: psy1 });
      assert.ok(!fixed.text.includes('Не найдены обязательные столбцы'));
      await req('POST', bad.location + '/cancel', { j: psy1, body: {} });
    });
    await step('чужой врач не видит черновик; лимиты: >1000 строк и >2 МБ отклоняются', async () => {
      const r = await upload(psy1, 'p.csv', `patient_id;scale;date;score\n${P1};gad7;2026-09-11;3\n`);
      const other = await req('GET', r.location, { j: psy2 });
      assert.strictEqual(other.status, 302);
      let big = 'patient_id;scale;date;score\n';
      for (let i = 0; i < 1001; i++) big += `${P1};gad7;2026-09-11;3\n`;
      const rb = await upload(psy1, 'big.csv', big);
      assert.strictEqual(rb.status, 302); assert.strictEqual(rb.location, '/tools/import');
      const huge = await upload(psy1, 'huge.csv', Buffer.alloc(2.2 * 1024 * 1024, 65));
      assert.strictEqual(huge.location, '/tools/import');
      await req('POST', r.location + '/cancel', { j: psy1, body: {} });
    });
    await step('BDI-II п.9=3 при импорте создаёт кризисную эскалацию (как ручной ввод), в предпросмотре предупреждение', async () => {
      const e0 = count('SELECT COUNT(*) AS n FROM crisis_escalations WHERE patient_id = ?', P1);
      const r = await upload(psy1, 'b.csv', `patient_id;scale;date;score;item9\n${P1};bdi2;2026-09-12;30;3\n`);
      const pv = await req('GET', r.location, { j: psy1 });
      assert.ok(pv.text.includes('будет создана кризисная эскалация'));
      await req('POST', r.location + '/confirm', { j: psy1, body: {} });
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM crisis_escalations WHERE patient_id = ?', P1), e0 + 1);
    });
    await step('откат партии: записи и пары сопоставления удалены, повторный откат и чужая партия отклоняются, через 24 ч — нельзя', async () => {
      const batch = db.prepare('SELECT * FROM tool_import_batches WHERE rows_ok = 3 ORDER BY id LIMIT 1').get();
      const n0 = nOff();
      const wrong = await req('POST', `/tools/import/${batch.id}/rollback`, { j: psy2, body: {} });
      assert.strictEqual(wrong.status, 302);
      assert.strictEqual(nOff(), n0, 'чужая партия не откатывается');
      const ok = await req('POST', `/tools/import/${batch.id}/rollback`, { j: psy1, body: {} });
      assert.strictEqual(ok.status, 302);
      assert.strictEqual(nOff(), n0 - 3);
      assert.ok(db.prepare('SELECT rolled_back_at FROM tool_import_batches WHERE id = ?').get(batch.id).rolled_back_at);
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM comparison_pairs cp WHERE NOT EXISTS (SELECT 1 FROM offline_results o WHERE o.id = cp.offline_result_id)'), 0);
      const again = csvImport.rollback({ id: PSY1 }, batch.id);
      assert.ok(!again.ok);
      const last = db.prepare('SELECT * FROM tool_import_batches WHERE rolled_back_at IS NULL ORDER BY id DESC LIMIT 1').get();
      const late = csvImport.rollback({ id: PSY1 }, last.id, new Date(Date.now() + 25 * 3600000));
      assert.ok(!late.ok && /24/.test(late.error));
    });
    await step('юнит: декодирование UTF-8 с BOM / CP1251, разделитель, формула в заметке', async () => {
      assert.strictEqual(csvImport.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('привет')])).text, 'привет');
      assert.strictEqual(csvImport.decode(encode1251('привет')).encoding, 'Windows-1251');
      assert.strictEqual(csvImport.detectDelimiter('a,b,c\n1,2,3'), ',');
      assert.strictEqual(csvImport.sanitizeNote('@cmd'), "'@cmd");
    });

    console.log('5) Когорта не раскрывает пациентов; порог 4/5');
    await step('у демо-врача достаточно пациентов? агрегаты без ФИО/ID/e-mail', async () => {
      const r = await req('GET', '/tools/cohort', { j: psy1 });
      assert.strictEqual(r.status, 200);
      const names = db.prepare("SELECT full_name FROM users WHERE role = 'patient'").all();
      for (const n of names) assert.ok(!r.text.includes(n.full_name), 'ФИО не в отчёте');
      const csv = await req('GET', '/tools/cohort.csv', { j: psy1 });
      for (const n of names) assert.ok(!csv.text.includes(n.full_name));
      assert.ok(!/@example\.com/.test(csv.text));
    });
    await step('порог: 4 пациента — «слишком мало», 5 — агрегат; чужие пациенты не учитываются', async () => {
      const doc = createUser(db, { email: 'cohort-doc@example.com', full_name: 'Врач Когорта', role: 'psychiatrist' });
      const mk = (i) => {
        const id = createUser(db, { email: `coh${i}@example.com`, full_name: `Когорта Пациент ${i}`, role: 'patient' });
        db.prepare('UPDATE users SET account_status = ? WHERE id = ?').run('active', id);
        db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(id, doc);
        return id;
      };
      const ids = [1, 2, 3, 4].map(mk);
      const s4 = cohort.summary(doc);
      assert.strictEqual(s4.tooFewAll, true);
      assert.ok(s4.status === null);
      assert.ok(cohort.toCsv(s4).includes('слишком мало для агрегата'));
      ids.push(mk(5));
      const s5 = cohort.summary(doc);
      assert.ok(!s5.tooFewAll && s5.total === 5 && s5.status.reduce((a, x) => a + x.n, 0) === 5);
      assert.ok(s5.dist.tooFew, 'по шкале без данных — слишком мало');
      // чужой пациент (psychiatrist2) не попадает
      assert.strictEqual(cohort.summary(doc).total, 5);
      // 5 результатов PHQ-9: агрегат появляется
      ids.forEach((id, k) => db.prepare("INSERT INTO online_results (patient_id, instrument, answers_json, total_score, band, created_at) VALUES (?, 'phq9', '[]', ?, 'x', datetime('now', '-3 days'))").run(id, 4 + k * 5));
      const s5b = cohort.summary(doc);
      assert.ok(!s5b.dist.tooFew && s5b.dist.rows.reduce((a, x) => a + x.n, 0) === 5);
      const cj = await login('cohort-doc@example.com');
      const page = await req('GET', '/tools/cohort', { j: cj });
      for (let i = 1; i <= 5; i++) assert.ok(!page.text.includes(`Когорта Пациент ${i}`));
    });

    console.log('6) Напоминания, поиск, быстрая заметка');
    await step('напоминания: страница работает, «отложить» только своего пациента', async () => {
      const r = await req('GET', '/tools/reminders?days=14', { j: psy1 });
      assert.strictEqual(r.status, 200);
      const sn = await req('POST', '/tools/reminders/snooze', { j: psy1, body: { patient_id: String(Z), days: '14' } });
      assert.strictEqual(sn.status, 302);
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM tool_repeat_snoozes WHERE patient_id = ?', Z), 0);
      assert.ok((await req('GET', '/dashboard', { j: psy1 })).status === 200);
    });
    await step('поиск: свои заметки находятся, чужие — нет; шаблоны ищутся', async () => {
      db.prepare('INSERT INTO clinician_notes (patient_id, author_id, body) VALUES (?, ?, ?)').run(P1, PSY1, 'Уникальнаяфразаоднаединственная про сон');
      db.prepare('INSERT INTO clinician_notes (patient_id, author_id, body) VALUES (?, ?, ?)').run(Z, uid('psychiatrist2@example.com'), 'Секретнаячужаязаметка про сон');
      const mine = await req('GET', '/tools/search?q=' + encodeURIComponent('уникальнаяфразаоднаединственная'), { j: psy1 });
      assert.ok(mine.text.includes('Уникальнаяфразаоднаединственная'));
      const foreign = await req('GET', '/tools/search?q=' + encodeURIComponent('секретнаячужаязаметка'), { j: psy1 });
      assert.ok(!foreign.text.includes('Секретнаячужаязаметка'));
      assert.ok((await req('GET', '/tools/search?q=' + encodeURIComponent('направление'), { j: psy1 })).text.includes('Направление'));
      assert.ok((await req('GET', '/tools/search?q=zzzzzzzzqq', { j: psy1 })).text.includes('Ничего не найдено'));
    });
    await step('быстрая заметка: черновик с пометкой, ничего не сохраняется; сохранение только закреплённому', async () => {
      const t0 = totalRows();
      const r = await req('POST', '/tools/quicknote', { j: psy1, body: { text: 'Жалобы: плохой сон.\nПлан: повторный приём.' } });
      assert.ok(r.text.includes('ЧЕРНОВИК') && r.text.includes('План'));
      assert.strictEqual(totalRows(), t0);
      assert.strictEqual(quicknote.structure('').empty, true);
      const bad = await req('POST', '/tools/quicknote/save', { j: psy1, body: { patient_id: String(Z), draft: 'x' } });
      assert.strictEqual(bad.status, 302); assert.strictEqual(bad.location, '/tools/quicknote');
      const n0 = count('SELECT COUNT(*) AS n FROM clinician_notes');
      const ok = await req('POST', '/tools/quicknote/save', { j: psy1, body: { patient_id: String(P1), draft: 'Жалобы: сон' } });
      assert.strictEqual(ok.status, 302);
      assert.strictEqual(count('SELECT COUNT(*) AS n FROM clinician_notes'), n0 + 1);
    });
  } finally {
    server.close();
  }
  console.log(`\ntools: ${oks} OK, ${failures} FAIL`);
  if (failures) process.exitCode = 1;
  else console.log('Все проверки инструментов врача прошли успешно.');
}

// Windows-1251 кодирование для теста (в Node нет встроенного энкодера)
function encode1251(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

main().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
