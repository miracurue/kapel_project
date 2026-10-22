'use strict';

/**
 * F-80 — обратимая псевдонимизация ПДн перед ИИ и обратная подстановка при показе/выгрузке.
 *
 * Область (scope) — пациент (scope_type='patient', scope_id=patient_id) или тред специалиста
 * без пациента (scope_type='thread'). Одно значение внутри области всегда получает один ключ
 * `#ТИП-N#` (таблица pii_values + счётчик pii_counters, см. схему этапа 11 / DB-93…DB-96).
 *
 * Значения шифруются AES-256-GCM ключом PII_ENC_KEY (src/crypto/field.js, формат v1:<key_id>:…),
 * поиск — по HMAC-SHA256(PII_HMAC_KEY, область|тип|нормализованное значение) без расшифровки.
 * Обратная подстановка — только для пользователя с доступом к области; чужие и выдуманные ключи
 * не подставляются (E-PSEUDO-UNKNOWN-KEY), при недоступном ключе шифрования — E-PSEUDO-DECRYPT.
 *
 * Распознавание: правила (regex, без сети — работают всегда) + Natasha NER через ml-worker /ner.
 * Если ml-worker недоступен — режим «только правила» (pii_mode='rules_only'), вызов продолжается.
 * Паттерны — review-required (владелец/юрист), эвристика, не гарантия обезличивания.
 */

const crypto = require('crypto');
const field = require('../../crypto/field');
const workspacePii = require('../workspace/pii');

// Типы ключей — как в CHECK pii_values.pii_type (миграция 0001).
const TYPES = new Set([
  'PERSON', 'PHONE', 'EMAIL', 'ADDRESS', 'PASSPORT', 'SNILS', 'POLICY', 'INN',
  'DOC', 'CARD', 'DATE_OF_BIRTH', 'ORG', 'NICK', 'URL',
]);

const KEY_RE = /#([A-Z_]+)-(\d{1,6})#/g;
// Пользовательские строки вида «#PERSON-1#» экранируются, чтобы не раскрывать значение при показе (F-80, критерий 6).
const SENTINEL = '\u0001';
const ESCAPED_KEY_RE = /\u0001([A-Z_]+-\d{1,6})\u0001/g;

// Типы, которые правила находят без NER: при сбое ml-worker они заменяются всегда (F-80 «Сбой распознавания»).
const RULE_TYPE_MAP = { fio: 'PERSON', phone: 'PHONE', email: 'EMAIL', snils: 'SNILS', passport: 'PASSPORT', polis: 'POLICY', address: 'ADDRESS', dob: 'DATE_OF_BIRTH' };

// Дополнительные правила к workspace/pii.js: карта, ИНН, ссылка, ник, номер медкарты, организация, адрес без «д.».
const EXTRA_RULES = [
  { type: 'CARD', re: /(?<![\d])2[0-6]\d{2}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?!\d)/g },
  { type: 'INN', re: /ИНН[:\s№N]*(\d{12}|\d{10})(?!\d)/gi },
  { type: 'URL', re: /https?:\/\/[^\s<>"']{4,200}/g },
  { type: 'NICK', re: /(?<![A-Za-z0-9_])@[A-Za-z0-9_]{3,30}(?![A-Za-z0-9_])/g },
  { type: 'DOC', re: /№\s*[А-ЯЁ]{1,4}-\d{4,}/g },
  { type: 'DOC', re: /(медкарт\w*|карт\w*|истори\w*)[^.\n]{0,8}№\s*\d{4,}/gi },
  { type: 'ORG', re: /(?:ООО|ОАО|ЗАО|ПАО|АО|АНО|НКО)\s*«[^»]{1,60}»/g },
  { type: 'ADDRESS', re: /(?:пр-т|проспект|ул\.|улица|пер\.|переулок)\s*[А-ЯЁ][а-яё\-]+,?\s*\d+(?:-\d+)*/g },
];

// При пересечении выигрывает более специфичный тип, затем более длинный фрагмент, затем более ранний.
const PRIORITY = ['PERSON', 'CARD', 'INN', 'SNILS', 'PASSPORT', 'POLICY', 'PHONE', 'EMAIL', 'URL', 'NICK', 'DOC', 'DATE_OF_BIRTH', 'ADDRESS', 'ORG'];

function normalize(type, value) {
  const v = String(value || '');
  switch (type) {
    case 'PHONE': {
      let digits = v.replace(/\D/g, '');
      if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
      if (digits.length === 10) digits = `7${digits}`;
      return digits;
    }
    case 'EMAIL':
      return v.toLowerCase();
    case 'PERSON':
    case 'ADDRESS':
    case 'ORG':
      return v.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
    case 'DATE_OF_BIRTH': {
      const m = v.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);
      if (m) {
        const year = m[3].length === 2 ? `19${m[3]}` : m[3];
        return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${year}`;
      }
      return v.replace(/\D/g, '');
    }
    case 'DOC':
      return v.toUpperCase().replace(/[^0-9A-ZА-ЯЁ]/g, '');
    default:
      return v.replace(/\D/g, '');
  }
}

/** Кандидаты от правил: базовые паттерны workspace/pii.js + дополнительные правила (карта, ИНН, ссылка, ник…). */
function ruleCandidates(text) {
  const src = String(text || '');
  const out = [];
  for (const m of workspacePii.detect(src)) {
    const type = RULE_TYPE_MAP[m.type];
    if (type) out.push({ type, start: m.start, end: m.end, value: m.value });
  }
  for (const rule of EXTRA_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src))) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      // для правил с группой берём координаты группы (ИНН), иначе всё совпадение
      let start = m.index;
      let value = m[0];
      if (rule.type === 'INN' && m[1]) {
        const rel = value.indexOf(m[1]);
        if (rel >= 0) { start += rel; value = m[1]; }
      }
      out.push({ type: rule.type, start, end: start + value.length, value });
    }
  }
  return out;
}

/** Снятие пересечений: более приоритетный тип, затем более длинный, затем более ранний. */
function resolveOverlaps(candidates) {
  const sorted = [...candidates].sort(
    (a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type)
      || (b.end - b.start) - (a.end - a.start)
      || a.start - b.start,
  );
  const taken = [];
  for (const c of sorted) {
    if (!taken.some((t) => c.start < t.end && c.end > t.start)) taken.push(c);
  }
  taken.sort((a, b) => a.start - b.start);
  return taken;
}

function createPii({ db, config, ml }) {
  const encKey = config.piiEncKey;
  const hmacKey = config.piiHmacKey || 'synthetic-test-key';
  function hmacHex(scope, type, normalized) {
    return crypto
      .createHmac('sha256', hmacKey)
      .update(`${scope.scopeType}:${scope.scopeId}:${type}:${normalized}`)
      .digest('hex');
  }

  /**
   * Заменяет значения ПДн ключами `#ТИП-N#` в области scope.
   * @param {{scopeType:'patient'|'thread', scopeId:number}} scope
   * @param {{nerEntities?:Array, nerOk?:boolean}} [opts]
   * @returns {{text, counts, mode}} counts — {ТИП: количество}, mode — 'ner+rules' | 'rules_only'
   */
  function pseudonymize(text, scope, { nerEntities = null, nerOk = false } = {}) {
    // 1. Экранируем ключи, введённые пользователем, — при показе они остаются текстом (критерий 6 карточки F-80).
    const prepared = String(text || '').replace(KEY_RE, (m) => `${SENTINEL}${m.slice(1, -1)}${SENTINEL}`);

    // 2. Кандидаты: правила + NER (координаты NER считаются в подготовленном тексте).
    const candidates = ruleCandidates(prepared);
    if (nerOk && Array.isArray(nerEntities)) {
      for (const e of nerEntities) {
        const type = String(e.type || '').toUpperCase();
        const start = Number(e.start);
        const end = Number(e.end);
        if (type === 'PERSON' && Number.isInteger(start) && Number.isInteger(end) && end > start && end <= prepared.length) {
          candidates.push({ type, start, end, value: prepared.slice(start, end) });
        }
      }
    }
    const found = resolveOverlaps(candidates).filter((c) => TYPES.has(c.type) && normalize(c.type, c.value));

    // 3. Присвоение ключей — одна транзакция (счётчик без пропусков, DB-93).
    const counts = {};
    let result = prepared;
    db.transaction(() => {
      let out = '';
      let pos = 0;
      for (const c of found) {
        out += prepared.slice(pos, c.start);
        out += keyFor(scope, c.type, c.value, counts);
        pos = c.end;
      }
      out += prepared.slice(pos);
      result = out;
    })();
    return { text: result, counts, mode: nerOk ? 'ner+rules' : 'rules_only' };
  }

  /** Ключ для значения: существующий по HMAC или новый (номер N — из счётчика области). */
  function keyFor(scope, type, value, counts) {
    const normalized = normalize(type, value);
    const hmac = hmacHex(scope, type, normalized);
    const existing = db
      .prepare('SELECT id, n, status FROM pii_values WHERE scope_type=? AND scope_id=? AND pii_type=? AND value_hmac=?')
      .get(scope.scopeType, scope.scopeId, type, hmac);
    if (existing) {
      if (existing.status !== 'current') db.prepare("UPDATE pii_values SET status='current' WHERE id=?").run(existing.id);
      counts[type] = (counts[type] || 0) + 1;
      return `#${type}-${existing.n}#`;
    }
    db.prepare(
      'INSERT INTO pii_counters(scope_type,scope_id,pii_type,last_n) VALUES (?,?,?,1) ON CONFLICT(scope_type,scope_id,pii_type) DO UPDATE SET last_n=last_n+1',
    ).run(scope.scopeType, scope.scopeId, type);
    const n = db
      .prepare('SELECT last_n FROM pii_counters WHERE scope_type=? AND scope_id=? AND pii_type=?')
      .get(scope.scopeType, scope.scopeId, type).last_n;
    db.prepare(
      'INSERT INTO pii_values(scope_type,scope_id,pii_type,n,value_enc,value_hmac,status,key_id) VALUES (?,?,?,?,?,?,?,?)',
    ).run(scope.scopeType, scope.scopeId, type, n, field.encrypt(encKey, value), hmac, 'current', field.keyIdFor(encKey));
    counts[type] = (counts[type] || 0) + 1;
    return `#${type}-${n}#`;
  }

  /**
   * Обратная подстановка при показе/выгрузке. Чужие и выдуманные ключи остаются как есть
   * с предупреждением E-PSEUDO-UNKNOWN-KEY; при недоступном ключе шифрования — E-PSEUDO-DECRYPT.
   * @returns {{text, warnings: string[]}}
   */
  function reveal(text, scope) {
    const warnings = new Set();
    let out = String(text || '');
    // Экранированные ключи из ввода пользователя — обратно в буквальный текст, без подстановки.
    out = out.replace(ESCAPED_KEY_RE, (m, key) => `\u0002${key}\u0002`);
    out = out.replace(KEY_RE, (whole, type, n) => {
      const row = db
        .prepare('SELECT value_enc FROM pii_values WHERE scope_type=? AND scope_id=? AND pii_type=? AND n=?')
        .get(scope.scopeType, scope.scopeId, String(type), Number(n));
      if (!row) {
        warnings.add('E-PSEUDO-UNKNOWN-KEY');
        return whole;
      }
      const dec = field.decrypt(encKey, row.value_enc);
      if (!dec.ok) {
        warnings.add('E-PSEUDO-DECRYPT');
        return whole;
      }
      return dec.value;
    });
    out = out.replace(/\u0002([A-Z_]+-\d{1,6})\u0002/g, '#$1#');
    return { text: out, warnings: [...warnings] };
  }

  /** Вызов NER (Natasha через ml-worker). Недоступность — не ошибка: режим «только правила». */
  async function nerDetect(text) {
    try {
      const r = await ml.ner(text);
      return r.ok ? { ok: true, entities: r.entities } : { ok: false, entities: [] };
    } catch (e) {
      return { ok: false, entities: [] };
    }
  }

  return { pseudonymize, reveal, nerDetect, keyFor, normalize };
}

module.exports = { createPii, TYPES, KEY_RE, normalize };

