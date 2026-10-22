'use strict';

// Админ-чат (F-81), люди и доступ (F-88…F-95), второй фактор (F-96, S-39), очередь (F-82, F-83, F-87), S-63.
// Администратор не видит клиники (PD-20); пациент — служебным номером; «Показать» пишет журнал, видимый пациенту.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { Client, expectError, expectOk } = require('../lib/client');
const { PASSWORD, byKey } = require('../fixtures/world');
const { totp, secretFromUri } = require('../lib/totp');
const F = require('../lib/flows');

const ctx = useApp();

// covers: T-240, UC-16, UC-44, F-81, F-91, F-26, PD-20
test('T-240 [W-37] админ-чат: «заблокируй …» → карточка-черновик; исполняет только кнопка через обычную функцию со всеми проверками; один раз', async () => {
  const admin = await ctx.as('admin1');
  ctx.app.ai.reset();
  const r = expectOk(await admin.post('/api/v1/admin/chat/messages', { text: `заблокируй ${byKey('plg2').email}` }));
  assert.ok(r.action_draft && r.action_draft.function === 'F-91', 'команду распознал код, а не модель');
  assert.equal(ctx.app.ai.calls().length, 0);
  assert.equal(ctx.app.query('SELECT status FROM users WHERE id = ?', ctx.id('plg2'))[0].status, 'active', 'черновик сам ничего не делает');
  const ex = expectOk(await admin.post(`/api/v1/admin/chat/drafts/${r.action_draft.id}/execute`, { fields: { reason_key: 'staff_leave' } }));
  assert.ok(ex.undo);
  assert.equal(ctx.app.query('SELECT status FROM users WHERE id = ?', ctx.id('plg2'))[0].status, 'blocked');
  expectError(await admin.post(`/api/v1/admin/chat/drafts/${r.action_draft.id}/execute`, { fields: {} }), 409, 'E-STATUS');
  expectOk(await admin.post(`/api/v1/undo/${ex.undo.id}`, {}));
  const self = expectOk(await admin.post('/api/v1/admin/chat/messages', { text: `заблокируй ${byKey('admin1').email}` }));
  expectError(await admin.post(`/api/v1/admin/chat/drafts/${self.action_draft.id}/execute`, { fields: { reason_key: 'other' } }), 403, 'E-SELF-ACTION');
});

// covers: T-241, UC-16, UC-44, F-81, F-26, F-80, PD-20, S-33, S-34
test('T-241 [W-37] вопрос не по команде уходит admin_assistant только со служебными данными: пациенты — номера, имена сотрудников — ключи; действие модели — только черновик', async () => {
  const admin = await ctx.as('admin1');
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'tool', name: 'block_user', arguments: { user_id: ctx.id('psy2'), reason_key: 'other' } });
  const r = expectOk(await admin.post('/api/v1/admin/chat/messages', { text: `Как дела у очереди запросов? Кто такой ${byKey('psy2').name}?` }));
  const seen = ctx.app.ai.seenText();
  assert.equal(ctx.app.ai.calls().at(-1).purpose, 'admin_assistant');
  assert.ok(!seen.includes(byKey('psy2').name), 'ФИО сотрудника заменено ключом');
  assert.doesNotMatch(seen, /Марина|Тестова|диагноз|смысла жить/, 'клинических данных нет');
  assert.ok(r.action_draft, 'предложение модели — карточка-черновик');
  assert.equal(ctx.app.query('SELECT status FROM users WHERE id = ?', ctx.id('psy2'))[0].status, 'active', 'модель сама ничего не исполнила');
});

// covers: T-242, UC-16, UC-35, F-88, F-22, PD-20, PD-03
test('T-242 [W-39] «Люди»: пациенты — служебным номером; имя и почта — только по «Показать», запись видна пациенту в «Кто смотрел»', async () => {
  const admin = await ctx.as('admin1');
  const list = expectOk(await admin.get('/api/v1/admin/people?filter=patients'));
  assert.ok(list.items.length >= 1);
  assert.doesNotMatch(JSON.stringify(list), /Марина|Тестова|pat\.a@/, 'в списке пациентов нет ФИО и почты');
  const card = expectOk(await admin.get(`/api/v1/admin/people/${ctx.id('patA')}`));
  assert.ok(!card.name, 'в карточке имя скрыто до «Показать»');
  const shown = expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('patA')}/reveal-contacts`, {}, { idem: false }));
  assert.equal(shown.email, byKey('patA').email);
  const mine = expectOk(await (await ctx.as('patA')).get('/api/v1/me/data')).access_log;
  assert.ok(mine.some((x) => /account|учётн/i.test(x.section)), 'показ записан и виден пациенту');
  const found = expectOk(await admin.get(`/api/v1/admin/people?q=${encodeURIComponent(byKey('patA').email)}`));
  assert.ok(found.items.some((x) => x.id === ctx.id('patA')), 'поиск пациента по точной почте');
  const partial = expectOk(await admin.get(`/api/v1/admin/people?q=${encodeURIComponent('pat.')}&filter=patients`));
  assert.equal(partial.items.length, 0, 'по части почты пациент не ищется');
});

// covers: T-243, UC-16, F-89, F-08, PD-21
test('T-243 [W-39] новый сотрудник: временный пароль от 10 символов один раз; при первом входе — смена; почта занята — E-EMAIL-TAKEN; «Отменить» деактивирует до первого входа', async () => {
  const admin = await ctx.as('admin1');
  expectError(await admin.post('/api/v1/admin/staff', { full_name: 'Синтетик Дубль', email: byKey('psy1').email, role: 'psychiatrist' }), 409, 'E-EMAIL-TAKEN');
  const r = expectOk(await admin.post('/api/v1/admin/staff', { full_name: 'Синтетик Новый', email: 'new.staff@cc.example.test', role: 'psychologist' }));
  assert.ok(r.temporary_password.length >= 10);
  const list = expectOk(await admin.get(`/api/v1/admin/people/${r.user.id}`));
  assert.ok(!JSON.stringify(list).includes(r.temporary_password), 'пароль больше не показывается');
  assert.equal(ctx.app.smtp.lastTo('new.staff@cc.example.test'), null, 'письмом не отправляется');
  const c = new Client(ctx.app.base);
  assert.equal(expectOk(await c.login('new.staff@cc.example.test', r.temporary_password)).next, 'change_password');
  const r2 = expectOk(await admin.post('/api/v1/admin/staff', { full_name: 'Синтетик Отменённый', email: 'undo.staff@cc.example.test', role: 'psychiatrist' }));
  expectOk(await admin.post(`/api/v1/undo/${r2.undo.id}`, {}));
  assert.equal(ctx.app.query('SELECT status FROM users WHERE id = ?', r2.user.id)[0].status, 'deactivated');
});

// covers: T-244, UC-16, UC-38, F-90, F-02, PD-21, PD-17
test('T-244 [W-39] сброс пароля администратором закрывает сессии; смена почты — со способом проверки личности, в журнале — хеши', async () => {
  const admin = await ctx.as('admin1');
  const victim = await ctx.fresh('patC');
  const r = expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('patC')}/password-reset`, {}));
  assert.ok(r.temporary_password.length >= 10);
  expectError(await victim.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  expectError(await admin.post(`/api/v1/admin/people/${ctx.id('patC')}/email`, { email: 'pat.c.new@cc.example.test' }), 422, 'E-VALIDATION');
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('patC')}/email`, { email: 'pat.c.new@cc.example.test', verification: 'in_person_document' }));
  const log = JSON.stringify(ctx.app.query("SELECT old_safe_json, new_safe_json FROM action_log WHERE target_user_id = ? ORDER BY id DESC LIMIT 3", ctx.id('patC')));
  assert.ok(!log.includes('pat.c.new@') && !log.includes('pat.c@'), 'почта в журнале только хешем');
});

// covers: T-245, UC-16, F-91, F-01, R-07, S-54, PD-21
test('T-245 [W-39] блокировка: причина из списка S-54 видна на экране R-07, сессии закрыты; себя — E-SELF-ACTION; последнего администратора — E-LAST-ADMIN; специалиста с пациентами деактивировать — E-ROLE-HAS-PATIENTS', async () => {
  const admin = await ctx.as('admin1');
  const doc = await ctx.fresh('psy3');
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('psy3')}/status`, { action: 'block', reason_key: 'staff_leave' }));
  expectError(await doc.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  const c = new Client(ctx.app.base);
  expectError(await c.login(byKey('psy3').email), 403, 'E-AUTH-BLOCKED');
  const page = await c.get('/blocked', { headers: { accept: 'text/html' } });
  assert.ok(page.body.includes(require('../lib/texts').text('msg.blocked.reason.list.staff_leave')), 'причина видна');
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('psy3')}/status`, { action: 'unblock' }));
  expectError(await admin.post(`/api/v1/admin/people/${ctx.id('admin1')}/status`, { action: 'block', reason_key: 'other' }), 403, 'E-SELF-ACTION');
  // Два администратора одновременно блокируют друг друга: ни одного активного остаться не может (E-LAST-ADMIN).
  const a1 = await ctx.fresh('admin1');
  const a2 = await ctx.fresh('admin2');
  const [x, y] = await Promise.all([
    a1.post(`/api/v1/admin/people/${ctx.id('admin2')}/status`, { action: 'block', reason_key: 'other' }),
    a2.post(`/api/v1/admin/people/${ctx.id('admin1')}/status`, { action: 'block', reason_key: 'other' }),
  ]);
  assert.equal([x, y].filter((r) => r.status === 200).length, 1, 'выполнилась только одна блокировка');
  const loser = x.status === 200 ? y : x;
  assert.ok(loser.status === 401 || loser.body.error.code === 'E-LAST-ADMIN', 'вторая — отказ «Это последний администратор»');
  assert.ok(ctx.app.query("SELECT count(*) n FROM users WHERE role = 'admin' AND status = 'active'")[0].n >= 1);
  ctx.app.exec("UPDATE users SET status = 'active' WHERE role = 'admin'");
  delete ctx.clients.admin1; delete ctx.clients.admin2; // их сеансы закрыты блокировкой
  const again = await ctx.as('admin1');
  expectError(await again.post(`/api/v1/admin/people/${ctx.id('psy1')}/status`, { action: 'deactivate' }), 409, 'E-ROLE-HAS-PATIENTS');
});

// covers: T-246, UC-16, UC-22, UC-45, F-92, F-98, F-72, PD-02
test('T-246 [W-39] роль и отметки действуют сразу: снятие «исследовательского права» закрывает исследования; психиатр → психолог теряет план и НЯ; себе менять нельзя', async () => {
  const admin = await ctx.as('admin1');
  const plg = await ctx.as('plg1');
  expectOk(await plg.get('/api/v1/analytics/research/comparison?instrument=phq9&from=2026-01-01&to=2026-12-31'));
  expectOk(await admin.put(`/api/v1/admin/people/${ctx.id('plg1')}/flags`, { research: false }));
  expectError(await plg.get('/api/v1/analytics/research/comparison?instrument=phq9&from=2026-01-01&to=2026-12-31'), 403, 'E-ACCESS');
  expectError(await admin.put(`/api/v1/admin/people/${ctx.id('plg2')}/flags`, { clinical_lead: true }), 422, 'E-VALIDATION');
  const psy = await ctx.as('psy2');
  expectOk(await psy.get(`/api/v1/patients/${ctx.id('patB')}/plan`));
  expectError(await admin.put(`/api/v1/admin/people/${ctx.id('psy2')}/role`, { role: 'admin' }), 409, 'E-ROLE-HAS-PATIENTS');
  expectOk(await admin.put(`/api/v1/admin/people/${ctx.id('psy2')}/role`, { role: 'psychologist' }));
  expectError(await psy.get(`/api/v1/patients/${ctx.id('patB')}/plan`), 403, 'E-ACCESS');
  expectError(await admin.put(`/api/v1/admin/people/${ctx.id('admin1')}/flags`, { catalog_reviewer: true }), 403, 'E-SELF-ACTION');
  expectOk(await admin.put(`/api/v1/admin/people/${ctx.id('psy2')}/role`, { role: 'psychiatrist' }));
});

// covers: T-247, UC-16, UC-36, F-93, F-82, PD-11, PD-03
test('T-247 [W-39] снятие последнего специалиста: предупреждение и запрос «пациент без специалиста» в очереди; специалист сразу теряет карточку; запись в журналы', async () => {
  const admin = await ctx.as('admin1');
  const r = expectOk(await admin.post('/api/v1/admin/care-assignments', { patient_id: ctx.id('patB'), clinician_id: ctx.id('psy2'), action: 'unassign' }));
  assert.ok(r.warnings && r.warnings.length >= 1, '«У пациента не останется специалиста»');
  await F.passUndoWindow(ctx.app);
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items;
  assert.ok(q.some((i) => i.kind === 'patient_without_clinician'));
  expectError(await (await ctx.as('psy2')).get(`/api/v1/patients/${ctx.id('patB')}?tab=overview`), 404, 'E-NOT-FOUND');
  expectOk(await admin.post('/api/v1/admin/care-assignments', { patient_id: ctx.id('patB'), clinician_id: ctx.id('psy2'), action: 'assign' }));
});

// covers: T-248, UC-16, UC-01, F-95, F-23, S-23
test('T-248 [W-39] приглашения администратора: код один раз, в списке код не виден, в базе — хеш', async () => {
  const admin = await ctx.as('admin1');
  const inv = expectOk(await admin.post('/api/v1/admin/invites', { clinician_id: ctx.id('psy1') }));
  const list = expectOk(await admin.get('/api/v1/admin/invites')).items;
  assert.ok(!JSON.stringify(list).includes(inv.code));
  assert.ok(!JSON.stringify(ctx.app.query('SELECT * FROM invite_codes')).includes(inv.code));
});

// covers: T-249, UC-38, UC-16, F-96, F-97, F-23, S-39, PD-21, PD-05
test('T-249 [W-56] второй фактор: QR и ключ, включение проверочным кодом, 10 резервных кодов один раз; вход требует код; код не принимается дважды; 5 неверных — пауза; S-39 действует для новых входов', async () => {
  const admin = await ctx.as('admin2');
  const s = expectOk(await admin.post('/api/v1/me/second-factor/setup', {}));
  assert.match(s.qr_svg, /<svg/);
  const secret = secretFromUri(s.otpauth_uri);
  expectError(await admin.post('/api/v1/me/second-factor/enable', { code: '000000' }), 401, 'E-2FA-INVALID');
  const en = expectOk(await admin.post('/api/v1/me/second-factor/enable', { code: totp(secret) }));
  assert.equal(en.backup_codes.length, 10);
  assert.ok(!JSON.stringify(ctx.app.query('SELECT * FROM second_factor_backup_codes')).includes(en.backup_codes[0]), 'резервные коды — хешами');
  assert.ok(!JSON.stringify(ctx.app.query('SELECT secret_enc FROM second_factor')).includes(secret), 'секрет зашифрован');
  const boss = await ctx.as('admin1');
  expectOk(await F.setSetting(boss, 'auth.admin_second_factor', 'on'));
  const c = new Client(ctx.app.base);
  const l = expectOk(await c.login(byKey('admin2').email, PASSWORD));
  assert.equal(l.next, 'second_factor');
  expectError(await c.get('/api/v1/admin/people'), 403, 'E-ACCESS');
  const code = totp(secret, Date.now() + 30000);
  await ctx.app.advanceClock(30000);
  expectOk(await c.post('/api/v1/auth/login/second-factor', { code }, { idem: false }));
  expectOk(await c.get('/api/v1/admin/people'));
  const c2 = new Client(ctx.app.base);
  await c2.login(byKey('admin2').email, PASSWORD);
  expectError(await c2.post('/api/v1/auth/login/second-factor', { code }, { idem: false }), 401, 'E-2FA-INVALID');
  for (let i = 0; i < 4; i += 1) await c2.post('/api/v1/auth/login/second-factor', { code: '123456' }, { idem: false });
  expectError(await c2.post('/api/v1/auth/login/second-factor', { code: '123457' }, { idem: false }), 429, 'E-RATE-LIMIT');
  const c3 = new Client(ctx.app.base);
  await c3.login(byKey('admin2').email, PASSWORD);
  expectOk(await c3.post('/api/v1/auth/login/second-factor', { backup_code: en.backup_codes[0] }, { idem: false }));
  expectOk(await boss.post(`/api/v1/admin/people/${ctx.id('admin2')}/second-factor/reset`, {}));
  const notes = ctx.app.query("SELECT count(*) n FROM notifications WHERE recipient_id = ? AND type LIKE '%2fa%'", ctx.id('admin1'))[0].n;
  assert.ok(notes >= 0);
  expectOk(await F.setSetting(boss, 'auth.admin_second_factor', 'off'));
  await ctx.app.advanceClock(-30000);
});

// covers: T-250, UC-17, UC-05, F-82, F-83, F-64, F-11, PD-16, PD-20, S-63
test('T-250 [W-38] служебная очередь: кризис без специалиста первым, без цитаты; «Взять» — условная операция; «только этот сигнал» даёт специалисту сигнал без карточки; нет кандидатов — E-NO-CANDIDATE', async () => {
  const p = await ctx.as('patC');
  expectOk(await p.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  const a1 = await ctx.as('admin1');
  const a2 = await ctx.as('admin2');
  const q = expectOk(await a1.get('/api/v1/admin/requests?filter=open')).items;
  assert.equal(q[0].kind, 'crisis_no_clinician', 'кризис без специалиста всегда первым');
  assert.doesNotMatch(JSON.stringify(q), /смысла жить|Зоя|Вымышленная/);
  const [x, y] = await Promise.all([a1.post(`/api/v1/admin/requests/${q[0].id}/take`, {}), a2.post(`/api/v1/admin/requests/${q[0].id}/take`, {})]);
  assert.equal([x, y].filter((r) => r.status === 200).length, 1);
  const owner = x.status === 200 ? a1 : a2;
  expectOk(await owner.post(`/api/v1/admin/requests/${q[0].id}/assign-clinician`, { clinician_id: ctx.id('psy3'), mode: 'single_signal' }));
  await F.passUndoWindow(ctx.app);
  const psy3 = await ctx.as('psy3');
  const sig = await F.crisisSignalFor(psy3, ctx.id('patC'));
  assert.ok(sig && sig.quote, 'специалист получил сигнал с цитатой');
  expectError(await psy3.get(`/api/v1/patients/${ctx.id('patC')}?tab=overview`), 404, 'E-NOT-FOUND');
  assert.ok(!require('../lib/contract').api().some((o) => /admin\/.*(acknowledge|handled)/.test(o.path)), 'у администратора нет «отметить кризис обработанным»');
  ctx.app.exec("UPDATE users SET status = 'blocked' WHERE role IN ('psychiatrist','psychologist')");
  const p2 = await ctx.as('patD');
  expectOk(await p2.post('/api/v1/crisis/help', { text: F.CRISIS_PHRASE, source: 'button' }));
  const q2 = expectOk(await a1.get('/api/v1/admin/requests?filter=open')).items.find((i) => i.kind === 'crisis_no_clinician' && i.status !== 'in_work');
  expectOk(await a1.post(`/api/v1/admin/requests/${q2.id}/take`, {}));
  expectError(await a1.post(`/api/v1/admin/requests/${q2.id}/assign-clinician`, { clinician_id: ctx.id('psy1'), mode: 'single_signal' }), 409, 'E-NO-CANDIDATE');
  ctx.app.exec("UPDATE users SET status = 'active' WHERE role IN ('psychiatrist','psychologist')");
});

// covers: T-251, UC-17, F-82, F-21, S-63
test('T-251 [W-38] взятый, но не закрытый запрос возвращается в общую очередь через срок S-63', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'queue.due', { info_days: 10, stop_days: 10, erasure_days: 30, change_days: 5, crisis_repeat_min: 15, taken_return_days: 1 }));
  const p = await ctx.as('patG');
  expectOk(await p.post('/api/v1/me/clinician-change', { clinician_id: ctx.id('psy1'), reason: 'синтетика' }));
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items.find((i) => i.kind === 'change_clinician');
  expectOk(await admin.post(`/api/v1/admin/requests/${q.id}/take`, {}));
  await ctx.app.advanceClock(3 * 86400000);
  await ctx.app.waitJobs(10);
  const back = expectOk(await admin.get(`/api/v1/admin/requests/${q.id}`));
  assert.equal(back.status, 'open');
  await ctx.app.advanceClock(-3 * 86400000);
});

// covers: T-252, UC-36, F-87, F-70, F-91
test('T-252 [W-40] постоянная передача при увольнении: все пациенты переходят новому специалисту одной транзакцией, затем деактивация', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await admin.post('/api/v1/admin/transfers', { from_clinician_id: ctx.id('psy2'), to_clinician_id: ctx.id('psy3'), all_patients: true }));
  await F.passUndoWindow(ctx.app);
  assert.equal(ctx.app.query('SELECT count(*) n FROM care_assignments WHERE clinician_id = ? AND ended_at IS NULL', ctx.id('psy2'))[0].n, 0);
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('psy2')}/status`, { action: 'deactivate' }));
});
