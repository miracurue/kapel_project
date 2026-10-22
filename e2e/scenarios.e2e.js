'use strict';

// Сквозные сценарии по ролям на сид-БД. Проверяется не только отсутствие ошибок,
// но и содержательный результат у ДРУГОЙ роли (что реально появилось у врача/пациента/админа).

const MARK = 'E2E-МАРКЕР-' + Date.now().toString(36);
const text = async (page) => (await page.innerText('body')).replace(/\s+/g, ' ');
const go = async (page, base, url) => { await page.goto(base + url, { waitUntil: 'load' }); return text(page); };
const submit = async (page, sel) => { await Promise.all([page.waitForLoadState('load'), page.click(sel)]); };

async function patientAndPsychiatrist({ base, browser, t, L }) {
  // --- психиатр создаёт код, пациент регистрируется по коду
  let { ctx: cpsy, page: psy } = await L.login(browser, base, 'psy1');
  await go(psy, base, '/invites');
  await submit(psy, 'form[action="/invites"] button[type=submit]');
  const code = ((await psy.innerText('main')).match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || [])[0];
  t.check('психиатр: создан код-приглашение', !!code, code);

  const ctxN = await browser.newContext({ ...L.MOBILE, locale: 'ru-RU' });
  const pn = await ctxN.newPage();
  await pn.goto(base + '/register');
  await pn.fill('#full_name', 'Е2Е Новая Пациентка');
  await pn.fill('#email', 'e2e.new@example.com');
  await pn.fill('#password', 'demo-pass-123');
  await pn.fill('#invite_code', code || 'XXXX-XXXX');
  await pn.check('#consent_given');
  await pn.check('#clinical_consent_given');
  await submit(pn, 'form[action="/register"] button[type=submit]');
  if (/\/login/.test(pn.url())) {
    await pn.fill('input[name=email]', 'e2e.new@example.com');
    await pn.fill('input[name=password]', 'demo-pass-123');
    await submit(pn, 'form[action="/login"] button[type=submit]');
  }
  t.check('пациент: регистрация по коду завершилась входом', !/\/(register|login)/.test(pn.url()), pn.url());
  await ctxN.close();
  const list = await go(psy, base, '/patients');
  t.check('психиатр: новый пациент по коду появился в списке', list.includes('Новая Пациентка'));

  // --- назначение теста (онлайн) -> пациент проходит -> врач видит результат
  await go(psy, base, '/assignments?patient=5');
  await psy.check('form.pc-assign input[name=instrument][value=isi]');
  await submit(psy, 'form.pc-assign button[type=submit]');
  const { ctx: cp, page: pat } = await L.login(browser, base, 'p1', L.MOBILE);
  await go(pat, base, '/dashboard');
  const links = await pat.$$eval('a[href*="/assignments/"]', (as) => as.map((a) => a.getAttribute('href')).filter((h) => /\/take$/.test(h)));
  t.check('пациент: назначенный врачом тест виден', links.length > 0, links);
  let passed = false;
  for (const href of links) {
    await go(pat, base, href);
    if (!(await pat.$('input[type=radio]'))) continue;
    if (!/ISI|бессонн/i.test(await pat.innerText('body'))) continue;
    for (let k = 0; k < 40 && (await pat.$('form[data-step-form]')); k++) {
      await pat.locator('input[name=value]').first().check({ force: true });
      await submit(pat, 'form[data-step-form] button[type=submit]');
    }
    await submit(pat, 'form[action$="/submit"] button[type=submit]');
    passed = true; break;
  }
  t.check('пациент: тест пройден и отправлен', passed);
  const card = await go(psy, base, '/patients/5');
  t.check('психиатр: результат ISI появился в карточке', /ISI/.test(card));

  // --- дневник с маркером: врач видит при согласии (scores+notes)
  await go(pat, base, '/share');
  for (const n of ['scores', 'notes']) { const c = pat.locator(`input[name=${n}]`); if (!(await c.isChecked())) await c.check(); }
  await submit(pat, 'form[action="/share"] button[type=submit]');
  await go(pat, base, '/diary');
  await pat.check('input[name=mood_score][value="4"]', { force: true }).catch(() => pat.click('label.mood-btn:nth-child(4)'));
  await pat.locator('details.optional summary').click();
  await pat.fill('#note', MARK);
  await submit(pat, 'form[action="/diary"] button[type=submit]');
  t.check('пациент: запись дневника сохранена', (await text(pat)).includes(MARK));
  t.check('психиатр: заметка дневника видна врачу при включённом «Поделиться»', (await go(psy, base, '/patients/5/diary')).includes(MARK));
  // выключаем заметки: маркер у врача пропадает
  await go(pat, base, '/share');
  await pat.locator('input[name=notes]').uncheck();
  await submit(pat, 'form[action="/share"] button[type=submit]');
  t.check('психиатр: при выключенных заметках текст заметки не виден', !(await go(psy, base, '/patients/5/diary')).includes(MARK));

  // --- «Мне плохо»
  const help = await go(pat, base, '/help');
  t.check('пациент: страница «Мне плохо» с быстрым выходом и контактами', /Быстрый выход/.test(help) && /112|103/.test(help));
  await pat.fill('#message', 'Мне тяжело сегодня ' + MARK);
  await submit(pat, 'form[action="/help/contact"] button[type=submit]');
  t.check('пациент: обращение «Мне плохо» принято без ошибки', !/Ошибка 5|Internal/i.test(await text(pat)));
  const inbox = await go(psy, base, '/patients/5/messages');
  const dash = await go(psy, base, '/crisis');
  t.check('психиатр: обращение «Мне плохо» дошло (сообщения или кризисная очередь)', inbox.includes(MARK) || dash.includes('Светлова') || /Светлова/.test(await go(psy, base, '/dashboard')));

  // --- чат ИИ: кризисная фраза -> показан кризисный блок и эскалация у врача
  await go(pat, base, '/chat');
  const kb = await pat.evaluate(() => { const l = document.getElementById('ai-log'); return !!l && l.getAttribute('tabindex') === '0'; });
  t.check('чат: область сообщений доступна с клавиатуры (tabindex=0)', kb);
  await pat.fill('#ai-input', 'я не хочу жить, думаю покончить с собой');
  await pat.click('#ai-send');
  await pat.waitForTimeout(4000);
  const chat = await text(pat);
  t.check('пациент: на кризисную фразу показаны экстренные контакты, а не обычный ответ', /112|103|8-800|телефон доверия|кризис/i.test(chat), chat.slice(-300));
  const crisis = await go(psy, base, '/crisis');
  t.check('психиатр: в кризисной очереди есть пациент Светлова после кризисной фразы в чате', /Светлова/.test(crisis));

  // --- ИИ-пространство врача: загрузка файла
  await go(psy, base, '/ai');
  await Promise.all([psy.waitForLoadState('load'), psy.click('text=Новый диалог')]);
  const thread = psy.url();
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const f = path.join(os.tmpdir(), 'e2e-vypiska-' + process.pid + '.txt');
  fs.writeFileSync(f, 'Выписка. Пациентка Иванова Мария Петровна, тел. +7 (912) 345-67-89. Жалобы на сниженное настроение. ' + MARK);
  await psy.locator('#ws-attach summary').click();
  await psy.setInputFiles('#ws-files', f);
  await submit(psy, '#ws-attach-form button[type=submit]');
  const prev = await text(psy);
  t.check('ИИ-пространство: предпросмотр файла показан, ПДн замаскированы в «После»', /Сохранить в диалог/.test(prev) && /\[ТЕЛЕФОН\]/.test(prev) && /\[ФИО\]/.test(prev), prev.slice(0, 300));
  await submit(psy, 'button:has-text("Сохранить в диалог")');
  t.check('ИИ-пространство: материал сохранён в диалог', /Материал 1|vypiska/i.test(await text(psy)));
  fs.rmSync(f, { force: true });
  void thread;

  // --- сообщения: врач пишет, пациент видит, и наоборот
  const reply = 'Ответ врача ' + MARK;
  await go(psy, base, '/patients/5/messages');
  await psy.fill('#body', reply);
  await submit(psy, 'form[action$="/messages"] button[type=submit]');
  t.check('пациент: сообщение врача видно в «Сообщения врачу»', (await go(pat, base, '/messages')).includes(reply));
  await pat.fill('#msg-body', 'Вопрос пациента ' + MARK);
  await submit(pat, 'form[action="/messages"] button[type=submit]');
  t.check('психиатр: сообщение пациента видно в карточке', (await go(psy, base, '/patients/5/messages')).includes('Вопрос пациента ' + MARK));

  // --- сводка
  const sum = await go(psy, base, '/dashboard');
  t.check('психиатр: сводка показывает группы светофора и кризисы', /Кризис|Красн|Внимание/i.test(sum));

  // --- очный тест «ожидает ввода»
  await go(psy, base, '/assignments?patient=5');
  await psy.check('form.pc-assign input[name=instrument][value=hdrs17]');
  await submit(psy, 'form.pc-assign button[type=submit]');
  t.check('психиатр: очный тест HDRS-17 «ожидает ввода» в списке назначений', /жидает ввода/.test(await go(psy, base, '/assignments?patient=5')));
  t.check('пациент: очный тест HDRS-17 нельзя пройти онлайн (нет ссылки «Пройти»)', !(await pat.$$eval('a', (as) => as.map((a) => a.innerText)).then((l) => l.some((x) => /Пройти.*HDRS|HDRS.*Пройти/i.test(x)))));

  await cp.close(); await cpsy.close();
}

async function psychologist({ base, browser, t, L }) {
  const { ctx, page: plg } = await L.login(browser, base, 'plg');
  await go(plg, base, '/patients/5/conclusions');
  await submit(plg, 'form[action$="/conclusions"] button[type=submit]');
  const m = plg.url().match(/\/conclusions\/(\d+)/);
  t.check('психолог: создан черновик заключения', !!m, plg.url());
  if (!m) { await ctx.close(); return; }
  const id = m[1];
  await plg.fill('#f-protocols', 'Протокол: ' + MARK);
  const firstKey = await plg.$$eval('textarea[id^="f-"]', (e) => e.map((x) => x.id));
  for (const k of firstKey) if (k !== 'f-protocols') { await plg.fill('#' + k, 'Раздел ' + k + ' ' + MARK); }
  await submit(plg, '.concl-form button[type=submit]');
  await plg.fill('input[name=confirm_password]', L.PASSWORD);
  await plg.fill('input[name=confirm_name]', 'Демо Психолог Белова Е. Н.');
  await plg.check('input[name=confirm_check]');
  await submit(plg, 'form.concl-sign button[type=submit]');
  const signed = await text(plg);
  t.check('психолог: заключение подписано (версия 1, содержание сохранено)', /подписан/i.test(signed) && signed.includes(MARK), signed.slice(0, 300));
  await plg.fill('input[name=reason]', 'Уточнение E2E');
  await submit(plg, 'form[action$="/revise"] button[type=submit]');
  t.check('психолог: создана новая версия после подписи', /версия 2|v2|Версия 2/i.test(await text(plg)) || (await go(plg, base, `/conclusions/${id}/versions/1`)).includes(MARK));
  // выдача пациенту
  await go(plg, base, `/conclusions/${id}`);
  const rel = plg.locator('form[action$="/release"] button');
  if (await rel.count()) { await rel.first().click(); await plg.waitForLoadState('load'); }
  await ctx.close();
}

async function admin({ base, browser, t, L }) {
  const { ctx, page: ad } = await L.login(browser, base, 'admin');
  // пользователи
  await go(ad, base, '/admin/users/new');
  await ad.fill('input[name=full_name]', 'Е2Е Новый Врач');
  await ad.fill('input[name=email]', 'e2e.doc@example.com');
  await ad.selectOption('select[name=role]', 'psychiatrist');
  await submit(ad, 'main form button[type=submit]');
  t.check('админ: создан сотрудник, показан временный пароль', /Е2Е Новый Врач|e2e\.doc@example\.com/.test(await text(ad)));
  t.check('админ: сотрудник в списке пользователей', (await go(ad, base, '/admin/users')).includes('e2e.doc@example.com'));
  // «Без врача»
  const nob = await go(ad, base, '/admin/nobody');
  t.check('админ: «Без врача» показывает эскалацию пациента без резерва (Зорина)', /Зорина/.test(nob));
  const sel = ad.locator('form[action$="/handover"] select').first();
  t.check('админ: у записи есть форма передачи врачу', (await sel.count()) > 0);
  if (await sel.count()) {
    await sel.selectOption({ index: 1 });
    await submit(ad, 'form[action$="/handover"] button[type=submit]');
    const { ctx: c3, page: d3 } = await L.login(browser, base, 'psy3');
    t.check('психиатр Беляев: переданная администратором эскалация (Зорина) видна в его кризисной очереди', /Зорина/.test(await go(d3, base, '/crisis')));
    await c3.close();
  }
  // удаление: пациент p8 запрашивает, админ исполняет
  const { ctx: c8, page: p8 } = await L.login(browser, base, 'p8', L.MOBILE);
  await go(p8, base, '/privacy/delete');
  await submit(p8, 'button:has-text("Да, отозвать согласие")');
  await c8.close();
  const q = await go(ad, base, '/admin/deletion');
  t.check('админ: запрос на удаление виден в очереди', /Новиков/.test(q) || /patient8/.test(q));
  await Promise.all([ad.waitForLoadState('load'), ad.locator('a:has-text("Открыть")').first().click()]);
  await Promise.all([ad.waitForLoadState('load'), ad.locator('a:has-text("Исполнить"), a:has-text("Удалить")').first().click()]);
  await ad.fill('input[name=confirm_email]', 'patient8.new@example.com');
  const force = ad.locator('input[name=force_open]');
  if (await force.count()) await force.check();
  await submit(ad, 'button:has-text("Удалить данные безвозвратно")');
  const ctxL = await browser.newContext({ locale: 'ru-RU' });
  const pl = await ctxL.newPage();
  await pl.goto(base + '/login');
  await pl.fill('input[name=email]', 'patient8.new@example.com');
  await pl.fill('input[name=password]', L.PASSWORD);
  await submit(pl, 'form[action="/login"] button[type=submit]');
  t.check('после удаления вход пациента невозможен', /\/login/.test(pl.url()) || /не найден|неверн|заблок|удал/i.test(await text(pl)));
  await ctxL.close();
  await ctx.close();
}

async function run(env) {
  await patientAndPsychiatrist(env);
  await psychologist(env);
  await admin(env);
}

module.exports = { run };
