'use strict';

/**
 * Страница чата пациента (P-13, W-34): разметка из утверждённого прототипа v5,
 * шаблон views/pages/app/chat.ejs. Тексты — только ключами locales/ru.json.
 * ИИ-согласие выключено — поле заменяет строка msg.chat.ai_off (T-415).
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', '..', 'views', 'pages', 'app', 'chat.ejs');
const template = ejs.compile(fs.readFileSync(TEMPLATE_PATH, 'utf8'), { filename: TEMPLATE_PATH });

/**
 * @param {{ t: (key: string, fallback?: string) => string, aiOff?: boolean,
 *          today?: Array<{id: number, title: string}>, earlier?: Array<{id: number, title: string}>, reminders?: object[],
 *          pausedUntil?: string|null }} locals (pausedUntil — срок мягкой паузы чата, статус ТРОЛЛЬ: поле ввода неактивно с подписью)
 */
function render({ t, aiOff = false, today = [], earlier = [], reminders = [], pausedUntil = null }) {
  return template({ t, aiOff, today, earlier, reminders, pausedUntil });
}

module.exports = { render };
