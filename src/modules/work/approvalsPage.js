'use strict';

/**
 * «Утверждения» специалиста (P-51): очередь изменений настроек, ждущих отметки клинического ответственного.
 * Шаблон views/pages/work/approvals.ejs; решения — public/js/approvals.js (POST /api/v1/approvals/{id}/approve|reject).
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', '..', 'views', 'pages', 'work', 'approvals.ejs');
const template = ejs.compile(fs.readFileSync(TEMPLATE_PATH, 'utf8'), { filename: TEMPLATE_PATH });

// Человеческие названия настроек: код (crisis.sla) на экране не показываем.
const TITLES = {
  'crisis.sla': 'Срок реакции на кризисную фразу',
  'crisis.contacts': 'Кризисные контакты',
  'crisis.outcome_due_hours': 'Срок отметки исхода кризиса',
  'messages.channel': 'Срок ответа на сообщение',
  'ai.enabled': 'ИИ включён',
  'ai.limits': 'Лимиты ИИ',
  'analytics.min_group': 'Минимальная группа в аналитике',
  'auth.session_timeouts': 'Время жизни сеанса',
  'pv.responsible': 'Ответственный по фармаконадзору',
  'org.timezone_hours': 'Часовой пояс и рабочие часы клиники',
  'queue.due': 'Сроки по запросам',
  'service.maintenance': 'Технические работы',
  'ui.undo_window_seconds': 'Время на «Отменить»',
};

function summary(v) {
  if (v === null || v === undefined) return 'не задано';
  if (typeof v === 'boolean') return v ? 'включено' : 'выключено';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  const text = JSON.stringify(v);
  return text.length > 70 ? text.slice(0, 70) + '…' : text;
}

function render({ t, items }) {
  const rows = items.map((a) => ({
    id: a.id,
    title: TITLES[a.setting_key] || t('msg.approvals.setting.other'),
    from: summary(a.from_value),
    to: summary(a.to_value),
    author: a.author_name || t('msg.approvals.author.unknown'),
    date: String(a.created_at || '').slice(0, 10),
  }));
  return template({ t, items: rows });
}

module.exports = { render };
