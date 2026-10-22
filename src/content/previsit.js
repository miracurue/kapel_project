'use strict';

// Опросник перед приёмом (REQ-PAT-025). Вопросы — ЗАГЛУШКИ, REVIEW-REQUIRED. Все вопросы необязательны.
// type: scale (1-10) | choice | text. Свободный текст проходит кризисный шлюз (REQ-PAT-016).

const QUESTIONS = Object.freeze([
  { id: 'general', type: 'scale', text: 'Как вы в целом чувствовали себя последнюю неделю? (1 — очень тяжело, 10 — хорошо)' },
  { id: 'topics', type: 'text', text: 'Что вам хотелось бы обсудить на приёме?' },
  { id: 'sleep_appetite', type: 'text', text: 'Изменились ли сон или аппетит? Если да, как?' },
  { id: 'meds', type: 'choice', text: 'Как проходит приём лекарств, о котором вы договаривались с врачом?', options: [
    { v: 'as_agreed', t: 'Как договорились' }, { v: 'partly', t: 'Частично' }, { v: 'not', t: 'Не принимаю' }, { v: 'na', t: 'Лекарства не назначены' } ] },
  { id: 'side', type: 'text', text: 'Есть ли ощущения, о которых вы хотите рассказать врачу?' },
  { id: 'other', type: 'text', text: 'Что-то ещё, что важно врачу?' },
]);

module.exports = { QUESTIONS, byId: (id) => QUESTIONS.find((q) => q.id === id) || null };
