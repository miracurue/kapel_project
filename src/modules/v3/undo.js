'use strict';
const FIELDS = {
  crisis: ['status', 'taken_by', 'taken_at', 'handled_by', 'handled_at', 'outcome_code', 'outcome_due_at', 'version'],
  ae: ['status', 'decision_by', 'decision_at', 'serious', 'version'],
};
function read(db, kind, id) {
  return kind === 'crisis'
    ? db.prepare('SELECT * FROM crisis_escalations WHERE id=?').get(id)
    : db.prepare('SELECT * FROM adverse_events WHERE id=?').get(id);
}
function pick(row, kind) {
  return Object.fromEntries(FIELDS[kind].map((key) => [key, row[key] ?? null]));
}
function save({ db, P, makeUndo }, actor, kind, before) {
  const current = read(db, kind, before.id);
  const undo = makeUndo(actor, `${kind}.change`, `v3_${kind}`, before.id);
  db.prepare("UPDATE undo_actions SET method='inverse',inverse_json=? WHERE key_hash=?").run(
    JSON.stringify({ before: pick(before, kind), after: pick(current, kind) }),
    P.sha(undo.id),
  );
  return undo;
}
function reverse({ db, P, config, now, activeSetting, auditPatient }, req, res, action) {
  const kind = action.object_type.slice(3);
  if (!['crisis', 'ae'].includes(kind)) return false;
  const row = read(db, kind, action.object_id);
  const assigned =
    row &&
    db
      .prepare(
        "SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL AND COALESCE(end_reason,'')<>'signal_only'",
      )
      .get(row.patient_id, req.user.id);
  const reserve =
    kind === 'crisis' &&
    row?.escalated_to_backup_at &&
    (activeSetting('crisis.backup').value || []).map(Number).includes(req.user.id);
  if (
    !row ||
    (!assigned && !reserve) ||
    !['psychiatrist', 'psychologist'].includes(req.user.role) ||
    (kind === 'ae' && req.user.role !== 'psychiatrist')
  ) {
    P.sendError(req, res, 404, 'E-NOT-FOUND');
    return true;
  }
  const current = P.iso(now(config));
  const snapshot = JSON.parse(action.inverse_json);
  if (JSON.stringify(pick(row, kind)) !== JSON.stringify(snapshot.after)) {
    P.sendError(req, res, 409, 'E-CONFLICT');
    return true;
  }
  try {
    db.transaction(() => {
      auditPatient(req, row.patient_id, 'allow', kind, reserve ? 'crisis' : 'assignment');
      const before = snapshot.before;
      if (kind === 'crisis')
        db.prepare(
          'UPDATE crisis_escalations SET status=?,taken_by=?,taken_at=?,handled_by=?,handled_at=?,outcome_code=?,outcome_due_at=?,version=version+1 WHERE id=?',
        ).run(
          before.status,
          before.taken_by,
          before.taken_at,
          before.handled_by,
          before.handled_at,
          before.outcome_code,
          before.outcome_due_at,
          row.id,
        );
      else
        db.prepare(
          'UPDATE adverse_events SET status=?,decision_by=?,decision_at=?,serious=?,version=version+1 WHERE id=?',
        ).run(before.status, before.decision_by, before.decision_at, before.serious, row.id);
      if (kind === 'crisis')
        db.prepare(
          "INSERT INTO crisis_incident_log(escalation_id,patient_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,'undo',?,'{}',?)",
        ).run(row.id, row.patient_id, req.user.id, current);
      db.prepare("UPDATE undo_actions SET state='undone',undone_at=? WHERE key_hash=?").run(current, action.key_hash);
    }).immediate();
    res.json({ undone: true });
  } catch (_) {
    P.sendError(req, res, 500, 'E-INTERNAL');
  }
  return true;
}
module.exports = { save, reverse };
