'use strict';

/**
 * Адаптер `local_stub` — локальная заглушка модели (без сети; тесты и демо, M-19).
 *
 * Контракт тестового крюка (tests/lib/fakes/ai_stub.js, NODE_ENV=test):
 *   AI_STUB_CAPTURE=<файл> — по строке JSON на КАЖДЫЙ вызов:
 *     { purpose, model, binding_version, prompt_key, prompt_version, system, messages, tools }
 *   AI_STUB_SCRIPT=<файл>  — { queue:[...], default:{...} }, режимы:
 *     text {text, delay_ms?} | echo | error | timeout | empty | tool {name, arguments}.
 * Без файлов адаптер возвращает пустой ответ (E-AI-EMPTY): осмысленные шаблонные ответы
 * старого детерминированного чата остаются в src/ai/provider.js (прежний путь /chat).
 */

const fs = require('fs');

function lastUserContent(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] && arr[i].role === 'user') return String(arr[i].content || '');
  }
  return '';
}

// Демо-режим с инструментами: по ключевым словам вопроса «вызывает» нужный инструмент, затем отвечает по его результату.
function demoToolStep(payload) {
  const messages = payload.messages || [];
  const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
  const names = payload.tools.map((d) => d.name);
  const after = messages[messages.length - 1];
  if (after && after.role === 'tool' && lastTool)
    return {
      text: `Демо-ответ по данным инструмента ${lastTool.name}: ${String(lastTool.content).replace(/\s+/g, ' ').slice(0, 600)}`,
    };
  const full = lastUserContent(messages);
  const q = full.includes('Сообщение врача:') ? full.split('Сообщение врача:').pop().toLowerCase() : full.toLowerCase();
  const pick = (name, re) => (names.includes(name) && re.test(q) ? name : null);
  const name =
    pick('get_my_medications', /лекарств|таблетк|принял|приняла|препарат/) ||
    pick('get_my_tests', /тест|опросник/) ||
    pick('search_journal', /стать|почитать|журнал|прочитать/) ||
    pick('get_my_diary', /дневник|заполнил|записал/) ||
    pick('get_diary', /дневник|настроени|сон|тревог|заметк/) ||
    pick('get_results', /тест|результат|шкал|phq|gad|балл/) ||
    pick('get_plan', /план|препарат|назначен|доз|лекарств/) ||
    pick('get_adverse_events', /побочн|нежелат/) ||
    pick('get_visits', /визит|приём|прием/) ||
    (names.includes('get_overview') ? 'get_overview' : null);
  const args = name === 'search_journal' ? { query: q.slice(0, 120) } : {};
  return name ? { text: '', tool: { id: `demo_${name}`, name, arguments: args } } : null;
}

function createLocalStub() {
  return {
    name: 'local_stub',
    /** @returns {Promise<{text: string, tool?: object, usage?: object}>} */
    async call({ payload, signal, meta }) {
      const capturePath = process.env.AI_STUB_CAPTURE;
      if (capturePath) {
        const line = JSON.stringify({
          purpose: meta.purpose,
          model: meta.modelIdent,
          binding_version: meta.bindingVersion,
          prompt_key: meta.promptKey,
          prompt_version: meta.promptVersion,
          prompt_layers: meta.promptLayers || null,
          system: payload.system,
          messages: payload.messages,
          tools: payload.tools || null,
        });
        fs.appendFileSync(capturePath, `${line}\n`);
      }
      let item = null;
      const scriptPath = process.env.AI_STUB_SCRIPT;
      if (scriptPath) {
        try {
          const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
          const queue = Array.isArray(script.queue) ? script.queue : [];
          item = queue.length ? queue.shift() : script.default || null;
          if (queue.length || script.queue)
            fs.writeFileSync(scriptPath, JSON.stringify({ queue, default: script.default || {} }));
        } catch (e) {
          item = null;
        }
      }
      const mode = item && item.mode;
      if (mode === 'error') throw Object.assign(new Error('local_stub: запрошенная ошибка'), { adapterCode: 'error' });
      if (mode === 'timeout') {
        await new Promise((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('local_stub: таймаут'), { adapterCode: 'timeout' }));
          if (signal && signal.aborted) return abort();
          if (signal) signal.addEventListener('abort', abort, { once: true });
          // На случай отсутствия таймаута у вызывающего — предохранитель на 10 минут.
          const guard = setTimeout(resolve, 10 * 60 * 1000);
          if (signal) signal.addEventListener('abort', () => clearTimeout(guard), { once: true });
        });
      }
      if (mode === 'empty') return { text: '' };
      if (mode === 'tool') return { text: '', tool: { name: item.name, arguments: item.arguments || {} } };
      if (mode === 'echo') return { text: lastUserContent(payload.messages) };
      if (mode === 'text') {
        if (item.delay_ms) await new Promise((resolve) => setTimeout(resolve, Number(item.delay_ms)));
        return { text: String(item.text || '') };
      }
      if (process.env.AI_DEMO_REPLIES === '1' && payload.tools && payload.tools.length) {
        const demo = demoToolStep(payload);
        if (demo) return demo;
      }
      if (process.env.AI_DEMO_REPLIES === '1')
        return { text: demoReply(meta.purpose, lastUserContent(payload.messages), meta.promptKey) };
      return { text: '' };
    },
  };
}

/**
 * Демо-ответы (AI_DEMO_REPLIES=1): без модели показывают, как выглядит чат. Не диагнозы и не рекомендации
 * по лечению; помечены STAND-IN. По умолчанию выключены — тесты ждут пустой ответ.
 */
function demoReply(purpose, userText, promptKey) {
  if (purpose === 'patient_assistant') {
    return (
      'STAND-IN: это демонстрационный ответ без настоящей модели. Спасибо, что написали. ' +
      'Можно записать состояние в дневник, пройти короткий тест на вкладке «Методики» или отправить вопрос специалисту ' +
      'на вкладке «Врач». Если стало тяжело — «Мне нужна помощь · 112» всегда сверху.'
    );
  }
  if (purpose === 'clinician_chat' && /\[справочник препарата\]/.test(userText)) {
    // Вкладка «Лекарства»: пересказ справочной карточки, без клинических утверждений от себя.
    const card = String(userText).split('[справочник препарата]').pop().split('\n');
    const pick = (label) => (card.find((l) => l.startsWith(`${label}:`)) || '').trim();
    const facts = ['Препарат', 'Группа', 'АТХ', 'Отпуск', 'Торговые названия']
      .map(pick)
      .filter(Boolean)
      .map((l) => `• ${l.slice(0, 200)}`);
    const asked = String(userText).split('Вопрос специалиста:').pop().trim().slice(0, 200);
    return (
      'STAND-IN: настоящая ИИ-модель не подключена, это демонстрационный ответ.\n' +
      `Ваш вопрос: «${asked}».\n` +
      'Из справочной карточки:\n' +
      (facts.join('\n') || '• сведений нет') +
      '\nПодробный ответ даст подключённая модель; решение остаётся за специалистом.'
    );
  }
  if (purpose === 'clinician_chat') {
    const lines = String(userText)
      .split('\n')
      .filter((l) => l.trim())
      .slice(-8)
      .map((l) => `• ${l.slice(0, 160)}`);
    return (
      'STAND-IN: черновик для вашей проверки, настоящая ИИ-модель не подключена.\n' +
      'Данные, на которые опирается ответ:\n' +
      (lines.join('\n') || '• материалы не прикреплены') +
      '\nРешение остаётся за специалистом.'
    );
  }
  if (purpose === 'document_draft' && /^task\.article_(patient|specialist)$/.test(String(promptKey))) {
    // Демо-черновик статьи: каркас из основных мыслей автора, без клинических утверждений.
    const forPatients = promptKey === 'task.article_patient';
    const points = String(userText)
      .split('СООБЩЕНИЕ АВТОРА:')
      .pop()
      .split(/\n+|(?<=[.!?])\s+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6);
    const first = (points[0] || 'Материал').replace(/[.!?]+$/, '').slice(0, 80);
    return [
      `ЗАГОЛОВОК: ${first}`,
      `КРАТКО: ${first}.`,
      forPatients ? 'ТЕГИ: тема:первые-недели' : 'ТЕГИ: тема:практика',
      '---',
      `## ${first}`,
      '',
      ...points.map((p) => `${p.replace(/^[-•*]\s*/, '')}`).flatMap((p) => [p, '']),
      forPatients
        ? '### Когда обратиться к врачу\nЕсли что-то беспокоит или состояние ухудшилось — напишите специалисту в разделе «Врач». Если стало совсем тяжело — звоните 112.'
        : '### Практический вывод\nСТАНД-ИН: вывод для работы специалиста вносит автор.',
    ].join('\n');
  }
  if (purpose === 'document_draft' && promptKey === 'task.article_rewrite') {
    // Демо-правка: возвращает фрагмент с пометкой, чтобы в тестах и демо была видна подмена.
    const fragment = String(userText).split('ФРАГМЕНТ:').pop().trim();
    return `${fragment} (переформулировано)`;
  }
  if (purpose === 'document_draft' && promptKey === 'task.document_template') {
    // Демо-заготовка для кнопки «ИИ» в шаблонах врача: только пустые места, без клинического содержания.
    return [
      'Пациент: [ФИО]',
      'Дата: [дата]',
      '',
      'Основание обращения: [жалобы]',
      'Результаты тестов: [результаты тестов]',
      'Заключение: [вносит специалист]',
      'Рекомендации: [рекомендации]',
      '',
      'Специалист: [врач]',
    ].join('\n');
  }
  return '';
}

module.exports = { createLocalStub };
