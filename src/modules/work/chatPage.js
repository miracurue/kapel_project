'use strict';

/**
 * Страница чата специалиста (P-20, W-35): разметка из утверждённого прототипа v5,
 * шаблон views/pages/work/chat.ejs. Тексты — только ключами locales/ru.json.
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', '..', 'views', 'pages', 'work', 'chat.ejs');
const template = ejs.compile(fs.readFileSync(TEMPLATE_PATH, 'utf8'), { filename: TEMPLATE_PATH });

/** @param {{ t: Function, patients: Array<{id: number, name: string}>, isPsychiatrist?: boolean, hintsEnabled?: boolean }} locals */
function render({ t, patients, isPsychiatrist = false, hintsEnabled = false }) {
  return template({ t, patients, isPsychiatrist, hintsEnabled });
}

module.exports = { render };
