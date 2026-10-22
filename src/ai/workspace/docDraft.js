'use strict';

/**
 * Черновик документа от ИИ (F-33, W-35). Разделы собираются из записей пациента
 * за период (белый список роли); в базе и в модели — только ключи #ТИП-N# (F-80).
 * ИИ-текст хранится отдельным разделом с пометкой; при сбое/таймауте модели
 * черновик всё равно создаётся из данных без связного текста, с предупреждением.
 * Экспорт TXT/DOCX/PDF — с обратной подстановкой настоящих значений; ключи без
 * значения показываются в квадратных скобках с пометкой; выгрузка — в export_log.
 */

const exporter = require('./export');
const { redactEntry } = require('../../modules/diary/visibility');
const { KEY_RE } = require('../pii');

const DOC_TITLES = {
  visit_summary: 'Сводка к приёму',
  mis_summary: 'Выписка для МИС',
  dynamics: 'Динамика',
  exam_protocol: 'Протокол обследования',
  consult_request: 'Направление на консультацию',
  crisis_record: 'Запись о кризисном событии',
  memo: 'Памятка пациенту',
  final_summary: 'Итоговая сводка',
  conclusion: 'Заключение',
};

const AI_NOTE = 'Черновик раздела подготовлен ИИ и требует проверки врача (решение принимает специалист).';

function docTitle(type) {
  return DOC_TITLES[type] || 'Документ';
}

/** Ключи #ТИП-N# в тексте, для которых нет значения в области (F-80: «неизвестная метка»). */
function unknownKeys(db, scope, texts) {
  const unknown = new Set();
  for (const text of texts) {
    for (const match of String(text || '').matchAll(KEY_RE)) {
      const row = db
        .prepare('SELECT id FROM pii_values WHERE scope_type=? AND scope_id=? AND pii_type=? AND n=?')
        .get(scope.scopeType, scope.scopeId, match[1], Number(match[2]));
      if (!row) unknown.add(match[0]);
    }
  }
  return [...unknown];
}

/** Подстановка для показа/экспорта: известные ключи — значениями (pii.reveal), оставшиеся — [ключ …]. */
function renderText(pii, db, scope, text) {
  const revealed = pii.reveal(String(text || ''), scope).text;
  return revealed.replace(KEY_RE, (whole, type, n) => {
    const row = db
      .prepare('SELECT id FROM pii_values WHERE scope_type=? AND scope_id=? AND pii_type=? AND n=?')
      .get(scope.scopeType, scope.scopeId, String(type), Number(n));
    return row ? whole : `[${whole}: значение недоступно]`;
  });
}
/**
 * Разделы из записей пациента за период. Тексты — с ключами F-80: имя —
 * детерминированный ключ; свободный текст (заметки) — через pii.pseudonymize.
 * @returns {{ sections: Array<{key,title,text,sources}>, refs: Array<{type,id}> }}
 */
function dataSections({ db, pii, scope, patientId, period, counts, isPsychiatrist, user }) {
  const sections = [];
  const refs = [];
  const nameRow = db.prepare('SELECT full_name FROM users WHERE id=?').get(patientId);
  if (nameRow && nameRow.full_name) {
    sections.push({
      key: 'patient',
      title: 'Пациент',
      text: `Пациент: ${pii.keyFor(scope, 'PERSON', nameRow.full_name, counts)}.`,
      sources: [],
    });
  }
  const from = period.from || '';
  const to = period.to || '';
  const inPeriod = (date) => (!from || String(date || '') >= from) && (!to || String(date || '').slice(0, 10) <= to);
  const results = [];
  for (const r of db
    .prepare(
      'SELECT id, instrument, total_score, band, created_at FROM online_results WHERE patient_id=? AND invalid_at IS NULL ORDER BY id DESC LIMIT 50',
    )
    .all(patientId)) {
    if (!inPeriod(r.created_at)) continue;
    refs.push({ type: 'result', id: r.id });
    results.push(
      `Результат ${r.instrument} (${String(r.created_at).slice(0, 10)}): балл ${r.total_score}${r.band ? `, ${r.band}` : ''}.`,
    );
  }
  for (const r of db
    .prepare(
      "SELECT id, instrument, total_score, test_date, notes FROM offline_results WHERE patient_id=? AND status='saved' AND invalid_at IS NULL ORDER BY id DESC LIMIT 50",
    )
    .all(patientId)) {
    if (!inPeriod(r.test_date)) continue;
    refs.push({ type: 'result', id: r.id });
    results.push(
      `Очный результат ${r.instrument} (${String(r.test_date).slice(0, 10)}): балл ${r.total_score === null ? 'нет' : r.total_score}${r.notes ? `. Заметки: ${maskFreeText(pii, scope, counts, r.notes)}` : ''}.`,
    );
  }
  sections.push({
    key: 'tests',
    title: 'Тесты',
    text: results.length ? results.join('\n') : 'нет данных',
    sources: refs.map((r) => ({ ...r })),
  });
  const diary = [];
  for (const entry of db
    .prepare(
      'SELECT id, entry_date, mood, sleep, anxiety, note FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL ORDER BY entry_date DESC, id DESC LIMIT 30',
    )
    .all(patientId)) {
    const d = redactEntry(db, patientId, user, entry);
    if (!inPeriod(d.entry_date)) continue;
    refs.push({ type: 'diary_entry', id: d.id });
    const parts = [String(d.entry_date).slice(0, 10)];
    if (d.mood !== null && d.mood !== undefined) parts.push(`настроение ${d.mood}`);
    if (d.sleep) parts.push(`сон ${d.sleep}`);
    if (d.anxiety) parts.push(`тревога ${d.anxiety}`);
    if (d.note) parts.push(`заметка: ${maskFreeText(pii, scope, counts, d.note)}`);
    diary.push(parts.join(', '));
  }
  sections.push({ key: 'diary', title: 'Дневник', text: diary.length ? diary.join('\n') : 'нет данных', sources: [] });
  if (isPsychiatrist) {
    const meds = db
      .prepare(
        "SELECT i.name, pi.dose_value, pi.dose_unit FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id JOIN inn i ON i.id=pi.inn_id WHERE pv.patient_id=? AND pv.status='published' AND pi.status='active' ORDER BY pv.version DESC LIMIT 20",
      )
      .all(patientId);
    sections.push({
      key: 'meds',
      title: 'Лечение',
      text: meds.length
        ? meds
            .map(
              (m) =>
                `${m.name}${m.dose_value ? ` ${String(m.dose_value).replace(/\.0$/, '')} ${m.dose_unit || ''}` : ''}.`,
            )
            .join('\n')
        : 'нет данных',
      sources: [],
    });
  }
  const visits = [];
  for (const v of db
    .prepare(
      "SELECT id, starts_at, format FROM visits WHERE patient_id=? AND status<>'cancelled' ORDER BY starts_at DESC LIMIT 30",
    )
    .all(patientId)) {
    if (!inPeriod(v.starts_at)) continue;
    refs.push({ type: 'visit', id: v.id });
    visits.push(`${String(v.starts_at).slice(0, 10)} (${v.format === 'in_person' ? 'очно' : 'дистанционно'}).`);
  }
  sections.push({
    key: 'visits',
    title: 'Визиты',
    text: visits.length ? visits.join('\n') : 'нет данных',
    sources: [],
  });
  return { sections, refs };
}

/** Псевдонимизация свободного текста записи до сборки раздела. Повторный проход по
 * готовому разделу запрещён: он экранировал бы собственные ключи #ТИП-N# как ввод пользователя. */
function maskFreeText(pii, scope, counts, text) {
  const pseudo = pii.pseudonymize(String(text || ''), scope, { nerEntities: [], nerOk: false });
  for (const [k, v] of Object.entries(pseudo.counts)) counts[k] = (counts[k] || 0) + v;
  return pseudo.text;
}

/** Черновик для экспорта: {title, date, note, items} для src/ai/workspace/export.js. */
function exportDoc({ pii, db, scope, doc, sections, aiGenerated }) {
  const items = sections.map((s) => ({
    who: `${s.title}${s.ai ? ' · подготовлен ИИ' : ''}`,
    text: renderText(pii, db, scope, s.text),
  }));
  return exporter.normalize({
    title: `${docTitle(doc.doc_type)} (черновик)`,
    date: String(doc.created_at || '').slice(0, 10) || exporter.today(),
    note: aiGenerated ? AI_NOTE : '',
    items,
  });
}

module.exports = { DOC_TITLES, docTitle, unknownKeys, renderText, dataSections, exportDoc, AI_NOTE };
