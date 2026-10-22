'use strict';

/**
 * Сбор контекста для ИИ специалиста (F-13, W-35). Содержимое чипов собирает
 * сервер; перед моделью всё проходит псевдонимизацию F-80 — уходят только
 * ключи #ТИП-N#. Пациентский ИИ-чат и переписка с врачом не прикрепляются
 * никем (allowlist src/modules/context/chips.js) — здесь их нет по построению.
 * Чтение контекста пишется в phi_access_log (section 'ai.context', PD-03/PD-14).
 * Имя пациента получает детерминированный ключ (pii.keyFor), остальное
 * содержимое псевдонимизирует вызывающая сторона (pii.pseudonymize).
 */

const chipsMod = require('../../modules/context/chips');
const { redactEntry } = require('../../modules/diary/visibility');
const { instrumentLabelFor, formatDate } = require('../../format');

function shortDate(value) {
  const s = String(value || '').slice(0, 10);
  return s.length === 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : s;
}

/** Сырое содержимое объекта по чипу (без идентификаторов). Возвращает строку или null. */
function chipContent(db, chip, user) {
  const id = Number(chip.id);
  if (!Number.isInteger(id)) return null;
  switch (chip.type) {
    case 'result': {
      const online = db
        .prepare('SELECT instrument, total_score, band, created_at FROM online_results WHERE id=?')
        .get(id);
      if (online)
        return `Результат ${instrumentLabelFor('patient', online.instrument)} (${shortDate(online.created_at)}): балл ${online.total_score}${online.band ? `, ${online.band}` : ''}.`;
      const offline = db
        .prepare('SELECT instrument, total_score, band, test_date, notes FROM offline_results WHERE id=?')
        .get(id);
      if (!offline) return null;
      return `Очный результат ${instrumentLabelFor('patient', offline.instrument)} (${shortDate(offline.test_date)}): балл ${offline.total_score === null ? 'нет' : offline.total_score}${offline.band ? `, ${offline.band}` : ''}${offline.notes ? `. Заметки: ${offline.notes}` : ''}.`;
    }
    case 'diary_entry': {
      const entry = db
        .prepare(
          'SELECT id, patient_id, entry_date, mood, sleep, anxiety, note FROM mood_entries WHERE id=? AND hidden_at IS NULL',
        )
        .get(id);
      if (!entry) return null;
      const row = redactEntry(db, entry.patient_id, user, entry);
      const parts = [`Дневник ${shortDate(row.entry_date)}`];
      if (row.mood !== null && row.mood !== undefined) parts.push(`настроение ${row.mood}`);
      if (row.sleep) parts.push(`сон ${row.sleep}`);
      if (row.anxiety) parts.push(`тревога ${row.anxiety}`);
      if (row.note) parts.push(`заметка: ${row.note}`);
      return `${parts.join(', ')}.`;
    }
    case 'plan_item': {
      const row = db
        .prepare(
          'SELECT i.name, pi.dose_value, pi.dose_unit FROM plan_items pi JOIN inn i ON i.id=pi.inn_id WHERE pi.id=?',
        )
        .get(id);
      return row
        ? `Пункт плана: ${row.name}${row.dose_value ? ` ${String(row.dose_value).replace(/\.0$/, '')} ${row.dose_unit || ''}` : ''}.`
        : null;
    }
    case 'patient_med': {
      const row = db.prepare('SELECT created_at FROM patient_meds WHERE id=? AND hidden_at IS NULL').get(id);
      return row ? `Препарат пациента (принят ${shortDate(row.created_at)}).` : null;
    }
    case 'purchase': {
      const row = db.prepare("SELECT created_at FROM purchase_marks WHERE id=? AND status<>'hidden'").get(id);
      return row ? `Покупка препарата ${shortDate(row.created_at)}.` : null;
    }
    case 'adverse_event': {
      const row = db.prepare('SELECT created_at, kind, severity FROM adverse_events WHERE id=?').get(id);
      return row
        ? `Нежелательное явление ${shortDate(row.created_at)}: ${row.kind || 'уточняется'}${row.severity ? `, тяжесть ${row.severity}` : ''}.`
        : null;
    }
    case 'visit': {
      const row = db.prepare("SELECT starts_at, format FROM visits WHERE id=? AND status<>'cancelled'").get(id);
      return row
        ? `Визит ${formatDate(row.starts_at)} (${row.format === 'in_person' ? 'очно' : 'дистанционно'}).`
        : null;
    }
    case 'file':
      // Содержимое файла в контекст чата не включается (распознавание — материалы ИИ-пространства).
      return 'Прикреплён файл пациента.';
    case 'library_item': {
      const row = db
        .prepare(
          "SELECT lv.title FROM library_items li JOIN library_versions lv ON lv.item_id=li.id AND lv.version=li.current_version WHERE li.id=? AND li.status='published'",
        )
        .get(id);
      return row ? `Материал базы знаний: ${row.title}.` : null;
    }
    default:
      return null;
  }
}

/**
 * Контекст для модели по закреплённому пациенту и чипам.
 * @returns {{ patientLine: string|null, rawText: string, refs: Array<{type: string, id: number}> }}
 *   patientLine — строка с ключом имени пациента (уже псевдонимизирована),
 *   rawText — сырое содержимое чипов (псевдонимизирует вызывающая сторона).
 */
function buildContext({ db, pii, scope, patientId, chips, req, user }) {
  const counts = {};
  const refs = [];
  const patientLine = patientId
    ? (() => {
        const row = db.prepare('SELECT full_name FROM users WHERE id=?').get(patientId);
        if (!row || !row.full_name) return null;
        return `Пациент: ${pii.keyFor(scope, 'PERSON', row.full_name, counts)}.`;
      })()
    : null;
  const rawParts = [];
  for (const chip of chips || []) {
    if (!chip || chip.type === 'patient') continue; // имя пациента — выше, отдельным ключом
    const content = chipContent(db, chip, user);
    if (!content) continue;
    rawParts.push(content);
    refs.push({ type: chip.type, id: Number(chip.id) });
    try {
      chipsMod.logAccess(db, req, user, chip.type, Number(chip.id), 'allow', patientId, 'assignment');
    } catch (_) {
      /* журнал не ломает действие */
    }
  }
  return { patientLine, rawText: rawParts.join('\n'), refs, counts };
}

module.exports = { buildContext, chipContent, shortDate };
