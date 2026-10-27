'use strict';
// Аудит P0-1: HTML-форма POST /login делит с API-входом лимит попыток и журнал; сообщение об ошибке общее.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { Client, expectError } = require('../lib/client');
const { PASSWORD, byKey } = require('../fixtures/world');
const ctx = useApp();

const submit = (email, password) =>
  fetch(`${ctx.app.base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }),
    redirect: 'manual',
  });

test('перебор пароля через форму: после 5 неудач верный пароль не пускает ни в форму, ни в API', async () => {
  const email = byKey('patH').email;
  const generic = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await submit(email, `bad-form-${i}-xxxx`);
    assert.equal(r.status, 401);
    generic.push(await r.text());
  }
  assert.ok(generic.every((html) => html.includes('Неверная почта или пароль')));
  const unknown = await submit('nobody-here@cc.example.test', 'whatever-xxxx');
  assert.equal(unknown.status, 401);
  assert.ok((await unknown.text()).includes('Неверная почта или пароль'), 'неизвестная почта — то же сообщение');

  const locked = await submit(email, PASSWORD);
  assert.equal(locked.status, 423);
  assert.equal(locked.headers.get('set-cookie'), null, 'сессия не создаётся');
  assert.ok((await locked.text()).includes('Неверная почта или пароль'), 'блокировка не раскрывается');
  expectError(await new Client(ctx.app.base).login(email, PASSWORD), 423, 'E-AUTH-LOCKED');
  const rows = ctx.app.query("SELECT count(*) n FROM login_attempts WHERE result='bad_password'")[0].n;
  assert.ok(rows >= 5, 'попытки с формы попали в журнал');
});

test('вход через форму по-прежнему работает и пишется в журнал', async () => {
  const r = await submit(byKey('patA').email, PASSWORD);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/app');
  assert.ok(ctx.app.query("SELECT count(*) n FROM login_attempts WHERE result='ok'")[0].n >= 1);
});
