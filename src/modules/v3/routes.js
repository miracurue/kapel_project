'use strict';

// В3: намеренно небольшой серверный слой для сигналов, НЯ, визитов и файлов.
// Свободный текст проверяется вызывающей стороной через `crisis` до сохранения.

const crypto = require('crypto');
const aeIntake = require('./ae_intake');
const crisisMode = require('../../ai/crisisMode');
const { isFullyAssigned } = require('../../access/assignment');

function install(app, { db, P, config, now, makeUndo, crisis, activeSetting, auditPatient, baseConsentGiven }) {
  const secured = require('./security').create(app, {
    db,
    P,
    config,
    now,
    auditPatient,
    baseConsentGiven,
    crisis,
    activeSetting,
  });
  const iso = () => P.iso(now(config));
  const snapshotUndo = (actor, kind, before) => require('./undo').save({ db, P, makeUndo }, actor, kind, before);
  const clinicianFor = (patientId, psychiatristOnly = false) =>
    db
      .prepare(
        `SELECT clinician_id FROM care_assignments ca JOIN users u ON u.id=ca.clinician_id
      WHERE ca.patient_id=? AND ca.ended_at IS NULL ${psychiatristOnly ? "AND u.role='psychiatrist'" : ''} ORDER BY ca.id LIMIT 1`,
      )
      .get(patientId);
  const assigned = (clinicianId, patientId, signal = false) => isFullyAssigned(db, patientId, clinicianId, { signal });
  const notify = (recipient, type, objectType, objectId, patientId, title, visible = iso()) => {
    db.prepare(
      "INSERT INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,?,?,?,?,?,?,?, 'active',?)",
    ).run(
      recipient,
      type,
      `${type}:${objectId}:${crypto.randomUUID()}`,
      objectType,
      objectId,
      title,
      patientId,
      visible,
      iso(),
    );
  };
  // Переход из «Сигналов» к извещению во вкладке «Шаблоны и документы»: готовый документ (если есть) или ключи для создания.
  const noticeDocument = (ae, ownerId) => {
    const doc = db
      .prepare(
        'SELECT id,status FROM clinician_documents WHERE owner_id=? AND ae_id=? AND NOT EXISTS (SELECT 1 FROM clinician_documents n WHERE n.supersedes_id=clinician_documents.id) ORDER BY id DESC LIMIT 1',
      )
      .get(ownerId, ae.id);
    return {
      available: ae.status === 'related_likely',
      template_key: 'b-roszdravnadzor',
      patient_id: ae.patient_id,
      ae_id: ae.id,
      document_id: doc ? doc.id : null,
      document_status: doc ? doc.status : null,
    };
  };
  const signalView = (row) => ({
    id: row.id,
    kind: 'crisis',
    status: row.status,
    due_at: row.due_at,
    shown_112: true,
    ...(row.includeQuote ? { quote: row.quote_enc || null } : {}),
    source: row.source,
    created_at: row.created_at,
    level: row.tier,
    ...(row.ai ? { ai_assessment: row.ai } : {}),
    can_open_chart: Boolean(row.canOpenChart),
    patient: { id: row.patient_id, ...(row.patientName ? { name: row.patientName } : {}) },
    taken_by: row.taken_by ? { id: row.taken_by, name: row.taken_name, role: row.taken_role, at: row.taken_at } : null,
  });
  const canSignal = (req, row) =>
    assigned(req.user.id, row.patient_id, true) ||
    (row.escalated_to_backup_at && (activeSetting('crisis.backup').value || []).map(Number).includes(req.user.id));
  const log = (id, patient, event, actor = null, detail = {}) =>
    db
      .prepare(
        'INSERT INTO crisis_incident_log(escalation_id,patient_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, patient, event, actor, JSON.stringify(detail), iso());

  secured.get('/api/v1/signals', (req, res) => {
    if (!['psychiatrist', 'psychologist'].includes(req.user.role)) return P.sendError(req, res, 403, 'E-ACCESS');
    const reserve = (activeSetting('crisis.backup').value || []).map(Number).includes(req.user.id);
    const rows = db
      .prepare(
        `SELECT ce.*,u.full_name taken_name,u.role taken_role FROM crisis_escalations ce
      LEFT JOIN users u ON u.id=ce.taken_by
      WHERE EXISTS(SELECT 1 FROM care_assignments ca WHERE ca.patient_id=ce.patient_id AND ca.clinician_id=? AND ca.ended_at IS NULL) OR (? AND ce.escalated_to_backup_at IS NOT NULL) ORDER BY ce.id DESC`,
      )
      .all(req.user.id, reserve ? 1 : 0);
    let items = rows.map((row) =>
      signalView({
        ...row,
        includeQuote: true,
        ai: crisisMode.latestAssessment(db, row.id),
        canOpenChart: Boolean(assigned(req.user.id, row.patient_id)),
        patientName: db.prepare('SELECT full_name FROM users WHERE id=?').get(row.patient_id)?.full_name,
      }),
    );
    if (req.user.role === 'psychiatrist' && req.query.kind !== 'crisis') {
      const aes = db
        .prepare(
          "SELECT * FROM adverse_events WHERE psychiatrist_id=? AND EXISTS(SELECT 1 FROM care_assignments ca WHERE ca.patient_id=adverse_events.patient_id AND ca.clinician_id=adverse_events.psychiatrist_id AND ca.ended_at IS NULL) AND status NOT IN ('cancelled','draft') AND (visible_from IS NULL OR visible_from<=?) ORDER BY id DESC",
        )
        .all(req.user.id, iso());
      items = items.concat(
        aes.map((ae) => ({
          id: ae.id,
          kind: 'ae',
          status: ae.status,
          patient: {
            id: ae.patient_id,
            name: db.prepare('SELECT full_name FROM users WHERE id=?').get(ae.patient_id)?.full_name,
          },
          can_open_chart: true,
          notice_document: noticeDocument(ae, req.user.id),
          due_at: null,
          created_at: ae.created_at,
          text: ae.description_enc,
          started_on: ae.onset_date,
          severity: ae.severity,
          related: ae.relation_patient,
          comment: ae.decision_comment_enc,
          upload_ids: db
            .prepare(
              "SELECT id FROM stored_files WHERE linked_type='adverse_event' AND linked_id=? AND status='linked'",
            )
            .all(ae.id)
            .map((file) => file.id),
        })),
      );
    }
    if (req.query.kind === 'ae') items = items.filter((x) => x.kind === 'ae');
    if (req.query.kind === 'crisis') items = items.filter((x) => x.kind === 'crisis');
    if (req.query.status && req.query.status !== 'all')
      items = items.filter((item) => item.status === req.query.status);
    const total = items.length;
    const page = Math.max(1, Number(req.query.page) || 1);
    for (const patientId of new Set(items.slice((page - 1) * 50, page * 50).map((item) => item.patient.id)))
      auditPatient(req, patientId, 'allow', 'signals', assigned(req.user.id, patientId, true) ? 'assignment' : 'crisis');
    res.json({ items: items.slice((page - 1) * 50, page * 50), page, page_size: 50, total });
  });

  secured.post('/api/v1/signals/:signalId/take', (req, res) => {
    const id = Number(req.params.signalId);
    const row = db.prepare('SELECT * FROM crisis_escalations WHERE id=?').get(id);
    if (!row || !canSignal(req, row)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (row.status === 'handled') return P.sendError(req, res, 409, 'E-SIGNAL-HANDLED');
    if (row.status === 'in_work') {
      if (row.taken_by === req.user.id)
        return res.json({ signal: signalView({ ...row, taken_name: req.user.full_name, taken_role: req.user.role }) });
      const who = db.prepare('SELECT full_name,role FROM users WHERE id=?').get(row.taken_by);
      return P.sendError(req, res, 409, 'E-SIGNAL-TAKEN', {
        details: { taken_by: { name: who.full_name, role: who.role, at: row.taken_at } },
      });
    }
    const changed = db
      .prepare(
        "UPDATE crisis_escalations SET status='in_work',taken_by=?,taken_at=?,outcome_due_at=?,version=version+1 WHERE id=? AND status='new'",
      )
      .run(
        req.user.id,
        iso(),
        P.iso(
          new Date(now(config).getTime() + Number(activeSetting('crisis.outcome_due_hours').value || 24) * 3600000),
        ),
        id,
      );
    if (!changed.changes) return P.sendError(req, res, 409, 'E-SIGNAL-TAKEN');
    log(id, row.patient_id, 'taken', req.user.id);
    const fresh = db
      .prepare(
        'SELECT ce.*,u.full_name taken_name,u.role taken_role FROM crisis_escalations ce LEFT JOIN users u ON u.id=ce.taken_by WHERE ce.id=?',
      )
      .get(id);
    const peers = db
      .prepare('SELECT clinician_id FROM care_assignments WHERE patient_id=? AND clinician_id<>? AND ended_at IS NULL')
      .all(row.patient_id, req.user.id);
    for (const peer of peers)
      notify(peer.clinician_id, 'crisis', 'crisis', id, row.patient_id, `Сигнал в работе у ${req.user.full_name}`);
    const undo = snapshotUndo(req.user.id, 'crisis', row);
    res.json({ signal: signalView(fresh), undo });
  });
  secured.post('/api/v1/signals/:signalId/contacted', (req, res) => {
    const id = Number(req.params.signalId);
    const row = db.prepare('SELECT * FROM crisis_escalations WHERE id=?').get(id);
    if (!row || !canSignal(req, row)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (row.status === 'handled') {
      if (row.handled_by === req.user.id) return res.json({ signal: signalView(row) });
      return P.sendError(req, res, 409, 'E-SIGNAL-HANDLED');
    }
    if (row.status === 'in_work' && row.taken_by !== req.user.id) return P.sendError(req, res, 409, 'E-SIGNAL-TAKEN');
    db.prepare(
      "UPDATE crisis_escalations SET status='handled',taken_by=COALESCE(taken_by,?),taken_at=COALESCE(taken_at,?),handled_by=?,handled_at=?,version=version+1 WHERE id=?",
    ).run(req.user.id, iso(), req.user.id, iso(), id);
    log(id, row.patient_id, 'contacted', req.user.id);
    res.json({
      signal: signalView({ ...row, status: 'handled', taken_by: req.user.id, taken_at: iso() }),
      undo: snapshotUndo(req.user.id, 'crisis', row),
    });
  });
  secured.post('/api/v1/signals/:signalId/outcome', (req, res) => {
    const id = Number(req.params.signalId);
    const row = db.prepare('SELECT * FROM crisis_escalations WHERE id=?').get(id);
    if (!row || !canSignal(req, row)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (row.taken_by !== req.user.id) return P.sendError(req, res, 409, 'E-SIGNAL-TAKEN');
    if (!['contacted_safe', 'referred', 'emergency', 'no_contact', 'other'].includes(req.body.outcome))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    db.prepare(
      "UPDATE crisis_escalations SET status='handled',handled_by=?,handled_at=?,outcome_code=?,outcome_note_enc=?,version=version+1 WHERE id=?",
    ).run(req.user.id, iso(), req.body.outcome || null, String(req.body.note || '').slice(0, 500), id);
    log(id, row.patient_id, 'outcome', req.user.id);
    res.json({ signal: signalView({ ...row, status: 'handled' }), undo: snapshotUndo(req.user.id, 'crisis', row) });
  });
  secured.post('/api/v1/signals/:signalId/release', (req, res) => {
    const id = Number(req.params.signalId);
    const row = db.prepare('SELECT * FROM crisis_escalations WHERE id=?').get(id);
    if (!row || !canSignal(req, row)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (row.taken_by !== req.user.id || !String(req.body.note || '').trim())
      return P.sendError(req, res, 422, 'E-VALIDATION');
    db.prepare(
      "UPDATE crisis_escalations SET status='new',taken_by=NULL,taken_at=NULL,version=version+1 WHERE id=?",
    ).run(id);
    db.prepare('UPDATE crisis_escalations SET outcome_note_enc=? WHERE id=?').run(
      String(req.body.note).trim().slice(0, 500),
      id,
    );
    log(id, row.patient_id, 'released', req.user.id, { note_recorded: true });
    for (const peer of db
      .prepare('SELECT clinician_id FROM care_assignments WHERE patient_id=? AND ended_at IS NULL')
      .all(row.patient_id))
      notify(peer.clinician_id, 'crisis', 'crisis', id, row.patient_id, 'Новый сигнал безопасности');
    res.json({
      signal: signalView({ ...row, status: 'new', taken_by: null }),
      undo: snapshotUndo(req.user.id, 'crisis', row),
    });
  });

  secured.post('/api/v1/me/adverse-events', (req, res) => {
    // F-45: серверный черновик НЯ. submit:false — сохранить draft; draft_id —
    // редактировать/финализировать/отменить свой draft; discard:true — мягко отменить.
    // Обычный POST без draft_id по-прежнему отправляет сразу (старый контракт).
    const draftId = req.body.draft_id ? Number(req.body.draft_id) : null;
    const isDiscard = req.body.discard === true;
    const isDraft = req.body.submit === false;
    let draftVersion = null;
    // discard без draft_id — ошибка валидации, а не «тихая» обычная отправка.
    if (isDiscard && !draftId) return P.sendError(req, res, 422, 'E-VALIDATION');
    if (isDiscard && draftId) {
      const row = db
        .prepare("SELECT id FROM adverse_events WHERE id=? AND patient_id=? AND status='draft'")
        .get(draftId, req.user.id);
      if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      db.prepare("UPDATE adverse_events SET status='cancelled',updated_at=? WHERE id=?").run(iso(), draftId);
      db.prepare(
        "UPDATE stored_files SET status='temp',expires_at=? WHERE linked_type='adverse_event' AND linked_id=? AND status='linked'",
      ).run(iso(), draftId);
      return res.json({ ae: { id: draftId, status: 'cancelled', version: 1 } });
    }
    // Опрос из чата: «ничего не принимаю» - это не побочный эффект, запись не создаётся.
    if (req.body.med && typeof req.body.med === 'object' && req.body.med.kind === 'none')
      return res.json({ not_adverse: true, saved: false });
    if (draftId && !isDiscard) {
      const row = db
        .prepare('SELECT id,status,version FROM adverse_events WHERE id=? AND patient_id=?')
        .get(draftId, req.user.id);
      if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      if (row.status !== 'draft') return P.sendError(req, res, 409, 'E-CONFLICT');
      // Версия необязательна: интерфейс шлёт только draft_id; если клиент прислал version, она должна совпасть.
      if (req.body.version !== undefined && Number(req.body.version) !== row.version)
        return P.sendError(req, res, 409, 'E-CONFLICT');
      draftVersion = row.version;
    }
    const text = String(req.body.text || '');
    if (
      (!isDraft && !text.trim()) ||
      text.length > 1000 ||
      (req.body.severity && !['mild', 'noticeable', 'severe'].includes(req.body.severity)) ||
      (req.body.related && !['yes', 'no', 'unknown'].includes(req.body.related))
    )
      return P.sendError(req, res, 422, 'E-VALIDATION');
    const symptomsIn = aeIntake.normalizeSymptoms(req.body.symptoms);
    if (symptomsIn === null) return P.sendError(req, res, 422, 'E-VALIDATION');
    // Новые поля опроса: source, thread_id, med. Без них работает прежний контракт.
    const medIn = req.body.med;
    if (
      medIn !== undefined &&
      (!medIn ||
        typeof medIn !== 'object' ||
        !['plan_item', 'other'].includes(medIn.kind) ||
        (medIn.kind === 'plan_item' && !medIn.item_key) ||
        (medIn.kind === 'other' && !medIn.patient_med_id && !medIn.inn_id && !String(medIn.name || '').trim()))
    )
      return P.sendError(req, res, 422, 'E-VALIDATION');
    if (req.body.source !== undefined && !['form', 'ai_chat'].includes(req.body.source))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    const intakeThread =
      req.body.thread_id !== undefined && req.body.thread_id !== null
        ? aeIntake.ownThread(db, req.user, req.user.id, req.body.thread_id)
        : null;
    if (req.body.thread_id !== undefined && req.body.thread_id !== null && !intakeThread)
      return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const itemKeyIn = medIn ? (medIn.kind === 'plan_item' ? medIn.item_key : null) : req.body.item_key;
    const patientMedIn = medIn ? (medIn.kind === 'other' ? medIn.patient_med_id : null) : req.body.patient_med_id;
    const innIn = medIn && medIn.kind === 'other' && medIn.inn_id ? Number(medIn.inn_id) : null;
    if (innIn && !db.prepare('SELECT 1 FROM inn WHERE id=?').get(innIn))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    const medText =
      medIn && medIn.kind === 'other' && !patientMedIn && medIn.name ? String(medIn.name).trim().slice(0, 200) : null;
    const hasUploadList = Array.isArray(req.body.upload_ids);
    const uploadIds = hasUploadList ? req.body.upload_ids.map(Number) : [];
    if (uploadIds.length > 5) return P.sendError(req, res, 422, 'E-FILE-COUNT');
    if (
      new Set(uploadIds).size !== uploadIds.length ||
      uploadIds.some(
        (id) =>
          !db
            .prepare(
              "SELECT 1 FROM stored_files WHERE id=? AND owner_user_id=? AND ((status='temp' AND expires_at>?) OR (status='linked' AND linked_type='adverse_event' AND linked_id=?))",
            )
            .get(id, req.user.id, iso(), draftId ?? -1),
      )
    )
      return P.sendError(req, res, 422, 'E-VALIDATION');
    let medication = null;
    if (itemKeyIn)
      medication = db
        .prepare(
          "SELECT pi.item_key,pi.inn_id FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id JOIN plan_item_acceptance a ON a.item_key=pi.item_key AND a.patient_id=pv.patient_id AND a.hidden_at IS NULL WHERE pv.patient_id=? AND pv.status='published' AND pv.visible_from<=? AND pi.item_key=? AND pi.status='active'",
        )
        .get(req.user.id, iso(), String(itemKeyIn));
    else if (patientMedIn)
      medication = db
        .prepare(
          "SELECT pm.id patient_med_id,pmv.inn_id FROM patient_meds pm JOIN patient_med_versions pmv ON pmv.patient_med_id=pm.id AND pmv.version=pm.current_version WHERE pm.id=? AND pm.patient_id=? AND pm.hidden_at IS NULL AND pm.status='active'",
        )
        .get(Number(patientMedIn), req.user.id);
    else if (innIn) medication = { inn_id: innIn };
    if ((itemKeyIn || patientMedIn) && !medication) return P.sendError(req, res, 422, 'E-VALIDATION');
    const c = req.crisisResult;
    const syncFiles = (aeId) => {
      // Без явного списка upload_ids существующие привязки не трогаем (F-45: файлы
      // черновика сохраняются при финальной отправке и редактировании черновика).
      if (!hasUploadList) return;
      const current = db
        .prepare("SELECT id FROM stored_files WHERE linked_type='adverse_event' AND linked_id=? AND status='linked'")
        .all(aeId);
      for (const f of current)
        if (!uploadIds.includes(f.id))
          db.prepare("UPDATE stored_files SET status='temp',expires_at=? WHERE id=?").run(iso(), f.id);
      for (const fileId of uploadIds)
        db.prepare(
          "UPDATE stored_files SET purpose='ae_attachment',linked_type='adverse_event',linked_id=?,patient_id=?,status='linked',expires_at=NULL WHERE id=?",
        ).run(aeId, req.user.id, fileId);
    };
    const psych = clinicianFor(req.user.id, true);
    const visible = P.iso(
      new Date(now(config).getTime() + Number(activeSetting('ui.undo_window_seconds').value || 10) * 1000),
    );
    const fields = {
      symptoms: JSON.stringify(symptomsIn),
      text: text.slice(0, 1000),
      onset: req.body.started_on || null,
      severity: req.body.severity || null,
      related: req.body.related || null,
      itemKey: medication ? medication.item_key || null : null,
      patientMedId: medication ? medication.patient_med_id || null : null,
      innId: medication ? medication.inn_id : null,
      medText,
      source: req.body.source === 'ai_chat' ? 'ai_chat' : 'form',
      threadId: intakeThread ? intakeThread.id : null,
    };
    if (isDraft) {
      let id;
      if (draftId) {
        db.prepare(
          'UPDATE adverse_events SET complaint_codes_json=?,description_enc=?,onset_date=?,severity=?,relation_patient=?,item_key=?,patient_med_id=?,inn_id=?,med_text_enc=?,source=?,thread_id=?,version=version+1,updated_at=? WHERE id=?',
        ).run(
          fields.symptoms,
          fields.text,
          fields.onset,
          fields.severity,
          fields.related,
          fields.itemKey,
          fields.patientMedId,
          fields.innId,
          fields.medText,
          fields.source,
          fields.threadId,
          iso(),
          draftId,
        );
        id = draftId;
      } else {
        const info = db
          .prepare(
            "INSERT INTO adverse_events(patient_id,complaint_codes_json,description_enc,onset_date,severity,relation_patient,item_key,patient_med_id,inn_id,med_text_enc,source,thread_id,reported_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)",
          )
          .run(
            req.user.id,
            fields.symptoms,
            fields.text,
            fields.onset,
            fields.severity,
            fields.related,
            fields.itemKey,
            fields.patientMedId,
            fields.innId,
            fields.medText,
            fields.source,
            fields.threadId,
            req.user.id,
            iso(),
            iso(),
          );
        id = Number(info.lastInsertRowid);
      }
      syncFiles(id);
      return res.status(draftId ? 200 : 201).json({
        ae: { id, version: draftId ? draftVersion + 1 : 1, status: 'draft' },
        ...(c ? { crisis: c } : {}),
      });
    }
    let id;
    if (draftId) {
      db.prepare(
        'UPDATE adverse_events SET complaint_codes_json=?,description_enc=?,onset_date=?,severity=?,relation_patient=?,item_key=?,patient_med_id=?,inn_id=?,med_text_enc=?,source=?,thread_id=?,reported_by=?,status=?,visible_from=?,psychiatrist_id=?,updated_at=? WHERE id=?',
      ).run(
        fields.symptoms,
        fields.text,
        fields.onset,
        fields.severity,
        fields.related,
        fields.itemKey,
        fields.patientMedId,
        fields.innId,
        fields.medText,
        fields.source,
        fields.threadId,
        req.user.id,
        psych ? 'submitted' : 'service_queue',
        visible,
        psych?.clinician_id || null,
        iso(),
        draftId,
      );
      id = draftId;
    } else {
      const info = db
        .prepare(
          'INSERT INTO adverse_events(patient_id,complaint_codes_json,description_enc,onset_date,severity,relation_patient,item_key,patient_med_id,inn_id,med_text_enc,source,thread_id,reported_by,status,visible_from,psychiatrist_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          req.user.id,
          fields.symptoms,
          fields.text,
          fields.onset,
          fields.severity,
          fields.related,
          fields.itemKey,
          fields.patientMedId,
          fields.innId,
          fields.medText,
          fields.source,
          fields.threadId,
          req.user.id,
          psych ? 'submitted' : 'service_queue',
          visible,
          psych?.clinician_id || null,
          iso(),
          iso(),
        );
      id = Number(info.lastInsertRowid);
    }
    syncFiles(id);
    // Нет психиатра: запись остаётся только у пациента (status service_queue без psychiatrist_id), службе не уходит.
    if (psych)
      notify(psych.clinician_id, 'ae', 'adverse_event', id, req.user.id, 'Новое сообщение о переносимости', visible);
    let summary;
    if (intakeThread) {
      const saved = db.prepare('SELECT * FROM adverse_events WHERE id=?').get(id);
      summary = aeIntake.writeSummary(db, {
        threadId: intakeThread.id,
        iso,
        text: aeIntake.summaryText(psych ? 'sent' : 'saved_private', saved, { drug: aeIntake.drugName(db, saved) }),
      });
    }
    res.status(201).json({
      ae: { id, version: 1, status: psych ? 'awaiting_visibility' : 'saved_private', attached: Boolean(psych) },
      ...(summary ? { summary } : {}),
      undo: makeUndo(req.user.id, 'ae.report', 'adverse_event', id),
      ...(c ? { crisis: c } : {}),
    });
  });
  secured.get('/api/v1/me/adverse-events', (req, res) => {
    const items = db
      .prepare(
        "SELECT id,status,visible_from,created_at,psychiatrist_id FROM adverse_events WHERE patient_id=? AND status<>'draft' AND status<>'cancelled' ORDER BY id DESC",
      )
      .all(req.user.id)
      .map(({ psychiatrist_id: psychiatristId, ...x }) => ({
        ...x,
        // Личная запись без врача (status service_queue, psychiatrist_id пуст) - «Сохранено у вас».
        attached: !(x.status === 'service_queue' && !psychiatristId),
        status: ['related_likely', 'not_related', 'insufficient'].includes(x.status)
          ? 'reviewed'
          : x.status === 'submitted' && x.visible_from <= iso()
            ? 'awaiting_doctor'
            : x.status === 'service_queue' && !psychiatristId
              ? 'saved_private'
              : x.status,
      }));
    // F-45: активный draft пациента с редактируемыми полями, med_ref и файлами.
    const draftRow = db
      .prepare("SELECT * FROM adverse_events WHERE patient_id=? AND status='draft' ORDER BY id DESC LIMIT 1")
      .get(req.user.id);
    const draft = draftRow
      ? {
          id: draftRow.id,
          version: draftRow.version,
          text: draftRow.description_enc,
          symptoms: JSON.parse(draftRow.complaint_codes_json || '[]'),
          started_on: draftRow.onset_date,
          severity: draftRow.severity,
          related: draftRow.relation_patient,
          med_ref: draftRow.item_key
            ? `plan:${draftRow.item_key}`
            : draftRow.patient_med_id
              ? `own:${draftRow.patient_med_id}`
              : null,
          upload_ids: db
            .prepare(
              "SELECT id FROM stored_files WHERE linked_type='adverse_event' AND linked_id=? AND status='linked'",
            )
            .all(draftRow.id)
            .map((x) => x.id),
        }
      : null;
    res.json({ items, draft, page: 1, page_size: 50, total: items.length });
  });
  secured.post('/api/v1/adverse-events/:aeId/decision', (req, res) => {
    const id = Number(req.params.aeId);
    const ae = db.prepare('SELECT * FROM adverse_events WHERE id=?').get(id);
    if (!ae || !assigned(req.user.id, ae.patient_id)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (ae.status === 'service_queue' && !ae.psychiatrist_id) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (ae.decision_by && ae.decision_by !== req.user.id)
      return P.sendError(req, res, 409, 'E-CONFLICT', { details: { decided_by: ae.decision_by } });
    if (!['submitted', 'awaiting_doctor', 'service_queue'].includes(ae.status))
      return P.sendError(req, res, 409, 'E-CONFLICT');
    if (!['probable', 'unrelated', 'insufficient'].includes(req.body.decision))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    if (req.body.comment != null && (typeof req.body.comment !== 'string' || req.body.comment.length > 1000))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    const status =
      req.body.decision === 'probable'
        ? 'related_likely'
        : req.body.decision === 'unrelated'
          ? 'not_related'
          : 'insufficient';
    db.prepare(
      'UPDATE adverse_events SET status=?,decision_by=?,decision_at=?,serious=?,decision_comment_enc=?,version=version+1,updated_at=? WHERE id=?',
    ).run(status, req.user.id, iso(), req.body.serious ? 1 : 0, req.body.comment || null, iso(), id);
    notify(ae.patient_id, 'ae_reviewed', 'adverse_event', id, ae.patient_id, 'Специалист посмотрел ваше сообщение');
    res.json({
      ae: { id, status: req.body.decision, version: ae.version + 1 },
      undo: snapshotUndo(req.user.id, 'ae', ae),
    });
  });
  function noticeFields(ae, reporter) {
    const plan = db
      .prepare(
        "SELECT id FROM plan_versions WHERE patient_id=? AND status='published' AND (visible_from IS NULL OR visible_from<=?) ORDER BY version DESC LIMIT 1",
      )
      .get(ae.patient_id, iso());
    const items = plan
      ? db
          .prepare(
            "SELECT pi.*,i.name inn_name,dp.trade_name,dp.manufacturer FROM plan_items pi JOIN inn i ON i.id=pi.inn_id LEFT JOIN purchase_marks pm ON pm.patient_id=? AND pm.item_key=pi.item_key AND pm.status='current' LEFT JOIN drug_products dp ON dp.id=pm.product_id WHERE pi.plan_version_id=? AND pi.status='active' AND (pi.end_date IS NULL OR pi.end_date>=?) ORDER BY pi.id",
          )
          .all(ae.patient_id, plan.id, iso().slice(0, 10))
      : [];
    // A suspected drug is known only when the report links an actual item/INN.
    const suspected = items.find((item) =>
      ae.item_key ? item.item_key === ae.item_key : ae.inn_id ? item.inn_id === ae.inn_id : false,
    );
    const regimen = (item) =>
      [item.dose_value, item.dose_unit, ...JSON.parse(item.times_json || '[]')]
        .filter((value) => value != null && value !== '')
        .join(' ');
    const symptoms = JSON.parse(ae.complaint_codes_json || '[]').map(
      (code) => NOTICE_LABELS[`msg.ae.chip.${code}`] || String(code),
    );
    // Порядок и состав — по «Рекомендуемой форме» (Приложение № 1 к Порядку фармаконадзора Росздравнадзора).
    return {
      report_type: 'Первичное',
      previous_report_number: '',
      patient: `П-${ae.patient_id}`,
      sex: '',
      weight: '',
      age: '',
      pregnancy: '',
      allergy: '',
      treatment_setting: '',
      trade_name: suspected?.trade_name || suspected?.inn_name || (suspected ? '' : ae.med_text_enc || ''),
      inn: suspected?.inn_name || '',
      manufacturer: suspected?.manufacturer || '',
      batch: '',
      dose: suspected ? regimen(suspected) : '',
      administration_route: '',
      drug_started_on: suspected?.start_date || '',
      drug_stopped_on: suspected?.end_date || '',
      indication: '',
      onset_date: ae.onset_date || '',
      description: [
        ae.description_enc,
        symptoms.length ? `${NOTICE_LABELS['msg.ae.chat.part.symptoms']} ${symptoms.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      resolved_on: '',
      seriousness_criteria: '',
      measures: '',
      outcome: '',
      dechallenge: '',
      rechallenge: '',
      rechallenge_result: '',
      other_medications: items
        .filter((item) => item !== suspected)
        .map((item) => [item.trade_name || item.inn_name, item.manufacturer, regimen(item)].filter(Boolean).join(' · '))
        .join('\n'),
      reporter_category: 'Врач',
      region: '',
      reporter_contact: reporter.email || '',
      reporter_name: reporter.full_name || '',
      reporter_position: '',
      report_date: iso().slice(0, 10),
      reporter_comment: '',
    };
  }
  // Поля, обязательные по бланку (отмечены «*»): код пациента, торговое наименование, описание, регион, контакт.
  const NOTICE_REQUIRED = ['patient', 'trade_name', 'description', 'region', 'reporter_contact'];
  const noticeMissing = (fields) => NOTICE_REQUIRED.filter((name) => !String((fields && fields[name]) ?? '').trim());
  const NOTICE_LABELS = require('../../../locales/ru.json');
  const noticeLabel = (name) => NOTICE_LABELS[`msg.v3.notice.${name}`] || name;
  function notice(req, res, next) {
    const ae = db.prepare('SELECT * FROM adverse_events WHERE id=?').get(Number(req.params.aeId));
    if (!ae || !assigned(req.user.id, ae.patient_id)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (req.user.role !== 'psychiatrist') return P.sendError(req, res, 403, 'E-ACCESS');
    if (ae.status !== 'related_likely') return P.sendError(req, res, 409, 'E-STATUS');
    req.ae = ae;
    next();
  }
  secured.get('/api/v1/adverse-events/:aeId/notice', notice, (req, res) => {
    const last = db
      .prepare('SELECT * FROM ae_notice_versions WHERE adverse_event_id=? ORDER BY version DESC LIMIT 1')
      .get(req.ae.id);
    const fields = last ? JSON.parse(last.fields_enc) : noticeFields(req.ae, req.user);
    const missing = noticeMissing(fields);
    res.json({ status: 'draft', version: last?.version || 1, fields, complete: missing.length === 0, missing });
  });
  secured.put('/api/v1/adverse-events/:aeId/notice', notice, (req, res) => {
    const current =
      db.prepare('SELECT MAX(version) version FROM ae_notice_versions WHERE adverse_event_id=?').get(req.ae.id)
        .version || 1;
    if (Number(req.body.version) !== current) return P.sendError(req, res, 409, 'E-CONFLICT');
    if (!req.body.fields || typeof req.body.fields !== 'object' || Array.isArray(req.body.fields))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    const v = current + 1;
    db.prepare(
      "INSERT INTO ae_notice_versions(adverse_event_id,patient_id,version,fields_enc,status,author_id,created_at) VALUES (?,?,?,?, 'draft',?,?)",
    ).run(req.ae.id, req.ae.patient_id, v, JSON.stringify(req.body.fields || {}), req.user.id, iso());
    res.json({ version: v, status: 'draft' });
  });
  secured.get('/api/v1/adverse-events/:aeId/notice/file', notice, (req, res) => {
    const format = req.query.format || 'txt';
    const exporter = require('../../ai/workspace/export');
    if (!['txt', 'pdf', 'docx'].includes(format)) return P.sendError(req, res, 422, 'E-VALIDATION');
    const last = db
      .prepare('SELECT * FROM ae_notice_versions WHERE adverse_event_id=? ORDER BY version DESC LIMIT 1')
      .get(req.ae.id);
    const fields = last ? JSON.parse(last.fields_enc) : noticeFields(req.ae, req.user);
    const document = {
      title: 'Извещение о нежелательной реакции или отсутствии терапевтического эффекта лекарственного препарата',
      label: 'ЧЕРНОВИК · по рекомендуемой форме Росздравнадзора',
      disclaimer:
        'Данные неполны; перед отправкой требуется проверка специалиста. Наружу автоматически не отправляется.',
      date: iso().slice(0, 10),
      note: `Версия: ${last?.version || 1}; автор: ${req.user.full_name}; время выгрузки: ${iso()}. Поля, отмеченные «*», обязательны. ${NOTICE_LABELS['msg.v3.notice.send_ways']}`,
      items: Object.entries(fields).map(([name, text]) => ({
        who: noticeLabel(name),
        text: typeof text === 'string' ? text : JSON.stringify(text),
      })),
    };
    const data = exporter.FORMATS[format].build(document);
    db.prepare(
      "INSERT INTO export_log(actor_id,kind,patient_id,row_count,recipient_class,created_at) VALUES (?,'ae_notice',?,1,'clinician',?)",
    ).run(req.user.id, req.ae.patient_id, iso());
    res.type(exporter.FORMATS[format].mime).attachment(`notice-draft.${format}`).send(data);
  });

  aeIntake.install(secured, { db, P, iso, notify, assigned });

  secured.post('/api/v1/patients/:patientId/visits', (req, res) => {
    const patient = Number(req.params.patientId);
    const start = new Date(req.body.starts_at);
    if (String(req.body.prepare || '').length > 500 || String(req.body.place || '').length > 1000)
      return P.sendError(req, res, 422, 'E-VALIDATION');
    if (req.body.format && !['in_person', 'remote'].includes(req.body.format))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    if (req.user.role !== 'psychiatrist') return P.sendError(req, res, 403, 'E-ACCESS');
    if (!assigned(req.user.id, patient)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (!Number.isFinite(start.getTime()) || start <= now(config)) return P.sendError(req, res, 422, 'E-VALIDATION');
    const visible = P.iso(
      new Date(now(config).getTime() + Number(activeSetting('ui.undo_window_seconds').value || 10) * 1000),
    );
    const x = db
      .prepare(
        "INSERT INTO visits(patient_id,clinician_id,starts_at,format,place,prepare_enc,previsit_enabled,status,visible_from,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,'scheduled',?,?,?,?)",
      )
      .run(
        patient,
        req.user.id,
        P.iso(start),
        req.body.format || 'in_person',
        req.body.place || null,
        req.body.prepare || null,
        req.body.previsit_enabled ? 1 : 0,
        visible,
        iso(),
        iso(),
        req.user.id,
      );
    const id = Number(x.lastInsertRowid);
    if (req.body.previsit_enabled)
      db.prepare(
        'INSERT INTO previsit_forms(patient_id,visit_id,requested_by,requested_at,status) VALUES (?,?,?,?,?)',
      ).run(patient, id, req.user.id, iso(), 'open');
    notify(patient, 'visit', 'visit', id, patient, 'Запланирован визит', visible);
    res.json({ visit: { id, version: 1 }, undo: makeUndo(req.user.id, 'visit.create', 'visit', id) });
  });
  secured.get('/api/v1/me/visits', (req, res) => {
    const items = db
      .prepare('SELECT * FROM visits WHERE patient_id=? AND visible_from<=? ORDER BY starts_at')
      .all(req.user.id, iso());
    res.json({ items });
  });
  secured.patch('/api/v1/visits/:visitId', (req, res) => {
    const v = db.prepare('SELECT * FROM visits WHERE id=?').get(Number(req.params.visitId));
    if (!v || v.clinician_id !== req.user.id) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (Number(req.body.version) !== v.version) return P.sendError(req, res, 409, 'E-CONFLICT');
    const status = req.body.status === 'held' ? 'done' : req.body.status || v.status;
    if (!['scheduled', 'done', 'no_show', 'cancelled'].includes(status))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    if (
      req.body.starts_at &&
      (!Number.isFinite(new Date(req.body.starts_at).getTime()) || new Date(req.body.starts_at) <= now(config))
    )
      return P.sendError(req, res, 422, 'E-VALIDATION');
    if (
      (req.body.format && !['in_person', 'remote'].includes(req.body.format)) ||
      String(req.body.prepare || '').length > 500 ||
      String(req.body.place || '').length > 1000
    )
      return P.sendError(req, res, 422, 'E-VALIDATION');
    db.prepare(
      'UPDATE visits SET starts_at=?,status=?,format=?,place=?,prepare_enc=?,previsit_enabled=?,version=version+1,updated_at=?,updated_by=? WHERE id=?',
    ).run(
      req.body.starts_at ? P.iso(new Date(req.body.starts_at)) : v.starts_at,
      status,
      req.body.format || v.format,
      req.body.place === undefined ? v.place : String(req.body.place),
      req.body.prepare === undefined ? v.prepare_enc : String(req.body.prepare),
      req.body.previsit_enabled === undefined ? v.previsit_enabled : req.body.previsit_enabled ? 1 : 0,
      iso(),
      req.user.id,
      v.id,
    );
    if (status === 'cancelled') db.prepare("UPDATE previsit_forms SET status='cancelled' WHERE visit_id=?").run(v.id);
    if (req.body.previsit_enabled && status !== 'cancelled')
      db.prepare(
        "INSERT OR IGNORE INTO previsit_forms(patient_id,visit_id,requested_by,requested_at,status) VALUES (?,?,?,?,'open')",
      ).run(v.patient_id, v.id, req.user.id, iso());
    notify(v.patient_id, 'visit', 'visit', v.id, v.patient_id, 'Изменён визит');
    res.json({ version: v.version + 1, visit: { id: v.id, version: v.version + 1, status } });
  });
  secured.get('/api/v1/patients/:patientId/visits', (req, res) => {
    const p = Number(req.params.patientId);
    if (!assigned(req.user.id, p)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const items = db.prepare('SELECT * FROM visits WHERE patient_id=?').all(p);
    const previsit = db
      .prepare(
        "SELECT pf.* FROM previsit_forms pf JOIN visits v ON v.id=pf.visit_id WHERE pf.patient_id=? AND pf.status='submitted' AND v.status<>'cancelled' ORDER BY pf.id DESC LIMIT 1",
      )
      .get(p);
    res.json({
      items,
      previsit: previsit
        ? {
            ...previsit,
            questions: questions(),
            answers: previsit.answers_json ? JSON.parse(previsit.answers_json) : null,
          }
        : null,
    });
  });
  const questions = () =>
    activeSetting('previsit.questions').value || [
      { id: 'sleep', type: 'text_long', text: 'Как вы себя чувствуете?', required: false },
      {
        id: 'changes',
        type: 'multi',
        text: 'Что изменилось?',
        options: [{ value: 'sleep', label: 'Сон' }],
        required: false,
      },
    ];
  secured.get('/api/v1/me/visits/:visitId/previsit', (req, res) => {
    const v = db
      .prepare('SELECT * FROM visits WHERE id=? AND patient_id=?')
      .get(Number(req.params.visitId), req.user.id);
    if (!v || v.status === 'cancelled') return P.sendError(req, res, 409, 'E-ASSIGNMENT-CLOSED');
    const days = Number(activeSetting('previsit.days_before').value?.days || 14);
    if (new Date(v.starts_at).getTime() - now(config).getTime() > days * 86400000)
      return P.sendError(req, res, 409, 'E-STATUS');
    const form = db
      .prepare('SELECT status,answers_json FROM previsit_forms WHERE visit_id=? AND patient_id=?')
      .get(v.id, req.user.id);
    res.json({
      questions: questions(),
      status: form?.status || 'open',
      answers: form?.answers_json ? JSON.parse(form.answers_json) : {},
    });
  });
  secured.put('/api/v1/me/visits/:visitId/previsit', (req, res) => {
    const v = db
      .prepare('SELECT * FROM visits WHERE id=? AND patient_id=?')
      .get(Number(req.params.visitId), req.user.id);
    if (!v || v.status === 'cancelled') return P.sendError(req, res, 409, 'E-ASSIGNMENT-CLOSED');
    const form = db
      .prepare('SELECT status FROM previsit_forms WHERE visit_id=? AND patient_id=?')
      .get(v.id, req.user.id);
    if (form?.status === 'submitted') return P.sendError(req, res, 409, 'E-CONFLICT');
    const c = req.crisisResult;
    const definitions = questions();
    if (
      Object.entries(req.body.answers || {}).some(([key, value]) => {
        const q = definitions.find((entry) => entry.id === key);
        if (!q) return true;
        if (q.type.startsWith('text')) return typeof value !== 'string' || value.length > 10000;
        const allowed = (q.options || []).map((option) => option.value);
        return q.type === 'multi'
          ? !Array.isArray(value) || value.some((item) => !allowed.includes(item))
          : !allowed.includes(value);
      })
    )
      return P.sendError(req, res, 422, 'E-VALIDATION');
    if (
      req.body.submit &&
      definitions.some(
        (q) =>
          q.required &&
          (req.body.answers?.[q.id] == null ||
            (typeof req.body.answers[q.id] === 'string' && !req.body.answers[q.id].trim()) ||
            (Array.isArray(req.body.answers[q.id]) && !req.body.answers[q.id].length)),
      )
    )
      return P.sendError(req, res, 422, 'E-VALIDATION');
    db.prepare('UPDATE previsit_forms SET answers_json=?,status=?,submitted_at=? WHERE visit_id=?').run(
      JSON.stringify(req.body.answers || {}),
      req.body.submit ? 'submitted' : 'open',
      req.body.submit ? iso() : null,
      v.id,
    );
    if (req.body.submit)
      notify(v.clinician_id, 'previsit_submitted', 'visit', v.id, req.user.id, 'Анкета перед визитом заполнена');
    res.json({ ok: true, ...(c ? { crisis: c } : {}) });
  });
}

module.exports = { install };
