'use strict';

/**
 * Провайдер ИИ — единственная точка, где ответ ассистента вообще порождается.
 *
 * Интерфейс:  generate({ role, messages, context }) -> Promise<{ text, sources, flags }>
 *   role     — 'patient' | 'clinician' (роль, для которой отвечаем);
 *   messages — [{ role: 'user'|'assistant', text }] — история треда, последнее — вопрос;
 *   context  — произвольные данные вызывающего (для врача: материалы пациента и т.п., W1.C2);
 *   sources  — [{ title, ... }] ссылки на материалы, на которых построен ответ (у заглушки пусто);
 *   flags    — { provider, ... }.
 * Алиас reply(thread, message, context) оставлен под формулировку REQ-AIP-008.
 *
 * ГАРАНТИИ (REQ-AIP-006/008/010):
 *  - провайдер вызывается ТОЛЬКО после детерминированной кризисной проверки (см. chatService.js /
 *    crisisGate.js): кризисное сообщение сюда не попадает;
 *  - локальная заглушка `local_stub` не делает сетевых запросов; внешняя модель НЕ подключена;
 *  - ответ любого провайдера проходит пост-фильтр outputFilter (диагнозы/дозы/лекарства/обещания).
 *
 * ТОЧКА ПОДКЛЮЧЕНИЯ БУДУЩЕЙ МОДЕЛИ: registerProvider('name', { generate }) и AI_PROVIDER=name.
 * Подключение внешней модели — отдельное решение владельца (DECISIONS 2026-10-10, COMPLIANCE.md):
 * до него ни один запрос с текстом пациента не должен покидать процесс.
 */

const chatbot = require('../chatbot');
const outputFilter = require('./outputFilter');
const texts = require('./texts');

// ---------- шаблоны заглушки (review-required, без диагнозов/доз/обещаний) ----------

const T = {
  diagnosisAsk:
    'Понимаю, что хочется ясности. Поставить диагноз может только врач после очного разговора и обследования, а я этого не делаю. '
    + 'Могу помочь записать, что вас беспокоит и как давно, — так будет проще рассказать об этом врачу.',
  medicationAsk:
    'Вопросы о лекарствах, дозах и их отмене нужно решать только с врачом — я не даю таких советов. '
    + 'Если что-то беспокоит в лечении, запишите свои вопросы, и я помогу их сформулировать для приёма.',
  results:
    'Результат теста — это не диагноз, а один из ориентиров для разговора с врачом. Баллы зависят от дня, самочувствия и даже настроения при заполнении. '
    + 'Врач увидит результат в своём кабинете. Можно записать вопросы, которые хочется ему задать.',
  appointment:
    'Хороший план для приёма: 1) что беспокоит и как давно; 2) как это влияет на сон, работу, общение; 3) что помогало, а что нет; '
    + '4) вопросы к врачу. Всё это удобно набросать заранее — например, в дневнике настроения.',
  diary:
    'Дневник настроения — это короткая оценка дня от 1 до 10 и, если хочется, заметка. Достаточно пары секунд в день. '
    + 'Оценки видны врачу, если вы делитесь ими; заметки по умолчанию остаются только у вас.',
  talk:
    'Я здесь и готов вас выслушать. Расскажите, как прошёл ваш день и что сейчас занимает мысли. Спешить не нужно.',
  anxiety:
    'Тревога — частое состояние, и вы не обязаны справляться с ней в одиночку. Иногда помогает медленное дыхание: вдох на четыре счёта, выдох на шесть, несколько минут. '
    + 'Если тревога держится или мешает жить, обязательно расскажите об этом врачу — можно записать ощущения в дневник.',
  thanks: 'Пожалуйста. Если захотите продолжить или появится что-то ещё — я здесь. Если станет тяжелее, не откладывайте обращение к врачу.',
  clinicianStub:
    'Это локальная заглушка ИИ-пространства врача: настоящая модель не подключена. Ответ на ваш запрос не сформирован. '
    + 'Решения по пациенту всегда принимает врач.',
};

function detectTopic(text) {
  const t = String(text || '').toLowerCase();
  if (/(какой\s+у\s+меня\s+диагноз|у\s+меня\s+депресс|это\s+депресс|поставь(те)?\s+диагноз|что\s+со\s+мной|я\s+болен|я\s+больн)/.test(t)) return 'diagnosisAsk';
  if (/(таблетк|лекарств|препарат|доз[аыу]|антидепресс|снотворн|принимать|пить\s+ли|отменить)/.test(t)) return 'medicationAsk';
  if (/(результат|баллы?|тест|опросник|шкал)/.test(t)) return 'results';
  if (/(приём|прием|к\s+врачу|визит|запис[аь])/.test(t)) return 'appointment';
  if (/(дневник|настроени)/.test(t)) return 'diary';
  if (/(поговорить|выслушай|пообщаться)/.test(t)) return 'talk';
  if (/(тревож|страшно|паник).*(что\s+(можно\s+)?(попробовать|делать)|как\s+справ|как\s+быть)/.test(t)) return 'anxiety';
  if (/(спасибо|благодар)/.test(t)) return 'thanks';
  return null;
}

const localStub = {
  name: 'local_stub',
  async generate({ role, messages, context }) {
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user');
    const text = lastUser ? lastUser.text : '';
    if (role === 'clinician') {
      // ИИ-пространство врача (W1.C2): сценарии и шаблоны, данные сервиса приходят в context (без идентификаторов)
      return require('./workspace/stub').generate({ messages, context });
    }
    const topic = detectTopic(text);
    if (topic) return { text: T[topic], sources: [], flags: { provider: 'local_stub', topic } };
    // Остальное — существующий детерминированный сценарий chatbot.js (приветствие, сон, грусть, по умолчанию).
    // Его ветка 'crisis' сюда недостижима (кризис перехвачен раньше), но на всякий случай не используем её текст.
    const { intent, reply } = chatbot.respond(text);
    if (intent === 'crisis') return { text: texts.FILTERED_REPLY, sources: [], flags: { provider: 'local_stub', topic: 'unexpected_crisis' } };
    return { text: reply, sources: [], flags: { provider: 'local_stub', topic: intent } };
  },
};

// ---------- реестр ----------

const providers = new Map([[localStub.name, localStub]]);
let override = null; // для тестов: setProvider(obj) подменяет выбор

function registerProvider(name, impl) {
  if (!name || !impl || typeof impl.generate !== 'function') throw new Error('provider must have generate()');
  providers.set(name, { name, ...impl });
}

function setProvider(impl) {
  override = impl || null;
}

function currentProvider() {
  if (override) return override;
  const wanted = process.env.AI_PROVIDER || 'local_stub';
  return providers.get(wanted) || localStub;
}

/**
 * Вызов провайдера + обязательный пост-фильтр вывода.
 * Исключение провайдера НЕ глотается — вызывающий (chatService) показывает «временно недоступен» (REQ-AIP-011).
 */
async function generate({ role, messages, context } = {}) {
  const p = currentProvider();
  const out = await p.generate({ role, messages: messages || [], context: context || {} });
  const text = out && typeof out.text === 'string' ? out.text : '';
  const verdict = outputFilter.check(text);
  if (!text || !verdict.ok) {
    return { text: texts.FILTERED_REPLY, sources: [], flags: { ...(out && out.flags), provider: p.name, filtered: true, matched: verdict.matched } };
  }
  return { text, sources: out.sources || [], flags: { ...(out.flags || {}), provider: p.name, filtered: false } };
}

function reply(thread, message, context) {
  const history = (thread && thread.messages) || [];
  return generate({ role: (thread && thread.role) || 'patient', messages: [...history, { role: 'user', text: message }], context });
}

module.exports = { generate, reply, registerProvider, setProvider, currentProvider, localStub };
