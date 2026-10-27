'use strict';

// Согласия и версии текстов (AUDIT_CONSENT_ACCESS H6): одна строка content_versions — это и страница
// «Полный текст», и то, что записывается в consent_events (версия и хэш). Автосоздания «STAND-IN» версий здесь нет:
// тексты публикует миграция 0044 или админка (POST /admin/content/docs/{kind}/versions).

const crypto = require('crypto');

// Вид согласия или документа -> вид записи в content_versions.
const CONTENT_OF = {
  base: 'consent.base',
  ai: 'consent.ai',
  research: 'consent.research',
  program: 'consent.program',
  staff_pd: 'consent.staff_pd',
  agreement: 'doc.agreement',
  privacy: 'doc.policy',
};
// Адрес страницы с полным текстом.
const URL_OF = {
  base: '/legal/consent/base',
  ai: '/legal/consent/ai',
  research: '/legal/consent/research',
  program: '/legal/consent/program',
  staff_pd: '/legal/consent/staff_pd',
  agreement: '/legal/agreement',
  privacy: '/legal/privacy',
};
const PATIENT_KINDS = ['base', 'ai', 'research', 'program'];
const STAFF_KINDS = ['agreement', 'staff_pd'];
// Автозаглушка старого кода («STAND-IN: текст согласия base»): текста, который можно было бы перечитать, в ней нет.
const AUTO_PLACEHOLDER = /^STAND-IN: текст согласия /;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Вопрос к владелице: обязательно ли согласие на ИИ при регистрации. По умолчанию нет (AI_CONSENT_REQUIRED=1 включает).
const AI_REQUIRED = process.env.AI_CONSENT_REQUIRED === '1';
const isRequired = (kind) => kind === 'base' || (kind === 'ai' && AI_REQUIRED);

function createService({ db, P, config, now }) {
  const iso = () => P.iso(now(config));

  function published(contentKind) {
    return db
      .prepare("SELECT * FROM content_versions WHERE kind=? AND status='published' ORDER BY version DESC LIMIT 1")
      .get(contentKind);
  }

  /** Опубликованный текст для вида согласия или документа. */
  function current(kind) {
    const contentKind = CONTENT_OF[kind] || kind;
    const row = published(contentKind);
    if (!row) throw new Error(`E-INTERNAL: нет опубликованного текста ${contentKind}`);
    return row;
  }

  /** Принятое согласие действует для текущей версии: та же версия, либо принято по автозаглушке прежнего кода. */
  function stillValid(event, version) {
    if (!event || event.action !== 'given') return false;
    if (event.content_version_id === version.id) return true;
    const old = db.prepare('SELECT body_md, author_id FROM content_versions WHERE id=?').get(event.content_version_id);
    return Boolean(old && !old.author_id && AUTO_PLACEHOLDER.test(old.body_md));
  }

  function status(userId, kind) {
    const version = current(kind);
    const event = userId
      ? db.prepare('SELECT * FROM consent_current WHERE user_id=? AND consent_kind=?').get(userId, kind)
      : null;
    const given = event?.action === 'given';
    const accepted = event
      ? db.prepare('SELECT version FROM content_versions WHERE id=?').get(event.content_version_id)
      : null;
    return {
      kind,
      version: version.version,
      content_version_id: version.id,
      state: event?.action || 'not_given',
      required: isRequired(kind),
      stale: Boolean(given && !stillValid(event, version)),
      accepted_version: accepted ? accepted.version : null,
      accepted_at: event ? event.created_at : null,
      published_at: version.published_at,
      document_url: URL_OF[kind],
    };
  }

  const patientConsents = (userId) => PATIENT_KINDS.map((kind) => status(userId, kind));

  /** Что надо подтвердить пациенту после смены текста: обязательное блокирует, остальное — один раз за сеанс. */
  function renewal(userId) {
    const stale = patientConsents(userId).filter((c) => c.stale);
    return {
      blocking: stale.some((c) => c.kind === 'base'),
      kinds: stale.map((c) => c.kind).filter((k) => k !== 'program'),
    };
  }

  /** Запись в журнал согласий: версия и хэш того текста, который открывается по ссылке. Повтор того же — без новой записи. */
  function record(userId, kind, action, { ipHmac = null, at = null } = {}) {
    const version = current(kind);
    const last = db
      .prepare('SELECT action, content_version_id FROM consent_current WHERE user_id=? AND consent_kind=?')
      .get(userId, kind);
    if (last && last.action === action && last.content_version_id === version.id) return { version, written: false };
    db.prepare(
      'INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method,ip_hmac,created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      userId,
      kind,
      action,
      version.id,
      version.body_sha256,
      version.sign_method || 'demo_click',
      ipHmac,
      at || iso(),
    );
    return { version, written: true };
  }

  const staffTerms = (userId) => STAFF_KINDS.map((kind) => status(userId, kind));
  const staffTermsMissing = (userId) => staffTerms(userId).some((c) => c.state !== 'given' || c.stale);

  const ipHmac = (req) => P.hmac(config, req.socket?.remoteAddress || 'local');
  const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

  return {
    current,
    status,
    patientConsents,
    renewal,
    record,
    staffTerms,
    staffTermsMissing,
    ipHmac,
    sha,
    iso,
  };
}

module.exports = { createService, CONTENT_OF, URL_OF, PATIENT_KINDS, STAFF_KINDS, EMAIL_RE, isRequired, AI_REQUIRED };
