'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W0.4: каталог методик. Юнит-проверки реестра + HTTP-сценарий на временной БД:
// каждый каталожный код назначается/вводится, проходится, сохраняется;
// негативные сценарии доступа.

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `tdr-catalog-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret';

const app = require('../src/app');
const db = require('../src/db');
const catalog = require('../src/instruments_catalog');
const { INSTRUMENTS, scoreInstrument } = require('../src/instruments');

const PORT = 20000 + Math.floor(Math.random() * 20000); // случайный порт: тесты могут идти параллельно в разных worktree
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

function jar() {
  const cookies = new Map();
  return {
    store(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
    },
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

async function req(method, p, { body, cookieJar } = {}) {
  const headers = {};
  if (cookieJar) headers.Cookie = cookieJar.header();
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (cookieJar) cookieJar.store(res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
}

function unitChecks() {
  console.log('1) Реестр каталога');
  const codes = catalog.CATALOG.map((e) => e.code);
  check('коды уникальны', new Set(codes).size === codes.length);
  const stubs = catalog.CATALOG.filter((e) => e.status === 'stub');
  check(`заглушек не меньше 35 (сейчас ${stubs.length})`, stubs.length >= 35);
  check(
    'у каждой записи есть обязательные поля',
    catalog.CATALOG.every((e) => e.code && e.title && catalog.DOMAINS[e.domain] && catalog.KINDS[e.kind] && catalog.MODES[e.mode] && e.status && e.source_note)
  );
  check('заглушки: status stub, review_required, source_note', stubs.every((e) => e.status === 'stub' && e.review_required === true && e.source_note));
  check('online_stub: 3-5 пунктов, варианты, подсчёт', stubs.filter((e) => e.mode === 'online_stub').every((e) => e.items.length >= 3 && e.items.length <= 5 && e.options.length > 1 && e.scoring));
  check('патопсихология/проективные — только clinician_entered', stubs.filter((e) => e.kind === 'pathopsych_experiment' || e.kind === 'projective').every((e) => e.mode === 'clinician_entered' || e.code === 'dembo_rubinstein'));
  const real = ['phq9', 'gad7', 'hads', 'who5', 'cssrs', 'bdi2', 'stai', 'mmpi'];
  check('реальные шкалы в каталоге', real.every((c) => catalog.getEntry(c) && catalog.getEntry(c).status === 'implemented'));
  const sample = { phq9: [1, 2, 3, 0, 1, 2, 3, 0, 2], gad7: [3, 3, 3, 3, 3, 3, 3], cssrs: [1, 1, 1, 0, 0, 1] };
  check(
    'scoreAny для реальных шкал идентичен scoreInstrument',
    Object.entries(sample).every(([c, a]) => JSON.stringify(catalog.scoreAny(c, a)) === JSON.stringify(scoreInstrument(c, a)))
  );
  const s = catalog.scoreAny('bai', [3, 3, 3, 3]);
  check('заглушка: band «демо», без риска', s.band === 'демо' && s.riskFlag === false && s.riskReasons.length === 0);
  check('группировка по domain/kind непуста', catalog.groupedCatalog().length > 5);
}

async function main() {
  unitChecks();
  const server = app.listen(PORT);
  try {
    const mk = async (email, name, role, extra = {}) => {
      const j = jar();
      if (role === 'patient') await req('POST', '/register', { body: { email, password: 'secret123', full_name: name, role, ...extra } });
      else require('./helpers').createUser(db, { email, full_name: name, role });
      await req('POST', '/login', { cookieJar: j, body: { email, password: 'secret123' } });
      return j;
    };
    const consent = { consent_given: '1', clinical_consent_given: '1', anonymized_export_opt_in: '1' };
    const psychiatrist = await mk('psy1@example.test', 'Врач Один', 'psychiatrist');
    const psychologist = await mk('psy2@example.test', 'Психолог Два', 'psychologist');
    const outsider = await mk('psy3@example.test', 'Чужой Врач', 'psychologist');
    const uid = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    const docId = uid('psy1@example.test');
    await mk('pat1@example.test', 'Пациент Один', 'patient', consent);
    db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(uid('pat1@example.test'), docId);
    const patient = jar();
    await req('POST', '/login', { cookieJar: patient, body: { email: 'pat1@example.test', password: 'secret123' } });
    const pid = uid('pat1@example.test');
    db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pid, uid('psy2@example.test'));
    const other = await mk('pat2@example.test', 'Пациент Два', 'patient', consent);

    console.log('2) Каждый онлайн-код каталога: назначение любым клиницистом, прохождение, сохранение');
    const online = catalog.CATALOG.filter((e) => e.mode === 'online' || e.mode === 'online_stub');
    let okAssign = 0;
    let okTake = 0;
    let okSaved = 0;
    for (const [i, e] of online.entries()) {
      const clin = i % 2 === 0 ? psychiatrist : psychologist; // оба права test.assign.any_catalog
      let r = await req('POST', '/assignments', { cookieJar: clin, body: { patient_id: String(pid), instrument: e.code } });
      const row = db.prepare("SELECT id FROM instrument_assignments WHERE patient_id = ? AND instrument = ? AND status = 'pending' ORDER BY id DESC").get(pid, e.code);
      if (r.status === 302 && row) okAssign += 1;
      else console.error(`    не назначено: ${e.code}`);
      r = await req('GET', `/assignments/${row.id}/take?i=0`, { cookieJar: patient });
      const stubOk = e.status !== 'stub' || r.text.includes('Демонстрационная заглушка, не клинически валидная версия');
      if (r.status === 200 && stubOk) okTake += 1;
      else console.error(`    экран не открылся/нет пометки: ${e.code}`);
      const nItems = (INSTRUMENTS[e.code] || e).items.length;
      const body = {};
      for (let k = 0; k < nItems; k += 1) body[`item_${k}`] = '0';
      await req('POST', `/assignments/${row.id}/submit`, { cookieJar: patient, body });
      const saved = db.prepare('SELECT * FROM online_results WHERE assignment_id = ?').get(row.id);
      if (saved && (e.status !== 'stub' || (saved.band === 'демо' && saved.risk_flag === 0))) okSaved += 1;
      else console.error(`    результат не сохранён: ${e.code}`);
    }
    check(`назначено ${online.length}/${online.length}`, okAssign === online.length);
    check('экран прохождения открывается, заглушки с пометкой', okTake === online.length);
    check('результаты сохранены (заглушки: band «демо», без риска)', okSaved === online.length);
    check(
      'заглушки не создают кризисных эскалаций',
      db.prepare("SELECT COUNT(*) AS n FROM crisis_escalations WHERE instrument IN (" + catalog.CATALOG.filter((e) => e.status === 'stub').map((e) => `'${e.code}'`).join(',') + ')').get().n === 0
    );

    let r = await req('GET', `/patients/${pid}/scales?scale=bai&period=all`, { cookieJar: psychiatrist });
    check('карточка: онлайн-результат заглушки виден с дисклеймером', r.status === 200 && /data-instrument="bai"/.test(r.text) && r.text.includes('Демонстрационная заглушка, не клинически валидная версия'));
    r = await req('GET', `/assignments?patient=${pid}`, { cookieJar: psychiatrist });
    check(
      'страница «Назначения»: форма выбора с поиском и группировкой, все онлайн-коды в списке',
      /assignPicker-search/.test(r.text) && /<legend>Тревога<\/legend>/.test(r.text) && online.every((e) => r.text.includes(`name="instrument" value="${e.code}"`))
    );
    r = await req('GET', `/patients/${pid}/offline`, { cookieJar: psychiatrist });
    check(
      'карточка: форма ввода содержит все clinician_entered-заглушки',
      catalog.CATALOG.filter((e) => e.mode === 'clinician_entered' && e.status === 'stub').every((e) => r.text.includes(`name="instrument" value="${e.code}"`))
    );
    r = await req('GET', '/tests?tab=done', { cookieJar: patient });
    check('кабинет пациента: заглушка помечена в истории', /badge-warn">демо-заглушка/.test(r.text));

    console.log('3) Каждый clinician_entered-код: ввод протокола врачом, сохранение');
    const entered = catalog.CATALOG.filter((e) => e.mode === 'clinician_entered' && e.status === 'stub');
    let okProto = 0;
    let okWaitingAssign = 0;
    for (const [i, e] of entered.entries()) {
      const clin = i % 2 === 0 ? psychologist : psychiatrist;
      const before = db.prepare('SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ?').get(pid).n;
      await req('POST', '/assignments', { cookieJar: clin, body: { patient_id: String(pid), instrument: e.code } });
      const wa = db.prepare("SELECT status FROM instrument_assignments WHERE patient_id = ? AND instrument = ? ORDER BY id DESC LIMIT 1").get(pid, e.code);
      if (db.prepare('SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ?').get(pid).n === before + 1 && wa.status === 'waiting_entry') okWaitingAssign += 1;
      r = await req('POST', `/patients/${pid}/protocols`, {
        cookieJar: clin,
        body: { instrument: e.code, test_date: '2026-10-05', duration_sec: '120', errors: '2', score: '7', observations: `наблюдение ${e.code}` },
      });
      const row = db.prepare('SELECT * FROM catalog_protocols WHERE patient_id = ? AND instrument = ?').get(pid, e.code);
      if (r.status === 302 && row && row.status === 'draft' && JSON.parse(row.protocol_json).score === 7) okProto += 1;
      else console.error(`    протокол не сохранён: ${e.code}`);
    }
    check(`протоколы сохранены ${entered.length}/${entered.length} (черновик)`, okProto === entered.length);
    check('clinician_entered назначается со статусом «ожидает ввода врачом» (REQ-CAT-007)', okWaitingAssign === entered.length);
    r = await req('GET', `/patients/${pid}/offline`, { cookieJar: psychologist });
    check('протокол виден в карточке с пометкой «черновик»', /наблюдение luria10/.test(r.text) && /черновик/.test(r.text));
    r = await req('POST', `/patients/${pid}/protocols`, { cookieJar: psychiatrist, body: { instrument: 'luria10', test_date: '2026-10-05', errors: '-3' } });
    check('отрицательное значение отклонено', db.prepare("SELECT COUNT(*) AS n FROM catalog_protocols WHERE instrument = 'luria10'").get().n === 1);

    console.log('4) Негативные сценарии доступа');
    const nAssign = db.prepare('SELECT COUNT(*) AS n FROM instrument_assignments').get().n;
    r = await req('POST', '/assignments', { cookieJar: patient, body: { patient_id: String(pid), instrument: 'bai' } });
    check('пациент не может назначать тесты (403)', r.status === 403);
    r = await req('POST', `/patients/${pid}/protocols`, { cookieJar: patient, body: { instrument: 'luria10', test_date: '2026-10-05' } });
    check('пациент не может вводить протокол (403)', r.status === 403);
    r = await req('GET', `/patients/${pid}`, { cookieJar: patient });
    check('пациент не открывает карточку клинициста (403)', r.status === 403);
    r = await req('POST', '/assignments', { cookieJar: outsider, body: { patient_id: String(pid), instrument: 'bai' } });
    check('чужой клиницист не назначает тест', r.status === 302 && db.prepare('SELECT COUNT(*) AS n FROM instrument_assignments').get().n === nAssign);
    r = await req('GET', `/patients/${pid}`, { cookieJar: outsider });
    check('чужой клиницист не видит пациента (403)', r.status === 403);
    const nProto = db.prepare('SELECT COUNT(*) AS n FROM catalog_protocols').get().n;
    r = await req('POST', `/patients/${pid}/protocols`, { cookieJar: outsider, body: { instrument: 'luria10', test_date: '2026-10-05' } });
    check('чужой клиницист не вводит протокол (403)', r.status === 403 && db.prepare('SELECT COUNT(*) AS n FROM catalog_protocols').get().n === nProto);
    await req('POST', '/assignments', { cookieJar: psychiatrist, body: { patient_id: String(pid), instrument: 'bai' } });
    const aid = db.prepare("SELECT id FROM instrument_assignments WHERE patient_id = ? AND status = 'pending'").get(pid).id;
    r = await req('GET', `/assignments/${aid}/take`, { cookieJar: other });
    check('другой пациент не открывает чужое назначение (404)', r.status === 404);
    r = await req('GET', `/assignments/${aid}/take`, { cookieJar: psychiatrist });
    check('клиницист не проходит тест за пациента (403)', r.status === 403);
    r = await req('POST', '/assignments', { cookieJar: psychiatrist, body: { patient_id: String(pid), instrument: 'no_such_code' } });
    check('неизвестный код не назначается', r.status === 302 && !db.prepare("SELECT 1 FROM instrument_assignments WHERE instrument = 'no_such_code'").get());
  } finally {
    server.close();
    db.close();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDb + '-wal', { force: true });
    fs.rmSync(tmpDb + '-shm', { force: true });
  }
  console.log(`\n${failures === 0 ? 'Все проверки каталога прошли успешно.' : `${failures} проверок каталога не прошло.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
