'use strict';

/**
 * Адаптеры провайдеров ИИ (M-19): local_stub, gigachat_api, openai_compat.
 * Выбор адаптера — по ai_models.adapter активной привязки назначения; реестр читается из базы.
 */

const { createLocalStub } = require('./localStub');
const { createGigachatApi } = require('./gigachatApi');
const { createOpenaiCompat } = require('./openaiCompat');

const instances = new Map();

function get(adapterName) {
  if (!instances.size) {
    instances.set('local_stub', createLocalStub());
    instances.set('gigachat_api', createGigachatApi());
    instances.set('openai_compat', createOpenaiCompat());
  }
  return instances.get(adapterName) || null;
}

module.exports = { get };
