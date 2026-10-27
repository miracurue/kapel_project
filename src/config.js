'use strict';

const fs = require('fs');
const path = require('path');

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === '1' || value === 'true';
}

function loadConfig(env = process.env) {
  const root = path.resolve(__dirname, '..');
  const config = {
    env: env.NODE_ENV || 'development',
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3000),
    dataMode: env.DATA_MODE || 'synthetic',
    demoMode: bool(env.DEMO_MODE, true),
    dbPath: env.DB_PATH || path.join(root, 'data', 'tdr.sqlite3'),
    dataDir: env.DATA_DIR || path.join(root, 'data'),
    baseUrl: env.PUBLIC_BASE_URL || `http://127.0.0.1:${env.PORT || 3000}`,
    sessionSecret: env.SESSION_SECRET || '',
    secretsMasterKey: env.SECRETS_MASTER_KEY || '',
    piiEncKey: env.PII_ENC_KEY || '',
    piiHmacKey: env.PII_HMAC_KEY || '',
    clinicalEncKey: env.CLINICAL_ENC_KEY || '',
    logHmacKey: env.LOG_HMAC_KEY || '',
    smtpHost: env.SMTP_HOST || '127.0.0.1',
    smtpPort: Number(env.SMTP_PORT || 1025),
    smtpSecure: bool(env.SMTP_SECURE, false),
    mailFrom: env.MAIL_FROM || 'noreply@cc.example.test',
    schedulerTickMs: Number(env.SCHEDULER_TICK_MS || 60000),
    clockFile: env.CC_CLOCK_FILE || '',
    fileScanner: env.FILE_SCANNER || 'none',
    mlWorkerUrl: env.ML_WORKER_URL || '',
    mlWorkerToken: env.ML_WORKER_TOKEN || '',
    // Пуш-уведомления (Web Push): 'webpush' — отправлять, 'dry' — только записывать в журнал (тесты, демо без ключей), 'off' — выключено.
    pushMode: env.PUSH_MODE || 'webpush',
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || '',
    pushExtraHosts: (env.PUSH_ENDPOINT_HOSTS || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    mlNerTimeoutMs: Number(env.ML_NER_TIMEOUT_MS || 5000),
  };
  if (!['synthetic', 'real'].includes(config.dataMode)) throw new Error('E-CONFIG: DATA_MODE');
  if (!['none', 'clamd'].includes(config.fileScanner)) throw new Error('E-CONFIG: FILE_SCANNER');
  if (!['webpush', 'dry', 'off'].includes(config.pushMode)) throw new Error('E-CONFIG: PUSH_MODE');
  if (config.dataMode === 'real' && config.demoMode) throw new Error('E-CONFIG: DEMO_MODE недопустим при real');
  if (config.env === 'production') {
    for (const [name, value] of [
      ['SESSION_SECRET', config.sessionSecret],
      ['SECRETS_MASTER_KEY', config.secretsMasterKey],
      ['PII_ENC_KEY', config.piiEncKey],
      ['PII_HMAC_KEY', config.piiHmacKey],
      ['CLINICAL_ENC_KEY', config.clinicalEncKey],
      ['LOG_HMAC_KEY', config.logHmacKey],
    ])
      if (String(value).length < 32) throw new Error(`E-CONFIG: ${name}`);
  }
  if (config.env === 'test' && config.dataMode === 'real') {
    if (env.FILE_SCANNER === 'none') throw new Error('E-CONFIG: FILE_SCANNER');
    if (env.REAL_MODE_CHECKLIST !== '1') throw new Error('E-CONFIG: REAL_MODE_CHECKLIST');
  }
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return config;
}

function now(config) {
  let offset = 0;
  if (config.clockFile) {
    try {
      offset = Number(JSON.parse(fs.readFileSync(config.clockFile, 'utf8')).offset_ms || 0);
    } catch (_) {
      offset = 0;
    }
  }
  return new Date(Date.now() + offset);
}

module.exports = { loadConfig, now };
