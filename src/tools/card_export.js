'use strict';

/**
 * Экспорт карточки пациента / справки «К приёму» в TXT, DOCX, PDF для переноса в МИС (REQ-PSA-003).
 * Данные — те же, что на экране «К приёму» (patient_card.visitSummary); разделы выбирает врач.
 * Имя файла без ФИО (ФИО внутри документа — это документ для переноса в карту). Каждая выгрузка пишется в phi_access_log.
 */

const db = require('../db');
const card = require('../patient_card');
const { formatDate, instrumentLabel } = require('../format');

const SECTIONS = [
  { key: 'changes', label: 'Что изменилось с прошлого просмотра' },
  { key: 'scores', label: 'Динамика: последние баллы шкал' },
  { key: 'results', label: 'История результатов (последние 15)' },
  { key: 'diary', label: 'Дневник и приверженность' },
  { key: 'escalations', label: 'Открытые эскалации' },
  { key: 'notes', label: 'Мои заметки по пациенту (видны только мне)' },
];
const DEFAULT_SECTIONS = ['changes', 'scores', 'diary', 'escalations'];

function parseSections(q) {
  const raw = [].concat(q === undefined ? [] : q).map(String);
  const picked = SECTIONS.map((s) => s.key).filter((k) => raw.includes(k));
  return picked;
}

function build(patientId, actor, sections, now = new Date()) {
  const s = card.visitSummary(patientId, actor, now);
  const items = [];
  const has = (k) => sections.includes(k);
  const head = [`Пациент: ${s.patient.full_name}`, `Сформировано: ${formatDate(card.sqlTime(now).slice(0, 16))}`];
  if (s.verdict) head.push(`Светофор: ${s.verdict.word} — ${s.verdict.oneLine}`);
  if (!s.consentOk) head.push('Клиническое согласие не оформлено или отозвано: данные пациента врачу не передаются.');
  items.push({ text: head.join('\n') });
  if (has('changes')) {
    const L = [s.changes.sinceText];
    if (s.changes.empty) L.push(s.changes.unchangedText);
    for (const r of s.changes.rows) L.push(`- ${r.word}: ${r.text}`);
    items.push({ who: 'Что изменилось', text: L.join('\n') });
  }
  if (has('scores')) {
    items.push({
      who: 'Последние баллы',
      text: s.scores.length
        ? s.scores.map((k) => `- ${k.title}: ${k.value}${k.band ? ` (${k.band})` : ''}, ${formatDate(k.date)}${k.delta ? `; ${k.delta.text}` : ''}`).join('\n')
        : 'Результатов шкал нет.',
    });
  }
  if (has('results') && s.consentOk) {
    const rows = card.gatherResults(patientId, { consentOk: true }).filter((r) => !r.stub).slice(-15).reverse();
    items.push({
      who: 'История результатов',
      text: rows.length
        ? rows.map((r) => `- ${formatDate(String(r.at).slice(0, 10))} · ${instrumentLabel(r.instrument)} · ${r.total === null ? '—' : r.total}${r.band ? ` (${r.band})` : ''} · ${card.SOURCE_LABEL[r.kind] || r.kind}`).join('\n')
        : 'Результатов нет.',
    });
  }
  if (has('diary')) {
    const L = [];
    if (s.diary && s.diary.count) {
      L.push(`Дневник: записей ${s.diary.count}${s.diary.cur !== null ? `; среднее за 7 дней ${card.fmt1(s.diary.cur)}` : ''}${s.diary.prev !== null ? `, неделей ранее ${card.fmt1(s.diary.prev)}` : ''}.`);
    } else L.push('Данных дневника нет или они не переданы.');
    if (s.adherence && s.adherence.total) L.push(`Приверженность: пройдено ${s.adherence.done} из ${s.adherence.total} назначенных за ${s.adherence.days} дн.`);
    if (s.waiting.length) L.push(`Ждёт ввода врачом: ${s.waiting.join(', ')}`);
    items.push({ who: 'Дневник и приверженность', text: L.join('\n') });
  }
  if (has('escalations')) {
    items.push({
      who: 'Открытые эскалации',
      text: s.escalations.length ? s.escalations.map((e) => `- ${e.label}${e.sla ? ` (${e.sla.text})` : ''}`).join('\n') : 'Открытых эскалаций нет.',
    });
  }
  if (has('notes')) {
    const notes = db.prepare('SELECT body, tags, note_date, created_at FROM clinician_notes WHERE patient_id = ? AND author_id = ? ORDER BY COALESCE(note_date, substr(created_at,1,10)) DESC, id DESC LIMIT 20').all(patientId, actor.id);
    items.push({
      who: 'Мои заметки',
      text: notes.length ? notes.map((n) => `- ${formatDate(n.note_date || String(n.created_at).slice(0, 10))}: ${n.body || ''}${n.tags ? ` [${n.tags}]` : ''}`).join('\n') : 'Заметок нет.',
    });
  }
  return {
    title: 'Справка по пациенту (для переноса в МИС)',
    draftLabel: 'ЧЕРНОВИК · справка, не заключение',
    disclaimer: card.CLINICAL_DISCLAIMER,
    items,
  };
}

function audit(actorId, patientId, fmt) {
  db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(actorId, patientId, `export_patient_card_${fmt}`);
}

module.exports = { SECTIONS, DEFAULT_SECTIONS, parseSections, build, audit };
