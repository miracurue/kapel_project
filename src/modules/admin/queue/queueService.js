'use strict';

/**
 * W-38: Служебная очередь и очередь запросов администратора (F-82, F-83, F-84, F-85, S-63).
 * Слой бизнес-логики, не зависит от HTTP. Схема — service_queue (миграции 0004/0011),
 * запросы субъекта — data_subject_requests. Пациент в очереди — только служебный номер (PD-20),
 * клинические тексты и ФИО сюда не попадают никогда.
 */

const field = require('../../../crypto/field');

const QUEUE = 'service_queue';
// Кризисные и срочные виды всегда впереди остальных запросов.
const URGENT_KINDS = ['crisis_no_clinician', 'crisis_manual_review', 'ae_no_psychiatrist'];
// Сроки исполнения по видам запросов — настройка S-63 «queue.due».
const DUE_DAYS_BY_KIND = {
  erasure: 'erasure_days',
  info: 'info_days',
  subject_info: 'info_days',
  dispute_access: 'info_days',
  stop_processing: 'stop_days',
  change_clinician: 'change_days',
};
const DEFAULT_DUE = {
  info_days: 10,
  stop_days: 10,
  erasure_days: 30,
  change_days: 5,
  crisis_repeat_min: 15,
  taken_return_days: 1,
};

class QueueService {
  constructor({ db, config, now, activeSetting, P, core, deletion, encKey }) {
    this.db = db;
    this.config = config;
    this.now = now;
    this.activeSetting = activeSetting;
    this.P = P;
    this.core = core;
    this.deletion = deletion;
    this.encKey = encKey;
    // Записывающие транзакции — BEGIN IMMEDIATE и короткие (build-rules §4);
    // busy_timeout — чтобы записи сессий на втором соединении не роняли очередь с SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
  }

  /** Коротая записывающая транзакция BEGIN IMMEDIATE: this.tx(fn)(...аргументы). */
  tx(fn) {
    const run = this.db.transaction(fn);
    return (...args) => run.immediate(...args);
  }

  iso() {
    return this.P.iso(this.now(this.config));
  }

  /** S-63: число дней из настройки queue.due; при отсутствии — значения по умолчанию. */
  dueDays(key) {
    let value = DEFAULT_DUE[key];
    try {
      const s = this.activeSetting('queue.due');
      const n = Number(s && s.value && s.value[key]);
      if (Number.isFinite(n) && n > 0) value = n;
    } catch (_) {
      /* настройки нет — значение по умолчанию */
    }
    return value;
  }

  dueAt(kind) {
    const days = DUE_DAYS_BY_KIND[kind];
    if (!days) return null;
    return this.P.iso(new Date(this.now(this.config).getTime() + this.dueDays(days) * 86400000));
  }

  encrypt(plaintext) {
    return field.encrypt(this.encKey, String(plaintext ?? ''));
  }

  decrypt(stored) {
    const out = field.decrypt(this.encKey, stored);
    return out.ok ? out.value : null;
  }

  /**
   * F-82: список запросов. Только метаданные: вид, служебный номер, срок, статус.
   * Кризисные виды — всегда первыми; далее новые сверху. Клинического текста и ФИО нет (PD-20).
   */
  listRequests({ userId = null, filter = 'open', page = 1, limit = 50 } = {}) {
    const filters = {
      open: "q.status IN ('new','open','waiting')",
      mine: "q.status = 'taken' AND q.taken_by = ?",
      all: '1=1',
    };
    const where = filters[filter] || filters.open;
    const params = filter === 'mine' ? [userId] : [];
    const rows = this.db
      .prepare(
        `SELECT q.id, q.kind, q.patient_id, q.ref_type, q.ref_id, q.priority, q.due_at, q.status,
                q.created_at, u.service_no AS patient_no
         FROM ${QUEUE} q LEFT JOIN users u ON u.id = q.patient_id
         WHERE ${where}
         ORDER BY (CASE WHEN q.kind IN ('crisis_no_clinician','crisis_manual_review','ae_no_psychiatrist') THEN 0 ELSE 1 END),
                  q.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, (page - 1) * limit);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${QUEUE} q WHERE ${where}`).get(...params).n;
    return { items: rows, page, page_size: limit, total };
  }

  /** F-82: карточка запроса. Администратору видна причина обращения (служебно), пациенту — нет. */
  getRequest(requestId) {
    const q = this.db
      .prepare(
        `SELECT q.id, q.kind, q.patient_id, q.ref_type, q.ref_id, q.priority, q.due_at, q.status,
                q.taken_by, q.taken_at, q.closed_by, q.closed_at, q.result_code, q.created_at,
                u.service_no AS patient_no
         FROM ${QUEUE} q LEFT JOIN users u ON u.id = q.patient_id WHERE q.id = ?`,
      )
      .get(Number(requestId));
    if (!q) return null;
    if (q.ref_type === 'dsr' && q.ref_id) {
      const r = this.db
        .prepare('SELECT request_type, status, text_enc FROM data_subject_requests WHERE id = ?')
        .get(q.ref_id);
      if (r) {
        q.request_status = r.status;
        if (r.text_enc) q.reason = this.decrypt(r.text_enc);
      }
    }
    return q;
  }

  /**
   * F-82: «Взять» — условная операция (T-250): UPDATE … WHERE status IN ('new','open').
   * Двойной взятис другим администратором — E-QUEUE-TAKEN; повтор тем же — идемпотентный успех.
   */
  takeRequest({ requestId, userId }) {
    const at = this.iso();
    const res = this.db
      .prepare(
        `UPDATE ${QUEUE} SET status = 'taken', taken_by = ?, taken_at = ?, version = version + 1
         WHERE id = ? AND status IN ('new','open')`,
      )
      .run(userId, at, Number(requestId));
    if (res.changes) return { ok: true };
    const row = this.db.prepare('SELECT status, taken_by FROM service_queue WHERE id = ?').get(Number(requestId));
    if (row && row.status === 'taken' && row.taken_by === userId) return { ok: true };
    const err = new Error(
      row && (row.status === 'done' || row.status === 'rejected') ? 'E-ALREADY-DONE' : 'E-QUEUE-TAKEN',
    );
    throw err;
  }

  /** Взятый запрос обязателен для следующих шагов: только тот же администратор, только в работе. */
  takenBy(requestId, adminId) {
    const q = this.db.prepare('SELECT * FROM service_queue WHERE id = ?').get(Number(requestId));
    if (!q) throw this.error('E-NOT-FOUND');
    if (q.status !== 'taken' || q.taken_by !== adminId) throw this.error('E-QUEUE-TAKEN');
    return q;
  }

  error(code) {
    const e = new Error(code);
    e.code = code;
    return e;
  }

  closeItem(q, adminId, resultCode) {
    this.db
      .prepare(
        `UPDATE ${QUEUE} SET status = 'done', closed_by = ?, closed_at = ?, result_code = ?, version = version + 1 WHERE id = ?`,
      )
      .run(adminId, this.iso(), resultCode, q.id);
  }

  activeClinician(clinicianId) {
    return this.db
      .prepare(
        "SELECT id, role, status FROM users WHERE id = ? AND status = 'active' AND role IN ('psychiatrist','psychologist')",
      )
      .get(Number(clinicianId));
  }

  logIncident(q, adminId, detail) {
    this.db
      .prepare(
        'INSERT INTO crisis_incident_log(escalation_id,patient_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(q.ref_id, q.patient_id, 'specialist_notified', adminId, JSON.stringify(detail), this.iso());
  }

  /**
   * F-83: назначение специалиста по запросу очереди, без цитат и без клинических текстов.
   * mode: 'assign' — закрепление; 'single_signal' — «только этот сигнал»: специалист видит сигнал,
   * но не карточку пациента (привязка с пометкой signal_only, карточка по ней не открывается).
   */
  assignSpecialist({ requestId, adminId, specialistId, mode = 'assign' }) {
    const q = this.takenBy(requestId, adminId);
    const spec = this.activeClinician(specialistId);
    if (!spec) throw this.error('E-NO-CANDIDATE');
    this.tx(() => {
      if (mode === 'single_signal') {
        this.db
          .prepare(
            "INSERT INTO care_assignments(patient_id, clinician_id, started_at, created_by, end_reason) VALUES (?, ?, ?, ?, 'signal_only')",
          )
          .run(q.patient_id, spec.id, this.iso(), adminId);
        if (q.ref_type === 'crisis' && q.ref_id)
          this.logIncident(q, adminId, { notified: spec.id, channel: 'signal_only' });
      } else {
        if (mode === 'replace')
          this.db
            .prepare(
              "UPDATE care_assignments SET ended_at = ?, ended_by = ?, end_reason = 'reassign' WHERE patient_id = ? AND ended_at IS NULL",
            )
            .run(this.iso(), adminId, q.patient_id);
        else
          this.db
            .prepare(
              "UPDATE care_assignments SET ended_at = ?, ended_by = ?, end_reason = 'reassign' WHERE patient_id = ? AND clinician_id = ? AND ended_at IS NULL AND end_reason = 'signal_only'",
            )
            .run(this.iso(), adminId, q.patient_id, spec.id);
        this.db
          .prepare(
            'INSERT OR IGNORE INTO care_assignments(patient_id, clinician_id, started_at, created_by) VALUES (?, ?, ?, ?)',
          )
          .run(q.patient_id, spec.id, this.iso(), adminId);
        this.db
          .prepare(
            'INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis) VALUES (?,?,?,?,?,?,?)',
          )
          .run(adminId, 'admin', q.patient_id, 'assignment', 'assign', 'allow', 'admin_service');
        if (q.ref_type === 'crisis' && q.ref_id)
          this.logIncident(q, adminId, { notified: spec.id, channel: 'assignment' });
        require('../../../patient_prefs').noteCareChange(q.patient_id, 'changed');
      }
      this.core.logAdmin(adminId, 'queue_assign', q.patient_id, {
        request_id: q.id,
        kind: q.kind,
        clinician_id: spec.id,
        mode,
      });
      this.closeItem(q, adminId, mode === 'single_signal' ? 'signal_only' : 'assigned');
    })();
    return { ok: true, assigned_to: spec.id, mode };
  }

  /**
   * F-86: исполнение просьбы пациента о смене специалиста (T-206).
   * mode 'replace': прежний специалист сразу теряет доступ, новый получает закрепление;
   * пациенту — нейтральное уведомление без причины.
   */
  clinicianChange({ requestId, adminId, newClinicianId, mode = 'replace' }) {
    const q = this.takenBy(requestId, adminId);
    const spec = this.activeClinician(newClinicianId);
    if (!spec) throw this.error('E-NO-CANDIDATE');
    if (mode !== 'replace') throw this.error('E-VALIDATION');
    this.tx(() => {
      const episode = this.db
        .prepare('SELECT id FROM care_episodes WHERE patient_id = ? AND ended_at IS NULL')
        .get(q.patient_id);
      this.db
        .prepare(
          "UPDATE care_assignments SET ended_at = ?, ended_by = ?, end_reason = 'patient_request' WHERE patient_id = ? AND ended_at IS NULL",
        )
        .run(this.iso(), adminId, q.patient_id);
      this.db
        .prepare(
          'INSERT INTO care_assignments(patient_id, clinician_id, episode_id, started_at, created_by) VALUES (?, ?, ?, ?, ?)',
        )
        .run(q.patient_id, spec.id, episode ? episode.id : null, this.iso(), adminId);
      this.db
        .prepare(
          "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,visible_from,status,created_at) VALUES (?,'care',?,'patient',?,'Изменение специалиста',?,'active',?)",
        )
        .run(q.patient_id, `care_change:${q.id}`, q.patient_id, this.iso(), this.iso());
      this.db
        .prepare(
          'INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis) VALUES (?,?,?,?,?,?,?)',
        )
        .run(adminId, 'admin', q.patient_id, 'assignment', 'reassign', 'allow', 'admin_service');
      if (q.ref_type === 'dsr' && q.ref_id)
        this.db.prepare("UPDATE data_subject_requests SET status = 'done' WHERE id = ?").run(q.ref_id);
      require('../../../patient_prefs').noteCareChange(q.patient_id, 'changed');
      this.core.logAdmin(adminId, 'queue_clinician_change', q.patient_id, {
        request_id: q.id,
        new_clinician_id: spec.id,
      });
      this.closeItem(q, adminId, 'replaced');
    })();
    return { ok: true, new_clinician_id: spec.id };
  }

  /**
   * F-84: ответ на запрос субъекта (сведения о данных, спор о доступе). Ответ уходит пациенту
   * в «Мои данные» — не письмом; содержимое записей не раскрывается (T-207, PD-18).
   */
  answerSubject({ requestId, adminId, decision, templateKey }) {
    const q = this.takenBy(requestId, adminId);
    if (q.ref_type !== 'dsr' || !q.ref_id) throw this.error('E-VALIDATION');
    const dsr = this.db.prepare('SELECT id, patient_id FROM data_subject_requests WHERE id = ?').get(q.ref_id);
    if (!dsr) throw this.error('E-NOT-FOUND');
    const answer = JSON.stringify({
      decision: String(decision || ''),
      template_key: String(templateKey || decision || ''),
    });
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE data_subject_requests SET status = 'done', answer_enc = ?, answer_visible_from = ? WHERE id = ?",
        )
        .run(this.encrypt(answer), this.iso(), dsr.id);
      this.core.logAdmin(adminId, 'queue_answer', dsr.patient_id, {
        request_id: q.id,
        decision: String(decision || ''),
      });
      this.closeItem(q, adminId, 'answered');
    })();
    return { ok: true };
  }

  /**
   * F-85: исполнение стирания по белому списку таблиц. Подтверждение — служебным номером пациента;
   * при открытом кризисе исполнение откладывается (E-CRISIS-OPEN, запрос остаётся в очереди).
   */
  executeErasure({ requestId, adminId, confirmServiceNo }) {
    const q = this.db.prepare('SELECT * FROM service_queue WHERE id = ?').get(Number(requestId));
    if (!q) throw this.error('E-NOT-FOUND');
    if (q.status === 'done') throw this.error('E-ALREADY-DONE');
    let dsrId = q.ref_type === 'dsr' ? q.ref_id : null;
    if (!dsrId)
      dsrId =
        this.db
          .prepare(
            "SELECT id FROM data_subject_requests WHERE patient_id = ? AND request_type IN ('erasure','consent_revocation_and_deletion') AND status NOT IN ('done','executed','rejected','cancelled') ORDER BY id DESC LIMIT 1",
          )
          .get(q.patient_id)?.id || null;
    if (!dsrId) throw this.error('E-NOT-FOUND');
    const out = this.deletion.execute(adminId, dsrId, { confirmServiceNo });
    if (!out.ok) {
      if (out.error === 'E-CRISIS-OPEN')
        this.db.prepare("UPDATE service_queue SET status = 'waiting', version = version + 1 WHERE id = ?").run(q.id);
      throw this.error(out.error || 'E-VALIDATION');
    }
    this.core.logAdmin(adminId, 'queue_erasure_executed', q.patient_id, { request_id: q.id, dsr_id: dsrId });
    this.closeItem(q, adminId, 'erased');
    return { ok: true, report: out.report };
  }

  /** Закрытие запроса администратором без исполнения (например, по ошибке). */
  closeRequest({ requestId, adminId, resultCode }) {
    const q = this.takenBy(requestId, adminId);
    this.core.logAdmin(adminId, 'queue_close', q.patient_id, {
      request_id: q.id,
      result_code: String(resultCode || 'closed'),
    });
    this.closeItem(q, adminId, String(resultCode || 'closed'));
    return { ok: true };
  }

  /**
   * F-82/F-21: взятый, но не закрытый запрос возвращается в общую очередь через срок S-63
   * (queue.due.taken_return_days). Вызывается планировщиком (F-21), не своим setInterval.
   */
  returnExpiredToQueue() {
    const days = this.dueDays('taken_return_days');
    if (!days || days <= 0) return 0;
    const cutoff = this.P.iso(new Date(this.now(this.config).getTime() - days * 86400000));
    const res = this.db
      .prepare(
        "UPDATE service_queue SET status = 'open', taken_by = NULL, taken_at = NULL, version = version + 1 WHERE status = 'taken' AND taken_at <= ?",
      )
      .run(cutoff);
    return res.changes;
  }

  // ---------- запросы субъекта (создание пациентом) ----------

  /**
   * «Это странно» (F-22/T-200): спор о записи журнала доступа. Одна жалоба на строку,
   * не больше 10 в сутки; запрос попадает в очередь администратору со сроком S-63.
   */
  createDispute({ patientId, accessLogId, comment }) {
    const row = this.db.prepare('SELECT id, patient_id FROM phi_access_log WHERE id = ?').get(Number(accessLogId));
    if (!row || row.patient_id !== Number(patientId)) throw this.error('E-NOT-FOUND');
    const open = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM data_subject_requests WHERE request_type = 'dispute_access' AND subject_ref_type = 'phi_access_log' AND subject_ref_id = ? AND status IN ('submitted','in_work','pending')",
      )
      .get(row.id).n;
    if (open) throw this.error('E-ALREADY-REQUESTED');
    const dayAgo = this.P.iso(new Date(this.now(this.config).getTime() - 86400000));
    const perDay = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM data_subject_requests WHERE patient_id = ? AND request_type = 'dispute_access' AND requested_at >= ?",
      )
      .get(patientId, dayAgo).n;
    if (perDay >= 10) throw this.error('E-RATE-LIMIT');
    const due = this.dueAt('dispute_access');
    let dsrId;
    this.tx(() => {
      dsrId = Number(
        this.db
          .prepare(
            "INSERT INTO data_subject_requests(patient_id,request_type,subject_ref_type,subject_ref_id,text_enc,status,due_at,requested_at) VALUES (?,'dispute_access','phi_access_log',?,?,'submitted',?,?)",
          )
          .run(patientId, row.id, comment ? this.encrypt(comment) : null, due, this.iso()).lastInsertRowid,
      );
      this.db
        .prepare(
          "INSERT INTO service_queue(kind,patient_id,ref_type,ref_id,priority,due_at,status,created_at) VALUES ('dispute_access',?,'dsr',?,5,?,'new',?)",
        )
        .run(patientId, dsrId, due, this.iso());
    })();
    return { id: dsrId, due_at: due };
  }

  /**
   * «Попросить сменить специалиста» (F-55/T-206, T-251): запрос администратору с причиной;
   * повторный открытый запрос — E-ALREADY-REQUESTED. Причина — ЧПД: хранится зашифрованной,
   * видна только администратору в карточке запроса.
   */
  createClinicianChange({ patientId, clinicianId, reason }) {
    const open = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM service_queue WHERE kind = 'change_clinician' AND patient_id = ? AND status IN ('new','open','waiting','taken')",
      )
      .get(patientId).n;
    if (open) throw this.error('E-ALREADY-REQUESTED');
    const assigned = this.db
      .prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ? AND ended_at IS NULL')
      .get(patientId, Number(clinicianId));
    if (!assigned || !reason || !String(reason).trim()) throw this.error('E-VALIDATION');
    const due = this.dueAt('change_clinician');
    let dsrId;
    this.tx(() => {
      dsrId = Number(
        this.db
          .prepare(
            "INSERT INTO data_subject_requests(patient_id,request_type,subject_ref_type,subject_ref_id,text_enc,status,due_at,requested_at) VALUES (?,'change_clinician','users',?,?,'submitted',?,?)",
          )
          .run(patientId, Number(clinicianId), this.encrypt(reason), due, this.iso()).lastInsertRowid,
      );
      this.db
        .prepare(
          "INSERT INTO service_queue(kind,patient_id,ref_type,ref_id,priority,due_at,status,created_at) VALUES ('change_clinician',?,'dsr',?,5,?,'new',?)",
        )
        .run(patientId, dsrId, due, this.iso());
    })();
    return { id: dsrId, due_at: due };
  }
}

module.exports = { QueueService, URGENT_KINDS, DEFAULT_DUE };
