'use strict';

/**
 * Журналы и состояние сервиса для администратора (F-114, F-115). Контракт — docs/openapi.yaml:
 *   GET /api/v1/admin/logs/{journal}   — access | actions | ai | exports | consents | requests | crisis
 *   GET /api/v1/admin/service/status   — версия, режим, база, ml-worker, почта, ИИ
 * Только чтение. Пациент в журналах — только служебным номером (PD-20); текстов и значений
 * псевдонимов в выдаче нет. Роль проверяется здесь повторно (контрактный слой — первым).
 */

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 50;
const MAX_PERIOD_MS = 2 * 365 * 86400000;

// Для сотрудников — имя, для пациентов — только номер.
const who = (alias) => `CASE WHEN ${alias}.role = 'patient' THEN ${alias}.service_no ELSE ${alias}.full_name END`;

const JOURNALS = {
  access: {
    from: `phi_access_log l LEFT JOIN users a ON a.id = l.actor_id LEFT JOIN users p ON p.id = l.patient_id`,
    cols: `l.id, l.created_at AS at, ${who('a')} AS actor, l.actor_role, p.service_no AS patient_no,
           (l.section || ':' || l.action) AS action, COALESCE(l.object_type || '#' || l.object_id, '') AS object, l.decision AS decision`,
    date: 'l.created_at',
    actor: 'l.actor_id',
    patient: 'p.service_no',
    action: "(l.section || ':' || l.action)",
  },
  actions: {
    from: `action_log l LEFT JOIN users a ON a.id = l.actor_id LEFT JOIN users t ON t.id = l.target_user_id`,
    cols: `l.id, l.created_at AS at, COALESCE(${who('a')}, 'система') AS actor, l.actor_role, t.service_no AS patient_no,
           l.action AS action, COALESCE(l.target_type || '#' || l.target_id, '') AS object, '' AS decision`,
    date: 'l.created_at',
    actor: 'l.actor_id',
    patient: 't.service_no',
    action: 'l.action',
  },
  ai: {
    from: `ai_audit l LEFT JOIN users a ON a.id = l.user_id LEFT JOIN users p ON p.id = l.patient_id`,
    cols: `l.id, l.created_at AS at, ${who('a')} AS actor, l.role AS actor_role, p.service_no AS patient_no,
           (l.purpose || ':' || l.status) AS action, COALESCE('диалог #' || l.thread_id, '') AS object, CASE WHEN l.crisis = 1 THEN 'кризис' ELSE '' END AS decision`,
    date: 'l.created_at',
    actor: 'l.user_id',
    patient: 'p.service_no',
    action: "(l.purpose || ':' || l.status)",
  },
  exports: {
    from: `export_log l LEFT JOIN users a ON a.id = l.actor_id LEFT JOIN users p ON p.id = l.patient_id`,
    cols: `l.id, l.created_at AS at, ${who('a')} AS actor, a.role AS actor_role, p.service_no AS patient_no,
           l.kind AS action, (l.row_count || ' строк') AS object, COALESCE(l.consent_filter, '') AS decision`,
    date: 'l.created_at',
    actor: 'l.actor_id',
    patient: 'p.service_no',
    action: 'l.kind',
  },
  consents: {
    from: `consent_events l LEFT JOIN users p ON p.id = l.user_id`,
    cols: `l.id, l.created_at AS at, p.service_no AS actor, p.role AS actor_role, p.service_no AS patient_no,
           (l.consent_kind || ':' || l.action) AS action, ('версия текста #' || l.content_version_id) AS object, l.sign_method AS decision`,
    date: 'l.created_at',
    actor: 'l.user_id',
    patient: 'p.service_no',
    action: "(l.consent_kind || ':' || l.action)",
  },
  requests: {
    from: `data_subject_requests l LEFT JOIN users p ON p.id = l.patient_id`,
    cols: `l.id, l.requested_at AS at, p.service_no AS actor, 'patient' AS actor_role, p.service_no AS patient_no,
           l.request_type AS action, COALESCE(l.subject_ref_type || '#' || l.subject_ref_id, '') AS object, l.status AS decision`,
    date: 'l.requested_at',
    actor: 'l.patient_id',
    patient: 'p.service_no',
    action: 'l.request_type',
  },
  crisis: {
    from: `crisis_incident_log l LEFT JOIN users a ON a.id = l.actor_id LEFT JOIN users p ON p.id = l.patient_id`,
    cols: `l.id, l.created_at AS at, COALESCE(${who('a')}, 'система') AS actor, a.role AS actor_role, p.service_no AS patient_no,
           l.event_type AS action, ('эскалация #' || l.escalation_id) AS object, '' AS decision`,
    date: 'l.created_at',
    actor: 'l.actor_id',
    patient: 'p.service_no',
    action: 'l.event_type',
  },
};

function install(app, { db, P, config }) {
  const adminOnly = (req, res) => {
    if (!req.user || req.user.role !== 'admin') {
      P.sendError(req, res, 403, 'E-ACCESS');
      return false;
    }
    return true;
  };
  const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);

  app.get('/api/v1/admin/logs/:journal', (req, res) => {
    if (!adminOnly(req, res)) return undefined;
    const def = JOURNALS[req.params.journal];
    if (!def) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const from = day(req.query.from);
    const to = day(req.query.to);
    if ((req.query.from && !from) || (req.query.to && !to)) return P.sendError(req, res, 422, 'E-VALIDATION');
    if (from && to && new Date(to) - new Date(from) > MAX_PERIOD_MS) return P.sendError(req, res, 422, 'E-VALIDATION');
    const where = [];
    const args = [];
    if (from) {
      where.push(`${def.date} >= ?`);
      args.push(`${from}T00:00:00Z`);
    }
    if (to) {
      where.push(`${def.date} <= ?`);
      args.push(`${to}T23:59:59Z`);
    }
    if (req.query.actor !== undefined && req.query.actor !== '') {
      where.push(`${def.actor} = ?`);
      args.push(Number(req.query.actor));
    }
    if (req.query.patient_no) {
      where.push(`${def.patient} LIKE ?`);
      args.push(`%${String(req.query.patient_no).replace(/[%_]/g, '').slice(0, 20)}%`);
    }
    if (req.query.action) {
      where.push(`${def.action} LIKE ?`);
      args.push(`%${String(req.query.action).replace(/[%_]/g, '').slice(0, 60)}%`);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${def.from}${clause}`).get(...args).n;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const items = db
      .prepare(`SELECT ${def.cols} FROM ${def.from}${clause} ORDER BY l.id DESC LIMIT ? OFFSET ?`)
      .all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return res.json({ items, page, page_size: PAGE_SIZE, total });
  });

  app.get('/api/v1/admin/service/status', (req, res) => {
    if (!adminOnly(req, res)) return undefined;
    const pkg = require('../../../../package.json');
    let dbBytes = null;
    try {
      dbBytes = fs.statSync(process.env.DB_PATH || path.join(config.dataDir, 'tdr.sqlite3')).size;
    } catch (_) {
      dbBytes = null;
    }
    let migrations = '';
    try {
      const m = db.prepare('SELECT version, name FROM schema_migrations ORDER BY rowid DESC LIMIT 1').get();
      migrations = m ? `${m.version} · ${m.name}` : '';
    } catch (_) {
      migrations = '';
    }
    const aiEnabled = (() => {
      try {
        const row = db.prepare("SELECT value_json FROM setting_versions WHERE key='ai.enabled' AND status='active' ORDER BY version DESC LIMIT 1").get();
        return row ? JSON.parse(row.value_json) : null;
      } catch (_) {
        return null;
      }
    })();
    return res.json({
      version: pkg.version,
      data_mode: config.dataMode,
      demo_mode: Boolean(config.demoMode),
      db: dbBytes === null ? 'нет данных' : `ok · ${(dbBytes / 1048576).toFixed(1)} МБ`,
      migrations,
      ml_worker: config.mlWorkerUrl ? 'настроен' : 'не настроен (голос и фото-распознавание недоступны)',
      mail: config.smtpHost ? `${config.smtpHost}:${config.smtpPort}` : 'не настроена',
      ai: { enabled: aiEnabled, demo_replies: process.env.AI_DEMO_REPLIES === '1' },
      jobs: [
        { name: 'планировщик (напоминания, сроки сигналов)', last_ok_at: null, failures: 0 },
        { name: 'очистка истории ИИ', last_ok_at: null, failures: 0 },
        { name: 'очередь писем', last_ok_at: null, failures: 0 },
      ],
    });
  });
}

module.exports = { install, JOURNALS };
