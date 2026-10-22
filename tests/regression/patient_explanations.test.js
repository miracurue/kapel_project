'use strict';
// covers: F-26, F-27, S-08; уточнение владельца 2026-10-21.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const { createRegistry } = require('../../src/ai/registry');
const ctx = useApp();

test('пациент: названия препаратов и классов проходят, новые правила передаются модели', async () => {
  const patient = await ctx.as('patA');
  for (const name of ['Триттико', 'сертралин', 'Золофт', 'антидепрессант']) {
    ctx.app.ai.reset();
    const text = `${name}: могу помочь понять назначение врача и подготовить вопросы к нему.`;
    ctx.app.ai.queue({ mode: 'text', text });
    const result = expectOk(await F.patientAsk(patient, 'Помоги понять назначение врача'));
    assert.equal(result.reply.text, text);
    const call = ctx.app.ai.calls().at(-1);
    assert.equal(call.prompt_version, 2);
    assert.match(call.system, /без медицинских знаний/);
    assert.match(call.system, /Названия препаратов.*разрешены/);
    assert.match(call.system, /Не лечи пациента/);
    assert.match(call.system, /Не требуй терпеть побочные эффекты/);
  }
});

test('пациент: назначения, изменение лечения, диагноз и обещания по-прежнему фильтруются', async () => {
  const patient = await ctx.as('patA');
  for (const text of [
    'Принимайте сертралин.',
    'Уменьшите дозу.',
    'Сертралин 50 мг.',
    'У вас депрессия.',
    'Обещаю, всё будет хорошо.',
  ]) {
    ctx.app.ai.reset();
    ctx.app.ai.queue({ mode: 'text', text });
    const result = expectOk(await F.patientAsk(patient, 'Помоги сформулировать вопрос врачу'));
    assert.notEqual(result.reply.text, text);
    assert.match(result.reply.text, /понять его назначения/);
    assert.doesNotMatch(result.reply.text, /не называю лекарства/);
    assert.equal(ctx.app.query('SELECT status FROM ai_audit ORDER BY id DESC LIMIT 1')[0].status, 'filtered');
  }
});

test('промпты пациента: v2 активна, v1 неизменна; обновление исходной базы повторяемо и сохраняет ручной откат', () => {
  const db = ctx.app.db();
  try {
    const registry = createRegistry({ db, config: { dataMode: 'real' }, now: () => new Date() });
    for (const key of ['patient_assistant', 'article_draft.patient', 'article_rewrite']) {
      const original = db
        .prepare('SELECT body, body_sha256 FROM prompt_versions WHERE prompt_key=? AND version=1')
        .get(key);
      assert.equal(registry.activePrompt(key).version, 2);
      // Состояние старой базы до обновления стартового промпта.
      db.prepare('DELETE FROM prompt_versions WHERE prompt_key=? AND version=2').run(key);
      db.prepare("UPDATE prompt_versions SET status='active' WHERE prompt_key=? AND version=1").run(key);
      registry.bootstrap();
      assert.equal(registry.activePrompt(key).version, 2);
      assert.deepEqual(
        db.prepare('SELECT body, body_sha256 FROM prompt_versions WHERE prompt_key=? AND version=1').get(key),
        original,
      );
      registry.bootstrap();
      assert.equal(db.prepare('SELECT count(*) n FROM prompt_versions WHERE prompt_key=?').get(key).n, 2);
      db.prepare("UPDATE prompt_versions SET status='previous' WHERE prompt_key=? AND version=2").run(key);
      db.prepare("UPDATE prompt_versions SET status='active' WHERE prompt_key=? AND version=1").run(key);
      registry.bootstrap();
      assert.equal(registry.activePrompt(key).version, 1, 'ручной откат не отменяется');
      db.prepare("UPDATE prompt_versions SET status='previous' WHERE prompt_key=? AND version=1").run(key);
      db.prepare("UPDATE prompt_versions SET status='active' WHERE prompt_key=? AND version=2").run(key);
    }
  } finally {
    db.close();
  }
});

test('промпты пациента: пользовательскую версию стартовое обновление не заменяет', async () => {
  const admin = await ctx.as('admin1');
  const base = '/api/v1/admin/ai/prompts/patient_assistant';
  const custom = expectOk(
    await admin.post(`${base}/versions`, { text: 'Пользовательские правила помощника.', comment: 'тест' }),
  );
  expectOk(await admin.post(`${base}/versions/${custom.version}/activate`, {}));
  const db = ctx.app.db();
  try {
    const registry = createRegistry({ db, config: { dataMode: 'real' }, now: () => new Date() });
    registry.bootstrap();
    assert.equal(registry.activePrompt('patient_assistant').version, custom.version);
    assert.equal(registry.activePrompt('patient_assistant').body, 'Пользовательские правила помощника.');
  } finally {
    db.close();
  }
});
