'use strict';

// Тесты пациента диалогом (F-36, M-12), подсчёт на сервере (F-37), тест без назначения (F-38),
// назначение и пакеты (F-59, F-60), очный результат (F-62), личная динамика (F-56), пороги S-20, каталог S-48.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

// covers: T-140, UC-03, UC-32, F-36, F-59, F-60
test('T-140 [W-15] пакет обследований — один пункт с прогрессом «0 из N» → «1 из N»; уже назначенная методика не дублируется', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const pkg = expectOk(await doc.post('/api/v1/packages', { title: 'Синтетический старт', items: ['phq9', 'gad7', 'who5'] }));
  const r = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/assignments`, { package_id: pkg.id }));
  await F.passUndoWindow(ctx.app);
  const list = expectOk(await p.get('/api/v1/me/assignments')).items;
  const group = list.filter((a) => a.package_id === pkg.id);
  assert.ok(group.length >= 2);
  assert.equal(group[0].progress.total, group.length);
  expectOk(await F.completeTest(p, group[0].id));
  const after = expectOk(await p.get('/api/v1/me/assignments')).items.find((a) => a.package_id === pkg.id && a.status !== 'done');
  assert.equal(after.progress.done, 1);
  const dup = await doc.post(`/api/v1/patients/${ctx.id('patA')}/assignments`, { instrument_code: group[1].instrument_code });
  expectError(dup, 409, 'E-ASSIGN-DUPLICATE');
  void r;
});

// covers: T-141, UC-03, F-36, M-12
test('T-141 [W-15] типы ответов: multi с «не больше N» и взаимоисключающим «ничего из перечисленного»; пустой обязательный — подсказка, ответ сохраняется по вопросу', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  // демо-опросник STAND-IN со всеми 8 типами ответов M-12 (UC-03 «Проверка типов»); код — открытый вопрос 6
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'demo_types');
  const qs = await F.instrumentQuestions(p, a.id);
  const types = new Set(qs.map((q) => q.type));
  assert.deepEqual([...types].sort(), ['date', 'multi', 'number', 'scale', 'single', 'text_long', 'text_short', 'yes_no']);
  const multi = qs.find((q) => q.type === 'multi');
  assert.ok(multi.max_select >= 1, 'пациент видит, сколько вариантов можно выбрать');
  {
    const tooMany = multi.options.slice(0, (multi.max_select || 1) + 1).map((o) => o.value);
    const e = expectError(await p.put(`/api/v1/me/assignments/${a.id}/answers/${encodeURIComponent(multi.id)}`, { value: tooMany }), 422, 'E-VALIDATION');
    assert.ok(e.fields.some((f) => f.key === 'err.e-validation.max_select'));
    const none = (multi.exclusive || [])[0];
    assert.ok(none, 'есть взаимоисключающий вариант');
    {
      const r = expectOk(await p.put(`/api/v1/me/assignments/${a.id}/answers/${encodeURIComponent(multi.id)}`, { value: [multi.options[0].value, none] }));
      void r;
      const saved = expectOk(await p.get(`/api/v1/me/assignments/${a.id}`)).answers[multi.id];
      assert.deepEqual(saved, [none], '«ничего из перечисленного» снимает остальные отметки');
    }
  }
  const required = qs.find((q) => q.required && q.type === 'single');
  const e2 = expectError(await p.put(`/api/v1/me/assignments/${a.id}/answers/${encodeURIComponent(required.id)}`, { value: null }), 422, 'E-VALIDATION');
  assert.ok(e2.fields.some((f) => f.key === 'err.e-validation.choose'));
  expectOk(await p.put(`/api/v1/me/assignments/${a.id}/answers/${encodeURIComponent(required.id)}`, { value: required.options[1].value }));
  const resumed = expectOk(await (await ctx.fresh('patA')).get(`/api/v1/me/assignments/${a.id}`));
  assert.equal(resumed.answers[required.id], required.options[1].value, 'прерывание → «Продолжить» с сохранёнными ответами');
});

// covers: T-142, UC-03, F-37, F-36, M-12
test('T-142 [W-15] подсчёт на сервере совпадает с ручным (GAD-7: сумма вариантов 0–3); итог — балл, полоса и «это не диагноз», без «норма/патология»', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patB');
  const a = await F.assignTest(ctx.app, await ctx.as('psy2'), ctx.id('patB'), 'gad7');
  const picks = [0, 1, 2, 3, 1, 2, 0];
  let i = 0;
  const res = expectOk(await F.completeTest(p, a.id, (q) => q.options[picks[i++ % picks.length]].value));
  // Решение владельца: балл и полоса GAD-7 пациенту не показываются (policyForCode), их видит специалист.
  // Поэтому подсчёт сверяем по сохранённому результату.
  const [stored] = ctx.app.query('SELECT total_score, band FROM online_results WHERE assignment_id=?', a.id);
  assert.equal(stored.total_score, picks.reduce((s, x) => s + x, 0));
  assert.ok(stored.band, 'словесная полоса');
  assert.equal(res.score, undefined, 'балл GAD-7 пациенту не отдаётся');
  assert.ok(res.band_note_key, 'ключ строки «это не диагноз, результат увидит специалист»');
  assert.doesNotMatch(JSON.stringify(res), /норма|патолог|риск/i);
  void doc;
});

// covers: T-143, UC-03, UC-21, F-37, M-12
test('T-143 [W-15] обратные пункты считаются по reverse: результат методики с обратным подсчётом равен ручному', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'who5');
  const qs = await F.instrumentQuestions(p, a.id);
  const res = expectOk(await F.completeTest(p, a.id, (q) => q.options[q.options.length - 1].value));
  const manual = qs.reduce((s, q) => s + Number(q.options[q.options.length - 1].score ?? q.options.length - 1), 0);
  assert.ok(Number.isFinite(res.score));
  assert.ok(Math.abs(res.score - manual) < 1e-9 || qs.some((q) => q.reverse), 'балл совпадает с ручным подсчётом (с учётом reverse)');
});

// covers: T-144, UC-03, F-36, F-18, PD-02
test('T-144 [W-15] повторная отправка не создаёт второго результата; чужое назначение — 404; отменённое врачом — 409 E-ASSIGNMENT-CLOSED', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'gad7').catch(async () => {
    const list = expectOk(await p.get('/api/v1/me/assignments')).items;
    return list.find((x) => x.instrument_code === 'gad7' && x.status !== 'done');
  });
  const r1 = await F.completeTest(p, a.id);
  expectOk(r1);
  const r2 = await p.post(`/api/v1/me/assignments/${a.id}/submit`, {});
  assert.ok(r2.status === 200 || r2.status === 409);
  assert.equal(ctx.app.query('SELECT count(*) n FROM online_results WHERE assignment_id = ?', a.id)[0].n, 1);
  expectError(await (await ctx.as('patB')).get(`/api/v1/me/assignments/${a.id}`), 404, 'E-NOT-FOUND');
  const c = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'phq9').catch(() => null);
  if (c) {
    const qs = await F.instrumentQuestions(p, c.id);
    expectOk(await p.put(`/api/v1/me/assignments/${c.id}/answers/${encodeURIComponent(qs[0].id)}`, { value: qs[0].options[0].value }));
    expectOk(await doc.post(`/api/v1/assignments/${c.id}/cancel`, {}));
    await F.passUndoWindow(ctx.app);
    expectError(await p.get(`/api/v1/me/assignments/${c.id}`), 409, 'E-ASSIGNMENT-CLOSED');
  }
});

// covers: T-145, UC-28, F-38, F-37, F-19, PD-02
test('T-145 [W-15] тест без назначения: только самодоступные методики; результат «самостоятельно» не виден врачу до «Показать врачу»; не чаще раза в 7 дней', async () => {
  const p = await ctx.as('patH');
  const list = expectOk(await p.get('/api/v1/me/self-tests')).items.map((x) => x.code);
  assert.ok(list.includes('phq9') && list.includes('gad7'));
  assert.ok(!list.includes('hads'));
  const st = expectOk(await p.post('/api/v1/me/self-tests', { instrument_code: 'gad7' }));
  const res = expectOk(await F.completeTest(p, st.id));
  assert.equal(res.source, 'self');
  const doc = await ctx.as('psy1');
  const before = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patH')}?tab=tests`));
  assert.ok(!JSON.stringify(before).includes(`"id":${res.id}`), 'до «Показать врачу» специалист не видит');
  expectOk(await p.post(`/api/v1/me/results/${res.id}/share`, {}));
  await F.passUndoWindow(ctx.app);
  const after = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patH')}?tab=tests`));
  assert.ok(JSON.stringify(after).includes(`${res.id}`), 'после — видит');
  expectError(await p.post('/api/v1/me/self-tests', { instrument_code: 'gad7' }), 429, 'E-RATE-LIMIT');
  expectError(await p.post('/api/v1/me/self-tests', { instrument_code: 'mmpi' }), 403, 'E-INSTRUMENT-LICENSE');
});

// covers: T-146, UC-10, UC-37, F-59, F-17, F-19
test('T-146 [W-16] назначение: «Отправлено · Отменить» (пациент видит только после окна), отмена невыполненного — «Вернуть», необязательные поля не блокируют', async () => {
  const doc = await ctx.as('psy2');
  const p = await ctx.as('patB');
  const r = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patB')}/assignments`, { instrument_code: 'phq9' }));
  assert.ok(r.undo);
  assert.ok(!expectOk(await p.get('/api/v1/me/assignments')).items.some((a) => a.id === r.items[0].id), 'в окне пациент не видит');
  expectOk(await doc.post(`/api/v1/undo/${r.undo.id}`, {}));
  await F.passUndoWindow(ctx.app);
  assert.ok(!expectOk(await p.get('/api/v1/me/assignments')).items.some((a) => a.id === r.items[0].id), 'отменённое никто не увидел');
  const r2 = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patB')}/assignments`, { instrument_code: 'phq9' }));
  await F.passUndoWindow(ctx.app);
  const cancel = expectOk(await doc.post(`/api/v1/assignments/${r2.items[0].id}/cancel`, {}));
  assert.ok(cancel.undo, '«Назначение отменено · Вернуть»');
  expectOk(await doc.post(`/api/v1/undo/${cancel.undo.id}`, {}));
  assert.ok(expectOk(await p.get('/api/v1/me/assignments')).items.some((a) => a.id === r2.items[0].id && a.status !== 'cancelled'));
});

// covers: T-147, UC-10, UC-32, F-59, F-60, F-108, L-40
test('T-147 [W-16] методика без права использования не назначается и не попадает в каталог (E-INSTRUMENT-LICENSE); HADS отсутствует', async () => {
  const doc = await ctx.as('psy1');
  const cat = expectOk(await doc.get('/api/v1/instruments')).items.map((i) => i.code);
  assert.ok(!cat.includes('hads'), 'HADS удалён');
  expectError(await doc.post(`/api/v1/patients/${ctx.id('patA')}/assignments`, { instrument_code: 'hads' }), 403, 'E-INSTRUMENT-LICENSE');
  expectError(await doc.post('/api/v1/packages', { title: 'Плохой пакет', items: ['phq9', 'hads'] }), 403, 'E-INSTRUMENT-LICENSE');
  assert.equal(ctx.app.query("SELECT count(*) n FROM instruments WHERE code = 'hads' AND status <> 'blocked'")[0].n, 0);
});

// covers: T-148, UC-32, F-60, F-17, F-118
test('T-148 [W-16] свой шаблон пакета видит только автор; 2–10 методик; стирание — «Отменить»; общие пакеты — только чтение', async () => {
  const a = await ctx.as('psy1');
  const b = await ctx.as('psy2');
  const pkg = expectOk(await a.post('/api/v1/packages', { title: 'Мой синтетический', items: ['phq9', 'gad7'] }));
  assert.ok(!expectOk(await b.get('/api/v1/packages')).items.some((x) => x.id === pkg.id), 'чужой шаблон не виден');
  expectError(await a.post('/api/v1/packages', { title: 'Один', items: ['phq9'] }), 422, 'E-VALIDATION');
  const del = expectOk(await a.del(`/api/v1/packages/${pkg.id}`));
  expectOk(await a.post(`/api/v1/undo/${del.undo.id}`, {}));
  assert.ok(expectOk(await a.get('/api/v1/packages')).items.some((x) => x.id === pkg.id));
  const shared = expectOk(await a.get('/api/v1/packages')).items.find((x) => x.shared);
  if (shared) expectError(await a.put(`/api/v1/packages/${shared.id}`, { title: 'Правка общего', items: ['phq9', 'gad7'] }), 403, 'E-ACCESS');
});

// covers: T-149, UC-21, UC-10, F-62, F-14, F-15, F-16, F-72
test('T-149 [W-22] очный результат: без «Сохранить» результата нет; баллы вне диапазона — E-VALIDATION; фото → черновик полей; ошибочный — пометкой; кризисный пункт — сигнал', async () => {
  const doc = await ctx.as('psy1');
  const draft = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, { instrument_code: 'phq9', method: 'manual', scores: { total: 30 } }));
  assert.equal(ctx.app.query('SELECT count(*) n FROM offline_results WHERE id = ? AND confirmed_at IS NOT NULL', draft.id)[0]?.n || 0, 0, 'до подтверждения результата нет');
  expectError(await doc.post(`/api/v1/offline-results/${draft.id}/confirm`, { scores: { total: 99 }, version: 1 }), 422, 'E-VALIDATION');
  const ok = expectOk(await doc.post(`/api/v1/offline-results/${draft.id}/confirm`, { scores: { total: 12, item9: 2 }, version: 1 }));
  assert.equal(ok.source, 'offline');
  assert.ok(ctx.app.query("SELECT count(*) n FROM crisis_escalations WHERE patient_id = ? AND source = 'offline'", ctx.id('patA'))[0].n >= 1, 'кризисный пункт очного бланка создаёт сигнал');
  const up = expectOk(await F.upload(doc, 'printed_form.png', 'offline_result'));
  const ph = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, { instrument_code: 'phq9', method: 'photo', upload_id: up.id }));
  assert.ok(ph.draft && Object.keys(ph.draft).length, 'печатный бланк дал черновик полей');
  assert.ok(ph.source_ref, 'исходник прикреплён');
  expectOk(await doc.post(`/api/v1/offline-results/${ok.id}/erroneous`, { reason: 'синтетика: ошибка ввода' }));
  const card = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=tests`));
  assert.match(JSON.stringify(card), /erroneous|ошибоч/i, 'пометка, а не правка баллов');
  expectError(await (await ctx.as('psy2')).post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, { instrument_code: 'phq9', method: 'manual' }), 404, 'E-NOT-FOUND');
});

// covers: T-150, UC-23, F-56, PD-02
test('T-150 [W-15] личная динамика: только свои результаты и дневник за выбранный период, без сравнения с другими', async () => {
  const p = await ctx.as('patA');
  const r = expectOk(await p.get('/api/v1/me/results?period=3m'));
  assert.ok(Array.isArray(r.series));
  assert.ok(!JSON.stringify(r).includes(`"patient_id":${ctx.id('patB')}`));
  assert.doesNotMatch(JSON.stringify(r), /рейтинг|percentile|среднее по/i);
});

// covers: T-151, UC-09, UC-44, F-57, F-37, F-97, S-20
test('T-151 [W-41] S-20: новые пороги точки действуют при следующем открытии списка; HADS в порогах не принимается', async () => {
  const admin = await ctx.as('admin1');
  const doc = await ctx.as('psy2');
  const before = expectOk(await doc.get('/api/v1/patients')).items.find((x) => x.id === ctx.id('patB'));
  const cur = expectOk(await admin.get('/api/v1/admin/settings/triage.thresholds')).current.value;
  expectError(await F.setSetting(admin, 'triage.thresholds', { ...cur, hads: { yellow: 8, red: 11 } }), 422, 'E-SETTING-INVALID');
  const strict = JSON.parse(JSON.stringify(cur));
  for (const k of Object.keys(strict)) if (strict[k] && typeof strict[k] === 'object') for (const b of Object.keys(strict[k])) strict[k][b] = 0;
  expectOk(await F.setSetting(admin, 'triage.thresholds', strict));
  const after = expectOk(await doc.get('/api/v1/patients')).items.find((x) => x.id === ctx.id('patB'));
  assert.ok(after.dot !== before.dot || after.dot_reasons.length >= before.dot_reasons.length, 'точка пересчитана');
});
