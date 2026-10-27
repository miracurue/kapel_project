'use strict';

/**
 * Пуш-уведомления о напоминаниях пациента (Web Push, решение владелицы 2026-10-26).
 * Напоминания считает src/modules/patient/reminders.js; здесь — подписки устройств, ключи VAPID, отбор того, что
 * пора отправить, и отправка. Запускается из планировщика (src/server.js, jobs).
 *
 * Правила:
 *  - в пуше нет сведений о здоровье: заголовок «Капель», текст «Есть напоминание» (виден на заблокированном экране);
 *  - каждое напоминание — не чаще раза в сутки (визит — один раз), тихие часы 23:00–7:00 по времени пациента;
 *  - вопрос о форме обращения пушем не напоминается;
 *  - адрес подписки принимается только от известных push-сервисов браузеров (иначе сервер стал бы ходить по чужим адресам);
 *  - режим PUSH_MODE=dry записывает отправку в журнал без сети (тесты и демо без ключей).
 */

const fs = require('fs');
const path = require('path');
const { dueReminders, localParts } = require('./reminders');

const QUIET_FROM_MIN = 23 * 60;
const QUIET_TO_MIN = 7 * 60;
const MAX_FAILS = 5;
const TITLE = 'Капель';
const BODY = 'Есть напоминание';

// Службы доставки браузеров: Chrome/Edge (FCM, Windows), Firefox (Mozilla), Safari (Apple).
const ALLOWED_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

const b64url = /^[A-Za-z0-9_-]{10,200}$/;

function createPush({ db, config, now = () => new Date(), webpush = null }) {
  let keys = null;

  function vapid() {
    if (keys) return keys;
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      keys = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
      return keys;
    }
    // Демо без ключей в окружении: создаём пару один раз и храним в каталоге данных.
    const file = path.join(config.dataDir, 'vapid.json');
    try {
      keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      keys = (webpush || require('web-push')).generateVAPIDKeys();
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    }
    return keys;
  }

  const enabled = () => config.pushMode !== 'off';
  const publicKey = () => (enabled() ? vapid().publicKey : null);

  function endpointAllowed(endpoint) {
    let url;
    try {
      url = new URL(endpoint);
    } catch (_) {
      return false;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return ALLOWED_HOSTS.some((re) => re.test(url.hostname)) || (config.pushExtraHosts || []).includes(url.hostname);
  }

  /** Сохраняет подписку устройства; возвращает false, если подписка не принята. */
  function subscribe(userId, sub) {
    if (!enabled() || !sub || typeof sub !== 'object') return false;
    const endpoint = String(sub.endpoint || '');
    const p256dh = String((sub.keys && sub.keys.p256dh) || '');
    const auth = String((sub.keys && sub.keys.auth) || '');
    if (endpoint.length > 600 || !endpointAllowed(endpoint) || !b64url.test(p256dh) || !b64url.test(auth)) return false;
    db.prepare(
      'INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,fail_count=0',
    ).run(userId, endpoint, p256dh, auth, now().toISOString());
    return true;
  }

  const unsubscribe = (userId, endpoint) =>
    db
      .prepare('DELETE FROM push_subscriptions WHERE user_id=? AND (? IS NULL OR endpoint=?)')
      .run(userId, endpoint || null, endpoint || null).changes;

  const subscribed = (userId) =>
    db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?').get(userId).n > 0;

  function keyOf(r) {
    if (r.kind === 'medication') return { key: `med:${r.slotKey}`, day: r.day };
    if (r.kind === 'diary') return { key: 'diary', day: r.day };
    if (r.kind === 'visit') return { key: `visit:${r.id}`, day: '' };
    // Назначенные тесты: один раз на набор назначенных методик, иначе пуш каждый день, пока тест не пройден.
    if (r.kind === 'test') return { key: `test:${r.names.join('|').slice(0, 120)}`, day: '' };
    return null; // profile и прочее пушем не напоминаем
  }

  async function sendTo(sub, payload) {
    if (config.pushMode === 'dry') return { ok: true };
    const lib = webpush || require('web-push');
    const k = vapid();
    try {
      await lib.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
        TTL: 3600,
        urgency: 'normal',
        vapidDetails: {
          subject: config.vapidSubject || config.baseUrl,
          publicKey: k.publicKey,
          privateKey: k.privateKey,
        },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, gone: e && (e.statusCode === 404 || e.statusCode === 410) };
    }
  }

  /** Один проход планировщика: отправляет то, что пора, пациентам с подписанными устройствами. Возвращает число отправок. */
  async function deliverDue({ timezone, labelOf } = {}) {
    if (!enabled()) return 0;
    const current = now();
    const patients = db
      .prepare(
        "SELECT DISTINCT s.user_id FROM push_subscriptions s JOIN users u ON u.id=s.user_id WHERE u.role='patient' AND u.status='active' AND s.fail_count<?",
      )
      .all(MAX_FAILS);
    let sent = 0;
    for (const { user_id: patientId } of patients) {
      const local = localParts(current, timezone);
      if (local.minutes >= QUIET_FROM_MIN || local.minutes < QUIET_TO_MIN) continue;
      const due = dueReminders(db, { patientId, now: current, timezone, labelOf }).map(keyOf).filter(Boolean);
      const fresh = due.filter(
        (k) =>
          !db
            .prepare('SELECT 1 FROM push_deliveries WHERE patient_id=? AND reminder_key=? AND day=?')
            .get(patientId, k.key, k.day),
      );
      if (!fresh.length) continue;
      const subs = db
        .prepare('SELECT * FROM push_subscriptions WHERE user_id=? AND fail_count<?')
        .all(patientId, MAX_FAILS);
      // Одно уведомление на проход, даже если пора несколько напоминаний: чтобы не засыпать устройство.
      const payload = JSON.stringify({ title: TITLE, body: BODY, tag: 'reminder', url: '/app?tab=chat' });
      let ok = 0;
      for (const sub of subs) {
        const r = await sendTo(sub, payload);
        if (r.ok) {
          ok += 1;
          db.prepare('UPDATE push_subscriptions SET last_ok_at=?,fail_count=0 WHERE id=?').run(
            current.toISOString(),
            sub.id,
          );
        } else if (r.gone) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
        else db.prepare('UPDATE push_subscriptions SET fail_count=fail_count+1 WHERE id=?').run(sub.id);
      }
      const status = config.pushMode === 'dry' ? 'dry' : ok ? 'sent' : 'failed';
      for (const k of fresh)
        db.prepare(
          'INSERT OR IGNORE INTO push_deliveries(patient_id,reminder_key,day,status,devices,created_at) VALUES (?,?,?,?,?,?)',
        ).run(patientId, k.key, k.day, status, ok, current.toISOString());
      if (ok) sent += 1;
    }
    return sent;
  }

  return { enabled, publicKey, subscribe, unsubscribe, subscribed, deliverDue, endpointAllowed };
}

module.exports = { createPush, TITLE, BODY, ALLOWED_HOSTS };
