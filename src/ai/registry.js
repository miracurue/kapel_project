'use strict';

/**
 * Реестр моделей и привязок назначений (M-19): читается из базы при каждом запросе,
 * кеш на 30 секунд — переключение модели администратором действует без перезапуска.
 * Здесь же стартовая настройка: загрузка начальных промптов из prompts/<ключ>/v001.md
 * и выбор привязки по окружению (ключ GigaChat есть — привязка GigaChat, нет — local_stub).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const PURPOSES = [
  'patient_assistant',
  'clinician_chat',
  'document_draft',
  'diagnostic_hints',
  'ae_extraction',
  'order_parse',
  'admin_assistant',
];
// Ключ промпта по умолчанию равен назначению; подключи вида `document_draft.template` выбирает вызывающий код
// (gateway.run({ promptKey })), привязка модели и лимиты остаются по назначению.
const PROMPT_KEYS = [
  ...PURPOSES.filter((p) => p !== 'admin_assistant'),
  'document_draft.template',
  'article_draft.patient',
  'article_draft.specialist',
  'article_rewrite',
];
// Основная модель GigaChat по назначению, если она не GigaChat-2-Max.
const GIGA_PRIMARY = { document_draft: 'GigaChat-3-Ultra' };
const CACHE_TTL_MS = 30 * 1000;
const PATIENT_EXPLANATION_PROMPTS = ['patient_assistant', 'article_draft.patient', 'article_rewrite'];

function createRegistry({ db, config, now }) {
  let cache = { at: 0, bindings: new Map() };

  function modelById(id) {
    return db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id) || null;
  }

  function activeBinding(purpose) {
    return db.prepare("SELECT * FROM ai_binding_versions WHERE purpose = ? AND status = 'active'").get(purpose) || null;
  }

  function getBinding(purpose) {
    const t = now(config).getTime();
    if (t - cache.at > CACHE_TTL_MS) {
      cache = { at: t, bindings: new Map() };
    }
    if (!cache.bindings.has(purpose)) {
      const binding = activeBinding(purpose);
      if (!binding) {
        cache.bindings.set(purpose, null);
        return null;
      }
      const primary = modelById(binding.primary_model_id);
      const fallback = binding.fallback_model_id ? modelById(binding.fallback_model_id) : null;
      cache.bindings.set(purpose, { version: binding.version, primary, fallback });
    }
    return cache.bindings.get(purpose);
  }

  function invalidate() {
    cache = { at: 0, bindings: new Map() };
  }

  /** Активная версия промпта назначения. */
  function activePrompt(promptKey) {
    return db.prepare("SELECT * FROM prompt_versions WHERE prompt_key = ? AND status = 'active'").get(promptKey) || null;
  }

  /**
   * Загрузка начальных промптов из prompts/<ключ>/v001.md при первом запуске (S-08).
   * Существующие версии не трогаются (тексты версий неизменяемы — триггер prompt_body_immutable).
   */
  function ensurePrompts() {
    for (const key of PROMPT_KEYS) {
      const exists = db.prepare('SELECT 1 FROM prompt_versions WHERE prompt_key = ? LIMIT 1').get(key);
      if (exists) continue;
      const file = path.join(ROOT, 'prompts', key, 'v001.md');
      if (!fs.existsSync(file)) continue;
      const body = fs.readFileSync(file, 'utf8');
      db.prepare(
        "INSERT INTO prompt_versions(prompt_key, version, body, body_sha256, status, author_id, comment) VALUES (?, 1, ?, ?, 'active', NULL, ?)",
      ).run(key, body, crypto.createHash('sha256').update(body).digest('hex'), 'Начальная версия из prompts/<ключ>/v001.md (W-30); текст review-required');
    }
    // Уточнение владельца: объяснять лекарства пациенту можно, самостоятельно лечить — нельзя.
    // Обновляем только нетронутую стартовую v1. Пользовательские версии и откаты сохраняются.
    db.transaction(() => {
      for (const key of PATIENT_EXPLANATION_PROMPTS) {
        const versions = db.prepare('SELECT version, body_sha256, status FROM prompt_versions WHERE prompt_key = ?').all(key);
        if (versions.length !== 1 || versions[0].version !== 1 || versions[0].status !== 'active') continue;
        const original = fs.readFileSync(path.join(ROOT, 'prompts', key, 'v001.md'), 'utf8');
        if (versions[0].body_sha256 !== crypto.createHash('sha256').update(original).digest('hex')) continue;
        const body = fs.readFileSync(path.join(ROOT, 'prompts', key, 'v002.md'), 'utf8');
        db.prepare("UPDATE prompt_versions SET status = 'previous' WHERE prompt_key = ? AND version = 1").run(key);
        db.prepare(
          "INSERT INTO prompt_versions(prompt_key, version, body, body_sha256, status, author_id, comment) VALUES (?, 2, ?, ?, 'active', NULL, ?)",
        ).run(key, body, crypto.createHash('sha256').update(body).digest('hex'), 'Уточнение владельца 2026-10-21: понятное объяснение лекарств и поддержка плана врача; review-required');
      }
    }).immediate();
  }

  /**
   * Привязка по окружению: ключ GigaChat в окружении → привязка на GigaChat-2-Max/Pro
   * (только DATA_MODE=synthetic: у внешних моделей data_class='synthetic_only', при real
   * шлюз их всё равно не вызовет — вторая проверка F-26). Нет ключа — возврат к local_stub.
   * Создаётся НОВАЯ версия привязки (история изменений сохраняется, автор — система).
   */
  function ensureBindingsForEnv() {
    const hasGigaKey = Boolean(process.env.GIGACHAT_AUTH_KEY);
    for (const purpose of PURPOSES) {
      const binding = activeBinding(purpose);
      const primary = binding ? modelById(binding.primary_model_id) : null;
      const wantGiga = hasGigaKey && config.dataMode !== 'real';
      const isGiga = primary && primary.adapter === 'gigachat_api';
      const gigaModel = (ident) => db.prepare("SELECT id FROM ai_models WHERE adapter='gigachat_api' AND model_ident=?").get(ident);
      // Основная модель по назначению: для шаблонов документов — GigaChat-3-Ultra, для остальных — 2-Max.
      const gigaMax = gigaModel(GIGA_PRIMARY[purpose] || 'GigaChat-2-Max');
      const gigaPro = gigaModel('GigaChat-2-Pro');
      // Автопривязка прошлого запуска, выбравшая другую основную модель, исправляется;
      // привязку, которую менял человек, не трогаем.
      const autoManaged = binding && String(binding.comment || '').startsWith('Автонастройка запуска');
      const staleAuto = wantGiga && isGiga && autoManaged && gigaMax && primary.id !== gigaMax.id;
      if (wantGiga === Boolean(isGiga) && !staleAuto) continue;
      const stubA = db.prepare("SELECT id FROM ai_models WHERE adapter='local_stub' AND title LIKE '%основная%'").get();
      const stubB = db.prepare("SELECT id FROM ai_models WHERE adapter='local_stub' AND title LIKE '%запасная%'").get();
      if (wantGiga && (!gigaMax || !gigaPro)) continue;
      const primaryId = wantGiga ? gigaMax.id : stubA && stubA.id;
      const fallbackId = wantGiga ? gigaPro.id : stubB && stubB.id;
      if (!primaryId) continue;
      const maxVersion = db.prepare('SELECT max(version) v FROM ai_binding_versions WHERE purpose = ?').get(purpose).v || 0;
      if (binding) db.prepare("UPDATE ai_binding_versions SET status='previous' WHERE id = ?").run(binding.id);
      db.prepare(
        "INSERT INTO ai_binding_versions(purpose, version, primary_model_id, fallback_model_id, status, comment) VALUES (?, ?, ?, ?, 'active', ?)",
      ).run(
        purpose,
        maxVersion + 1,
        primaryId,
        fallbackId || null,
        wantGiga
          ? 'Автонастройка запуска: в окружении есть GIGACHAT_AUTH_KEY (демо/синтетика)'
          : 'Автонастройка запуска: ключа GigaChat нет — работа без сети на local_stub',
      );
    }
    invalidate();
  }

  function bootstrap() {
    ensurePrompts();
    ensureBindingsForEnv();
  }

  return { getBinding, activePrompt, invalidate, bootstrap, PURPOSES, PROMPT_KEYS };
}

module.exports = { createRegistry, PURPOSES, PROMPT_KEYS };
