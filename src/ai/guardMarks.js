'use strict';

/**
 * Служебные метки защитных слоёв (prompts/guard/*). Их ставит модель по смыслу, шлюз вырезает из текста до показа
 * и до сохранения. Здесь только разбор меток, без оценки темы и тона: оценка — дело модели (словарей нет).
 *   [[OFFTOPIC]] — обращение специалиста бессмысленно или не по теме (guard.scope_clinician);
 *   [[GAME]], [[RUDE]] — заигрывание/проверка и грубость в чате пациента (guard.patient_conduct).
 */

const OFF_TOPIC_RE = /\[\[\s*OFFTOPIC\s*\]\]/i;
// Допускаем одинарные скобки и регистр: модель иногда сокращает метку.
const CONDUCT_RE = /\[{1,2}\s*(GAME|RUDE)\s*\]{1,2}/gi;

const hasOffTopic = (text) => OFF_TOPIC_RE.test(String(text || ''));

/** Вырезает метки поведения: { text, marks } — marks в порядке появления, без повторов. */
function stripConduct(text) {
  const marks = [];
  const cleaned = String(text || '')
    .replace(CONDUCT_RE, (_, kind) => {
      const k = kind.toUpperCase();
      if (!marks.includes(k)) marks.push(k);
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, marks };
}

/** Одна метка на сообщение: при двух побеждает грубость (RUDE), она важнее. */
const pickMark = (marks) => (marks.includes('RUDE') ? 'RUDE' : marks.includes('GAME') ? 'GAME' : null);

/**
 * Тривиальная проверка без модели: в тексте меньше двух букв или цифр (пусто, «ф», «?»). Смысл не оценивается,
 * это только отсечка очевидной пустоты; всё остальное решает модель.
 */
function isTrivial(text) {
  const letters = String(text || '').match(/[\p{L}\p{N}]/gu);
  return !letters || letters.length < 2;
}

module.exports = { hasOffTopic, stripConduct, pickMark, isTrivial };
