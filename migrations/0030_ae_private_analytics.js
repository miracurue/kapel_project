'use strict';

// Личная запись пациента о побочном эффекте без прикреплённого психиатра (status service_queue, psychiatrist_id пуст)
// никому не передана, поэтому не входит ни в аналитические факты, ни в отчёт insights.
// Представления из 0025 и 0027 пересоздаются с тем же текстом плюс одно условие (применённые файлы не правятся).
const PRIVATE = "NOT (status='service_queue' AND psychiatrist_id IS NULL)";

function rewrite(db, name, from, to) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name=?").get(name);
  if (!row || !row.sql.includes(from)) throw new Error(`view ${name}: expected fragment not found`);
  db.exec(`DROP VIEW ${name}`);
  db.exec(row.sql.replace(from, to));
}

module.exports = function migrate(db) {
  rewrite(
    db,
    'analytics_source_events',
    "FROM adverse_events WHERE status NOT IN ('draft','cancelled')",
    `FROM adverse_events WHERE status NOT IN ('draft','cancelled') AND ${PRIVATE}`,
  );
  rewrite(
    db,
    'insights_adverse',
    "WHERE ae.status NOT IN ('draft','cancelled')",
    `WHERE ae.status NOT IN ('draft','cancelled') AND NOT (ae.status='service_queue' AND ae.psychiatrist_id IS NULL)`,
  );
};
