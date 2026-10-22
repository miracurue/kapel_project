'use strict';

/**
 * W-40: замещение специалиста (F-70, F-87) и постоянная передача (F-86).
 * Врач предлагает замещающего на период; администратор подтверждает (F-87).
 * Замещающий видит пациентов и сигналы только в период; после — доступ пропадает
 * (задача планировщика F-21 закрывает привязки с пометкой substitution:<id>).
 */

class SubstitutionService {
  constructor({ db, config, now, P, core }) {
    this.db = db;
    this.config = config;
    this.now = now;
    this.P = P;
    this.core = core;
    this.db.pragma('busy_timeout = 5000');
  }

  iso() {
    return this.P.iso(this.now(this.config));
  }

  today() {
    return this.iso().slice(0, 10);
  }

  error(code) {
    const e = new Error(code);
    e.code = code;
    return e;
  }

  tx(fn) {
    const run = this.db.transaction(fn);
    return (...args) => run.immediate(...args);
  }

  isDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  /**
   * F-70: предложение замещения. Требования: коллега той же роли и не сам,
   * период от сегодняшнего дня, пересечение периодов — E-VALIDATION (T-214).
   */
  propose(clinician, { substitute_id, from, to, all_patients, patient_ids }) {
    const sub = this.core.getUser(substitute_id);
    if (!sub || sub.id === clinician.id || sub.role !== clinician.role || !this.core.isActiveAccount(sub))
      throw this.error('E-VALIDATION');
    if (!this.isDate(from) || !this.isDate(to) || String(from) > String(to) || String(from) < this.today())
      throw this.error('E-VALIDATION');
    const overlap = this.db
      .prepare(
        "SELECT 1 FROM substitutions WHERE absent_id = ? AND status IN ('proposed','confirmed') AND NOT (date_to < ? OR date_from > ?) LIMIT 1",
      )
      .get(clinician.id, String(from), String(to));
    if (overlap) throw this.error('E-VALIDATION');
    const scope = all_patients === true || all_patients === 'true' ? 'all' : 'selected';
    let patients = [];
    if (scope === 'selected') {
      const ids = Array.isArray(patient_ids) ? patient_ids.map(Number) : [];
      if (!ids.length) throw this.error('E-VALIDATION');
      for (const pid of ids) {
        const own = this.db
          .prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ? AND ended_at IS NULL')
          .get(pid, clinician.id);
        if (!own) throw this.error('E-VALIDATION');
        patients.push(pid);
      }
    }
    let id;
    this.tx(() => {
      id = Number(
        this.db
          .prepare(
            "INSERT INTO substitutions(absent_id,substitute_id,scope,date_from,date_to,status,kind,created_by,created_at) VALUES (?,?,?,?,?,'proposed','temporary',?,?)",
          )
          .run(clinician.id, sub.id, scope, String(from), String(to), clinician.id, this.iso()).lastInsertRowid,
      );
      for (const pid of patients)
        this.db.prepare('INSERT INTO substitution_patients(substitution_id,patient_id) VALUES (?,?)').run(id, pid);
      for (const a of this.db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all())
        this.db
          .prepare(
            "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,visible_from,status,created_at) VALUES (?,'service',?,'substitution',?,'Предложение замещения на период',?,'active',?)",
          )
          .run(a.id, `substitution_proposed:${id}`, id, this.iso(), this.iso());
    })();
    this.core.logAdmin(clinician.id, 'substitution_proposed', null, {
      substitution_id: id,
      substitute_id: sub.id,
      from,
      to,
    });
    return { id, substitute_id: sub.id, date_from: String(from), date_to: String(to), status: 'proposed' };
  }

  /**
   * F-87: подтверждение администратором. Замещающий получает доступ к пациентам
   * основного специалиста на период (привязки с пометкой substitution:<id>).
   */
  confirm(adminId, substitutionId) {
    const s = this.db.prepare('SELECT * FROM substitutions WHERE id = ?').get(Number(substitutionId));
    if (!s) throw this.error('E-NOT-FOUND');
    if (s.status !== 'proposed') throw this.error('E-STATUS');
    const patients =
      s.scope === 'all'
        ? this.db
            .prepare('SELECT patient_id FROM care_assignments WHERE clinician_id = ? AND ended_at IS NULL')
            .all(s.absent_id)
            .map((r) => r.patient_id)
        : this.db
            .prepare('SELECT patient_id FROM substitution_patients WHERE substitution_id = ?')
            .all(s.id)
            .map((r) => r.patient_id);
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE substitutions SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ? AND status = 'proposed'",
        )
        .run(adminId, this.iso(), s.id);
      for (const pid of patients)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO care_assignments(patient_id,clinician_id,started_at,created_by,end_reason) VALUES (?,?,?,?,'substitution:' || ?)",
          )
          .run(pid, s.substitute_id, this.iso(), adminId, s.id);
      this.db
        .prepare(
          "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,visible_from,status,created_at) VALUES (?,'service',?,'substitution',?,'Замещение подтверждено администратором',?,'active',?)",
        )
        .run(s.substitute_id, `substitution_confirmed:${s.id}`, s.id, this.iso(), this.iso());
    })();
    this.core.logAdmin(adminId, 'substitution_confirmed', null, { substitution_id: s.id, patients: patients.length });
    return { ok: true, id: s.id, patients: patients.length };
  }

  /** Список предложений для администратора (P-38). */
  listForAdmin() {
    return this.db
      .prepare(
        `SELECT s.id, s.absent_id, s.substitute_id, s.scope, s.date_from, s.date_to, s.status, s.created_at,
                a.full_name AS absent_name, b.full_name AS substitute_name
         FROM substitutions s JOIN users a ON a.id = s.absent_id JOIN users b ON b.id = s.substitute_id
         ORDER BY s.id DESC LIMIT 200`,
      )
      .all();
  }

  listMine(clinicianId) {
    return this.db
      .prepare(
        `SELECT s.id, s.substitute_id, s.scope, s.date_from, s.date_to, s.status, s.kind, s.created_at,
                b.full_name AS substitute_name
         FROM substitutions s JOIN users b ON b.id = s.substitute_id
         WHERE s.absent_id = ? ORDER BY s.id DESC LIMIT 100`,
      )
      .all(clinicianId);
  }

  /** Отмена своего предложенного замещения (до подтверждения). */
  cancel(clinicianId, substitutionId) {
    const s = this.db.prepare('SELECT * FROM substitutions WHERE id = ?').get(Number(substitutionId));
    if (!s || s.absent_id !== clinicianId) throw this.error('E-NOT-FOUND');
    if (s.status !== 'proposed') throw this.error('E-STATUS');
    this.tx(() => {
      this.db.prepare("UPDATE substitutions SET status = 'cancelled' WHERE id = ?").run(s.id);
    })();
    return { ok: true };
  }

  /** F-86: постоянная передача пациентов коллеге — одной транзакцией (T-252). */
  transfer(adminId, { from_clinician_id, to_clinician_id, all_patients, patient_ids }) {
    const from = this.core.getUser(from_clinician_id);
    const to = this.core.getUser(to_clinician_id);
    if (!from || !to || from.id === to.id) throw this.error('E-VALIDATION');
    if (!['psychiatrist', 'psychologist'].includes(from.role) || from.role !== to.role)
      throw this.error('E-VALIDATION');
    if (!this.core.isActiveAccount(to)) throw this.error('E-VALIDATION');
    let assignments;
    if (all_patients === true || all_patients === 'true') {
      assignments = this.db
        .prepare('SELECT id, patient_id, episode_id FROM care_assignments WHERE clinician_id = ? AND ended_at IS NULL')
        .all(from.id);
    } else {
      const ids = Array.isArray(patient_ids) ? patient_ids.map(Number) : [];
      if (!ids.length) throw this.error('E-VALIDATION');
      assignments = [];
      for (const pid of ids) {
        const a = this.db
          .prepare(
            'SELECT id, patient_id, episode_id FROM care_assignments WHERE clinician_id = ? AND patient_id = ? AND ended_at IS NULL',
          )
          .get(from.id, pid);
        if (!a) throw this.error('E-VALIDATION');
        assignments.push(a);
      }
    }
    this.tx(() => {
      for (const a of assignments) {
        this.db
          .prepare(
            "UPDATE care_assignments SET ended_at = ?, ended_by = ?, end_reason = 'transferred' WHERE id = ? AND ended_at IS NULL",
          )
          .run(this.iso(), adminId, a.id);
        this.db
          .prepare(
            'INSERT OR IGNORE INTO care_assignments(patient_id,clinician_id,episode_id,started_at,created_by) VALUES (?,?,?,?,?)',
          )
          .run(a.patient_id, to.id, a.episode_id, this.iso(), adminId);
        this.db
          .prepare(
            "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,visible_from,status,created_at) VALUES (?,'care',?,'patient',?,'Изменение специалиста',?,'active',?)",
          )
          .run(a.patient_id, `transfer:${a.id}`, a.patient_id, this.iso(), this.iso());
      }
    })();
    this.core.logAdmin(adminId, 'patients_transferred', from.id, { to: to.id, count: assignments.length });
    require('../../patient_prefs');
    for (const a of assignments) require('../../patient_prefs').noteCareChange(a.patient_id, 'changed');
    return { ok: true, transferred: assignments.length };
  }

  /**
   * F-21: по окончании периода замещения доступ замещающего пропадает (T-214).
   * Привязки создаются с пометкой end_reason='substitution:<id>' — задание закрывает их
   * и переводит замещение в статус 'ended'. Вызывается планировщиком.
   */
  endExpired() {
    const today = this.today();
    const rows = this.db.prepare("SELECT id FROM substitutions WHERE status = 'confirmed' AND date_to < ?").all(today);
    for (const s of rows) {
      this.tx(() => {
        this.db
          .prepare(
            "UPDATE care_assignments SET ended_at = ?, end_reason = 'substitution_ended' WHERE ended_at IS NULL AND end_reason = 'substitution:' || ?",
          )
          .run(this.iso(), s.id);
        this.db.prepare("UPDATE substitutions SET status = 'ended' WHERE id = ?").run(s.id);
      })();
    }
    return rows.length;
  }

  /** Активное замещение пациента (для страницы «Мой специалист», F-87). */
  activeForPatient(patientId) {
    const today = this.today();
    return this.db
      .prepare(
        `SELECT s.id, s.date_to, su.full_name AS substitute_name, ab.full_name AS absent_name
         FROM substitutions s
         JOIN users su ON su.id = s.substitute_id
         JOIN users ab ON ab.id = s.absent_id
         WHERE s.status = 'confirmed' AND s.date_from <= ? AND s.date_to >= ?
           AND (s.scope = 'all' OR EXISTS (SELECT 1 FROM substitution_patients sp WHERE sp.substitution_id = s.id AND sp.patient_id = ?))
           AND EXISTS (SELECT 1 FROM care_assignments ca WHERE ca.patient_id = ? AND ca.clinician_id = s.absent_id AND ca.ended_at IS NULL)
         ORDER BY s.id DESC LIMIT 1`,
      )
      .get(today, today, patientId, patientId);
  }
}

module.exports = { SubstitutionService };
