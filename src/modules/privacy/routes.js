'use strict';

/**
 * W-50 (этап 14, веха В6): «Мои данные» (F-51), выгрузка (F-52, PD-18/19),
 * запрос на стирание и отмена (F-53, PD-12), исправление записи (F-54).
 * Очередь/стирание — из В5 (admin/queue, admin_deletion); здесь пациентские
 * эндпоинты по замороженному контракту. Ограничение записи при открытом
 * стирании (PD-12) — ранний перехватчик в src/server.js (Express-layer order:
 * он должен быть зарегистрирован раньше маршрутов дневника/назначений).
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const field = require('../../crypto/field');
const diaryStore = require('../diary/service');
const diaryStorage = require('../diary/storage');
const svc = require('../documents/service'); // storedZip — ZIP без зависимостей (store)

const LINK_TTL_MS = 15 * 60 * 1000; // S-23: одноразовая ссылка на 15 минут
const ERASURE_DUE_DAYS = 30;

// Что может исправлять специалист (F-54): белый список таблиц/колонок.
const CORRECTABLE = { mood_entries: ['mood', 'sleep', 'anxiety', 'note', 'triggers'] };
const CORRECTION_TYPES = { diary_entry: 'mood_entries' };

// Защита CSV от формул (PD-18): ячейка с =,+,-,@,Tab,CR — префикс "'".
function csvCell(v) {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvRow(cells) {
  return cells.map((c) => `"${csvCell(c).replaceAll('"', '""')}"`).join(';');
}

function install(app, { db, P, config, now, idemCached, saveIdem }) {
  const currentIso = () => P.iso(now(config));
  const isoAt = (date) => P.iso(date);
  const encKey = () => process.env.PII_ENC_KEY;

  function verifyPassword(req) {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    return Boolean(
      user && user.password_hash && bcrypt.compareSync(String(req.body.password || ''), user.password_hash),
    );
  }

  // --- Выгрузка своих данных (F-52) ----------------------------------------

  app.post('/api/v1/me/exports', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.status(201).json(state.cached);
    if (!verifyPassword(req)) return P.sendError(req, res, 401, 'E-REAUTH');
    const current = currentIso();
    const uid = req.user.id;

    const profile = db.prepare('SELECT service_no, email, full_name, role, created_at FROM users WHERE id=?').get(uid);
    const consents = db
      .prepare('SELECT consent_kind, action, created_at FROM consent_events WHERE user_id=? ORDER BY id')
      .all(uid);
    const diary = db
      .prepare(
        'SELECT id, entry_date, mood, sleep, anxiety, note, triggers, created_at FROM mood_entries WHERE patient_id=? ORDER BY entry_date, id',
      )
      .all(uid);
    const messages = db
      .prepare(
        "SELECT id, created_at, body AS text FROM care_messages WHERE patient_id=? AND status='sent' ORDER BY id",
      )
      .all(uid);
    const assignments = db
      .prepare('SELECT id, instrument, status, assigned_at FROM instrument_assignments WHERE patient_id=? ORDER BY id')
      .all(uid);
    const visits = db
      .prepare('SELECT id, starts_at, format, status FROM visits WHERE patient_id=? ORDER BY id')
      .all(uid);

    const diaryWorkspace = db
      .prepare('SELECT revision,state_json,updated_at FROM diary_workspaces WHERE patient_id=?')
      .get(uid);
    const bundle = {
      generated_at: current,
      profile,
      consents,
      diary,
      diary_workspace: diaryWorkspace
        ? {
            revision: diaryWorkspace.revision,
            state: diaryStore.create(db).read(uid).state,
            normalized: diaryStorage.exportData(db, uid),
            updated_at: diaryWorkspace.updated_at,
          }
        : null,
      messages,
      assignments,
      visits,
      flower: require('../flower/service')
        .create(db, { now: currentIso, today: () => current.slice(0, 10) })
        .exportData(uid),
      product_activity: db
        .prepare('SELECT role,event,recorded_at FROM analytics_product_activity WHERE user_id=? ORDER BY id')
        .all(uid),
    };
    const json = Buffer.from(JSON.stringify(bundle, null, 1), 'utf8');

    const csvLines = [csvRow(['тип', 'дата', 'поле', 'значение'])];
    for (const d of diary) {
      csvLines.push(csvRow(['дневник', d.entry_date, 'mood', d.mood]));
      csvLines.push(csvRow(['дневник', d.entry_date, 'sleep', d.sleep]));
      csvLines.push(csvRow(['дневник', d.entry_date, 'anxiety', d.anxiety]));
      if (d.note) csvLines.push(csvRow(['дневник', d.entry_date, 'note', d.note]));
      if (d.triggers) csvLines.push(csvRow(['дневник', d.entry_date, 'triggers', d.triggers]));
    }
    for (const m of messages) csvLines.push(csvRow(['сообщение', m.created_at, 'text', m.text]));
    for (const a of assignments) csvLines.push(csvRow(['назначение', a.assigned_at, 'instrument', a.instrument]));
    const csv = Buffer.from(csvLines.join('\n'), 'utf8');

    const counts = {
      diary: diary.length,
      messages: messages.length,
      assignments: assignments.length,
      visits: visits.length,
    };
    const summary = svc.renderExport(
      {
        typeTitle: 'Выгрузка моих данных',
        number: `EXP-${current.slice(0, 4)}-${uid}`,
        version: 1,
        sections: Object.entries(counts).map(([key, n]) => ({ key, text: `${key}: ${n}` })),
      },
      'pdf',
    );

    const zip = svc.storedZip([
      ['data.json', json],
      ['data.csv', csv],
      ['summary.pdf', summary.body],
    ]);
    const dir = path.join(config.dataDir, 'files');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const storage = `${crypto.randomUUID()}.zip`;
    fs.writeFileSync(path.join(dir, storage), zip, { mode: 0o600 });
    const info = db
      .prepare(
        "INSERT INTO stored_files(owner_user_id,purpose,storage_name,mime,size_bytes,sha256,scan_status,exif_stripped,status,expires_at,created_at) VALUES (?,'export_bundle',?,'application/zip',?,'', 'not_required',0,'temp',?,?)",
      )
      .run(uid, storage, zip.length, isoAt(new Date(now(config).getTime() + 20 * 60 * 1000)), current);
    const fileId = Number(info.lastInsertRowid);
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = isoAt(new Date(now(config).getTime() + LINK_TTL_MS));
    db.prepare('INSERT INTO export_links(user_id,file_id,link_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run(
      uid,
      fileId,
      P.sha(token),
      expires,
      current,
    );
    db.prepare(
      "INSERT INTO export_log(actor_id,kind,patient_id,row_count,recipient_class,created_at) VALUES (?,'self_export',?,?,?,?)",
    ).run(uid, uid, diary.length + messages.length + assignments.length + visits.length, 'patient', current);
    const response = {
      link: `/export/${token}`,
      expires_at: expires,
      format: String(req.body.format || 'zip_json_pdf'),
    };
    saveIdem(req.user.id, state, response);
    return res.status(201).json(response);
  });

  // Скачивание вне /api (операции скачивания в контракте нет).
  app.get('/export/:token', (req, res) => {
    const row = db.prepare('SELECT * FROM export_links WHERE link_hash=?').get(P.sha(String(req.params.token)));
    const fail = () => P.sendError(req, res, 410, 'E-EXPORT-LINK');
    if (!row) return fail();
    if (row.used_at) return fail();
    if (row.expires_at <= currentIso()) return fail();
    if (!req.user || req.user.id !== row.user_id) return fail();
    const file = db.prepare("SELECT * FROM stored_files WHERE id=? AND status<>'deleted'").get(row.file_id);
    if (!file) return fail();
    const filePath = path.join(config.dataDir, 'files', file.storage_name);
    if (!fs.existsSync(filePath)) return fail();
    db.prepare('UPDATE export_links SET used_at=? WHERE id=?').run(currentIso(), row.id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="my-data-export.zip"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(fs.readFileSync(filePath));
  });

  // --- Запрос на стирание (F-53, PD-12) ------------------------------------

  function revokeResearchConsent(userId, current) {
    const version = db
      .prepare(
        "SELECT id, body_sha256 FROM content_versions WHERE kind='consent.research' AND status='published' ORDER BY version DESC LIMIT 1",
      )
      .get();
    if (!version) return;
    db.prepare(
      'INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(userId, 'research', 'revoked', version.id, version.body_sha256, 'patient_request', current);
  }

  app.post('/api/v1/me/deletion-request', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const body = req.body || {};
    if (body.confirm !== true) return P.sendError(req, res, 422, 'E-VALIDATION');
    if (!verifyPassword(req)) return P.sendError(req, res, 401, 'E-AUTH-INVALID');
    const open = db
      .prepare(
        "SELECT id FROM data_subject_requests WHERE patient_id=? AND request_type='erasure' AND status IN ('submitted','in_work','waiting_crisis')",
      )
      .get(req.user.id);
    if (open) return P.sendError(req, res, 409, 'E-ALREADY-REQUESTED');
    const current = currentIso();
    const due = isoAt(new Date(now(config).getTime() + ERASURE_DUE_DAYS * 86400000));
    const reason = String(body.reason || '').slice(0, 2000);
    const created = db.transaction(() => {
      // PD-12: обработка ограничена сразу (перехватчик в server.js), запись
      // статуса аккаунта — сигнал для админ-стирания (admin_deletion).
      db.prepare("UPDATE users SET status='deletion_requested' WHERE id=?").run(req.user.id);
      // PD-09: отзыв научного согласия; отмена стирания его не возвращает (T-202).
      revokeResearchConsent(req.user.id, current);
      const dsrId = Number(
        db
          .prepare(
            "INSERT INTO data_subject_requests(patient_id,request_type,text_enc,status,due_at,requested_at) VALUES (?,'erasure',?,'submitted',?,?)",
          )
          .run(req.user.id, reason ? field.encrypt(encKey(), reason) : null, due, current).lastInsertRowid,
      );
      // Очередь администратора (F-82): пациент — только номером (T-203).
      db.prepare(
        "INSERT INTO service_queue(kind,patient_id,ref_type,ref_id,priority,due_at,status,created_at) VALUES ('erasure',?,'dsr',?,5,?,'new',?)",
      ).run(req.user.id, dsrId, due, current);
      return dsrId;
    })();
    const response = { ok: true, id: created, status: 'submitted', due_at: due };
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  app.delete('/api/v1/me/deletion-request', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    const open = db
      .prepare(
        "SELECT id, status FROM data_subject_requests WHERE patient_id=? AND request_type='erasure' AND status IN ('submitted','in_work','waiting_crisis') ORDER BY id DESC LIMIT 1",
      )
      .get(req.user.id);
    if (!open) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const current = currentIso();
    db.transaction(() => {
      db.prepare("UPDATE data_subject_requests SET status='cancelled', version=version+1 WHERE id=?").run(open.id);
      // Отмена возвращает аккаунт в активные; уже отозванные согласия не восстанавливаются (T-202).
      db.prepare("UPDATE users SET status='active' WHERE id=? AND status='deletion_requested'").run(req.user.id);
      db.prepare(
        "UPDATE service_queue SET status='rejected', closed_at=?, result_code='withdrawn', version=version+1 WHERE ref_type='dsr' AND ref_id=? AND status IN ('new','taken','waiting')",
      ).run(current, open.id);
    })();
    const response = { ok: true, id: open.id };
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  // --- Исправление записи (F-54, record_revisions) --------------------------

  app.post('/api/v1/me/corrections', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.status(201).json(state.cached);
    const record = (req.body && req.body.record) || {};
    const text = String((req.body && req.body.text) || '').slice(0, 2000);
    const table = CORRECTION_TYPES[String(record.type || '')];
    const rowId = Number(record.id);
    if (!table || !Number.isInteger(rowId) || !text) return P.sendError(req, res, 422, 'E-VALIDATION');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND patient_id=?`).get(rowId, req.user.id);
    if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const openSame = db
      .prepare(
        "SELECT id FROM data_subject_requests WHERE patient_id=? AND request_type='correction' AND subject_ref_type=? AND subject_ref_id=? AND status IN ('submitted','in_work','pending')",
      )
      .get(req.user.id, table, rowId);
    if (openSame) return P.sendError(req, res, 409, 'E-ALREADY-REQUESTED');
    const current = currentIso();
    const due = isoAt(new Date(now(config).getTime() + ERASURE_DUE_DAYS * 86400000));
    const id = Number(
      db
        .prepare(
          "INSERT INTO data_subject_requests(patient_id,request_type,subject_ref_type,subject_ref_id,text_enc,status,due_at,requested_at) VALUES (?,'correction',?,?,?,?,?,?)",
        )
        .run(req.user.id, table, rowId, field.encrypt(encKey(), text), 'submitted', due, current).lastInsertRowid,
    );
    const response = { id, version: 1, status: 'submitted', due_at: due };
    saveIdem(req.user.id, state, response);
    return res.status(201).json(response);
  });

  app.get('/api/v1/patients/:patient_id/corrections', (req, res) => {
    const patientId = Number(req.params.patient_id);
    const rows = db
      .prepare(
        "SELECT id, subject_ref_type, subject_ref_id, status, due_at, version, requested_at FROM data_subject_requests WHERE patient_id=? AND request_type='correction' ORDER BY id DESC LIMIT 200",
      )
      .all(patientId);
    return res.json({ items: rows, page: 1, page_size: 50, total: rows.length });
  });

  app.post('/api/v1/corrections/:correction_id/decision', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const id = Number(req.params.correction_id);
    const dsr = db.prepare("SELECT * FROM data_subject_requests WHERE id=? AND request_type='correction'").get(id);
    if (!dsr) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    // Решение принимает только закреплённый специалист (чужой — 404, T-205).
    const assigned = db
      .prepare(
        "SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL AND (end_reason IS NULL OR end_reason<>'signal_only')",
      )
      .get(dsr.patient_id, req.user.id);
    if (!assigned) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const body = req.body || {};
    // Версия проверяется раньше статуса: устаревшая версия — E-CONFLICT (T-205).
    if (Number(body.version) !== dsr.version) return P.sendError(req, res, 409, 'E-CONFLICT');
    if (!['submitted', 'in_work'].includes(dsr.status)) return P.sendError(req, res, 409, 'E-STATUS');
    const decision = String(body.decision || '');
    const reason = String(body.reason || '').slice(0, 1000);
    if (!['accept', 'reject'].includes(decision) || !reason) return P.sendError(req, res, 422, 'E-VALIDATION');
    const current = currentIso();
    if (decision === 'accept') {
      const table = dsr.subject_ref_type;
      const columns = CORRECTABLE[table];
      const newValue = body.new_value || {};
      if (!columns || typeof newValue !== 'object') return P.sendError(req, res, 422, 'E-VALIDATION');
      const keys = Object.keys(newValue).filter((k) => columns.includes(k));
      if (!keys.length) return P.sendError(req, res, 422, 'E-VALIDATION');
      const row = db
        .prepare(`SELECT * FROM ${table} WHERE id=? AND patient_id=?`)
        .get(dsr.subject_ref_id, dsr.patient_id);
      if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      const revision =
        db.prepare('SELECT count(*) n FROM record_revisions WHERE table_name=? AND row_id=?').get(table, row.id).n + 1;
      db.transaction(() => {
        const updates = keys.map((k) => `${k}=?`).join(', ');
        db.prepare(`UPDATE ${table} SET ${updates} WHERE id=?`).run(...keys.map((k) => newValue[k]), row.id);
        db.prepare(
          'INSERT INTO record_revisions(patient_id,table_name,row_id,revision,before_json,reason,request_id,changed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run(
          dsr.patient_id,
          table,
          row.id,
          revision,
          JSON.stringify(Object.fromEntries(keys.map((k) => [k, row[k]]))),
          reason,
          dsr.id,
          req.user.id,
          current,
        );
        db.prepare(
          "UPDATE data_subject_requests SET status='done', version=version+1, answer_enc=?, executed_at=?, executed_by=? WHERE id=?",
        ).run(field.encrypt(encKey(), JSON.stringify({ decision, reason })), current, req.user.id, dsr.id);
      })();
    } else {
      db.prepare("UPDATE data_subject_requests SET status='rejected', version=version+1, answer_enc=? WHERE id=?").run(
        field.encrypt(encKey(), JSON.stringify({ decision, reason })),
        dsr.id,
      );
    }
    const response = { ok: true, id: dsr.id, decision, status: decision === 'accept' ? 'done' : 'rejected' };
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });
}

module.exports = { install };
