'use strict';

// Решение владелицы H7 (docs/AUDIT_CONSENT_ACCESS_2026-10-27.md): три уровня данных.
//  Уровень 1 — служебные счётчики (сколько пациентов, записей, активность): по всем пациентам, согласие не нужно.
//    Новые представления analytics_service_members / analytics_service_facts: только случайный код субъекта,
//    из фактов только отметка «в этот день есть запись» (оценки и заметки сюда не попадают).
//  Уровень 2 — агрегаты по здоровью: те, у кого действует согласие 'research' (раньше 'program').
//  Уровень 3 — построчные наборы с псевдонимом: 'research'. Единственный вход для будущей выгрузки (T-226) —
//    представление analytics_research_pseudonyms: псевдоним без patient_id, только у согласившихся и неистёкший.
// Имена analytics_program_* и область 'program' в analytics_reporting_members остаются (меняется только согласие):
// применённые файлы не правятся, представления пересоздаются с тем же текстом и одной заменой.
// Отзыв 'research' исключает пациента при следующем запросе: consent_current читается каждый раз.

function rewrite(db, name, from, to) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name=?").get(name);
  if (!row || !row.sql.includes(from)) throw new Error(`view ${name}: expected fragment not found`);
  db.exec(`DROP VIEW ${name}`);
  db.exec(row.sql.replace(from, to));
}

module.exports = function migrate(db) {
  rewrite(db, 'analytics_program_members', "consent_kind='program'", "consent_kind='research'");
  rewrite(db, 'analytics_reporting_members', "c.consent_kind='program'", "c.consent_kind='research'");

  db.exec(`
CREATE VIEW analytics_service_members AS
 SELECT s.subject_code FROM analytics_subjects s JOIN users u ON u.id=s.patient_id
 WHERE u.role='patient' AND u.status<>'tombstone';
CREATE VIEW analytics_service_facts AS
 SELECT s.subject_code,f.day,date(f.day,'weekday 0','-6 days') week,f.metric,f.value,f.source,f.computed_at
 FROM analytics_facts f JOIN analytics_subjects s ON s.patient_id=f.patient_id
 JOIN analytics_service_members m ON m.subject_code=s.subject_code
 WHERE f.metric='diary_entry';
CREATE VIEW analytics_research_pseudonyms AS
 SELECT r.pseudonym,r.expires_at FROM research_pseudonyms r JOIN users u ON u.id=r.patient_id
 WHERE u.role='patient' AND u.status<>'tombstone' AND r.expires_at>datetime('now')
 AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=r.patient_id AND c.consent_kind='research' AND c.action='given');
`);
};
