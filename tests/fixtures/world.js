'use strict';

// Тестовый мир: поддельные пользователи каждой роли и их связи. ТОЛЬКО синтетика (PD-24):
// имена вымышлены, почта — домен example.test (RFC 2606), телефонов и документов настоящих людей нет.
//
// Мир пишется прямо в базу после миграций (scripts/migrate.js, W-03) по именам таблиц и полей
// утверждённой схемы `files/11-database/schema.sql`. Публичной регистрации специалистов нет,
// а API админки появляется только в В5, поэтому специалистов и пациентов создаёт загрузчик.
// Всё остальное (сигналы, планы, НЯ, сообщения) тесты создают через API, как пользователи.
// Подгонка загрузчика к фактическим миграциям (имя колонки, формат HMAC) требования не меняет:
// её одобряет основная сессия по разделу 10 стандартов.

const crypto = require('crypto');
const path = require('path');

const PASSWORD = 'Synthetic-Pass-2026';

// key — имя в тестах; role — роль схемы; R — номер роли из 03.
const PEOPLE = [
  { key: 'admin1', R: 'R-05', role: 'admin', name: 'Админ Тестовый Первый', email: 'admin1@cc.example.test' },
  { key: 'admin2', R: 'R-05', role: 'admin', name: 'Админ Тестовый Второй', email: 'admin2@cc.example.test' },
  { key: 'psy1', R: 'R-03', role: 'psychiatrist', name: 'Анна Синтетикова', email: 'psy1@cc.example.test', flags: { clinical_lead: 1, research: 1 } },
  { key: 'psy2', R: 'R-03', role: 'psychiatrist', name: 'Игорь Демонстров', email: 'psy2@cc.example.test' },
  { key: 'psy3', R: 'R-03', role: 'psychiatrist', name: 'Вера Резервная', email: 'psy3@cc.example.test', flags: { reference_reviewer: 1 } },
  { key: 'plg1', R: 'R-04', role: 'psychologist', name: 'Ольга Пробнова', email: 'plg1@cc.example.test', flags: { research: 1 } },
  { key: 'plg2', R: 'R-04', role: 'psychologist', name: 'Семён Модельный', email: 'plg2@cc.example.test' },
  // Пациенты. consents: base, ai, research, program (что дано).
  { key: 'patA', R: 'R-02', role: 'patient', name: 'Марина Тестова', email: 'pat.a@cc.example.test', clinicians: ['psy1', 'plg1'], consents: ['base', 'ai', 'research', 'program'] },
  { key: 'patB', R: 'R-02', role: 'patient', name: 'Олег Пробный', email: 'pat.b@cc.example.test', clinicians: ['psy2'], consents: ['base', 'ai'] },
  { key: 'patC', R: 'R-02', role: 'patient', name: 'Зоя Вымышленная', email: 'pat.c@cc.example.test', clinicians: [], consents: ['base', 'ai'] },
  { key: 'patD', R: 'R-02', role: 'patient', name: 'Пётр Условный', email: 'pat.d@cc.example.test', clinicians: ['psy1'], consents: ['base', 'ai'], archived: true },
  { key: 'patE', R: 'R-02', role: 'patient', name: 'Елена Удаляемая', email: 'pat.e@cc.example.test', clinicians: ['psy1'], consents: ['base'], status: 'deletion_requested' },
  { key: 'patF', R: 'R-07', role: 'patient', name: 'Фёдор Заблокированный', email: 'pat.f@cc.example.test', clinicians: ['psy1'], consents: ['base'], status: 'blocked', status_reason: 'suspicious' },
  { key: 'patG', R: 'R-02', role: 'patient', name: 'Галина Безии', email: 'pat.g@cc.example.test', clinicians: ['psy1'], consents: ['base'] },
  { key: 'patH', R: 'R-02', role: 'patient', name: 'Хасан Исследуемый', email: 'pat.h@cc.example.test', clinicians: ['psy1'], consents: ['base', 'ai', 'research', 'program'] },
  { key: 'patI', R: 'R-02', role: 'patient', name: 'Инна Безпсихиатра', email: 'pat.i@cc.example.test', clinicians: ['plg1'], consents: ['base', 'ai'] },
];

// Участники из extraPeople, переданные в loadWorld: byKey() должен находить и их (patJ, patK, patL).
let extraLoaded = [];

function byKey(key) {
  const p = PEOPLE.find((x) => x.key === key) || extraLoaded.find((x) => x.key === key);
  if (!p) throw new Error(`нет участника мира ${key}`);
  return p;
}

function hmacHex(key, value) {
  return crypto.createHmac('sha256', key).update(String(value).toLowerCase()).digest('hex');
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

// Вставка только тех полей, что есть в таблице (защита от мелких расхождений миграций со схемой 11).
function insert(db, table, row) {
  const cols = columns(db, table);
  if (cols.size === 0) throw new Error(`в базе нет таблицы ${table} (миграции W-03 ещё не применены?)`);
  const keys = Object.keys(row).filter((k) => cols.has(k));
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...keys.map((k) => row[k])).lastInsertRowid;
}

function consentVersionId(db, kind) {
  const row = db.prepare("SELECT id, body_sha256 FROM content_versions WHERE kind = ? AND status = 'published' ORDER BY version DESC LIMIT 1").get(`consent.${kind}`);
  if (row) return row;
  const body = `STAND-IN: текст согласия ${kind} (синтетика для тестов)`;
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const id = insert(db, 'content_versions', { kind: `consent.${kind}`, version: 1, body_md: body, body_sha256: sha, sign_method: 'demo_click', status: 'published', is_stand_in: 1, published_at: nowIso() });
  return { id, body_sha256: sha };
}

// Загружает мир в базу. env — переменные окружения теста (LOG_HMAC_KEY и т. п.).
function loadWorld(dbPath, env, { extra = [] } = {}) {
  const Database = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));
  const bcrypt = require(path.join(__dirname, '..', '..', 'node_modules', 'bcryptjs'));
  extraLoaded = extra;
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const ids = {};
  let n = 100;
  const tx = db.transaction(() => {
    for (const p of [...PEOPLE, ...extra]) {
      n += 1;
      const flags = p.flags || {};
      ids[p.key] = insert(db, 'users', {
        service_no: `Т-${String(n).padStart(5, '0')}`, // префикс «Т» — не пересекается с демо-сидом
        email: p.email,
        email_hmac: hmacHex(env.LOG_HMAC_KEY, p.email),
        password_hash: hash,
        role: p.role,
        full_name: p.name,
        status: p.status || 'active',
        status_reason: p.status_reason || null,
        is_demo: 1,
        flag_clinical_lead: flags.clinical_lead ? 1 : 0,
        flag_research: flags.research ? 1 : 0,
        flag_reference_reviewer: flags.reference_reviewer ? 1 : 0,
        password_changed_at: nowIso(-86400000),
        created_at: nowIso(-30 * 86400000),
      });
      insert(db, 'user_prefs', { user_id: ids[p.key], onboarding_done_at: p.onboardingPending ? null : nowIso(-86400000) });
    }
    for (const p of [...PEOPLE, ...extra].filter((x) => x.role === 'patient')) {
      for (const kind of p.consents || []) {
        const v = consentVersionId(db, kind);
        insert(db, 'consent_events', { user_id: ids[p.key], consent_kind: kind, action: 'given', content_version_id: v.id, text_sha256: v.body_sha256, sign_method: 'demo_click', created_at: nowIso(-20 * 86400000) });
      }
      const episode = insert(db, 'care_episodes', {
        patient_id: ids[p.key], started_at: nowIso(-20 * 86400000), opened_by: ids.admin1,
        ended_at: p.archived ? nowIso(-86400000) : null, ended_by: p.archived ? ids.psy1 : null,
        end_reason: p.archived ? 'course_completed' : null,
      });
      for (const c of p.clinicians || []) {
        insert(db, 'care_assignments', {
          patient_id: ids[p.key], clinician_id: ids[c], episode_id: episode, started_at: nowIso(-20 * 86400000), created_by: ids.admin1,
          ended_at: p.archived ? nowIso(-86400000) : null, ended_by: p.archived ? ids.psy1 : null, end_reason: p.archived ? 'archive' : null,
        });
      }
    }
  });
  tx();
  db.close();
  return ids;
}

module.exports = { PASSWORD, PEOPLE, byKey, loadWorld, insert, hmacHex, nowIso };
