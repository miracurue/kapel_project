'use strict';

// Обвязка файла приёмочных тестов: сервер (как в API-тестах) + один браузер на файл.

const { before, after } = require('node:test');
const { startApp } = require('./app');
const { launch } = require('./browser');
const { as } = require('./client');

function useBrowserApp(opts = {}) {
  const ctx = { app: null, browser: null, contexts: [] };
  before(async () => {
    ctx.app = await startApp(opts);
    ctx.browser = await launch();
  }, { timeout: 180000 });
  after(async () => {
    for (const c of ctx.contexts) { try { await c.close(); } catch (_) { /* закрыт */ } }
    if (ctx.browser) await ctx.browser.close();
    if (ctx.app) await ctx.app.stop();
  });
  ctx.api = (key) => as(ctx.app, key);
  ctx.track = (c) => { ctx.contexts.push(c); return c; };
  return ctx;
}

module.exports = { useBrowserApp };
