'use strict';

/**
 * W-51 (этап 14, веха В6): завершение наблюдения и архив (F-69, UC-35).
 * POST /api/v1/patients/{patient_id}/archive — только психиатр (episode.close,
 * роль проверяет контрактный контроль). Диалог с причиной и подтверждением;
 * при открытом кризисе — 409 E-CRISIS-OPEN (F-16); успех одной транзакцией:
 * назначения отменены, напоминания остановлены, визиты отменены, эпизод и
 * закрепления закрыты (пациент уходит из списка специалиста, кабинет —
 * только для чтения: запись в дневник отвечает 409 E-ARCHIVED по активному
 * эпизоду, «Мне нужна помощь · 112» продолжает работать).
 */

function install(app, { db, P, config, now, idemCached, saveIdem, auditPatient }) {
  const currentIso = () => P.iso(now(config));

  app.post('/api/v1/patients/:patient_id/archive', (req, res) => {
    const patientId = Number(req.params.patient_id);
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const deny = () => {
      try {
        auditPatient(req, patientId, 'deny', 'episode');
      } catch (_) {
        return P.sendError(req, res, 500, 'E-INTERNAL');
      }
      return P.sendError(req, res, 404, 'E-NOT-FOUND');
    };
    const episode = db
      .prepare('SELECT * FROM care_episodes WHERE patient_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(patientId);
    // Закрепление проверяем здесь (мидлвар для episode.close его пропускает:
    // повторный archive уже без закрепления должен отвечать E-ARCHIVED, T-212).
    // Права — раньше проверки тела: чужому пациенту только 404 (T-332).
    if (!episode) {
      const wasAssigned = db
        .prepare("SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND end_reason='archive'")
        .get(patientId, req.user.id);
      return wasAssigned ? P.sendError(req, res, 409, 'E-ARCHIVED') : deny();
    }
    const assigned = db
      .prepare(
        "SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND episode_id=? AND ended_at IS NULL AND (end_reason IS NULL OR end_reason<>'signal_only')",
      )
      .get(patientId, req.user.id, episode.id);
    if (!assigned) return deny();
    const body = req.body || {};
    const reason = String(body.reason || '').trim();
    if (!reason || body.confirm !== true) return P.sendError(req, res, 422, 'E-VALIDATION');
    const openCrisis = db
      .prepare("SELECT id FROM crisis_escalations WHERE patient_id=? AND status IN ('new','in_work')")
      .all(patientId);
    if (openCrisis.length) return P.sendError(req, res, 409, 'E-CRISIS-OPEN');
    const current = currentIso();
    db.transaction(() => {
      // Назначения тестов — отменить.
      db.prepare(
        "UPDATE instrument_assignments SET status='cancelled', cancelled_at=?, cancelled_by=?, cancel_reason='observation_ended' WHERE patient_id=? AND status IN ('pending','in_progress','waiting_entry')",
      ).run(current, req.user.id, patientId);
      // Напоминания — остановить.
      db.prepare('UPDATE reminders SET active=0 WHERE patient_id=? AND active=1').run(patientId);
      // Будущие визиты — отменить.
      db.prepare("UPDATE visits SET status='cancelled', version=version+1 WHERE patient_id=? AND status IN ('draft','scheduled')").run(patientId);
      // Эпизод и закрепления — закрыть (пациент уходит из списка, кабинет — только чтение).
      // end_reason эпизода — по справочнику CHECK; причина диалога врача — в журнал действий.
      const episodeReason = /курс|course/i.test(reason) ? 'course_completed' : 'other';
      db.prepare('UPDATE care_episodes SET ended_at=?, ended_by=?, end_reason=? WHERE id=?').run(current, req.user.id, episodeReason, episode.id);
      db.prepare("UPDATE care_assignments SET ended_at=?, ended_by=?, end_reason='archive' WHERE patient_id=? AND episode_id=? AND ended_at IS NULL").run(current, req.user.id, patientId, episode.id);
    })();
    const response = {
      ok: true,
      episode_id: episode.id,
      reason,
      ended_at: current,
      note: 'Пациент может нажать «Мне нужна помощь · 112» в любое время',
    };
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  return { currentIso };
}

module.exports = { install };