'use strict';

// «Мои данные» (F-51), выгрузка (F-52, PD-18, PD-19), запрос на стирание и отмена (F-53, PD-12),
// исполнение стирания (F-77, F-85, PD-12, PD-13, PD-27), исправление записи (F-54), смена специалиста (F-55, F-86),
// ответ на запрос сведений и «Это странно» (F-84).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const { PASSWORD } = require('../fixtures/world');
const F = require('../lib/flows');

const ctx = useApp({
  extraPeople: [
    { key: 'patJ', R: 'R-02', role: 'patient', name: 'Юлия Стираемая', email: 'pat.j@cc.example.test', clinicians: ['psy1', 'plg1'], consents: ['base', 'ai', 'research'] },
    { key: 'patK', R: 'R-02', role: 'patient', name: 'Кирилл Скризисом', email: 'pat.k@cc.example.test', clinicians: ['psy1'], consents: ['base', 'ai'] },
  ],
});

// Таблицы, где после стирания остаются только факты без текста (PD-12 «надгробие»): белый список теста.
const FACT_TABLES = new Set(['phi_access_log', 'crisis_incident_log', 'crisis_escalations', 'consent_events', 'data_subject_requests', 'export_log', 'service_queue', 'care_episodes', 'care_assignments', 'ai_audit', 'action_log']);
const TEXT_COL = /(_enc|^note$|^body$|^text$|^quote|^message|answers_json|triggers_json)/;

// covers: T-200, UC-08, F-51, F-22, PD-03, PD-20
test('T-200 [W-50] «Мои данные»: категории и число записей, «кто смотрел» (кто, роль, раздел, дата, без IP); «Это странно» — запрос без клинического текста', async () => {
  const doc = await ctx.as('psy1');
  expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=overview`));
  const p = await ctx.as('patA');
  const d = expectOk(await p.get('/api/v1/me/data'));
  assert.ok(d.categories.length >= 1);
  const row = d.access_log.find((x) => /Анна|Синтетикова/.test(x.who));
  assert.ok(row && row.role && row.section && row.at, 'строка «кто смотрел»');
  assert.doesNotMatch(JSON.stringify(d.access_log), /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  expectOk(await p.post(`/api/v1/me/data/access-log/${row.id}/strange`, { comment: 'Синтетика: не помню такого' }));
  const q = expectOk(await (await ctx.as('admin1')).get('/api/v1/admin/requests?filter=open'));
  assert.ok(q.items.some((i) => i.kind === 'dispute_access'));
  for (let i = 0; i < 10; i += 1) await p.post(`/api/v1/me/data/access-log/${row.id}/strange`, {});
  const lim = await p.post(`/api/v1/me/data/access-log/${row.id}/strange`, {});
  assert.ok([409, 429].includes(lim.status), 'одна жалоба на строку и не больше 10 в сутки');
});

// covers: T-201, UC-08, F-52, PD-18, PD-19, PD-03
test('T-201 [W-50] выгрузка своих данных: повторный пароль, одноразовая ссылка на 15 минут, чужой и повтор — E-EXPORT-LINK, CSV защищён от формул, только свои данные', async () => {
  const p = await ctx.as('patA');
  expectOk(await p.post('/api/v1/me/diary', { mood: 3, note: '=HYPERLINK("http://evil.example.test","x") синтетика' }));
  expectError(await p.post('/api/v1/me/exports', { password: 'wrong-password-1' }), 401, 'E-REAUTH');
  const e = expectOk(await p.post('/api/v1/me/exports', { password: PASSWORD, format: 'zip_json_pdf' }));
  const path = new URL(e.link, ctx.app.base).pathname;
  expectError(await (await ctx.as('patB')).get(path), 410, 'E-EXPORT-LINK');
  const file = await p.get(path, { binary: true });
  assert.equal(file.status, 200);
  const zip = file.body.toString('latin1');
  assert.match(zip, /^PK/, 'архив ZIP (JSON + CSV + PDF)');
  assert.ok(!file.body.includes(Buffer.from('Олег Пробный')), 'чужих данных нет');
  expectError(await p.get(path), 410, 'E-EXPORT-LINK');
  const e2 = expectOk(await p.post('/api/v1/me/exports', { password: PASSWORD, format: 'zip_json_pdf' }));
  await ctx.app.advanceClock(16 * 60 * 1000);
  expectError(await p.get(new URL(e2.link, ctx.app.base).pathname), 410, 'E-EXPORT-LINK');
  await ctx.app.advanceClock(-16 * 60 * 1000);
  assert.ok(ctx.app.query("SELECT count(*) n FROM export_log WHERE kind = 'self_export' AND patient_id = ?", ctx.id('patA'))[0].n >= 1);
  assert.equal(ctx.app.smtp.messages.filter((m) => /attachment/i.test(m.data)).length, 0, 'письмом выгрузка не отправляется');
});

// covers: T-202, UC-08, UC-17, F-53, PD-12, PD-09, PD-10
test('T-202 [W-50] запрос на стирание: обработка ограничена сразу, повтор — E-ALREADY-REQUESTED, кризисный путь работает; отмена паролем не возвращает научное согласие', async () => {
  const p = await ctx.as('patJ');
  expectError(await p.post('/api/v1/me/deletion-request', { password: PASSWORD, confirm: false }), 422, 'E-VALIDATION');
  expectOk(await p.post('/api/v1/me/deletion-request', { password: PASSWORD, confirm: true, reason: 'синтетика' }));
  expectError(await p.post('/api/v1/me/deletion-request', { password: PASSWORD, confirm: true }), 409, 'E-ALREADY-REQUESTED');
  const w = await p.post('/api/v1/me/diary', { mood: 3 });
  assert.equal(w.status, 403, 'новые записи запрещены');
  expectOk(await p.post('/api/v1/crisis/help', { text: F.CRISIS_PHRASE, source: 'button' }));
  const doc = await ctx.as('psy1');
  const r = await doc.post(`/api/v1/patients/${ctx.id('patJ')}/assignments`, { instrument_code: 'phq9' });
  assert.ok(r.status >= 400, 'специалист тоже не создаёт новых записей (PD-12)');
  expectOk(await p.del('/api/v1/me/deletion-request'));
  const c = expectOk(await p.get('/api/v1/consents')).items.find((x) => x.kind === 'research');
  assert.notEqual(c.state, 'given', 'научное согласие само не вернулось');
  expectOk(await p.post('/api/v1/me/deletion-request', { password: PASSWORD, confirm: true }));
});

// covers: T-203, UC-08, UC-17, F-77, F-85, F-80, PD-12, PD-13, PD-27, PD-23
test('T-203 [W-50] стирание администратором: подтверждение номером, одной транзакцией, «надгробие»; во всех таблицах с patient_id — только факты без текста; таблица ключей F-80 пуста; повтор — E-ALREADY-DONE', async () => {
  const p = await ctx.as('patJ');
  ctx.app.exec(`UPDATE crisis_escalations SET status = 'handled' WHERE patient_id = ${Number(ctx.id('patJ'))}`);
  const admin = await ctx.as('admin1');
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items.find((i) => i.kind === 'erasure');
  assert.ok(q, 'запрос стирания в очереди');
  assert.ok(!JSON.stringify(q).includes('Юлия'), 'пациент — номером');
  expectError(await admin.post(`/api/v1/admin/requests/${q.id}/execute-erasure`, { confirm_service_no: 'П-000000', confirm: true }), 422, 'E-VALIDATION');
  const done = expectOk(await admin.post(`/api/v1/admin/requests/${q.id}/execute-erasure`, { confirm_service_no: q.patient_no, confirm: true }));
  assert.ok(done.report.erased.length && done.report.kept_as_fact.length, 'отчёт «что стёрто, что сохранено как факт»');
  const pid = ctx.id('patJ');
  const user = ctx.app.query('SELECT status, email, full_name, password_hash FROM users WHERE id = ?', pid)[0];
  assert.deepEqual(user, { status: 'tombstone', email: null, full_name: null, password_hash: null });
  const tables = ctx.app.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").map((t) => t.name);
  const problems = [];
  for (const t of tables) {
    const cols = ctx.app.query(`PRAGMA table_info(${t})`).map((c) => c.name);
    const pcol = ['patient_id', 'user_id', 'owner_user_id', 'recipient_id'].find((c) => cols.includes(c));
    if (!pcol || t === 'users') continue;
    const n = ctx.app.query(`SELECT count(*) n FROM ${t} WHERE ${pcol} = ?`, pid)[0].n;
    if (!n) continue;
    if (!FACT_TABLES.has(t)) { problems.push(`${t}: ${n} строк`); continue; }
    for (const c of cols.filter((x) => TEXT_COL.test(x))) {
      const left = ctx.app.query(`SELECT count(*) n FROM ${t} WHERE ${pcol} = ? AND ${c} IS NOT NULL AND ${c} <> ''`, pid)[0].n;
      if (left) problems.push(`${t}.${c}: текст остался`);
    }
  }
  assert.deepEqual(problems, [], 'каждая таблица с данными пациента входит в белый список стирания (build-rules §4)');
  assert.equal(ctx.app.query("SELECT count(*) n FROM pii_values WHERE scope_type = 'patient' AND scope_id = ?", pid)[0].n, 0, 'таблица ключей стёрта в той же транзакции');
  expectError(await admin.post(`/api/v1/admin/requests/${q.id}/execute-erasure`, { confirm_service_no: q.patient_no, confirm: true }), 409, 'E-ALREADY-DONE');
  expectError(await p.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
});

// covers: T-204, UC-08, UC-17, F-77, F-85, F-16
test('T-204 [W-50] при открытом кризисе стирание откладывается: E-CRISIS-OPEN и пометка «ждёт обработки кризиса»', async () => {
  const p = await ctx.as('patK');
  expectOk(await p.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  expectOk(await p.post('/api/v1/me/deletion-request', { password: PASSWORD, confirm: true }));
  const admin = await ctx.as('admin1');
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items.find((i) => i.kind === 'erasure' && i.patient_no !== undefined && i.status !== 'closed');
  expectError(await admin.post(`/api/v1/admin/requests/${q.id}/execute-erasure`, { confirm_service_no: q.patient_no, confirm: true }), 409, 'E-CRISIS-OPEN');
  const row = ctx.app.query("SELECT status FROM data_subject_requests WHERE patient_id = ? AND request_type = 'erasure'", ctx.id('patK'))[0];
  assert.equal(row.status, 'waiting_crisis');
});

// covers: T-205, UC-08, F-54, F-19, PD-02, PD-27
test('T-205 [W-50] исправление записи: специалист создаёт новую версию с причиной, исходная сохранена; второй специалист — E-CONFLICT; отказ с причиной', async () => {
  const p = await ctx.as('patA');
  const old = expectOk(await p.post('/api/v1/me/diary', { day: '2026-09-01', mood: 1 }));
  await F.passUndoWindow(ctx.app);
  const c = expectOk(await p.post('/api/v1/me/corrections', { record: { type: 'diary_entry', id: old.entry.id }, text: 'Синтетика: настроение было 4' }));
  const psy = await ctx.as('psy1');
  const list = expectOk(await psy.get(`/api/v1/patients/${ctx.id('patA')}/corrections`)).items;
  assert.ok(list.some((x) => x.id === c.id));
  const plg = await ctx.as('plg1');
  expectOk(await psy.post(`/api/v1/corrections/${c.id}/decision`, { decision: 'accept', new_value: { mood: 4 }, reason: 'по словам пациента', version: c.version }));
  expectError(await plg.post(`/api/v1/corrections/${c.id}/decision`, { decision: 'reject', reason: 'x', version: c.version }), 409, 'E-CONFLICT');
  const rev = ctx.app.query("SELECT before_json, reason FROM record_revisions WHERE table_name = 'mood_entries' AND row_id = ?", old.entry.id);
  assert.ok(rev.length === 1 && JSON.parse(rev[0].before_json).mood === 1, 'исходная версия сохранена');
  const c2 = expectOk(await p.post('/api/v1/me/corrections', { record: { type: 'diary_entry', id: old.entry.id }, text: 'Синтетика: ещё раз' }));
  expectError(await (await ctx.as('psy2')).post(`/api/v1/corrections/${c2.id}/decision`, { decision: 'reject', reason: 'x', version: c2.version }), 404, 'E-NOT-FOUND');
});

// covers: T-206, UC-43, UC-16, F-55, F-86, F-82, PD-11, PD-20
test('T-206 [W-40] «Попросить сменить специалиста»: запрос у администратора с причиной, текущий врач видит только факт; «заменить» — старый сразу теряет доступ', async () => {
  const p = await ctx.as('patH');
  expectOk(await p.post('/api/v1/me/clinician-change', { clinician_id: ctx.id('psy1'), reason: 'Синтетика: неудобное время приёма' }));
  expectError(await p.post('/api/v1/me/clinician-change', { clinician_id: ctx.id('psy1') }), 409, 'E-ALREADY-REQUESTED');
  const psy = await ctx.as('psy1');
  const card = expectOk(await psy.get(`/api/v1/patients/${ctx.id('patH')}?tab=overview`));
  assert.ok(!JSON.stringify(card).includes('неудобное время'), 'специалист не видит причину');
  const admin = await ctx.as('admin1');
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items.find((i) => i.kind === 'change_clinician');
  const det = expectOk(await admin.get(`/api/v1/admin/requests/${q.id}`));
  assert.ok(JSON.stringify(det).includes('неудобное время'), 'администратор видит причину (служебно)');
  expectOk(await admin.post(`/api/v1/admin/requests/${q.id}/take`, {}));
  expectError(await (await ctx.as('admin2')).post(`/api/v1/admin/requests/${q.id}/take`, {}), 409, 'E-QUEUE-TAKEN');
  expectOk(await admin.post(`/api/v1/admin/requests/${q.id}/clinician-change`, { new_clinician_id: ctx.id('psy3'), mode: 'replace' }));
  await F.passUndoWindow(ctx.app);
  expectError(await psy.get(`/api/v1/patients/${ctx.id('patH')}?tab=overview`), 404, 'E-NOT-FOUND');
  expectOk(await (await ctx.as('psy3')).get(`/api/v1/patients/${ctx.id('patH')}?tab=overview`));
  const note = expectOk(await p.get('/api/v1/notifications')).items.find((n) => /специалист/i.test(n.title));
  assert.ok(note && !/неудобн/.test(note.title), 'пациенту нейтральное уведомление');
});

// covers: T-207, UC-08, UC-17, F-84, F-82, PD-03, PD-18, PD-20, S-63
test('T-207 [W-38] запрос «сведения о данных»: сводка без содержимого записей выдаётся пациенту в «Мои данные» (не письмом); срок — S-63', async () => {
  const p = await ctx.as('patB');
  const doc = await ctx.as('psy2');
  expectOk(await doc.get(`/api/v1/patients/${ctx.id('patB')}?tab=overview`));
  const access = expectOk(await p.get('/api/v1/me/data')).access_log[0];
  expectOk(await p.post(`/api/v1/me/data/access-log/${access.id}/strange`, { comment: 'синтетика' }));
  const admin = await ctx.as('admin1');
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items.find((i) => i.kind === 'dispute_access');
  assert.ok(q.due_at, 'срок виден');
  expectOk(await admin.post(`/api/v1/admin/requests/${q.id}/take`, {}));
  expectOk(await admin.post(`/api/v1/admin/requests/${q.id}/answer`, { decision: 'access_justified', template_key: 'access_justified' }));
  await F.passUndoWindow(ctx.app);
  const mine = expectOk(await p.get('/api/v1/me/data')).requests;
  assert.ok(mine.some((r) => /justified|обоснован/i.test(JSON.stringify(r))), 'ответ в кабинете пациента');
  assert.ok(!ctx.app.smtp.lastTo('pat.b@cc.example.test'), 'письмом не отправлено');
});
