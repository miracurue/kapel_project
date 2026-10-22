'use strict';

// Управление заглушкой-провайдером шлюза ИИ `local_stub` (12, «Среды»: в CI всегда local_stub, без сети).
//
// Контракт для W-30 (раздел Handoff отчёта 13): если NODE_ENV=test и заданы переменные окружения,
//   AI_STUB_CAPTURE=<файл> — local_stub дописывает в файл по одной JSON-строке на КАЖДЫЙ полученный вызов:
//       { purpose, model, binding_version, prompt_key, prompt_version, system, messages:[{role, content}], tools }
//       ровно то, что ушло бы в модель (после псевдонимизации F-80), — так тест проверяет, что в модель
//       попали только ключи #ТИП-N#, а инструкции отделены от данных пользователя;
//   AI_STUB_SCRIPT=<файл> — local_stub перед ответом читает файл { queue:[...], default:{...} } и
//       берёт первый элемент очереди (удаляя его) или default. Режимы:
//       {mode:'text', text}            — вернуть этот текст;
//       {mode:'echo'}                  — вернуть последнее сообщение пользователя как есть (с ключами);
//       {mode:'error'}                 — ошибка адаптера (для проверки запасной модели и E-AI-UNAVAILABLE);
//       {mode:'timeout'}               — не отвечать дольше таймаута назначения (E-AI-TIMEOUT);
//       {mode:'empty'}                 — пустой ответ (E-AI-EMPTY);
//       {mode:'tool', name, arguments} — вызов функции (ae_extraction, order_parse, admin_assistant, diagnostic_hints).
// Без файлов local_stub работает как сейчас (шаблонные ответы).

const fs = require('fs');

class AiStub {
  constructor(dir) {
    this.capture = `${dir}/ai-capture.jsonl`;
    this.script = `${dir}/ai-script.json`;
    fs.writeFileSync(this.capture, '');
    this.setDefault({ mode: 'text', text: 'Синтетический ответ заглушки: обсудите это с врачом на приёме.' });
  }

  env() {
    return { AI_STUB_CAPTURE: this.capture, AI_STUB_SCRIPT: this.script, AI_PROVIDER: 'local_stub' };
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.script, 'utf8')); } catch (_) { return { queue: [], default: {} }; }
  }

  setDefault(def) {
    const s = this.read();
    fs.writeFileSync(this.script, JSON.stringify({ queue: s.queue || [], default: def }));
  }

  queue(...items) {
    const s = this.read();
    fs.writeFileSync(this.script, JSON.stringify({ queue: [...(s.queue || []), ...items], default: s.default }));
  }

  reset() {
    fs.writeFileSync(this.capture, '');
    fs.writeFileSync(this.script, JSON.stringify({ queue: [], default: { mode: 'text', text: 'Синтетический ответ заглушки: обсудите это с врачом на приёме.' } }));
  }

  calls() {
    let raw = '';
    try { raw = fs.readFileSync(this.capture, 'utf8'); } catch (_) { return []; }
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  // Весь текст, который видела «модель», одной строкой — для поиска запрещённых значений.
  seenText() {
    return this.calls().map((c) => JSON.stringify(c)).join('\n');
  }

  callsFor(purpose) {
    return this.calls().filter((c) => c.purpose === purpose);
  }
}

module.exports = { AiStub };
