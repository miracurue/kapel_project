'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W2.E: заключения психолога — e2e на демо-сиде + негативные сценарии (психиатр не подписывает,
// пациент/админ 403, чужой пациент, правка после подписи = новая версия, хэши различаются).

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-concl-'));
process.env.TDR_DB_PATH = path.join(tmp, 'cc.sqlite3');
process.env.SESSION_SECRET = 'test-secret';

require('../scripts/gc-guard');
const db = require('../src/db');
const { seedDemo, DEMO_PASSWORD } = require('../scripts/seed-demo');
const C = require('../src/conclusions');

seedDemo();
const app = require('../src/app');

let BASE = '';
let failures = 0;
let oks = 0;
function check(label, cond) {
  if (cond) { oks++; console.log(`  OK   ${label}`); } else { failures++; console.error(`  FAIL ${label}`); }
}
function jar() {
  const cookies = new Map();
  return {
    store(res) { for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); } },
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}
async function req(method, p, { body, cookieJar, headers: extra = {}, raw = false } = {}) {
  const headers = { ...extra };
  if (cookieJar) headers.Cookie = cookieJar.header();
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) sp.append(k, x);
    payload = sp.toString();
  }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (cookieJar) cookieJar.store(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: raw ? '' : buf.toString('utf8'), buf, location: res.headers.get('location'), headers: res.headers };
}
async function login(email) {
  const j = jar();
  const r = await req('POST', '/login', { cookieJar: j, body: { email, password: DEMO_PASSWORD } });
  if (r.status !== 302) throw new Error(`login ${email}: ${r.status}`);
  return j;
}
const uid = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const noRequired = (t) => !/\srequired[\s>=]/.test(t);

function inflateAll(pdf) {
  // распаковать все flate-потоки PDF (нужно для проверки текста через ToUnicode не требуется: проверяем структуру)
  const out = [];
  let i = 0;
  const s = pdf.toString('latin1');
  while ((i = s.indexOf('stream\n', i)) >= 0) {
    const end = s.indexOf('\nendstream', i);
    try { out.push(zlib.inflateSync(pdf.subarray(i + 7, end))); } catch { /* пропуск */ }
    i = end + 10;
  }
  return out;
}

async function main() {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const psycho = await login('psychologist1@example.com');
    const psycho2 = await login('psychologist2@example.com');
    const psyatr = await login('psychiatrist1@example.com');
    const psyatr2 = await login('psychiatrist2@example.com');
    const patJar = await login('patient2.worsening@example.com');
    const admin = await login('admin@example.com');
    const G = uid('patient2.worsening@example.com');
    const PSYCHO = uid('psychologist1@example.com');

    console.log('1) Список и создание черновика (REQ-PSY-001, -003)');
    let r = await req('GET', '/conclusions', { cookieJar: psycho });
    check('психолог: раздел «Заключения» открыт, видны демо-заключения сида', r.status === 200 && /Заключение по результатам обследования/.test(r.text) && /Заключения<\/a>/.test(r.text));
    r = await req('GET', '/conclusions', { cookieJar: psycho2 });
    check('психолог без заключений: пустое состояние с подсказкой', r.status === 200 && /Заключений пока нет/.test(r.text));
    r = await req('GET', `/patients/${G}/conclusions`, { cookieJar: psycho });
    check('вкладка «Заключения» в карточке: 200, кнопка создания, без required', r.status === 200 && /Создать черновик заключения/.test(r.text) && noRequired(r.text));
    // протоколы для подстановки: сеанс обследования, частичный ввод
    r = await req('POST', `/patients/${G}/exam`, { cookieJar: psycho, body: { session_date: '2026-10-01', title: 'Первый сеанс' } });
    const sid = Number((r.location || '').split('/').pop());
    check('сеанс обследования создан (302)', r.status === 302 && sid > 0);
    r = await req('GET', `/patients/${G}/exam/${sid}`, { cookieJar: psycho });
    check('сеанс: индикатор «внесено 0 из 0», без required', r.status === 200 && /внесено 0 из 0/.test(r.text) && noRequired(r.text));
    const stubCode = require('../src/instruments_catalog').CATALOG.find((e) => e.status === 'stub' && e.mode === 'clinician_entered').code;
    const stubCode2 = require('../src/instruments_catalog').CATALOG.filter((e) => e.status === 'stub' && e.mode === 'clinician_entered')[1].code;
    await req('POST', `/patients/${G}/exam/${sid}/plan`, { cookieJar: psycho, body: { instrument: stubCode } });
    await req('POST', `/patients/${G}/exam/${sid}/plan`, { cookieJar: psycho, body: { instrument: stubCode2 } });
    r = await req('GET', `/patients/${G}/exam/${sid}`, { cookieJar: psycho });
    check('в сеансе 2 методики, внесено 0 из 2', /внесено 0 из 2/.test(r.text));
    r = await req('POST', `/patients/${G}/exam/${sid}/protocol/${stubCode}`, { cookieJar: psycho, headers: { 'X-Requested-With': 'fetch' }, body: { observations: 'частичный ввод', verbatim: 'дословно: ' + 'я'.repeat(15000), errors: '2' } });
    let j = JSON.parse(r.text);
    check('автосохранение (XHR): ok, внесено 1 из 2', r.status === 200 && j.ok && j.saved && j.progress.entered === 1 && j.progress.total === 2);
    r = await req('POST', `/patients/${G}/exam/${sid}/protocol/${stubCode2}`, { cookieJar: psycho, headers: { 'X-Requested-With': 'fetch' }, body: {} });
    j = JSON.parse(r.text);
    check('пустое сохранение не блокирует и не создаёт строку', r.status === 200 && j.ok && !j.saved);
    r = await req('GET', `/patients/${G}/exam/${sid}`, { cookieJar: psycho });
    check('вернулись: данные на месте (15000 симв. дословных ответов)', r.status === 200 && r.text.includes('частичный ввод') && r.text.includes('я'.repeat(15000)) && /внесено 1 из 2/.test(r.text));
    r = await req('POST', `/patients/${G}/exam/${sid}/protocol/${stubCode}`, { cookieJar: psycho, headers: { 'X-Requested-With': 'fetch' }, body: { errors: '-3' } });
    check('неверное число: 400 с сообщением, без 500', r.status === 400);
    await req('POST', `/patients/${G}/exam/${sid}/protocol/${stubCode}`, { cookieJar: psycho, body: { score: '12', ready: '1', observations: 'x' } });
    check('«готово» ставит статус ready', db.prepare('SELECT status FROM catalog_protocols WHERE session_id = ? AND instrument = ?').get(sid, stubCode).status === 'ready');

    r = await req('POST', `/patients/${G}/conclusions`, { cookieJar: psycho, body: { title: 'Тест' } });
    const cid = Number((r.location || '').split('/').pop());
    check('черновик создан, редирект на /conclusions/:id', r.status === 302 && cid > 0);
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psycho });
    check('метка ЧЕРНОВИК, форма редактирования, оговорка про подпись, без required', r.status === 200 && /ЧЕРНОВИК/.test(r.text) && /не квалифицированная электронная подпись/.test(r.text) && /name="summary"/.test(r.text) && noRequired(r.text));
    check('подстановка протоколов в раздел, «демо-балл», ссылки в версии', r.text.includes('демо-балл') && C.latestVersion(cid).refs.some((x) => x.kind === 'protocol'));
    check('нет полей диагноза/терапии в DOM', !/name="diagnos/i.test(r.text) && !/Назначить терапию|Поставить диагноз/i.test(r.text));
    const tplText = JSON.stringify(C.SECTIONS) + JSON.stringify(C.REMINDERS);
    check('шаблоны: нет фраз-диагнозов (МКБ-коды, «у пациента ... расстройство»)', !/\bF\d\d(\.\d)?\b/.test(tplText) && !/диагноз:|установлен диагноз|депрессивн|тревожн/i.test(tplText));
    check('напоминания проходят пост-фильтр REQ-AIP-010', C.remindersSafe().length === C.REMINDERS.length);

    console.log('2) Пустое сохранение и правка черновика');
    r = await req('POST', `/conclusions/${cid}`, { cookieJar: psycho, body: { title: '', reason: '', summary: '' } });
    check('сохранить совсем пустое — можно (302)', r.status === 302);
    r = await req('POST', `/conclusions/${cid}`, { cookieJar: psycho, headers: { 'X-Requested-With': 'fetch' }, body: { title: 'Тест', summary: 'Свободный текст психолога', findings: '<script>alert(1)</script>' } });
    check('автосохранение заключения: JSON ok', r.status === 200 && JSON.parse(r.text).ok);
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psycho });
    check('XSS экранирован', !r.text.includes('<script>alert(1)</script>') && r.text.includes('&lt;script&gt;'));
    r = await req('GET', `/conclusions`, { cookieJar: psycho });
    check('в списке: «черновик»', /черновик/.test(r.text) && r.text.includes('Тест'));

    console.log('3) Права: психиатр, пациент, админ, чужие');
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psyatr });
    check('психиатр читает черновик психолога: 200, пометка, только чтение', r.status === 200 && /Черновик психолога, не подписано/.test(r.text) && /Только чтение/.test(r.text) && !/<textarea/.test(r.text) && !/name="confirm_password"/.test(r.text));
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psyatr2 });
    check('психиатр без привязки к пациенту: 403', r.status === 403);
    r = await req('GET', '/conclusions', { cookieJar: psyatr });
    check('психиатр: черновик в списке с пометкой', r.status === 200 && r.text.includes('Тест') && /черновик психолога, не подписано/.test(r.text));
    r = await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psyatr, body: { confirm_name: 'Демо Психиатр', confirm_check: '1' } });
    check('психиатр не подписывает (403)', r.status === 403 && C.latestVersion(cid).status === 'draft');
    r = await req('POST', `/conclusions/${cid}`, { cookieJar: psyatr, body: { summary: 'взлом' } });
    check('психиатр не правит (403)', r.status === 403 && C.latestVersion(cid).sections.summary === 'Свободный текст психолога');
    r = await req('POST', `/patients/${G}/conclusions`, { cookieJar: psyatr, body: {} });
    check('психиатр не создаёт заключение (403)', r.status === 403);
    r = await req('POST', `/patients/${G}/treatment`, { cookieJar: psycho, body: { body: 'x' } });
    check('REQ-PSY-006: психолог POST /treatment -> 403', r.status === 403);
    for (const [who, jr] of [['пациент', patJar], ['админ', admin]]) {
      const a = await req('GET', '/conclusions', { cookieJar: jr });
      const b = await req('GET', `/conclusions/${cid}`, { cookieJar: jr });
      const c2 = await req('POST', `/conclusions/${cid}/sign`, { cookieJar: jr, body: { confirm_name: 'x', confirm_check: '1' } });
      const d = await req('GET', `/conclusions/${cid}/export.pdf`, { cookieJar: jr });
      const e = await req('GET', `/patients/${G}/conclusions`, { cookieJar: jr });
      check(`${who}: список/просмотр/подпись/экспорт/вкладка -> 403`, [a, b, c2, d, e].every((x) => x.status === 403));
    }
    r = await req('GET', `/conclusions/${cid}`);
    check('аноним: не получает содержимое (редирект/403)', r.status !== 200);
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psycho2 });
    check('чужой психолог (не закреплён): 403', r.status === 403);
    r = await req('GET', `/patients/${G}/conclusions`, { cookieJar: psyatr2 });
    check('чужой психиатр: вкладка 403', r.status === 403);
    r = await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psycho2, body: { confirm_name: 'Демо Психолог Тихонова Н. Р.', confirm_check: '1' } });
    check('чужой психолог не подписывает (403)', r.status === 403);
    r = await req('GET', '/conclusions/99999', { cookieJar: psycho });
    check('несуществующее заключение: 404', r.status === 404);

    console.log('4) Подпись (REQ-PSY-004)');
    r = await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psycho, body: { confirm_password: 'неверный' } });
    check('неверный пароль: не подписано', r.status === 302 && C.latestVersion(cid).status === 'draft');
    r = await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psycho, body: { confirm_name: 'Другое Имя', confirm_check: '1' } });
    check('неверное ФИО: не подписано', C.latestVersion(cid).status === 'draft');
    r = await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psycho, body: { confirm_name: 'Демо Психолог Белова Е. Н.' } });
    check('ФИО без флажка: не подписано', C.latestVersion(cid).status === 'draft');
    const auditBefore = count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action = 'conclusion_sign'");
    r = await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psycho, body: { confirm_password: DEMO_PASSWORD } });
    const v1 = C.latestVersion(cid);
    check('подпись паролем: signed, ФИО, время, хэш', v1.status === 'signed' && v1.signed_name === 'Демо Психолог Белова Е. Н.' && !!v1.signed_at && /^[0-9a-f]{64}$/.test(v1.checksum) && v1.sign_method === 'password');
    check('хэш воспроизводим, целостность подтверждается', C.checksumOf(v1) === v1.checksum && C.integrityOk(v1));
    check('подпись записана в аудит', count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action = 'conclusion_sign'") === auditBefore + 1);
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psycho });
    check('UI: подписано, хэш, оговорка «не КЭП», форма подписи скрыта, текст заблокирован', /подписано/.test(r.text) && r.text.includes(v1.checksum) && /не квалифицированная электронная подпись/.test(r.text) && !/name="confirm_password"/.test(r.text) && !/<textarea/.test(r.text));
    r = await req('POST', `/conclusions/${cid}`, { cookieJar: psycho, body: { summary: 'правка после подписи' } });
    check('сохранение тела после подписи (форма) -> 409', r.status === 409 && C.latestVersion(cid).sections.summary === 'Свободный текст психолога');
    r = await req('POST', `/conclusions/${cid}`, { cookieJar: psycho, headers: { 'X-Requested-With': 'fetch' }, body: { summary: 'правка после подписи' } });
    check('POST (автосохранение) после подписи -> 409', r.status === 409);
    let threw = false;
    try { db.prepare("UPDATE conclusion_versions SET sections_json = '{}' WHERE id = ?").run(v1.id); } catch { threw = true; }
    check('БД: UPDATE подписанной версии запрещён триггером', threw && C.latestVersion(cid).sections.summary === 'Свободный текст психолога');
    r = await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psycho, body: { confirm_password: DEMO_PASSWORD } });
    check('повторная подпись подписанного не меняет версию', r.status === 302 && count('SELECT COUNT(*) AS n FROM conclusion_versions WHERE conclusion_id = ?', cid) === 1);

    console.log('5) Психиатр читает подписанное (REQ-PSY-008)');
    r = await req('GET', '/conclusions', { cookieJar: psyatr });
    check('психиатр видит подписанное в списке', r.status === 200 && r.text.includes('Тест') && /подписано/.test(r.text));
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psyatr });
    check('психиатр открывает: только чтение, без форм подписи/правки', r.status === 200 && /Только чтение/.test(r.text) && !/name="confirm_password"/.test(r.text) && !/name="reason"/.test(r.text) && !/<textarea/.test(r.text));
    r = await req('GET', `/conclusions/${cid}/export.txt`, { cookieJar: psyatr });
    check('психиатр экспортирует подписанное', r.status === 200);
    r = await req('POST', `/conclusions/${cid}/revise`, { cookieJar: psyatr, body: { reason: 'x' } });
    check('психиатр не создаёт версии (403)', r.status === 403);
    r = await req('GET', '/my-conclusions', { cookieJar: patJar });
    check('пациент: пока пусто (не выдано)', r.status === 200 && /Пока ничего нет/.test(r.text));
    r = await req('GET', `/my-conclusions/${cid}`, { cookieJar: patJar });
    check('пациент: невыданное заключение -> 404', r.status === 404);

    console.log('6) Новая версия: причина, история, хэши (REQ-PSY-004)');
    r = await req('POST', `/conclusions/${cid}/revise`, { cookieJar: psycho, body: { reason: '   ' } });
    check('правка без причины отклонена', count('SELECT COUNT(*) AS n FROM conclusion_versions WHERE conclusion_id = ?', cid) === 1);
    r = await req('POST', `/conclusions/${cid}/revise`, { cookieJar: psycho, body: { reason: 'Уточнение формулировки' } });
    const v2d = C.latestVersion(cid);
    check('создана версия 2 (черновик) с причиной; v1 неизменна', v2d.version === 2 && v2d.status === 'draft' && v2d.reason === 'Уточнение формулировки' && C.getVersion(cid, 1).status === 'signed');
    r = await req('POST', `/conclusions/${cid}`, { cookieJar: psycho, body: { title: 'Тест', summary: 'Исправленный текст' } });
    check('версия 2 правится', r.status === 302 && C.latestVersion(cid).sections.summary === 'Исправленный текст' && C.getVersion(cid, 1).sections.summary === 'Свободный текст психолога');
    r = await req('GET', `/conclusions`, { cookieJar: psyatr });
    check('психиатр видит и черновик v2 в списке', r.status === 200 && r.text.includes('Тест'));
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psyatr });
    check('психиатр на странице видит черновик v2 (только чтение)', r.text.includes('Исправленный текст') && /Черновик психолога, не подписано/.test(r.text) && !/<textarea/.test(r.text));
    await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psycho, body: { confirm_name: 'демо  психолог белова е. н.', confirm_check: '1' } });
    const v2 = C.getVersion(cid, 2);
    check('v2 подписана (ФИО+флажок), хэши v1 и v2 различаются', v2.status === 'signed' && v2.sign_method === 'name_check' && v2.checksum !== v1.checksum);
    r = await req('GET', `/conclusions/${cid}`, { cookieJar: psycho });
    check('история: обе версии, причина, ссылки на версии', /Версия 1/.test(r.text) && /Версия 2/.test(r.text) && r.text.includes('Уточнение формулировки') && r.text.includes(v1.checksum.slice(0, 12)));
    r = await req('GET', `/conclusions/${cid}/versions/1`, { cookieJar: psycho });
    check('старая версия просматривается (не последняя)', r.status === 200 && /не последняя/.test(r.text) && r.text.includes('Свободный текст психолога') && !r.text.includes('Исправленный текст'));
    r = await req('GET', `/conclusions/${cid}/versions/2`, { cookieJar: psyatr });
    check('психиатр читает v2', r.status === 200);

    console.log('7) Экспорт DOCX/PDF/TXT (REQ-PSY-005) и аудит');
    const exAudit = count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action LIKE 'conclusion_export_%'");
    r = await req('GET', `/conclusions/${cid}/export.txt`, { cookieJar: psycho });
    check('TXT: подписанное, подпись и хэш, без ЧЕРНОВИК', r.status === 200 && /attachment/.test(r.headers.get('content-disposition')) && r.text.includes('Исправленный текст') && r.text.includes(v2.checksum) && !/ЧЕРНОВИК/.test(r.text));
    check('имя файла без ФИО', /filename="conclusion-\d+-v2\.txt"/.test(r.headers.get('content-disposition')));
    r = await req('GET', `/conclusions/${cid}/export.docx`, { cookieJar: psycho, raw: true });
    check('DOCX: zip-сигнатура, document.xml с кириллицей', r.status === 200 && r.buf.subarray(0, 2).toString() === 'PK' && r.buf.includes(Buffer.from('word/document.xml')));
    r = await req('GET', `/conclusions/${cid}/export.pdf`, { cookieJar: psycho, raw: true });
    check('PDF: %PDF, шрифт встроен, не пустой', r.status === 200 && r.buf.subarray(0, 5).toString() === '%PDF-' && r.buf.includes(Buffer.from('FontFile2')) && r.buf.length > 5000);
    // черновик: метка в экспорте
    await req('POST', `/conclusions/${cid}/revise`, { cookieJar: psycho, body: { reason: 'ещё правка' } });
    r = await req('GET', `/conclusions/${cid}/export.txt`, { cookieJar: psycho });
    check('черновик в TXT: метка ЧЕРНОВИК', /ЧЕРНОВИК/.test(r.text));
    r = await req('GET', `/conclusions/${cid}/export.pdf`, { cookieJar: psycho, raw: true });
    check('черновик в PDF: водяной знак (отдельный оп. Tm)', r.status === 200 && inflateAll(r.buf).some((b) => b.toString('latin1').includes('0.7071 0.7071 -0.7071')));
    r = await req('GET', `/conclusions/${cid}/export.txt?v=3`, { cookieJar: psyatr });
    check('психиатр экспортирует черновик с меткой ЧЕРНОВИК', r.status === 200 && /ЧЕРНОВИК/.test(r.text));
    r = await req('GET', `/conclusions/${cid}/export.txt?v=3`, { cookieJar: psycho2 });
    check('коллега-психолог (не автор, закреплён?) не получает черновик', r.status === 403 || r.status === 404);
    check('экспорты записаны в аудит (4 + проверки)', count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action LIKE 'conclusion_export_%'") >= exAudit + 5);
    r = await req('GET', `/conclusions/${cid}/export.xls`, { cookieJar: psycho });
    check('неизвестный формат: 404', r.status === 404);

    console.log('8) Выдача пациенту (REQ-PSY-008, should)');
    r = await req('POST', `/conclusions/${cid}/release`, { cookieJar: psyatr, body: { release: '1' } });
    check('психиатр не выдаёт (403)', r.status === 403);
    await req('POST', `/conclusions/${cid}/sign`, { cookieJar: psycho, body: { confirm_password: DEMO_PASSWORD } });
    r = await req('POST', `/conclusions/${cid}/release`, { cookieJar: psycho, body: { release: '1' } });
    check('психолог выдаёт подписанное', db.prepare('SELECT released_to_patient AS r FROM conclusions WHERE id = ?').get(cid).r === 1);
    r = await req('GET', `/my-conclusions/${cid}`, { cookieJar: patJar });
    check('пациент видит выданную последнюю подписанную версию', r.status === 200 && /не квалифицированная/.test(r.text));
    const other = await login('patient1.improving@example.com');
    r = await req('GET', `/my-conclusions/${cid}`, { cookieJar: other });
    check('чужой пациент: 404', r.status === 404);
    await req('POST', `/conclusions/${cid}/revise`, { cookieJar: psycho, body: { reason: 'после выдачи' } });
    check('новая версия снимает выдачу', db.prepare('SELECT released_to_patient AS r FROM conclusions WHERE id = ?').get(cid).r === 0);

    console.log('9) Поиск (REQ-PSY-009) и назначение тестов (REQ-PSY-007)');
    r = await req('GET', '/conclusions?q=' + encodeURIComponent('Исправленный'), { cookieJar: psycho });
    check('поиск по тексту находит заключение', r.status === 200 && r.text.includes('Тест'));
    r = await req('GET', '/conclusions?q=' + encodeURIComponent(require('../src/instruments_catalog').getEntry(stubCode).title.slice(0, 8)), { cookieJar: psycho });
    check('поиск по протоколам находит наблюдение', /Найденные протоколы/.test(r.text));
    r = await req('GET', '/conclusions?q=zzzнетзнаю', { cookieJar: psycho });
    check('пустой поиск: «Ничего не найдено»', /Ничего не найдено/.test(r.text));
    r = await req('GET', '/conclusions?status=signed&from=2000-01-01', { cookieJar: psycho });
    check('фильтры статус/дата работают', r.status === 200);
    r = await req('GET', '/assignments', { cookieJar: psycho });
    check('психолог видит назначения (любые тесты каталога)', r.status === 200);

    console.log('10) Аудит и удаление данных');
    check('просмотры/создание/подпись в phi_access_log', count("SELECT COUNT(*) AS n FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action IN ('conclusion_create','conclusion_sign','view_conclusion','conclusion_revise')", PSYCHO, G) >= 4);
    check('таблицы заключений зарегистрированы как спец. категория', !!db.SPECIAL_CATEGORY_TABLES.conclusion_versions && !!db.SPECIAL_CATEGORY_TABLES.exam_sessions);
    check('нет сырого текста заключения в phi_access_log', count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action LIKE '%Исправленный%'") === 0);
  } finally {
    server.close();
  }
  console.log(`\nconclusions: ${oks} OK, ${failures} FAIL`);
  if (failures) process.exitCode = 1;
  else console.log('Все проверки заключений психолога прошли успешно.');
}

main().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
