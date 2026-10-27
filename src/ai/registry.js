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

const catalog = require('./promptCatalog');

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
// Ключи промптов — слои роль/инструменты/навык/задача (promptCatalog); привязка модели и лимиты остаются по назначению.
const PROMPT_KEYS = catalog.KEYS;
// Основная модель GigaChat по назначению, если она не GigaChat-2-Max.
const GIGA_PRIMARY = { document_draft: 'GigaChat-3-Ultra' };
const CACHE_TTL_MS = 30 * 1000;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const promptFile = (dir, key, version) =>
  path.join(dir, catalog.categoryOf(key), catalog.nameOf(key), `v${String(version).padStart(3, '0')}.md`);

function createRegistry({ db, config, now, promptsDir = path.join(ROOT, 'prompts') }) {
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
   * Загрузка промптов из prompts/<слой>/<имя>/vNNN.md (S-08). Первый запуск берёт v001. Дальше, если действует
   * нетронутая версия из файла и рядом лежит файл следующей версии, он становится действующим; версии, созданные
   * людьми, и ручные откаты не трогаются (тексты версий неизменяемы — триггер prompt_body_immutable).
   */
  function ensurePrompts() {
    const insert = db.prepare(
      'INSERT INTO prompt_versions(prompt_key, version, body, body_sha256, status, author_id, comment) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    );
    db.transaction(() => {
      for (const key of PROMPT_KEYS) {
        const rows = db.prepare('SELECT version, body_sha256, status FROM prompt_versions WHERE prompt_key = ?').all(key);
        if (!rows.length) {
          const file = promptFile(promptsDir, key, 1);
          if (!fs.existsSync(file)) continue;
          const body = fs.readFileSync(file, 'utf8');
          insert.run(key, 1, body, sha(body), 'active', 'Начальная версия из prompts/<слой>/<имя>/v001.md; текст review-required');
          // Чистая база: сразу идём по цепочке файлов vNNN+1.md, как при последующих запусках.
          let n = 1;
          while (fs.existsSync(promptFile(promptsDir, key, n + 1))) {
            const next = fs.readFileSync(promptFile(promptsDir, key, n + 1), 'utf8');
            db.prepare("UPDATE prompt_versions SET status = 'previous' WHERE prompt_key = ? AND version = ?").run(key, n);
            insert.run(key, n + 1, next, sha(next), 'active', `Версия из файла v${String(n + 1).padStart(3, '0')}.md; текст review-required`);
            n += 1;
          }
          continue;
        }
        const latest = rows.reduce((max, r) => Math.max(max, r.version), 0);
        const active = rows.find((r) => r.status === 'active');
        if (!active || active.version !== latest) continue;
        const currentFile = promptFile(promptsDir, key, active.version);
        const nextFile = promptFile(promptsDir, key, active.version + 1);
        if (!fs.existsSync(currentFile) || !fs.existsSync(nextFile)) continue;
        if (active.body_sha256 !== sha(fs.readFileSync(currentFile, 'utf8'))) continue;
        const body = fs.readFileSync(nextFile, 'utf8');
        db.prepare("UPDATE prompt_versions SET status = 'previous' WHERE prompt_key = ? AND version = ?").run(key, active.version);
        insert.run(key, active.version + 1, body, sha(body), 'active', `Версия из файла v${String(active.version + 1).padStart(3, '0')}.md; текст review-required`);
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
      // Привязку, заданную человеком (автор или пометка «Ручная настройка»), автонастройка не переписывает.
      if (binding && (binding.author_id || String(binding.comment || '').startsWith('Ручная настройка'))) continue;
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
