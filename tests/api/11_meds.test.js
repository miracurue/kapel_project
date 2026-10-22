'use strict';

// Лекарства: план только по МНН (F-61), «Принять» с обязательным дженериком (F-42), «на проверке» (F-122),
// отметки приёма (F-40), «Где купить» (F-43, PD-25, S-52), поддержка курса (F-44, S-21), свои препараты (F-120).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();
const today = () => new Date().toISOString().slice(0, 10);

// covers: T-160, UC-12, UC-26, F-61, F-76, F-17, F-19, PD-02
test('T-160 [W-18] план по МНН: черновик пациенту не виден; «Отправить пациенту» → версия N видна после окна; у врача нет поля торгового наименования; история версий', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const inn = await F.innId(doc, 'сертралин');
  const cur = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}/plan`));
  const base = (cur.draft && cur.draft.version) || (cur.published && cur.published.version) || 1;
  const d = expectOk(await doc.put(`/api/v1/patients/${ctx.id('patA')}/plan/draft`, { version: base, items: [{ inn_id: inn, dose: 50, unit: 'мг', times: ['утро'], trade_name: 'Золофт' }] }));
  assert.ok(!JSON.stringify(d).includes('Золофт'), 'торговое наименование врачом не сохраняется (L-23)');
  assert.equal(expectOk(await p.get('/api/v1/me/meds')).plan_items.filter((i) => i.inn_id === inn).length, 0, 'черновик пациент не видит');
  const pub = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/plan/publish`, { version: d.version || base }));
  assert.ok(pub.undo && pub.published_version >= 1);
  assert.equal(expectOk(await p.get('/api/v1/me/meds')).plan_items.filter((i) => i.inn_id === inn).length, 0, 'в окне «Отменить» пациент ещё не видит');
  await F.passUndoWindow(ctx.app);
  const seen = expectOk(await p.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  assert.ok(seen && !seen.acceptance, 'опубликовано, но ещё не принято');
  const plan = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}/plan`));
  assert.ok(plan.versions.length >= 1, 'история версий');
  const notes = expectOk(await p.get('/api/v1/notifications')).items;
  assert.ok(notes.some((n) => /план|назначен/i.test(n.title)), 'пациенту уведомление о плане');
});

// covers: T-161, UC-12, F-61
test('T-161 [W-18] два врача правят план одновременно — второй получает 409 E-CONFLICT; психолог плана не видит', async () => {
  const a = await ctx.as('psy1');
  const inn = await F.innId(a, 'эсциталопрам');
  const cur = expectOk(await a.get(`/api/v1/patients/${ctx.id('patA')}/plan`));
  const base = (cur.draft && cur.draft.version) || (cur.published && cur.published.version) || 1;
  expectOk(await a.put(`/api/v1/patients/${ctx.id('patA')}/plan/draft`, { version: base, items: [{ inn_id: inn, dose: 10, unit: 'мг', times: ['утро'] }] }));
  const second = await (await ctx.fresh('psy1')).put(`/api/v1/patients/${ctx.id('patA')}/plan/draft`, { version: base, items: [{ inn_id: inn, dose: 20, unit: 'мг', times: ['утро'] }] });
  expectError(second, 409, 'E-CONFLICT');
  expectError(await (await ctx.as('plg1')).get(`/api/v1/patients/${ctx.id('patA')}/plan`), 403, 'E-ACCESS');
});

// covers: T-162, UC-26, F-42, F-121, F-40, F-41, F-17
test('T-162 [W-19] «Принять» без купленного препарата — E-GENERIC-REQUIRED; с дженериком этого МНН — «Принято · Отменить», начинаются отметки и напоминания', async () => {
  const doc = await ctx.as('psy2');
  const p = await ctx.as('patB');
  const inn = await F.innId(doc, 'сертралин');
  await F.publishPlan(ctx.app, doc, ctx.id('patB'), [{ inn_id: inn, dose: 50, unit: 'мг', times: ['утро'] }]);
  const item = expectOk(await p.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  expectError(await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/accept`, {}), 422, 'E-GENERIC-REQUIRED');
  expectError(await p.post('/api/v1/me/med-marks', { target: { type: 'plan_item', id: 0 }, day: today(), status: 'taken' }), 404, 'E-NOT-FOUND');
  const prod = await F.productOf(p, inn, 'Асентра');
  const acc = expectOk(await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/accept`, { product_id: prod.id }));
  assert.ok(acc.undo);
  assert.equal(acc.item.acceptance.product.id, prod.id);
  assert.ok(expectOk(await p.get('/api/v1/me/reminders')).items.length >= 1, 'напоминания из схемы');
  const card = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patB')}?tab=treatment`));
  assert.ok(JSON.stringify(card).includes('Асентра'), 'врач видит купленный препарат');
});

// covers: T-163, UC-26, F-42, F-121, L-23
test('T-163 [W-19] выбран препарат другого МНН — «Действующее вещество не совпадает» и «Отправить врачу» вместо «Принять»; сервис замену не советует', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patH');
  const inn = await F.innId(doc, 'флуоксетин');
  await F.publishPlan(ctx.app, doc, ctx.id('patH'), [{ inn_id: inn, dose: 20, unit: 'мг', times: ['утро'] }]);
  const item = expectOk(await p.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  const other = await F.productOf(p, await F.innId(doc, 'сертралин'), 'Золофт');
  const r = await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/accept`, { product_id: other.id });
  assert.ok(r.status === 422 || r.status === 409 || (r.body.item && r.body.item.acceptance && r.body.item.acceptance.inn_mismatch));
  assert.doesNotMatch(JSON.stringify(r.body), /замените|рекомендуем|лучше принимать/i);
  const mark = ctx.app.query('SELECT inn_mismatch FROM purchase_marks WHERE patient_id = ? ORDER BY id DESC LIMIT 1', ctx.id('patH'))[0];
  assert.ok(!mark || mark.inn_mismatch === 1, 'отметка с несовпадением МНН помечена, а не принята как обычная');
});

// covers: T-164, UC-26, UC-46, F-122, F-121, F-123, PD-20
test('T-164 [W-14] «Не нашли? Добавить как есть»: запись «на проверке» сохраняется сразу, видна в подсказках только автору; не больше 5 в сутки; повтор того же названия — та же запись', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const inn = await F.innId(doc, 'пароксетин');
  await F.publishPlan(ctx.app, doc, ctx.id('patA'), [{ inn_id: inn, dose: 20, unit: 'мг', times: ['утро'] }]);
  const item = expectOk(await p.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  const acc = expectOk(await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/accept`, { pending_name: 'Синтепарокс Т13' }));
  assert.equal(acc.item.acceptance.product.status, 'pending', 'принятие не ждёт проверки');
  const own = expectOk(await p.get(`/api/v1/catalog/search?q=${encodeURIComponent('Синтепарокс')}&scope=products`)).items;
  assert.ok(own.some((x) => x.status === 'pending'), 'автор видит свою запись');
  const other = expectOk(await (await ctx.as('patB')).get(`/api/v1/catalog/search?q=${encodeURIComponent('Синтепарокс')}&scope=products`)).items;
  assert.ok(!other.some((x) => x.status === 'pending'), 'другой пользователь — нет');
  const again = expectOk(await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/purchase`, { pending_name: 'синтепарокс т13' }));
  assert.equal(again.item.acceptance.product.id, acc.item.acceptance.product.id, 'одинаковое по нормализованному виду — та же запись');
  for (let i = 0; i < 4; i += 1) expectOk(await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/purchase`, { pending_name: `Синтетизан ${i}` }));
  expectError(await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/purchase`, { pending_name: 'Синтетизан 6' }), 429, 'E-DRUG-PENDING-LIMIT');
  const review = expectOk(await (await ctx.as('psy3')).get('/api/v1/admin/drug-review'));
  assert.doesNotMatch(JSON.stringify(review), /Марина|Тестова|pat\.a@|patient_id/, 'в очереди проверки нет данных пациентов');
});

// covers: T-165, UC-26, F-42, F-17
test('T-165 [W-19] «Купил(а) другой»: новая отметка, прежняя остаётся в истории', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const { inn, item, product } = await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, ctx.id('patA'));
  const other = await F.productOf(p, inn, 'Стимулотон');
  expectOk(await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/purchase`, { product_id: other.id }));
  const marks = ctx.app.query('SELECT product_id, status FROM purchase_marks WHERE patient_id = ? AND item_key = ? ORDER BY id', ctx.id('patA'), item.item_key);
  assert.ok(marks.some((m) => m.product_id === product.id && m.status === 'previous'));
  assert.ok(marks.some((m) => m.product_id === other.id && m.status === 'current'));
});

// covers: T-166, UC-04, UC-26, F-40, F-17
test('T-166 [W-19] отметка приёма: одна на пункт, день и время; повтор меняет статус; «Отменить»; отменённый врачом пункт — 404', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const { item } = await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, ctx.id('patA'));
  // ChipRef.id — целое: ID пункта действующей версии плана (открытый вопрос 7: в PlanItem API нет id, только item_key)
  const row = ctx.app.query("SELECT pi.id FROM plan_items pi JOIN plan_versions pv ON pv.id = pi.plan_version_id WHERE pi.item_key = ? AND pv.status = 'published' ORDER BY pv.version DESC LIMIT 1", item.item_key)[0];
  const target = { type: 'plan_item', id: row.id };
  const m1 = expectOk(await p.post('/api/v1/me/med-marks', { target, day: today(), status: 'taken' }));
  expectOk(await p.post('/api/v1/me/med-marks', { target, day: today(), status: 'skipped' }));
  const rows = ctx.app.query('SELECT status FROM med_log WHERE patient_id = ? AND item_key = ? AND day = ? AND hidden_at IS NULL', ctx.id('patA'), item.item_key, today());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped');
  void m1;
  await F.publishPlan(ctx.app, doc, ctx.id('patA'), []);
  expectError(await p.post('/api/v1/me/med-marks', { target, day: today(), status: 'taken' }), 404, 'E-NOT-FOUND');
});

// covers: T-167, UC-27, F-43, PD-25, S-52, L-21
test('T-167 [W-19] «Где купить»: не меньше 2 аптек, ссылка без ID пациента и назначения, только МНН; Referrer-Policy: no-referrer; порядок не рекламный', async () => {
  const doc = await ctx.as('psy2');
  const p = await ctx.as('patB');
  const inn = await F.innId(doc, 'кветиапин');
  await F.publishPlan(ctx.app, doc, ctx.id('patB'), [{ inn_id: inn, dose: 25, unit: 'мг', times: ['на ночь'] }]);
  const item = expectOk(await p.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  const r = await p.get(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/where-to-buy`);
  const body = expectOk(r);
  assert.ok(body.links.length >= 2);
  for (const l of body.links) {
    assert.match(l.url, /^https:\/\//);
    assert.ok(!l.url.includes(String(ctx.id('patB'))) && !/patient|diag|plan|item/i.test(l.url), 'ссылка без данных пациента');
    assert.ok(decodeURIComponent(l.url).toLowerCase().includes('кветиапин'), 'ищется по МНН');
  }
  const page = await p.get('/app?tab=meds', { headers: { accept: 'text/html' } });
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const admin = await ctx.as('admin1');
  expectError(await F.setSetting(admin, 'reference.pharmacies', { order: 'alpha', items: [{ title: 'Одна', template: 'https://a.example.test/?q={inn}', active: true }] }), 422, 'E-SETTING-INVALID');
  expectError(await F.setSetting(admin, 'reference.pharmacies', { order: 'alpha', items: [{ title: 'A', template: 'http://a.example.test/?q={inn}', active: true }, { title: 'B', template: 'https://b.example.test/?q={inn}&p={patient}', active: true }] }), 422, 'E-SETTING-INVALID');
  expectOk(await F.setSetting(admin, 'reference.pharmacies', { order: 'alpha', items: [{ title: 'Бета-аптека', template: 'https://b.example.test/?q={inn}', active: true }, { title: 'Альфа-аптека', template: 'https://a.example.test/?q={inn}', active: true }] }));
  const sorted = expectOk(await p.get(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/where-to-buy`)).links.map((l) => l.title);
  assert.deepEqual(sorted, ['Альфа-аптека', 'Бета-аптека'], 'порядок alpha из S-52 действует сразу');
});

// covers: T-168, UC-29, F-44, F-21, S-21
test('T-168 [W-19] поддержка по ходу курса: на нужной неделе одно сообщение один раз; выключатель; правило S-21', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'course_support.rules', [{ week: 2, text: 'Синтетика: эффект может наступить не сразу (STAND-IN)' }]));
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patH');
  await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, ctx.id('patH'));
  await ctx.app.advanceClock(8 * 86400000);
  await ctx.app.waitJobs(10);
  const resumed = await ctx.fresh('patH');
  const shown = expectOk(await resumed.get('/api/v1/me/meds')).course_support;
  assert.equal(shown.length, 1);
  await ctx.app.waitJobs(10);
  assert.equal(ctx.app.query('SELECT count(*) n FROM course_support_shown WHERE patient_id = ?', ctx.id('patH'))[0].n, 1, 'одно и то же один раз');
  expectOk(await resumed.patch('/api/v1/me/prefs', { course_support_enabled: false }));
  await ctx.app.advanceClock(-8 * 86400000);
});

// covers: T-169, UC-46, F-120, F-121, F-17, F-19, PD-02
test('T-169 [W-20] «+ Добавить препарат»: дженерик обязателен; «Добавлено · Отменить»; врач видит «внесено пациентом», «Подтвердить» и комментарий; психолог не видит', async () => {
  const p = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  expectError(await p.post('/api/v1/me/patient-meds', { dose: 25, unit: 'мг', times: ['на ночь'] }), 422, 'E-GENERIC-REQUIRED');
  const atarax = await F.productOf(p, await F.innId(p, 'гидроксизин'), 'Атаракс');
  const r = expectOk(await p.post('/api/v1/me/patient-meds', { product_id: atarax.id, dose: 25, unit: 'мг', times: ['на ночь'], ongoing: true }));
  assert.equal(r.med.inn.name.toLowerCase(), 'гидроксизин', 'МНН подставился по препарату');
  assert.ok(r.undo);
  await F.passUndoWindow(ctx.app);
  const tr = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=treatment`));
  assert.ok(JSON.stringify(tr).includes('Атаракс'));
  expectError(await doc.post(`/api/v1/patient-meds/${r.med.id}/confirm`, { version: r.med.version + 5 }), 409, 'E-CONFLICT');
  expectOk(await doc.post(`/api/v1/patient-meds/${r.med.id}/confirm`, { version: r.med.version }));
  expectOk(await doc.post(`/api/v1/patient-meds/${r.med.id}/comments`, { text: 'Синтетика: обсудим на приёме' }));
  const mine = expectOk(await p.get('/api/v1/me/meds')).patient_meds.find((x) => x.id === r.med.id);
  assert.equal(mine.review, 'seen', 'у пациента «врач видел»');
  const plg = expectOk(await (await ctx.as('plg1')).get(`/api/v1/patients/${ctx.id('patA')}?tab=overview`));
  assert.ok(!JSON.stringify(plg).includes('Атаракс'), 'психолог лекарства не видит');
});

// covers: T-170, UC-46, F-120, F-69
test('T-170 [W-20] свой препарат того же МНН, что назначен, — E-DRUG-DUPLICATE; в архиве — E-ARCHIVED; правка — новая версия', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const { inn } = await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, ctx.id('patA'));
  const prod = await F.productOf(p, inn, 'Серлифт');
  expectError(await p.post('/api/v1/me/patient-meds', { product_id: prod.id, dose: 50, unit: 'мг', times: ['утро'] }), 409, 'E-DRUG-DUPLICATE');
  const arch = await ctx.as('patD');
  expectError(await arch.post('/api/v1/me/patient-meds', { product_id: prod.id, dose: 50, unit: 'мг', times: ['утро'] }), 409, 'E-ARCHIVED');
  const mel = await F.productOf(p, await F.innId(p, 'мелатонин'), 'Мелаксен');
  const m = expectOk(await p.post('/api/v1/me/patient-meds', { product_id: mel.id, dose: 3, unit: 'мг', times: ['на ночь'] }));
  const v2 = expectOk(await p.put(`/api/v1/me/patient-meds/${m.med.id}`, { version: m.med.version, dose: 6, unit: 'мг', times: ['на ночь'] }));
  assert.equal(v2.version, m.med.version + 1);
  assert.equal(v2.review, 'not_seen', 'новая версия — снова «не просмотрен врачом»');
});

// covers: T-171, UC-26, F-42, F-61
test('T-171 [W-19] новая версия плана помечает прежнее принятие «проверьте»', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const { inn } = await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, ctx.id('patA'));
  await F.publishPlan(ctx.app, doc, ctx.id('patA'), [{ inn_id: inn, dose: 100, unit: 'мг', times: ['утро'] }]);
  const item = expectOk(await p.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  const acc = ctx.app.query('SELECT review_needed FROM plan_item_acceptance WHERE patient_id = ? AND item_key = ?', ctx.id('patA'), item.item_key)[0];
  assert.equal(acc.review_needed, 1, 'отметка «проверьте» после новой версии плана');
});
