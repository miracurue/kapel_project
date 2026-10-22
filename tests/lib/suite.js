'use strict';

// Общая обвязка файла тестов: один сервер на файл (свежая база и мир), закрытие после.
// Номер вехи и задачи — в названии теста: `T-101 [W-24] …`; по нему `npm run test:gate`
// запускает только тесты сделанных задач (tests/tools/gate.js).

const { before, after } = require('node:test');
const { startApp } = require('./app');
const { as, guest } = require('./client');

function useApp(opts = {}) {
  const ctx = { app: null, clients: {} };
  before(async () => { ctx.app = await startApp(opts); }, { timeout: 180000 });
  after(async () => { if (ctx.app) await ctx.app.stop(); });
  ctx.as = async (key) => {
    if (!ctx.clients[key]) ctx.clients[key] = await as(ctx.app, key);
    return ctx.clients[key];
  };
  ctx.fresh = (key) => as(ctx.app, key); // новая сессия того же пользователя
  ctx.guest = () => guest(ctx.app);
  ctx.id = (key) => ctx.app.ids[key];
  return ctx;
}

// Пауза (для окон «Отменить», опросов раз в 30 с при сдвинутых часах и т. п.)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ожидание условия с опросом.
async function eventually(fn, { timeout = 5000, step = 100, message = 'условие не выполнилось' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() - t0 > timeout) throw new Error(`${message}: ${last && last.message ? last.message : JSON.stringify(last)}`);
    await sleep(step);
  }
}

module.exports = { useApp, sleep, eventually };
