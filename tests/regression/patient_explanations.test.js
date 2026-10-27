'use strict';
// covers: F-26, F-27, S-08; уточнение владельца 2026-10-21.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
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
    assert.equal(call.prompt_key, 'task.patient_chat');
    assert.match(call.system, /ИИ-помощник пациента/, 'системная роль пациента перед задачей');
    assert.match(call.system, /без медицинских знаний/);
    assert.match(call.system, /Названия препаратов.*можно/);
    assert.match(call.system, /не учи выбирать лечение/);
    assert.match(call.system, /Не требуй терпеть побочные эффекты/);
  }
});

test('пациент: пост-фильтр отключён (решение владельца 2026-10-26), ответ модели доходит как есть', async () => {
  const patient = await ctx.as('patA');
  for (const text of [
    'Сертралин 50 мг врач назначил при тревоге.',
    'Всё будет хорошо, ты не один.',
    'Примите душ и отдохните.',
  ]) {
    ctx.app.ai.reset();
    ctx.app.ai.queue({ mode: 'text', text });
    const result = expectOk(await F.patientAsk(patient, 'Помоги сформулировать вопрос врачу'));
    assert.equal(result.reply.text, text);
    assert.equal(ctx.app.query('SELECT status FROM ai_audit ORDER BY id DESC LIMIT 1')[0].status, 'ok');
  }
});
