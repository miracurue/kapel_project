'use strict';

// Кризисный шлюз всех свободных вводов (F-16) до ИИ, «Мне нужна помощь · 112» (F-46),
// сроки реакции и резерв (F-64), настройки S-17, S-18, S-55, S-56. Кризис не зависит от ИИ и согласий (PD-16, PD-10).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { Client, expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

function signalsOfPatient(patientKey) {
  return ctx.app.query('SELECT * FROM crisis_escalations WHERE patient_id = ? ORDER BY id', ctx.id(patientKey));
}

// covers: T-070, UC-05, UC-24, F-16, F-27, F-19, PD-16, M-14
test('T-070 [W-24] кризисная фраза в ИИ-чате: карточка 112 вместо ответа, модель не вызвана, сигнал с минимальной цитатой и нейтральные уведомления психиатру и психологу', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  const long = `${'Синтетический длинный текст о дне. '.repeat(40)}${F.CRISIS_PHRASE} ${'И ещё синтетика. '.repeat(30)}`;
  const r = expectOk(await F.patientAsk(p, long));
  assert.ok(r.crisis, 'в ответе кризисная карточка');
  assert.equal(r.crisis.contacts[0].phone, '112', '112 первым');
  assert.equal(r.crisis.signal_delivered, true);
  assert.ok(!r.reply || r.reply.status === 'crisis', 'ответа модели нет');
  assert.equal(ctx.app.ai.calls().length, 0, 'модель не вызывалась (PD-16)');
  const sig = signalsOfPatient('patA').at(-1);
  assert.ok(sig, 'сигнал создан');
  const psy = await ctx.as('psy1');
  const card = await F.crisisSignalFor(psy, ctx.id('patA'));
  assert.ok(card && card.quote, 'психиатр видит минимальную цитату');
  assert.ok(card.quote.length <= 300, 'цитата не длиннее 300 символов');
  assert.ok(card.quote.includes('нет смысла жить'), 'цитата — предложение со срабатыванием');
  assert.ok(!card.quote.includes('И ещё синтетика'), 'остальной текст чата специалисту недоступен');
  const plg = await ctx.as('plg1');
  assert.ok(await F.crisisSignalFor(plg, ctx.id('patA')), 'психолог тоже получатель');
  for (const who of ['psy1', 'plg1']) {
    const n = expectOk(await (await ctx.as(who)).get('/api/v1/notifications')).items;
    const crisisNote = n.find((x) => x.object && x.object.id === card.id);
    assert.ok(crisisNote, `${who} получил уведомление`);
    assert.doesNotMatch(crisisNote.title, /смысла|жить|суицид/i, 'в заголовке нет текста');
  }
});

// covers: T-071, UC-03, UC-04, UC-06, UC-07, UC-34, UC-30, F-16, F-36, F-39, F-45, F-47, F-49, PD-16
test('T-071 [W-24] кризисная проверка срабатывает в каждом свободном вводе: дневник, сообщение врачу, НЯ, анкета, ответ теста, обращение', async () => {
  const p = await ctx.as('patH');
  const doc = await ctx.as('psy1');
  const before = signalsOfPatient('patH').length;
  const sources = [];
  const d = expectOk(await p.post('/api/v1/me/diary', { mood: 1, note: F.CRISIS_PHRASE }));
  assert.ok(d.crisis);
  sources.push('diary');
  const m = expectOk(await p.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  assert.ok(m.crisis);
  sources.push('message');
  const ae = expectOk(
    await p.post('/api/v1/me/adverse-events', {
      symptoms: ['other'],
      text: F.CRISIS_PHRASE,
      severity: 'severe',
      related: 'unknown',
    }),
  );
  assert.ok(ae.crisis);
  sources.push('ae');
  const visit = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patH')}/visits`, {
      starts_at: new Date(Date.now() + 2 * 86400000).toISOString(),
      format: 'in_person',
      previsit_enabled: true,
    }),
  );
  await F.passUndoWindow(ctx.app);
  const form = expectOk(await p.get(`/api/v1/me/visits/${visit.visit.id}/previsit`));
  const textQ = form.questions.find((q) => q.type === 'text_long' || q.type === 'text_short');
  assert.ok(textQ, 'в анкете есть вопрос со свободным ответом');
  const pre = expectOk(
    await p.put(`/api/v1/me/visits/${visit.visit.id}/previsit`, {
      answers: { [textQ.id]: F.CRISIS_PHRASE },
      submit: true,
    }),
  );
  assert.ok(pre.crisis);
  sources.push('previsit');
  const help = expectOk(await p.post('/api/v1/crisis/help', { text: F.CRISIS_PHRASE, source: 'help_page' }));
  assert.ok(help.crisis);
  sources.push('appeal');
  const all = signalsOfPatient('patH');
  assert.ok(all.length >= before + 1, 'сигнал создан');
  const incidents = ctx.app.query(
    "SELECT event_type FROM crisis_incident_log WHERE patient_id = ? AND event_type IN ('created','appended')",
    ctx.id('patH'),
  );
  assert.ok(
    incidents.length >= sources.length,
    `каждый ввод записан в журнал инцидентов: ${incidents.length} из ${sources.length}`,
  );
});

// covers: T-072, UC-03, F-16, F-36, F-37, PD-16
test('T-072 [W-24] кризисный ответ в тесте (свободный текст и кризисный пункт): поддержка показана сразу, до результата', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'phq9');
  const qs = await F.instrumentQuestions(p, a.id);
  const item9 = qs.find((q) => /9$/.test(q.id) || /смерт|навред|вред/i.test(q.text));
  assert.ok(item9, 'в PHQ-9 есть кризисный пункт');
  const answer = await p.put(`/api/v1/me/assignments/${a.id}/answers/${encodeURIComponent(item9.id)}`, {
    value: item9.options.at(-1).value,
  });
  const body = expectOk(answer);
  assert.ok(body.crisis, 'кризисная поддержка сразу при ответе, до подсчёта');
  assert.ok(signalsOfPatient('patA').length >= 1);
});

// covers: T-073, UC-05, UC-35, UC-17, F-16, F-64, F-46, PD-10, PD-16, PD-20
test('T-073 [W-24] кризис распознаётся без ИИ-согласия, в архиве и без специалиста; без специалиста — служебная очередь без цитаты', async () => {
  for (const key of ['patG', 'patD', 'patC']) {
    const p = await ctx.as(key);
    const r = expectOk(await p.post('/api/v1/crisis/help', { text: F.CRISIS_PHRASE, source: 'button' }));
    assert.ok(r.crisis, `${key}: карточка 112`);
    assert.ok(signalsOfPatient(key).length >= 1, `${key}: сигнал создан`);
  }
  const admin = await ctx.as('admin1');
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open'));
  const forC = q.items.filter((i) => /crisis/.test(i.kind));
  assert.ok(forC.length >= 2, 'кризисы пациентов без специалиста и в архиве — в служебной очереди');
  assert.doesNotMatch(
    JSON.stringify(q),
    /смысла жить|Зоя|Вымышленная|Пётр|Условный/,
    'администратор не видит цитату и ФИО (PD-20)',
  );
});

// covers: T-074, UC-05, F-16, PD-16
test('T-074 [W-24] повтор кризисной фразы за 24 часа дописывается в открытый сигнал, второго сигнала нет; после обработки — новый', async () => {
  const p = await ctx.as('patB');
  expectOk(await p.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  const n1 = signalsOfPatient('patB').length;
  expectOk(await p.post('/api/v1/me/diary', { mood: 1, note: `${F.CRISIS_PHRASE} снова` }));
  assert.equal(signalsOfPatient('patB').length, n1, 'объединено с открытым');
  const appended = ctx.app.query(
    "SELECT count(*) n FROM crisis_incident_log WHERE patient_id = ? AND event_type = 'appended'",
    ctx.id('patB'),
  )[0].n;
  assert.ok(appended >= 1);
  const doc = await ctx.as('psy2');
  const s = await F.crisisSignalFor(doc, ctx.id('patB'));
  expectOk(await doc.post(`/api/v1/signals/${s.id}/contacted`, {}));
  await F.passUndoWindow(ctx.app);
  expectOk(await p.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  assert.equal(signalsOfPatient('patB').length, n1 + 1, 'после обработки — новый сигнал');
});

// covers: T-075, F-16, F-23, F-27, PD-16
test('T-075 [W-24] кризисный текст не ограничивается ни длиной, ни частотой (лимит 20 вопросов за 10 мин на него не действует)', async () => {
  const p = await ctx.as('patI');
  const huge = `${F.CRISIS_PHRASE} ${'x'.repeat(6000)}`;
  const r = expectOk(await F.patientAsk(p, huge));
  assert.ok(r.crisis, 'длинный кризисный текст не отклонён по длине');
  for (let i = 0; i < 25; i += 1) {
    const x = await F.patientAsk(p, `${F.CRISIS_PHRASE} ${i}`);
    assert.equal(x.status, 200, `кризисное сообщение ${i} не ограничено частотой`);
  }
});

// covers: T-076, UC-05, F-16, F-46, PD-16
test('T-076 [W-24] сбой записи сигнала: пациент всё равно видит 112 и «не удалось передать» (E-CRISIS-DELIVERY)', async () => {
  const p = await ctx.as('patA');
  ctx.app.exec(
    "CREATE TRIGGER t13_crisis_fail BEFORE INSERT ON crisis_escalations BEGIN SELECT RAISE(ABORT, 'test: db down'); END;",
  );
  ctx.app.exec(
    "CREATE TRIGGER t13_crisis_fail2 BEFORE INSERT ON crisis_incident_log BEGIN SELECT RAISE(ABORT, 'test: db down'); END;",
  );
  try {
    const r = await p.post('/api/v1/crisis/help', { text: `${F.CRISIS_PHRASE} новый случай`, source: 'button' });
    if (r.status === 200) {
      assert.equal(r.body.crisis.signal_delivered, false);
      assert.equal(r.body.crisis.contacts[0].phone, '112');
    } else {
      const e = expectError(r, 500, 'E-CRISIS-DELIVERY');
      assert.equal(e.details.crisis_card.contacts[0].phone, '112', 'карточка 112 в details');
      assert.equal(e.details.crisis_card.signal_delivered, false);
    }
    const chat = expectOk(await F.patientAsk(p, `${F.CRISIS_PHRASE} в чате`));
    assert.equal(chat.crisis.signal_delivered, false);
  } finally {
    ctx.app.exec('DROP TRIGGER t13_crisis_fail; DROP TRIGGER t13_crisis_fail2;');
  }
});

// covers: T-077, UC-05, UC-39, F-46, F-09, R-01, R-07, S-17
test('T-077 [W-24] контакты экстренной помощи доступны без входа и заблокированному: 112 первым, без обещания немедленного ответа', async () => {
  const g = new Client(ctx.app.base);
  const r = expectOk(await g.get('/api/v1/crisis/contacts'));
  assert.equal(r.contacts[0].phone, '112');
  const help = await g.get('/account/help', { headers: { accept: 'text/html' } });
  assert.equal(help.status, 200);
  assert.match(help.body, /data-page="P-27"/);
  const idx112 = help.body.indexOf('112');
  assert.ok(idx112 >= 0 && idx112 < help.body.indexOf('data-testid="msg.help.'), '112 вверху справки (L-49)');
  assert.doesNotMatch(help.body, /немедленно ответ|ответим сразу|срочно свяжемся/i, 'нет обещаний немедленного ответа');
});

// covers: T-078, UC-05, F-46, F-02
test('T-078 [W-24] «Мне нужна помощь»: обращение уходит закреплённым специалистам, «Быстрый выход» закрывает сессию', async () => {
  const p = await ctx.fresh('patA');
  const r = expectOk(
    await p.post('/api/v1/crisis/help', { text: 'Хочу поговорить со специалистом, синтетика', source: 'button' }),
  );
  assert.ok(r.appeal_id, 'обращение создано');
  const appeal = ctx.app.query('SELECT routed_to FROM patient_appeals WHERE id = ?', r.appeal_id)[0];
  assert.equal(appeal.routed_to, 'clinician');
  expectOk(await p.post('/api/v1/auth/logout', {}, { idem: false }));
  expectError(await p.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
});

// covers: T-079, UC-11, UC-17, F-64, F-21, S-18, S-56, PD-16, PD-20
test('T-079 [W-25] срок реакции S-18: новый сигнал после срока уходит резервному специалисту S-56, после второго срока — в служебную очередь без цитаты', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'crisis.backup', [ctx.id('psy3')]));
  expectOk(await F.setSetting(admin, 'crisis.sla', { work_minutes: 15, off_minutes: 15 }));
  const p = await ctx.as('patH');
  expectOk(await p.post('/api/v1/me/messages', { text: `${F.CRISIS_PHRASE} новый для срока` }));
  const sig = signalsOfPatient('patH').at(-1);
  await ctx.app.advanceClock(16 * 60 * 1000);
  await ctx.app.waitJobs(10);
  const backup = await ctx.as('psy3');
  const notes = expectOk(await backup.get('/api/v1/notifications')).items;
  assert.ok(
    notes.some((n) => n.object && n.object.id === sig.id),
    'резерв получил уведомление',
  );
  const row = ctx.app.query('SELECT escalated_to_backup_at FROM crisis_escalations WHERE id = ?', sig.id)[0];
  assert.ok(row.escalated_to_backup_at);
  await ctx.app.advanceClock(16 * 60 * 1000);
  await ctx.app.waitJobs(10);
  const freshAdmin = await ctx.fresh('admin1');
  const q = expectOk(await freshAdmin.get('/api/v1/admin/requests?filter=open'));
  assert.ok(
    q.items.some((i) => i.kind === 'crisis_manual_review'),
    'нужен ручной разбор',
  );
  assert.doesNotMatch(JSON.stringify(q), /смысла жить/);
});

// covers: T-080, UC-44, UC-05, F-97, F-46, S-17
test('T-080 [W-41] S-17: новый контакт организации виден пациенту со следующей страницы; 112 удалить или сдвинуть нельзя', async () => {
  const admin = await ctx.as('admin1');
  const bad = await F.setSetting(admin, 'crisis.contacts', [
    { title: 'Синтетическая линия', phone: '+7 800 000-00-00', hours: 'круглосуточно' },
  ]);
  expectError(bad, 422, 'E-SETTING-INVALID');
  expectOk(
    await F.setSetting(admin, 'crisis.contacts', [
      { title: 'Экстренные службы', phone: '112' },
      { title: 'Синтетическая линия', phone: '+7 800 000-00-00', hours: 'круглосуточно' },
    ]),
  );
  const r = expectOk(await new Client(ctx.app.base).get('/api/v1/crisis/contacts'));
  assert.equal(r.contacts[0].phone, '112');
  assert.ok(r.contacts.some((c) => c.title === 'Синтетическая линия'));
});

// covers: T-081, UC-44, UC-45, F-97, F-98, S-55, M-14
test('T-081 [W-41] S-55: правило, теряющее прежний положительный пример кризисного набора, не включается (E-CRISIS-REGRESSION); новое правило срабатывает', async () => {
  const admin = await ctx.as('admin1');
  const cur = expectOk(await admin.get('/api/v1/admin/settings/crisis.rules')).current.value;
  const weakened = JSON.parse(JSON.stringify(cur));
  const phrases = weakened.phrases || weakened.dictionary || weakened;
  if (Array.isArray(phrases)) phrases.splice(0, phrases.length);
  const r = await F.setSetting(admin, 'crisis.rules', weakened);
  const e = expectError(r, 422, 'E-CRISIS-REGRESSION');
  assert.ok(Array.isArray(e.details.missed) && e.details.missed.length >= 1, 'перечислены пропущенные примеры');
  assert.ok(
    !JSON.stringify(
      ctx.app.query("SELECT new_safe_json FROM action_log WHERE action LIKE 'setting%' ORDER BY id DESC LIMIT 1"),
    ).includes('нет смысла жить'),
    'в журнале коды, не тексты',
  );
  const extended = JSON.parse(JSON.stringify(cur));
  const list = extended.phrases || extended.dictionary;
  list.push({ text: 'синтетическая проверочная фраза т13', level: 'high', code: 'T13' });
  expectOk(await F.setSetting(admin, 'crisis.rules', extended));
  const p = await ctx.as('patB');
  const m = expectOk(
    await p.post('/api/v1/me/diary', { mood: 2, note: 'Сегодня СИНТЕТИЧЕСКАЯ проверочная фраза т13' }),
  );
  assert.ok(m.crisis, 'новое правило работает сразу, без перезапуска');
});
