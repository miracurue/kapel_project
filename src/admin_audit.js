'use strict';

/**
 * Просмотр журналов аудита (REQ-ADM-008). Журналы только на чтение: этот модуль и маршруты
 * не выполняют UPDATE/DELETE ни над одной из таблиц журналов.
 * Журналы: phi_access_log, export_audit_log, ai_audit, data_subject_requests, admin_action_log.
 */

const db = require('./db');

const PAGE_SIZE = 50;
const MAX_ROWS = 20000;

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

const LOGS = {
  phi: {
    title: 'Доступ к данным пациентов',
    hint: 'Кто и когда открывал карточку пациента, вкладку, экспорт или кризисную запись.',
    columns: [['created_at', 'Когда'], ['actor', 'Кто'], ['action', 'Действие'], ['subject', 'Чьи данные']],
    actorLabel: 'Кто смотрел', subjectLabel: 'Чьи данные (пациент)',
    sql: `SELECT l.id, l.created_at, l.action, l.actor_id, a.full_name AS actor, a.email AS actor_email,
                 l.patient_id AS subject_id, p.full_name AS subject, p.email AS subject_email
          FROM phi_access_log l LEFT JOIN users a ON a.id = l.actor_id LEFT JOIN users p ON p.id = l.patient_id`,
    dateCol: 'l.created_at', order: 'l.id DESC',
  },
  export: {
    title: 'Научный экспорт',
    hint: 'Каждый запуск экспорта: кто, когда, какой фильтр согласия, сколько строк.',
    columns: [['created_at', 'Когда'], ['actor', 'Кто запускал'], ['action', 'Строк в выгрузке'], ['detail', 'Фильтр согласия']],
    actorLabel: 'Кто запускал', subjectLabel: null,
    sql: `SELECT l.id, l.run_at AS created_at, l.run_by AS actor_id, a.full_name AS actor, a.email AS actor_email,
                 CAST(l.row_count AS TEXT) AS action, l.consent_filter AS detail
          FROM export_audit_log l LEFT JOIN users a ON a.id = l.run_by`,
    dateCol: 'l.run_at', order: 'l.id DESC',
  },
  ai: {
    title: 'Обращения к ИИ',
    hint: 'Кто, когда, в каком диалоге. Содержимого сообщений здесь нет.',
    columns: [['created_at', 'Когда'], ['actor', 'Кто'], ['action', 'Событие'], ['detail', 'Диалог / кризис / провайдер']],
    actorLabel: 'Кто', subjectLabel: null,
    sql: `SELECT l.id, l.created_at, l.user_id AS actor_id, a.full_name AS actor, a.email AS actor_email,
                 l.event AS action,
                 ('диалог ' || COALESCE(l.thread_id, '—') || (CASE WHEN l.crisis = 1 THEN ' · кризис' ELSE '' END) || ' · ' || COALESCE(l.provider, '—')) AS detail
          FROM ai_audit l LEFT JOIN users a ON a.id = l.user_id`,
    dateCol: 'l.created_at', order: 'l.id DESC',
  },
  dsr: {
    title: 'Запросы субъектов данных',
    hint: 'Отзыв согласия, запросы на удаление и их исполнение.',
    columns: [['created_at', 'Когда'], ['subject', 'Пациент'], ['action', 'Тип запроса'], ['detail', 'Статус']],
    actorLabel: null, subjectLabel: 'Пациент',
    sql: `SELECT l.id, l.requested_at AS created_at, l.patient_id AS subject_id, p.full_name AS subject, p.email AS subject_email,
                 (CASE l.request_type WHEN 'consent_revocation_and_deletion' THEN 'отзыв согласия и удаление' ELSE 'отзыв согласия на научный экспорт' END) AS action,
                 (CASE WHEN l.request_type = 'consent_revocation_and_deletion' THEN
                    (CASE l.status WHEN 'executed' THEN 'исполнен ' || COALESCE(substr(l.executed_at, 1, 10), '') ELSE 'ожидает исполнения' END)
                  ELSE 'учтён' END) AS detail
          FROM data_subject_requests l LEFT JOIN users p ON p.id = l.patient_id`,
    dateCol: 'l.requested_at', order: 'l.id DESC',
  },
  admin: {
    title: 'Действия администраторов',
    hint: 'Создание, сброс пароля, деактивация, переназначение, удаление. Пароли в журнал не пишутся.',
    columns: [['created_at', 'Когда'], ['actor', 'Кто'], ['action', 'Действие'], ['subject', 'Над кем']],
    actorLabel: 'Администратор', subjectLabel: 'Над кем',
    sql: `SELECT l.id, l.created_at, l.admin_id AS actor_id, a.full_name AS actor, a.email AS actor_email,
                 l.action, l.target_user_id AS subject_id, t.full_name AS subject, t.email AS subject_email, l.detail_json AS detail
          FROM admin_action_log l LEFT JOIN users a ON a.id = l.admin_id LEFT JOIN users t ON t.id = l.target_user_id`,
    dateCol: 'l.created_at', order: 'l.id DESC',
  },
};

const { actionLabel: sharedActionLabel, aiEventLabel } = require('./labels');

function actionLabel(a) {
  return sharedActionLabel(a);
}

function parseDate(s, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  return `${s} ${endOfDay ? '23:59:59' : '00:00:00'}`;
}

function matches(text, needle) {
  return !needle || norm(text).includes(norm(needle));
}

/** filters: { who, subject, action, from, to, page } -> { rows, total, page, pages } */
function query(logKey, filters = {}) {
  const def = LOGS[logKey];
  if (!def) return null;
  const where = [];
  const args = [];
  const from = parseDate(filters.from, false);
  const to = parseDate(filters.to, true);
  if (from) { where.push(`REPLACE(${def.dateCol}, 'T', ' ') >= ?`); args.push(from); }
  if (to) { where.push(`REPLACE(${def.dateCol}, 'T', ' ') <= ?`); args.push(to + '.999'); }
  const sql = `${def.sql} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${def.order} LIMIT ${MAX_ROWS}`;
  let rows = db.prepare(sql).all(...args);
  const who = String(filters.who || '').trim();
  const subject = String(filters.subject || '').trim();
  const action = String(filters.action || '').trim();
  const idOrText = (idVal, name, email, needle) => {
    if (/^#?\d+$/.test(needle)) return String(idVal) === needle.replace('#', '');
    return matches(name, needle) || matches(email, needle);
  };
  rows = rows.filter(
    (r) =>
      (!who || idOrText(r.actor_id, r.actor, r.actor_email, who)) &&
      (!subject || idOrText(r.subject_id, r.subject, r.subject_email, subject)) &&
      (!action || matches(r.action, action) || matches(actionLabel(r.action), action))
  );
  rows = rows.map((r) => ({
    ...r,
    actionText: logKey === 'phi' || logKey === 'admin' ? actionLabel(r.action) : logKey === 'ai' ? aiEventLabel(r.action) : r.action,
    actor: r.actor || (r.actor_id ? `пользователь №${r.actor_id}` : '—'),
    subject: r.subject || (r.subject_id ? `пользователь №${r.subject_id}` : '—'),
    detailText: logKey === 'admin' ? detailText(r.detail) : r.detail,
  }));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(filters.page, 10) || 1));
  return { rows, total, page, pages, pageRows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
}

function detailText(json) {
  if (!json) return '';
  try {
    const d = JSON.parse(json);
    return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ');
  } catch { return ''; }
}

// ---------- CSV (защита от формул, разделитель «;», BOM) ----------

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(logKey, rows) {
  const def = LOGS[logKey];
  const head = [...def.columns.map((c) => c[1]), ...(logKey === 'admin' ? ['Подробности'] : [])];
  const lines = [head.map(csvCell).join(';')];
  for (const r of rows) {
    const cells = def.columns.map(([k]) => (k === 'action' ? r.actionText : k === 'detail' ? r.detailText : r[k]));
    if (logKey === 'admin') cells.push(r.detailText);
    lines.push(cells.map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Статус научного экспорта: последние запуски, число пациентов с согласием. */
function exportStatus() {
  const eligible = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'patient' AND anonymized_export_opt_in = 1 AND export_consent_revoked_at IS NULL AND account_status = 'active'")
    .get().n;
  const revoked = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'patient' AND export_consent_revoked_at IS NOT NULL").get().n;
  const runs = db.prepare('SELECT COUNT(*) AS n, MAX(run_at) AS last FROM export_audit_log').get();
  const pseudonyms = db.prepare('SELECT COUNT(*) AS n FROM research_pseudonyms').get().n;
  return { eligible, revoked, runs: runs.n, lastRun: runs.last, pseudonyms };
}

module.exports = { LOGS, PAGE_SIZE, query, toCsv, csvCell, actionLabel, exportStatus };
