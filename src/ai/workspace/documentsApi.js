'use strict';

/**
 * Документы пациента (вкладка «Шаблоны и документы»): заполненный экземпляр формы для конкретного закреплённого
 * пациента. Сейчас единственная форма — «Извещение о нежелательной реакции (Росздравнадзор)», шаблон
 * `b-roszdravnadzor`. Шаблон не меняется и не превращается в документ: документ создаётся из него.
 * Статусы: «Черновик» (правится) и «Готово» (неизменяем, триггер clinician_documents_ready_immutable);
 * ошибку исправляют «исправленной версией» — новым черновиком на основе готового.
 * Поля хранятся типизированным JSON под полевым шифрованием (F-80); бланк собирается при выгрузке модулем
 * src/modules/documents/notice_form.js. Наружу ничего не уходит: скачивание пишет export_log.
 * Пути — вне замороженного /api/v1: только психиатр-владелец и только закреплённый пациент.
 */

const crypto = require('crypto');
const field = require('../../crypto/field');
const { isFullyAssigned, hasBaseConsent } = require('../../access/assignment');
const LABELS = require('../../../locales/ru.json');

const NOTICE_KEY = 'b-roszdravnadzor';
// Документ из текстового шаблона с подставленными данными пациента: {title, body}, сразу «Готово», не правится.
const TEXT_KEY = 'text';
const TITLE_MAX = 200;
const BODY_MAX = 10000;
const FORMATS = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const SUSPECT_MAX = 3;
const OTHER_MAX = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Бланк (validate / render / blank) — src/modules/documents/notice_form.js; контракт полей v1 в .agents/tasks/2026-10-26-templates-and-documents.md.
const noticeForm = () => require('../../modules/documents/notice_form');

function install(app, h) {
  const { db, P, nowIso } = h;
  const encKey = () => process.env.PII_ENC_KEY;

  const guard = (req, res, mutating) => {
    const user = req.user;
    if (!user) {
      P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      return null;
    }
    // Психолог: извещение у него не заведено (решение владелицы) — 403, как и у остальных ролей.
    if (user.role !== 'psychiatrist') {
      P.sendError(req, res, 403, 'E-ACCESS');
      return null;
    }
    if (mutating && (!req.session || req.headers['x-csrf-token'] !== req.session.data.csrf)) {
      P.sendError(req, res, 403, 'E-CSRF');
      return null;
    }
    return user;
  };

  // Idempotency-Key для создающих/фиксирующих POST: тот же ключ и тело — прежний ответ; другое тело — 409.
  const withIdem = (req, res, user, status, produce) => {
    if (!req.headers['idempotency-key'] || !h.idemCached) return produce(null);
    const state = h.idemCached(req, user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) {
      // В таблице ключей хранится только номер документа, без полей (там данные пациента).
      const row = db
        .prepare('SELECT * FROM clinician_documents WHERE id=? AND owner_id=?')
        .get(state.cached.document_id, user.id);
      return row ? res.status(status).json({ document: full(row) }) : P.sendError(req, res, 404, 'E-NOT-FOUND');
    }
    return produce(state);
  };
  const reply = (res, user, state, status, body) => {
    if (state && h.saveIdem) h.saveIdem(user.id, state, { document_id: body.document.id });
    return res.status(status).json(body);
  };

  const invalid = (req, res, fieldName, key = 'err.e-validation') =>
    P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: fieldName, key }] });

  const assigned = (clinicianId, patientId) => isFullyAssigned(db, patientId, clinicianId);

  const seal = (fields) => field.encrypt(encKey(), JSON.stringify(fields));
  const open = (row) => {
    const d = field.decrypt(encKey(), row.fields_enc);
    return d.ok ? JSON.parse(d.value) : null;
  };

  const titleOf = (key) => (key === NOTICE_KEY ? LABELS['msg.doc.notice.title'] : key);
  const patientOf = (id) => {
    const u = db.prepare('SELECT id,service_no,full_name FROM users WHERE id=?').get(id);
    return u ? { id: u.id, service_no: u.service_no, name: u.full_name || '' } : { id, service_no: '', name: '' };
  };

  const isText = (row) => row.template_key === TEXT_KEY;
  const meta = (row) => {
    const next = db
      .prepare('SELECT id FROM clinician_documents WHERE supersedes_id=? ORDER BY id DESC LIMIT 1')
      .get(row.id);
    return {
      id: row.id,
      template_key: row.template_key,
      kind: isText(row) ? 'text' : 'form',
      title: isText(row) ? (open(row) || {}).title || '' : titleOf(row.template_key),
      patient: patientOf(row.patient_id),
      ae_id: row.ae_id,
      status: row.status,
      version: row.version,
      supersedes_id: row.supersedes_id,
      superseded_by: next ? next.id : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  };
  const full = (row) => {
    if (isText(row)) {
      const text = open(row) || {};
      return { ...meta(row), body: text.body || '', fields: {}, missing: [], complete: true };
    }
    const fields = open(row);
    const checked = fields ? noticeForm().validate(fields) : { fields: {}, missing: [] };
    return { ...meta(row), fields: checked.fields, missing: checked.missing, complete: checked.missing.length === 0 };
  };
  const missingError = (req, res, missing) =>
    P.sendError(req, res, 422, 'E-VALIDATION', {
      fields: missing.map((name) => ({ field: name, key: `msg.doc.field.${name}` })),
      missing,
    });

  // Свой документ закреплённого пациента, иначе 404 (чужой и «открепили» неотличимы от несуществующего).
  const loadOwn = (req, res, user) => {
    const row = db.prepare('SELECT * FROM clinician_documents WHERE id=?').get(Number(req.params.id));
    if (!row || row.owner_id !== user.id || !assigned(user.id, row.patient_id)) {
      P.sendError(req, res, 404, 'E-NOT-FOUND');
      return null;
    }
    if (!hasBaseConsent(db, row.patient_id)) {
      P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
      return null;
    }
    return row;
  };

  const audit = (user, patientId, action) =>
    db
      .prepare(
        "INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis) VALUES (?,?,?,'export',?,'allow','assignment')",
      )
      .run(user.id, user.role, patientId, action);

  const dateOnly = (v) => (typeof v === 'string' && DATE_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : '');

  // Автозаполнение: только то, что есть в системе. Чего нет (вес, беременность, серия, регион, должность) — пусто.
  function autofill(user, patientId, ae) {
    const today = nowIso().slice(0, 10);
    const patient = db.prepare('SELECT service_no,sex,age_band FROM users WHERE id=?').get(patientId) || {};
    const plan = db
      .prepare(
        "SELECT id FROM plan_versions WHERE patient_id=? AND status='published' AND (visible_from IS NULL OR visible_from<=?) ORDER BY version DESC LIMIT 1",
      )
      .get(patientId, nowIso());
    const items = plan
      ? db
          .prepare(
            "SELECT pi.*,i.name inn_name,dp.trade_name,dp.manufacturer FROM plan_items pi JOIN inn i ON i.id=pi.inn_id LEFT JOIN purchase_marks pm ON pm.patient_id=? AND pm.item_key=pi.item_key AND pm.status='current' LEFT JOIN drug_products dp ON dp.id=pm.product_id WHERE pi.plan_version_id=? AND pi.status='active' AND (pi.end_date IS NULL OR pi.end_date>=?) ORDER BY pi.id",
          )
          .all(patientId, plan.id, today)
      : [];
    const regimen = (item) =>
      [item.dose_value, item.dose_unit, ...JSON.parse(item.times_json || '[]')]
        .filter((value) => value != null && value !== '')
        .join(' ');
    const drug = (item) => ({
      trade_name: item.trade_name || item.inn_name || '',
      manufacturer: item.manufacturer || '',
      batch: '',
      dose_route: regimen(item),
      started_on: dateOnly(item.start_date),
      stopped_on: dateOnly(item.end_date),
      indication: '',
    });
    // Подозреваемый препарат известен, только если запись о НЯ связана с пунктом плана или МНН.
    const suspected = ae
      ? items.find((item) =>
          ae.item_key ? item.item_key === ae.item_key : ae.inn_id ? item.inn_id === ae.inn_id : false,
        )
      : null;
    const suspectDrugs = [];
    if (suspected) suspectDrugs.push(drug(suspected));
    else if (ae && ae.med_text_enc) suspectDrugs.push({ ...drug({}), trade_name: String(ae.med_text_enc) });
    const symptoms = ae
      ? JSON.parse(ae.complaint_codes_json || '[]').map((code) => LABELS[`msg.ae.chip.${code}`] || String(code))
      : [];
    const description = ae
      ? [ae.description_enc, symptoms.length ? `${LABELS['msg.ae.chat.part.symptoms']} ${symptoms.join(', ')}` : '']
          .filter(Boolean)
          .join('\n')
      : '';
    return {
      report_type: 'primary',
      patient_code: patient.service_no || `П-${patientId}`,
      sex: patient.sex === 'f' || patient.sex === 'm' ? patient.sex : '',
      age: patient.age_band || '',
      suspect_drugs: suspectDrugs.slice(0, SUSPECT_MAX),
      reaction_started_on: ae ? dateOnly(ae.onset_date) : '',
      description,
      other_drugs: items
        .filter((item) => item !== suspected)
        .map(drug)
        .slice(0, OTHER_MAX),
      reporter_category: 'doctor',
      contact: user.email || '',
      reporter_name: user.full_name || '',
      report_date: today,
    };
  }

  // Список: свои документы по закреплённым пациентам, со статусом.
  app.get('/work/api/documents', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const rows = db
      .prepare(
        `SELECT d.* FROM clinician_documents d
         JOIN care_assignments ca ON ca.patient_id=d.patient_id AND ca.clinician_id=d.owner_id AND ca.ended_at IS NULL AND COALESCE(ca.end_reason,'')<>'signal_only'
         WHERE d.owner_id=? ${req.query.patient_id ? 'AND d.patient_id=?' : ''}
         ORDER BY d.patient_id, d.id DESC`,
      )
      .all(...[user.id, ...(req.query.patient_id ? [Number(req.query.patient_id)] : [])]);
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.patient_id)) groups.set(row.patient_id, { ...patientOf(row.patient_id), documents: [] });
      groups.get(row.patient_id).documents.push(meta(row));
    }
    return res.json({ patients: [...groups.values()] });
  });

  // Пустой бланк (без пациента). Объявлен до /:id.
  app.get('/work/api/documents/blank', (req, res, next) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const format = String(req.query.format || 'docx');
    if (!FORMATS[format]) return invalid(req, res, 'format');
    if (req.query.template_key && req.query.template_key !== NOTICE_KEY) return invalid(req, res, 'template_key');
    return Promise.resolve(noticeForm().blank(format))
      .then((data) => {
        db.prepare(
          "INSERT INTO export_log(actor_id,kind,row_count,recipient_class,created_at) VALUES (?,'ae_notice',0,'clinician',?)",
        ).run(user.id, nowIso());
        res.type(FORMATS[format]).attachment(`notice-blank.${format}`).send(data);
      })
      .catch(next);
  });

  // Создать документ из шаблона для своего закреплённого пациента (+ запись о НЯ, если указана).
  app.post('/work/api/documents', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const body = req.body || {};
    if (body.template_key !== NOTICE_KEY) return invalid(req, res, 'template_key');
    const patientId = Number(body.patient_id);
    if (!Number.isInteger(patientId) || patientId <= 0) return invalid(req, res, 'patient_id');
    if (!assigned(user.id, patientId)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (!hasBaseConsent(db, patientId)) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
    let ae = null;
    if (body.ae_id != null) {
      ae = db.prepare('SELECT * FROM adverse_events WHERE id=? AND patient_id=?').get(Number(body.ae_id), patientId);
      if (!ae) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      if (ae.status !== 'related_likely') return P.sendError(req, res, 409, 'E-STATUS');
    }
    return withIdem(req, res, user, 201, (state) => {
      const fields = noticeForm().validate(autofill(user, patientId, ae)).fields;
      const at = nowIso();
      const info = db
        .prepare(
          "INSERT INTO clinician_documents(owner_id,patient_id,template_key,ae_id,fields_enc,status,version,created_at,updated_at) VALUES (?,?,?,?,?,'draft',1,?,?)",
        )
        .run(user.id, patientId, NOTICE_KEY, ae ? ae.id : null, seal(fields), at, at);
      audit(user, patientId, 'view');
      const row = db.prepare('SELECT * FROM clinician_documents WHERE id=?').get(info.lastInsertRowid);
      return reply(res, user, state, 201, { document: full(row) });
    });
  });

  // Сохранить подставленный в шаблон текст как документ закреплённого пациента (шаблон не меняется). Сразу «Готово».
  app.post('/work/api/documents/from-text', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const body = req.body || {};
    const patientId = Number(body.patient_id);
    if (!Number.isInteger(patientId) || patientId <= 0) return invalid(req, res, 'patient_id');
    const name = String(body.title || '')
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, TITLE_MAX);
    const text = String(body.body || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .slice(0, BODY_MAX);
    if (!name) return invalid(req, res, 'title');
    if (!text.trim()) return invalid(req, res, 'body');
    if (!assigned(user.id, patientId)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (!hasBaseConsent(db, patientId)) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
    return withIdem(req, res, user, 201, (state) => {
      const at = nowIso();
      const who = patientOf(patientId);
      const day = at.slice(0, 10).split('-').reverse().join('.');
      const title = `${name} — ${who.name || who.service_no || ''}, ${day}`.slice(0, TITLE_MAX);
      const info = db
        .prepare(
          "INSERT INTO clinician_documents(owner_id,patient_id,template_key,fields_enc,status,version,created_at,updated_at) VALUES (?,?,?,?,'ready',1,?,?)",
        )
        .run(user.id, patientId, TEXT_KEY, seal({ title, body: text }), at, at);
      audit(user, patientId, 'view');
      const row = db.prepare('SELECT * FROM clinician_documents WHERE id=?').get(info.lastInsertRowid);
      return reply(res, user, state, 201, { document: full(row) });
    });
  });

  app.get('/work/api/documents/:id', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const row = loadOwn(req, res, user);
    if (!row) return undefined;
    audit(user, row.patient_id, 'view');
    return res.json({ document: full(row) });
  });

  // Сохранить черновик: проверка версии, как у /adverse-events/:id/notice (E-CONFLICT).
  app.put('/work/api/documents/:id', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const row = loadOwn(req, res, user);
    if (!row) return undefined;
    const body = req.body || {};
    if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields))
      return invalid(req, res, 'fields');
    if (row.status === 'ready') return P.sendError(req, res, 409, 'E-SIGNED-IMMUTABLE');
    if (Number(body.version) !== row.version) return P.sendError(req, res, 409, 'E-CONFLICT');
    const checked = noticeForm().validate(body.fields);
    const done = db
      .prepare(
        "UPDATE clinician_documents SET fields_enc=?, version=version+1, updated_at=? WHERE id=? AND version=? AND status='draft'",
      )
      .run(seal(checked.fields), nowIso(), row.id, row.version);
    if (!done.changes) return P.sendError(req, res, 409, 'E-CONFLICT');
    return res.json({ document: full(db.prepare('SELECT * FROM clinician_documents WHERE id=?').get(row.id)) });
  });

  // «Готово»: обязательные поля заполнены → документ зафиксирован и больше не правится.
  app.post('/work/api/documents/:id/ready', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const row = loadOwn(req, res, user);
    if (!row) return undefined;
    if (row.status === 'ready') return P.sendError(req, res, 409, 'E-SIGNED-IMMUTABLE');
    if (req.body && req.body.version != null && Number(req.body.version) !== row.version)
      return P.sendError(req, res, 409, 'E-CONFLICT');
    return withIdem(req, res, user, 200, (state) => {
      const fields = open(row);
      if (!fields) return P.sendError(req, res, 500, 'E-INTERNAL');
      const checked = noticeForm().validate(fields);
      if (checked.missing.length) return missingError(req, res, checked.missing);
      db.prepare(
        "UPDATE clinician_documents SET fields_enc=?, status='ready', version=version+1, updated_at=? WHERE id=? AND status='draft'",
      ).run(seal(checked.fields), nowIso(), row.id);
      return reply(res, user, state, 200, {
        document: full(db.prepare('SELECT * FROM clinician_documents WHERE id=?').get(row.id)),
      });
    });
  });

  // «Создать исправленную версию»: новый черновик на основе готового; прежний остаётся. Повтор вернёт тот же черновик.
  app.post('/work/api/documents/:id/revise', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const row = loadOwn(req, res, user);
    if (!row) return undefined;
    if (row.status !== 'ready' || isText(row)) return P.sendError(req, res, 409, 'E-STATUS');
    return withIdem(req, res, user, 201, (state) => {
      const existing = db
        .prepare("SELECT * FROM clinician_documents WHERE supersedes_id=? AND status='draft' ORDER BY id DESC LIMIT 1")
        .get(row.id);
      if (existing) return reply(res, user, state, 200, { document: full(existing) });
      const fields = open(row);
      if (!fields) return P.sendError(req, res, 500, 'E-INTERNAL');
      const revised = noticeForm().validate({
        ...fields,
        report_type: 'additional',
        previous_report_date: dateOnly(row.updated_at),
        report_date: nowIso().slice(0, 10),
      }).fields;
      const at = nowIso();
      const info = db
        .prepare(
          "INSERT INTO clinician_documents(owner_id,patient_id,template_key,ae_id,fields_enc,status,version,supersedes_id,created_at,updated_at) VALUES (?,?,?,?,?,'draft',1,?,?,?)",
        )
        .run(user.id, row.patient_id, row.template_key, row.ae_id, seal(revised), row.id, at, at);
      return reply(res, user, state, 201, {
        document: full(db.prepare('SELECT * FROM clinician_documents WHERE id=?').get(info.lastInsertRowid)),
      });
    });
  });

  // Удалить можно только черновик: готовое остаётся навсегда.
  app.delete('/work/api/documents/:id', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const row = loadOwn(req, res, user);
    if (!row) return undefined;
    if (row.status === 'ready') return P.sendError(req, res, 409, 'E-SIGNED-IMMUTABLE');
    db.prepare("DELETE FROM clinician_documents WHERE id=? AND status='draft'").run(row.id);
    return res.json({ ok: true });
  });

  // Скачать заполненный бланк (docx; PDF пока не делаем); имя файла без ФИО; выгрузка пишется в export_log.
  app.get('/work/api/documents/:id/file', (req, res, next) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const row = loadOwn(req, res, user);
    if (!row) return undefined;
    const format = String(req.query.format || 'docx');
    if (!FORMATS[format] || isText(row)) return invalid(req, res, 'format');
    const fields = open(row);
    if (!fields) return P.sendError(req, res, 500, 'E-INTERNAL');
    return Promise.resolve(noticeForm().render(fields, format))
      .then((data) => {
        db.prepare(
          "INSERT INTO export_log(actor_id,kind,patient_id,row_count,file_sha256,recipient_class,created_at) VALUES (?,'ae_notice',?,1,?,'clinician',?)",
        ).run(user.id, row.patient_id, crypto.createHash('sha256').update(data).digest('hex'), nowIso());
        audit(user, row.patient_id, 'download');
        res.type(FORMATS[format]).attachment(`notice-${row.id}.${format}`).send(data);
      })
      .catch(next);
  });
}

module.exports = { install, NOTICE_KEY, TEXT_KEY };
