'use strict';

// Clinical demo workflow. Instrument content is sourced from the approved clinical
// recommendation and remains review-required; medication catalogue fallbacks are STAND-IN.
const fs = require('fs');
const path = require('path');

const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
const compact = (value) => norm(value).replace(/\s/g, '');
const iso = (deps) => deps.P.iso(deps.now(deps.config));

function csvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (c === ',' && !quoted) {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out.map((x) => x.trim());
}

function cyrToLatin(text) {
  const pairs = [
    ['щ', 'shch'],
    ['ш', 'sh'],
    ['ч', 'ch'],
    ['ц', 'ts'],
    ['ю', 'yu'],
    ['я', 'ya'],
    ['ж', 'zh'],
    ['х', 'kh'],
    ['а', 'a'],
    ['б', 'b'],
    ['в', 'v'],
    ['г', 'g'],
    ['д', 'd'],
    ['е', 'e'],
    ['з', 'z'],
    ['и', 'i'],
    ['й', 'y'],
    ['к', 'k'],
    ['л', 'l'],
    ['м', 'm'],
    ['н', 'n'],
    ['о', 'o'],
    ['п', 'p'],
    ['р', 'r'],
    ['с', 's'],
    ['т', 't'],
    ['у', 'u'],
    ['ф', 'f'],
    ['ы', 'y'],
    ['э', 'e'],
    ['ь', ''],
    ['ъ', ''],
  ];
  let r = compact(text);
  for (const [a, b] of pairs) r = r.split(a).join(b);
  return r;
}
function layoutToCyr(text) {
  const en = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
  const ru = 'йцукенгшщзхъфывапролджэячсмитьбю.';
  return String(text || '')
    .toLowerCase()
    .split('')
    .map((c) => {
      const i = en.indexOf(c);
      return i < 0 ? c : ru[i];
    })
    .join('');
}
function distance(a, b) {
  const aa = compact(a);
  const bb = compact(b);
  const row = Array.from({ length: bb.length + 1 }, (_x, i) => i);
  for (let i = 1; i <= aa.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= bb.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (aa[i - 1] === bb[j - 1] ? 0 : 1));
      prev = old;
    }
  }
  return row[bb.length];
}

// Настоящие методики вносятся по одной: файл в ./instruments/ и строка здесь.
const INSTRUMENT_DEFS = [
  require('./instruments/gad7'),
  require('./instruments/scl90r'),
  ...require('./instruments/itt').defs,
  require('./instruments/stai'),
  require('./instruments/bai'),
  require('./instruments/shars'),
  ...require('./instruments/gad_registry').REFERENCE_DEFS,
  ...require('./instruments/clinrec_methods').soonDefs(),
];
const { scoreScl90r } = require('./instruments/scl90r_score');
const { scoreItt } = require('./instruments/itt_score');
const { scoreStai } = require('./instruments/stai_score');
const { policyForCode } = require('./instruments/gad_registry');

function instrumentPolicy(code) {
  const entry = policyForCode(code);
  return entry
    ? { mode: entry.mode, assignable: entry.assignable, appendix: entry.label, href: entry.href }
    : { mode: 'assignable', assignable: true };
}

function hidesPatientResult(ins) {
  return Boolean(ins && (policyForCode(ins.code) || ins.scoring.patient_hides_result));
}

function completionView(db, assignment, shared = false) {
  const role =
    assignment.assigned_by && db.prepare('SELECT role FROM users WHERE id=?').get(assignment.assigned_by)?.role;
  return {
    completion_key:
      role === 'psychologist'
        ? 'msg.tests.result.psychologist'
        : role
          ? 'msg.tests.result.doctor'
          : shared
            ? 'msg.tests.result.shared'
            : 'msg.tests.result.self',
    assigned_role: role || null,
  };
}

function seedInstrument(db, def) {
  const current = db
    .prepare(
      'SELECT v.schema_json FROM instruments i JOIN instrument_versions v ON v.instrument_code=i.code AND v.version=i.current_version WHERE i.code=? AND v.is_stand_in=0',
    )
    .get(def.code);
  if (
    current &&
    db
      .prepare('SELECT schema_json FROM instrument_versions WHERE instrument_code=? AND is_stand_in=0')
      .all(def.code)
      .some((v) => JSON.parse(v.schema_json).meta?.catalog_revision === 'gad-demo-v1')
  )
    return;
  const policy = instrumentPolicy(def.code);
  const version =
    Number(db.prepare('SELECT max(version) v FROM instrument_versions WHERE instrument_code=?').get(def.code).v || 0) +
    1;
  const questions = def.items.map((text, n) => ({
    id: `q${n + 1}`,
    type: 'single',
    required: true,
    text,
    options: def.options,
    // Явный признак кризисного пункта (SCL-90-R: 15 и 59); у остальных пунктов методики — false.
    ...(def.crisisItems ? { crisis_item: def.crisisItems.includes(n + 1) } : {}),
  }));
  db.prepare(
    "INSERT INTO instruments(code,title,kind,status,online_allowed,self_service,translation_source,current_version) VALUES (?,?, 'scale','published',?,?,?,?) ON CONFLICT(code) DO UPDATE SET title=excluded.title,status='published',online_allowed=excluded.online_allowed,self_service=excluded.self_service,translation_source=excluded.translation_source,current_version=excluded.current_version",
  ).run(
    def.code,
    def.title,
    policy.assignable ? 1 : 0,
    policy.assignable && def.selfService ? 1 : 0,
    def.meta.sources.join(' '),
    version,
  );
  db.prepare(
    "INSERT INTO instrument_versions(instrument_code,version,schema_json,scoring_json,bands_json,is_stand_in,status) VALUES (?,?,?,?,?,0,'published')",
  ).run(
    def.code,
    version,
    JSON.stringify({
      questions,
      meta: {
        ...def.meta,
        ...policy,
        catalog_revision: 'gad-demo-v1',
        review_required: true,
        ...(def.patientTitle ? { patient_title: def.patientTitle } : {}),
      },
    }),
    JSON.stringify({ ...def.scoring, patient_hides_result: true }),
    JSON.stringify(def.bands),
  );
}

// Общий пакет «Старт»: первичный набор из действующих методик каталога (состав — демо-решение, review-required).
const START_PACKAGE = { title: 'Старт', items: ['gad7', 'scl90r', 'itt_s'] };

function seedStartPackage(db) {
  if (db.prepare('SELECT 1 FROM package_templates WHERE owner_id IS NULL AND title=?').get(START_PACKAGE.title)) return;
  db.prepare('INSERT INTO package_templates(owner_id,title,items_json,is_shared) VALUES (NULL,?,?,1)').run(
    START_PACKAGE.title,
    JSON.stringify(START_PACKAGE.items),
  );
}

function seedInstruments(db) {
  for (const def of INSTRUMENT_DEFS) seedInstrument(db, def);
  seedStartPackage(db);
}

function ensureSeed(db) {
  if (!db.prepare("SELECT 1 FROM inn WHERE status='in_catalog' LIMIT 1").get()) {
    const file = path.join(__dirname, '..', '..', '..', 'config', 'defaults', 'catalog_stand_in.csv');
    const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).map(csvLine);
    const inns = new Map();
    const addInn = db.prepare(
      "INSERT INTO inn(name,name_norm,drug_group,atc_code,rx_only,status,source,source_date) VALUES (?,?,?,?,?,'in_catalog','stand_in',?)",
    );
    const addProduct = db.prepare(
      "INSERT INTO drug_products(inn_id,trade_name,trade_name_norm,manufacturer,dosage_form,strength,status,source,source_date) VALUES (?,?,?,?,?,?,'in_catalog','stand_in',?)",
    );
    for (const row of rows) {
      const [name, group, atc, rx, trade, manufacturer, form, strength, , sourceDate] = row;
      if (!inns.has(norm(name)))
        inns.set(norm(name), Number(addInn.run(name, norm(name), group, atc, Number(rx), sourceDate).lastInsertRowid));
      addProduct.run(inns.get(norm(name)), trade, norm(trade), manufacturer, form, strength, sourceDate);
    }
    db.prepare(
      "INSERT INTO pharmacy_links(name,url_template,active,is_stand_in) VALUES ('Альфа-аптека','https://alpha.example.test/search?q={inn}',1,1),('Бета-аптека','https://beta.example.test/search?q={inn}',1,1)",
    ).run();
  }
  seedInstruments(db);
}

function instrument(db, code, version = null) {
  const row = db
    .prepare(
      'SELECT i.*,v.version selected_version,v.schema_json,v.bands_json,v.scoring_json FROM instruments i LEFT JOIN instrument_versions v ON v.instrument_code=i.code AND v.version=coalesce(?,i.current_version) WHERE i.code=?',
    )
    .get(version, code);
  if (
    !row ||
    ['blocked', 'withdrawn'].includes(row.status) ||
    !row.online_allowed ||
    !instrumentPolicy(code).assignable ||
    !row.schema_json
  )
    return null;
  return {
    ...row,
    questions: JSON.parse(row.schema_json || '{"questions":[]}').questions || [],
    meta: JSON.parse(row.schema_json || '{}').meta || {},
    scoring: JSON.parse(row.scoring_json || '{}'),
    bands: JSON.parse(row.bands_json || '[]'),
  };
}
function patientArchived(db, patientId) {
  return (
    Boolean(
      db
        .prepare('SELECT 1 FROM care_episodes WHERE patient_id=? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1')
        .get(patientId),
    ) && !db.prepare('SELECT 1 FROM care_episodes WHERE patient_id=? AND ended_at IS NULL').get(patientId)
  );
}
function assignmentView(db, row) {
  const progress = row.package_template_id
    ? db
        .prepare(
          "SELECT count(*) total,sum(CASE WHEN status='completed' THEN 1 ELSE 0 END) done FROM instrument_assignments WHERE patient_id=? AND package_template_id=?",
        )
        .get(row.patient_id, row.package_template_id)
    : { total: 1, done: row.status === 'completed' ? 1 : 0 };
  return {
    id: row.id,
    instrument_code: row.instrument,
    status: row.status,
    package_id: row.package_template_id,
    progress: { total: Number(progress.total || 0), done: Number(progress.done || 0) },
  };
}

// Подсчёт баллов по ответам — один для онлайн-прохождения и для очного бланка, который заполняет врач.
function scoreAnswers(db, ins, answers, patientId) {
  // SCL-90-R: ключ берём из сохранённой версии методики, ответам пациента не доверяем (только варианты 0–4).
  const scl = ins.scoring.type === 'scl90r' ? scoreScl90r(answers, ins.scoring.scales) : null;
  // ИТТ: ключ и таблицы берём из сохранённой версии методики; группу норм выбирает сервер по профилю.
  const itt =
    ins.scoring.type === 'itt'
      ? scoreItt(answers, ins.scoring, db.prepare('SELECT sex,age_band FROM users WHERE id=?').get(patientId))
      : null;
  const stai = ins.scoring.type === 'stai' ? scoreStai(answers, ins.scoring) : null;
  const score =
    stai?.total ??
    scl?.total ??
    itt?.total ??
    ins.questions.reduce((sum, q) => {
      // В сумму идут только числовые ответы: текст, дата и «несколько вариантов» без баллов дают 0
      // (иначе NaN и total_score NOT NULL роняет отправку).
      const points = (answer) => {
        const found = (q.options || []).find((o) => o.value === answer);
        const v = Number(found?.score ?? answer ?? 0);
        return Number.isFinite(v) ? v : 0;
      };
      const a = answers[q.id];
      if (Array.isArray(a)) return sum + a.reduce((s, x) => s + points(x), 0);
      const v = points(a);
      return sum + (q.reverse ? (q.options?.length || 4) - 1 - v : v);
    }, 0);
  const band =
    scl || itt || stai
      ? 'Показатели рассчитаны'
      : ins.bands.find((b) => score >= b.min && score <= b.max)?.label || 'review_required';
  const sub = scl
    ? { scales: scl.scales, gsi: scl.gsi, psi: scl.psi, pdsi: scl.pdsi }
    : itt
      ? itt.sub
      : stai
        ? stai.sub
        : null;
  return { score, band, sub };
}

// Кризисный пункт методики: явный признак crisis_item (SCL-90-R) или, если его нет, эвристика по номеру и словам.
function crisisAnswer(q, value) {
  const explicit = typeof q.crisis_item === 'boolean';
  const crisisItem = explicit ? q.crisis_item : /9$/.test(q.id) || /смерт|навред|вред/i.test(`${q.id} ${q.text || ''}`);
  const lastOption = Array.isArray(q.options) ? q.options.at(-1)?.value : undefined;
  return crisisItem && (explicit ? Number(value) > 0 : String(value) === String(lastOption) || Number(value) > 0);
}

const PLAN_UNITS = ['мг', 'мкг', 'мл', 'таблетка'];

function install(app, deps) {
  const { db, P, config, now } = deps;
  ensureSeed(db);
  const err = (req, res, status, code, extra) => P.sendError(req, res, status, code, extra);
  const patient = (req) => Number(req.params.patientId || req.params.patient_id);
  const ownAssignment = (req, id) =>
    db.prepare('SELECT * FROM instrument_assignments WHERE id=? AND patient_id=?').get(id, req.user.id);

  app.get('/api/v1/catalog/search', (req, res) => {
    const q = String(req.query.q || '');
    const scope = String(req.query.scope || 'products');
    const wantedInn = Number(req.query.inn_id || 0);
    const settings = deps.activeSetting('reference.search').value || { suggestions: 5, min_chars: 2 };
    if (compact(q).length < (settings.min_chars || 2)) return res.json({ items: [], add_as_is: true, stand_in: true });
    let rows;
    if (scope === 'inn')
      rows = db
        .prepare(
          "SELECT id,name,name_norm,'inn' kind,status,(source='entered_by_clinician') added_by_doctor FROM inn WHERE status='in_catalog'",
        )
        .all();
    else
      rows = db
        .prepare(
          "SELECT p.id,p.trade_name name,p.trade_name_norm name_norm,p.inn_id,'product' kind,p.status,i.name inn_name FROM drug_products p JOIN inn i ON i.id=p.inn_id WHERE (p.status='in_catalog' OR (p.status='pending' AND p.author_id=?)) AND (?=0 OR p.inn_id=?)",
        )
        .all(req.user.id, wantedInn, wantedInn);
    const converted = layoutToCyr(q);
    const scored = rows
      .map((x) => {
        const d = Math.min(
          distance(q, x.name_norm),
          distance(converted, x.name_norm),
          distance(cyrToLatin(x.name_norm), q),
        );
        const exact = compact(x.name_norm) === compact(q);
        const prefix = compact(x.name_norm).startsWith(compact(q));
        return { ...x, score: exact ? -100 : prefix ? -50 : d };
      })
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'ru'))
      .slice(0, settings.suggestions || 5);
    return res.json({ items: scored, add_as_is: true, stand_in: true });
  });

  app.get('/api/v1/instruments', (_req, res) =>
    res.json({
      items: db
        .prepare(
          "SELECT code,title,kind,status,self_service FROM instruments WHERE status NOT IN ('blocked','withdrawn') ORDER BY code",
        )
        .all()
        .map((row) => ({
          ...row,
          ...instrumentPolicy(row.code),
          preview: require('./instruments/preview').preview(db, row.code),
        })),
      stand_in: true,
    }),
  );
  app.get('/api/v1/me/self-tests', (req, res) =>
    res.json({
      items: db
        .prepare(
          "SELECT code,title FROM instruments WHERE self_service=1 AND online_allowed=1 AND status NOT IN ('blocked','withdrawn')",
        )
        .all(),
    }),
  );
  app.post('/api/v1/me/self-tests', (req, res) => {
    const ins = instrument(db, req.body.instrument_code);
    if (!ins || !ins.self_service) return err(req, res, 403, 'E-INSTRUMENT-LICENSE');
    const recent = db
      .prepare(
        'SELECT 1 FROM online_results WHERE patient_id=? AND instrument=? AND self_initiated=1 AND created_at>=? LIMIT 1',
      )
      .get(req.user.id, ins.code, P.iso(new Date(now(config).getTime() - 7 * 86400000)));
    if (recent) return err(req, res, 429, 'E-RATE-LIMIT');
    // Открытое назначение той же методики одно на пациента (uq_ia_open): продолжаем его, а не создаём второе.
    const open = db
      .prepare(
        "SELECT id, assigned_by FROM instrument_assignments WHERE patient_id=? AND instrument=? AND status IN ('pending','in_progress','waiting_entry')",
      )
      .get(req.user.id, ins.code);
    if (open) return res.status(201).json({ id: open.id, instrument_code: ins.code, self: open.assigned_by == null });
    const id = Number(
      db
        .prepare(
          "INSERT INTO instrument_assignments(patient_id,instrument,instrument_version,status,assigned_at) VALUES (?,?,?,'pending',?)",
        )
        .run(req.user.id, ins.code, ins.current_version, iso(deps)).lastInsertRowid,
    );
    return res.status(201).json({ id, instrument_code: ins.code, self: true });
  });

  app.get('/api/v1/me/assignments', (req, res) => {
    const rows = db
      .prepare(
        "SELECT * FROM instrument_assignments WHERE patient_id=? AND status<>'cancelled' AND (visible_from IS NULL OR visible_from<=?) ORDER BY id DESC",
      )
      .all(req.user.id, iso(deps));
    return res.json({ items: rows.map((r) => assignmentView(db, r)), page: 1, page_size: 50, total: rows.length });
  });
  // Текущие настройки профиля (переключатели в «Мои данные», «Уведомления», «Профиль»).
  app.get('/api/v1/me/prefs', (req, res) => {
    const row = db
      .prepare(
        'SELECT share_diary_notes, course_support_enabled, hints_enabled, timezone, address_form, praise_mode FROM user_prefs WHERE user_id=?',
      )
      .get(req.user.id);
    return res.json({
      diary_notes_visible: Boolean(row && row.share_diary_notes),
      course_support_enabled: Boolean(row && row.course_support_enabled),
      hints_enabled: Boolean(row && row.hints_enabled),
      timezone: (row && row.timezone) || null,
      address_form: (row && row.address_form) || 'n',
      praise_mode: (row && row.praise_mode) || 'normal',
      // Пуши о напоминаниях: ключ для подписки браузера и признак, что это устройство-пользователь подписан хотя бы одним устройством.
      push: {
        available: Boolean(app.locals.push && app.locals.push.enabled()),
        public_key: app.locals.push ? app.locals.push.publicKey() : null,
        subscribed: Boolean(app.locals.push && app.locals.push.subscribed(req.user.id)),
      },
    });
  });
  app.patch('/api/v1/me/prefs', (req, res) => {
    const fields = [];
    const values = [];
    if (typeof req.body.diary_notes_visible === 'boolean') {
      fields.push('share_diary_notes=?');
      values.push(req.body.diary_notes_visible ? 1 : 0);
    }
    if (typeof req.body.course_support_enabled === 'boolean') {
      fields.push('course_support_enabled=?');
      values.push(req.body.course_support_enabled ? 1 : 0);
    }
    if (typeof req.body.timezone === 'string') {
      fields.push('timezone=?');
      values.push(req.body.timezone.slice(0, 64));
    }
    // Форма обращения в тёплых фразах (не медицинский пол) и режим фраз цветка.
    if (['f', 'm', 'n'].includes(req.body.address_form)) {
      fields.push('address_form=?', 'address_form_set=1');
      values.push(req.body.address_form);
    }
    if (['normal', 'quiet', 'off'].includes(req.body.praise_mode)) {
      fields.push('praise_mode=?');
      values.push(req.body.praise_mode);
    }
    // Подписка устройства на пуши: объект подписки браузера или null (отписаться от всех устройств).
    if (req.user.role === 'patient' && req.body.push_subscription !== undefined) {
      const push = app.locals.push;
      if (req.body.push_subscription === null) push.unsubscribe(req.user.id);
      else if (!push.subscribe(req.user.id, req.body.push_subscription)) return err(req, res, 422, 'E-VALIDATION');
      if (!fields.length) return res.json({ ok: true });
    }
    if (!fields.length) return err(req, res, 422, 'E-VALIDATION');
    fields.push('updated_at=?');
    values.push(iso(deps), req.user.id);
    db.prepare(`UPDATE user_prefs SET ${fields.join(',')} WHERE user_id=?`).run(...values);
    return res.json({ ok: true, undo: deps.makeUndo(req.user.id, 'prefs.change', 'user_pref', req.user.id) });
  });
  app.patch('/api/v1/me/diary/:id', (req, res) => {
    const row = db
      .prepare('SELECT * FROM mood_entries WHERE id=? AND patient_id=? AND hidden_at IS NULL')
      .get(Number(req.params.id), req.user.id);
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    if (row.entry_date !== iso(deps).slice(0, 10)) return err(req, res, 409, 'E-EDIT-WINDOW');
    db.prepare(
      'UPDATE mood_entries SET mood=?,sleep=?,anxiety=?,note=?,revision=revision+1,updated_at=? WHERE id=?',
    ).run(
      req.body.mood ?? row.mood,
      req.body.sleep ?? row.sleep,
      req.body.anxiety ?? row.anxiety,
      req.body.note ?? row.note,
      iso(deps),
      row.id,
    );
    return res.json({ ok: true });
  });
  app.delete('/api/v1/me/diary/:id', (req, res) => {
    const row = db
      .prepare('SELECT * FROM mood_entries WHERE id=? AND patient_id=? AND hidden_at IS NULL')
      .get(Number(req.params.id), req.user.id);
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    db.prepare('UPDATE mood_entries SET hidden_at=? WHERE id=?').run(iso(deps), row.id);
    return res.json({ undo: deps.makeUndo(req.user.id, 'diary.delete', 'mood_entry_restore', row.id) });
  });
  app.get('/api/v1/me/assignments/:id', (req, res) => {
    const row = ownAssignment(req, Number(req.params.id));
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    if (row.status === 'cancelled') return err(req, res, 409, 'E-ASSIGNMENT-CLOSED');
    const ins = instrument(db, row.instrument, row.instrument_version);
    if (!ins) return err(req, res, 403, 'E-INSTRUMENT-LICENSE');
    const draft = db.prepare('SELECT answers_json FROM assignment_drafts WHERE assignment_id=?').get(row.id);
    return res.json({
      ...assignmentView(db, row),
      ...(ins.meta.instruction ? { instruction: ins.meta.instruction } : {}),
      ...(ins.meta.question_title ? { question_title: ins.meta.question_title } : {}),
      ...(ins.meta.patient_title ? { title: ins.meta.patient_title } : {}),
      questions: ins.questions,
      answers: JSON.parse(draft?.answers_json || '{}'),
    });
  });
  app.put('/api/v1/me/assignments/:id/answers/:qid', (req, res) => {
    const row = ownAssignment(req, Number(req.params.id));
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    if (row.status === 'cancelled') return err(req, res, 409, 'E-ASSIGNMENT-CLOSED');
    const ins = instrument(db, row.instrument, row.instrument_version);
    const q = ins?.questions.find((x) => x.id === req.params.qid);
    if (!q) return err(req, res, 404, 'E-NOT-FOUND');
    let value = req.body.value;
    if (q.required && (value === null || value === undefined || value === ''))
      return err(req, res, 422, 'E-VALIDATION', { fields: [{ key: 'err.e-validation.choose' }] });
    if (q.type === 'single' && value != null && value !== '' && q.options && !q.options.some((o) => o.value === value))
      return err(req, res, 422, 'E-VALIDATION', { fields: [{ key: 'err.e-validation.choose' }] });
    const filled = value !== null && value !== undefined && value !== '';
    if (q.type === 'number' && filled) {
      const n = Number(value);
      if (!Number.isFinite(n) || (q.min !== undefined && n < q.min) || (q.max !== undefined && n > q.max))
        return err(req, res, 422, 'E-VALIDATION', {
          fields: [{ key: 'err.e-validation.range', params: { min: q.min, max: q.max } }],
        });
    }
    if (q.type === 'date' && filled && !/^\d{4}-\d{2}-\d{2}$/.test(String(value)))
      return err(req, res, 422, 'E-VALIDATION');
    const textLimit = { text_short: 300, text_long: 4000 }[q.type];
    if (textLimit && filled && String(value).length > textLimit)
      return err(req, res, 422, 'E-VALIDATION', {
        fields: [{ key: 'err.e-validation.too_long', params: { max: textLimit } }],
      });
    if (q.type === 'multi') {
      if (!Array.isArray(value) || value.length > (q.max_select || Infinity))
        return err(req, res, 422, 'E-VALIDATION', { fields: [{ key: 'err.e-validation.max_select' }] });
      if ((q.exclusive || []).some((x) => value.includes(x)))
        value = [value.find((x) => (q.exclusive || []).includes(x))];
    }
    const old = db.prepare('SELECT answers_json FROM assignment_drafts WHERE assignment_id=?').get(row.id);
    const answers = JSON.parse(old?.answers_json || '{}');
    answers[q.id] = value;
    db.prepare(
      'INSERT INTO assignment_drafts(assignment_id,patient_id,answers_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET answers_json=excluded.answers_json,updated_at=excluded.updated_at',
    ).run(row.id, req.user.id, JSON.stringify(answers), iso(deps));
    db.prepare("UPDATE instrument_assignments SET status='in_progress' WHERE id=? AND status='pending'").run(row.id);
    const text = Array.isArray(value) ? value.join(' ') : String(value || '');
    // Если у пункта есть явный признак crisis_item (SCL-90-R), эвристика по номеру и словам не применяется:
    // иначе q19, q29… (id на «9») давали бы ложные срабатывания, а пункт 15 не срабатывал бы совсем.
    const explicit = typeof q.crisis_item === 'boolean';
    const crisis = /нет смысла жить|поконч|суицид/i.test(text) || crisisAnswer(q, value);
    const crisisCard = crisis
      ? deps.crisis(explicit ? `Пункт ${q.id.slice(1)}: ${q.text}. Ответ: ${text}` : text, 'test', req.user.id)
      : null;
    return res.json({ ok: true, ...(crisisCard ? { crisis: crisisCard } : {}) });
  });
  app.post('/api/v1/me/assignments/:id/submit', (req, res) => {
    const row = ownAssignment(req, Number(req.params.id));
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    const existing = db.prepare('SELECT * FROM online_results WHERE assignment_id=?').get(row.id);
    if (existing) {
      const hidden =
        Boolean(policyForCode(existing.instrument)) ||
        hidesPatientResult(instrument(db, existing.instrument, existing.instrument_version));
      return res.json({
        id: existing.id,
        ...completionView(db, row, Boolean(existing.shared_at)),
        ...(hidden ? {} : { score: existing.total_score, band: existing.band }),
        source: existing.self_initiated ? 'self' : 'assigned',
        band_note_key: 'msg.test.not_diagnosis',
      });
    }
    if (row.status === 'cancelled') return err(req, res, 409, 'E-ASSIGNMENT-CLOSED');
    const ins = instrument(db, row.instrument, row.instrument_version);
    if (!ins) return err(req, res, 403, 'E-INSTRUMENT-LICENSE');
    const answers = JSON.parse(
      db.prepare('SELECT answers_json FROM assignment_drafts WHERE assignment_id=?').get(row.id)?.answers_json || '{}',
    );
    for (const q of ins.questions)
      if (q.required && (answers[q.id] === undefined || answers[q.id] === null))
        return err(req, res, 422, 'E-VALIDATION');
    const { score, band, sub } = scoreAnswers(db, ins, answers, req.user.id);
    const hidden = hidesPatientResult(ins);
    const id = Number(
      db
        .prepare(
          'INSERT INTO online_results(assignment_id,patient_id,instrument,instrument_version,answers_json,total_score,subscales_json,band,self_initiated,created_at) VALUES (?,?,?,?,?,?,?,?, ?,?)',
        )
        .run(
          row.id,
          req.user.id,
          row.instrument,
          ins.selected_version,
          JSON.stringify(answers),
          score,
          sub ? JSON.stringify(sub) : null,
          band,
          row.assigned_by ? 0 : 1,
          iso(deps),
        ).lastInsertRowid,
    );
    db.prepare("UPDATE instrument_assignments SET status='completed',completed_at=? WHERE id=?").run(iso(deps), row.id);
    return res.json({
      id,
      ...completionView(db, row),
      ...(hidden ? {} : { score, band }),
      source: row.assigned_by ? 'assigned' : 'self',
      band_note_key: 'msg.test.not_diagnosis',
    });
  });
  app.post('/api/v1/assignments/:id/cancel', (req, res) => {
    const row = db.prepare('SELECT * FROM instrument_assignments WHERE id=?').get(Number(req.params.id));
    if (!row || row.assigned_by !== req.user.id) return err(req, res, 404, 'E-NOT-FOUND');
    db.prepare(
      "UPDATE instrument_assignments SET status='cancelled',cancelled_at=?,cancelled_by=? WHERE id=? AND status<>'completed'",
    ).run(iso(deps), req.user.id, row.id);
    return res.json({
      ok: true,
      undo: deps.makeUndo(req.user.id, 'assignment.cancel', 'instrument_assignment_restore', row.id),
    });
  });
  app.get('/api/v1/packages', (req, res) => {
    const rows = db
      .prepare(
        'SELECT id,title,items_json,is_shared,version FROM package_templates WHERE hidden_at IS NULL AND (owner_id=? OR is_shared=1) ORDER BY is_shared DESC,id',
      )
      .all(req.user.id);
    return res.json({
      items: rows.map((x) => ({ ...x, items: JSON.parse(x.items_json), shared: Boolean(x.is_shared) })),
      page: 1,
      page_size: 50,
      total: rows.length,
    });
  });
  app.post('/api/v1/packages', (req, res) => {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length < 2 || items.length > 10) return err(req, res, 422, 'E-VALIDATION');
    for (const code of items)
      if (!instrument(db, code))
        return err(req, res, 403, 'E-INSTRUMENT-LICENSE', { fields: [{ key: 'msg.tests.not_assignable' }] });
    const id = Number(
      db
        .prepare('INSERT INTO package_templates(owner_id,title,items_json,created_at) VALUES (?,?,?,?)')
        .run(req.user.id, String(req.body.title || 'STAND-IN'), JSON.stringify([...new Set(items)]), iso(deps))
        .lastInsertRowid,
    );
    return res.status(201).json({ id, title: req.body.title, items, shared: false });
  });
  app.put('/api/v1/packages/:id', (req, res) => {
    const row = db
      .prepare('SELECT * FROM package_templates WHERE id=? AND hidden_at IS NULL')
      .get(Number(req.params.id));
    if (!row || row.owner_id !== req.user.id) return err(req, res, 403, 'E-ACCESS');
    if (!Array.isArray(req.body.items) || req.body.items.length < 2 || req.body.items.length > 10)
      return err(req, res, 422, 'E-VALIDATION');
    for (const code of req.body.items)
      if (!instrument(db, code))
        return err(req, res, 403, 'E-INSTRUMENT-LICENSE', { fields: [{ key: 'msg.tests.not_assignable' }] });
    db.prepare('UPDATE package_templates SET title=?,items_json=?,version=version+1,updated_at=? WHERE id=?').run(
      String(req.body.title || row.title),
      JSON.stringify(req.body.items),
      iso(deps),
      row.id,
    );
    return res.json({ ok: true });
  });
  app.delete('/api/v1/packages/:id', (req, res) => {
    const row = db
      .prepare('SELECT * FROM package_templates WHERE id=? AND hidden_at IS NULL')
      .get(Number(req.params.id));
    if (!row || row.owner_id !== req.user.id) return err(req, res, 403, 'E-ACCESS');
    db.prepare('UPDATE package_templates SET hidden_at=? WHERE id=?').run(iso(deps), row.id);
    return res.json({ undo: deps.makeUndo(req.user.id, 'package.delete', 'package_template', row.id) });
  });
  app.post('/api/v1/me/results/:id/share', (req, res) => {
    const row = db
      .prepare('SELECT * FROM online_results WHERE id=? AND patient_id=?')
      .get(Number(req.params.id), req.user.id);
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    db.prepare('UPDATE online_results SET shared_at=? WHERE id=?').run(iso(deps), row.id);
    return res.json({ ok: true });
  });
  app.get('/api/v1/me/results', (req, res) => {
    const rows = db
      .prepare(
        'SELECT r.id,r.instrument,r.instrument_version,r.total_score,r.band,r.created_at,r.self_initiated,r.shared_at,a.assigned_by FROM online_results r LEFT JOIN instrument_assignments a ON a.id=r.assignment_id WHERE r.patient_id=? ORDER BY r.id DESC',
      )
      .all(req.user.id)
      // Методики, чей балл пациенту не показывается (SCL-90-R), отдаём без балла и полосы.
      .map(({ assigned_by, ...r }) => {
        const completion = completionView(db, { assigned_by }, Boolean(r.shared_at));
        return hidesPatientResult(instrument(db, r.instrument, r.instrument_version)) || policyForCode(r.instrument)
          ? { ...r, ...completion, total_score: null, band: null }
          : r;
      });
    return res.json({ series: rows, stand_in: true });
  });
  app.get('/api/v1/patients', (req, res) => {
    const archive = req.query.filter === 'archive';
    const rows = db
      .prepare(
        `SELECT u.id,u.service_no,u.full_name,e.ended_at,
        EXISTS(SELECT 1 FROM crisis_escalations c WHERE c.patient_id=u.id AND c.status IN ('new','in_progress')) crisis
       FROM users u JOIN care_assignments ca ON ca.patient_id=u.id
       JOIN care_episodes e ON e.id=ca.episode_id
       WHERE ca.clinician_id=? AND (${archive ? 'e.ended_at IS NOT NULL' : 'ca.ended_at IS NULL'})
       ORDER BY crisis DESC,u.id ASC LIMIT 50`,
      )
      .all(req.user.id);
    const query = norm(req.query.q || '');
    const items = rows
      .filter((x) => !query || norm(x.full_name).includes(query))
      .map((x) => ({
        id: x.id,
        service_no: x.service_no,
        dot: x.crisis ? 'red' : 'green',
        dot_reasons: x.crisis ? ['open_crisis'] : [],
      }));
    return res.json({ items, page: 1, page_size: 50, total: items.length });
  });
  app.post('/api/v1/patients/:patientId/parse', (req, res) => {
    const phrase = String(req.body.phrase || '');
    const target = req.body.target;
    if (target === 'plan_item' && req.user.role !== 'psychiatrist') return err(req, res, 403, 'E-ACCESS');
    if (target === 'visit')
      return res.json({ draft: { format: /очно/i.test(phrase) ? 'in_person' : 'remote' }, missing: [] });
    const p = norm(phrase);
    const inns = db.prepare("SELECT id,name FROM inn WHERE status='in_catalog'").all();
    const products = db
      .prepare(
        "SELECT p.inn_id,p.trade_name,i.name FROM drug_products p JOIN inn i ON i.id=p.inn_id WHERE p.status='in_catalog'",
      )
      .all();
    let hit = inns.find((x) => p.includes(norm(x.name)));
    if (!hit) {
      const brand = products.find((x) => p.includes(norm(x.trade_name)));
      if (brand) hit = { id: brand.inn_id, name: brand.name };
    }
    const dose = phrase.match(/(\d+(?:[.,]\d+)?)\s*(мг|мл)/i);
    const times = /на ночь/i.test(phrase) ? ['на ночь'] : /утром/i.test(phrase) ? ['утро'] : [];
    const draft = {
      inn_id: hit?.id,
      inn_name: hit?.name,
      dose: dose ? Number(dose[1].replace(',', '.')) : undefined,
      unit: dose?.[2]?.toLowerCase(),
      times,
    };
    const missing = [];
    if (!hit) missing.push('inn');
    if (!dose) missing.push('dose');
    if (!times.length) missing.push('times');
    return res.json({ draft, missing });
  });
  app.post('/api/v1/admin/care-assignments', (req, res) => {
    const patientId = Number(req.body.patient_id);
    const clinicianId = Number(req.body.clinician_id);
    const current = iso(deps);
    if (req.body.action === 'unassign') {
      db.prepare(
        'UPDATE care_assignments SET ended_at=?,ended_by=?,end_reason=? WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL',
      ).run(current, req.user.id, 'admin_unassign', patientId, clinicianId);
    } else if (req.body.action === 'assign') {
      let episode = db
        .prepare('SELECT id FROM care_episodes WHERE patient_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
        .get(patientId);
      if (!episode) {
        const id = db
          .prepare('INSERT INTO care_episodes(patient_id,started_at,opened_by) VALUES (?,?,?)')
          .run(patientId, current, req.user.id).lastInsertRowid;
        episode = { id };
      }
      db.prepare(
        'INSERT INTO care_assignments(patient_id,clinician_id,episode_id,started_at,created_by) VALUES (?,?,?,?,?)',
      ).run(patientId, clinicianId, episode.id, current, req.user.id);
    } else return err(req, res, 422, 'E-VALIDATION');
    return res.json({ ok: true });
  });
  app.get('/api/v1/admin/drug-review', (_req, res) => {
    const items = db
      .prepare("SELECT id,trade_name,status,created_at FROM drug_products WHERE status='pending' ORDER BY id")
      .all();
    return res.json({ items, page: 1, page_size: 50, total: items.length });
  });

  function planRow(patientId, status = 'published', visible = false) {
    const clause = visible ? 'AND (visible_from IS NULL OR visible_from<=?)' : '';
    return db
      .prepare(`SELECT * FROM plan_versions WHERE patient_id=? AND status=? ${clause} ORDER BY version DESC LIMIT 1`)
      .get(patientId, status, ...(visible ? [iso(deps)] : []));
  }
  function planItems(version, patientId) {
    if (!version) return [];
    return db
      .prepare(
        `SELECT pi.id,pi.item_key,pi.inn_id,pi.dose_value dose,pi.dose_unit unit,pi.times_json,pi.start_date,pi.end_date until,pi.comment_enc comment,i.name inn_name,i.drug_group,
      a.id acceptance_id,a.review_needed,a.patient_dose_value,a.patient_dose_unit,pm.product_id,dp.trade_name product_name,dp.status product_status
      FROM plan_items pi JOIN inn i ON i.id=pi.inn_id
      LEFT JOIN plan_item_acceptance a ON a.patient_id=? AND a.item_key=pi.item_key AND a.hidden_at IS NULL
      LEFT JOIN purchase_marks pm ON pm.patient_id=? AND pm.item_key=pi.item_key AND pm.status='current'
      LEFT JOIN drug_products dp ON dp.id=pm.product_id WHERE pi.plan_version_id=? AND pi.status='active'`,
      )
      .all(patientId, patientId, version.id)
      .map((x) => ({
        ...x,
        group: x.drug_group,
        times: JSON.parse(x.times_json || '[]'),
        patient_dose:
          x.acceptance_id && x.patient_dose_value != null
            ? { value: x.patient_dose_value, unit: x.patient_dose_unit || x.unit }
            : null,
        acceptance: x.acceptance_id
          ? {
              id: x.acceptance_id,
              review_needed: Boolean(x.review_needed),
              product: x.product_id ? { id: x.product_id, name: x.product_name, status: x.product_status } : null,
            }
          : null,
      }));
  }
  app.get('/api/v1/patients/:patientId/plan', (req, res) => {
    const patientId = patient(req);
    const draft = planRow(patientId, 'draft');
    const published = planRow(patientId, 'published');
    const versions = db
      .prepare(
        'SELECT id,version,status,visible_from,published_at FROM plan_versions WHERE patient_id=? ORDER BY version DESC',
      )
      .all(patientId);
    return res.json({
      draft: draft ? { id: draft.id, version: draft.edit_rev, items: planItems(draft, patientId) } : null,
      published: published
        ? { id: published.id, version: published.version, items: planItems(published, patientId) }
        : null,
      versions,
    });
  });
  app.put('/api/v1/patients/:patientId/plan/draft', (req, res) => {
    const patientId = patient(req);
    const current = planRow(patientId, 'draft');
    const requested = Number(req.body.version || 1);
    if (current && requested !== current.edit_rev) return err(req, res, 409, 'E-CONFLICT');
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length > 30) return err(req, res, 422, 'E-VALIDATION');
    const seen = new Set();
    const today = iso(deps).slice(0, 10);
    for (const item of items) {
      const innId = Number(item.inn_id);
      if (!db.prepare("SELECT 1 FROM inn WHERE id=? AND status='in_catalog'").get(innId) || seen.has(innId))
        return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'inn_id', key: 'err.e-validation' }] });
      seen.add(innId);
      const bad =
        (item.dose !== undefined && item.dose !== null && !(Number(item.dose) > 0 && Number(item.dose) <= 100000)) ||
        (item.unit && !PLAN_UNITS.includes(item.unit)) ||
        (item.times !== undefined && !(Array.isArray(item.times) && item.times.every((x) => typeof x === 'string'))) ||
        (item.until && !/^\d{4}-\d{2}-\d{2}$/.test(String(item.until))) ||
        String(item.comment || '').length > 1000;
      if (bad) return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'items', key: 'err.e-validation' }] });
    }
    let draft = current;
    if (!draft) {
      const next = (planRow(patientId, 'published')?.version || 0) + 1;
      const id = Number(
        db
          .prepare(
            "INSERT INTO plan_versions(patient_id,version,status,author_id,edit_rev,created_at) VALUES (?,?,'draft',?,1,?)",
          )
          .run(patientId, next, req.user.id, iso(deps)).lastInsertRowid,
      );
      draft = db.prepare('SELECT * FROM plan_versions WHERE id=?').get(id);
    }
    db.prepare('DELETE FROM plan_items WHERE plan_version_id=?').run(draft.id);
    // Дата начала сквозная: пункт, который уже был в плане, не «начинается заново» при каждой правке соседнего.
    const started = db.prepare(
      'SELECT pi.start_date FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id WHERE pv.patient_id=? AND pi.item_key=? AND pv.id<>? ORDER BY pv.version DESC LIMIT 1',
    );
    const add = db.prepare(
      'INSERT INTO plan_items(plan_version_id,item_key,inn_id,dose_value,dose_unit,times_json,start_date,end_date,comment_enc,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    for (const item of items) {
      const key = `inn:${Number(item.inn_id)}`;
      const ended = item.ended === true;
      add.run(
        draft.id,
        key,
        Number(item.inn_id),
        Number(item.dose || 0) || null,
        item.unit || null,
        JSON.stringify(item.times || []),
        started.get(patientId, key, draft.id)?.start_date || today,
        ended ? today : item.until || null,
        String(item.comment || '').trim() || null,
        ended ? 'ended' : 'active',
      );
    }
    db.prepare('UPDATE plan_versions SET edit_rev=edit_rev+1 WHERE id=?').run(draft.id);
    const updated = db.prepare('SELECT * FROM plan_versions WHERE id=?').get(draft.id);
    return res.json({ id: updated.id, version: updated.edit_rev, items: planItems(updated, patientId) });
  });
  app.post('/api/v1/patients/:patientId/plan/publish', (req, res) => {
    const patientId = patient(req);
    const draft = planRow(patientId, 'draft');
    if (!draft || Number(req.body.version) !== draft.edit_rev) return err(req, res, 409, 'E-CONFLICT');
    const visible = P.iso(new Date(now(config).getTime() + 10000));
    const old = planRow(patientId, 'published');
    db.prepare("UPDATE plan_versions SET status='superseded' WHERE patient_id=? AND status='published'").run(patientId);
    db.prepare("UPDATE plan_versions SET status='published',visible_from=?,published_at=? WHERE id=?").run(
      visible,
      iso(deps),
      draft.id,
    );
    // «Проверьте» — только у пунктов, где изменились доза, приём или срок; соседние назначения не трогаем.
    if (old) {
      const sig = (row) => JSON.stringify([row.dose_value, row.dose_unit, row.times_json, row.end_date]);
      const before = new Map(
        db
          .prepare("SELECT * FROM plan_items WHERE plan_version_id=? AND status='active'")
          .all(old.id)
          .map((r) => [r.item_key, sig(r)]),
      );
      const mark = db.prepare(
        'UPDATE plan_item_acceptance SET review_needed=1 WHERE patient_id=? AND item_key=? AND hidden_at IS NULL',
      );
      for (const r of db.prepare("SELECT * FROM plan_items WHERE plan_version_id=? AND status='active'").all(draft.id))
        if (before.has(r.item_key) && before.get(r.item_key) !== sig(r)) mark.run(patientId, r.item_key);
    }
    db.prepare(
      "INSERT INTO notifications(recipient_id,type,event_key,title,patient_id,visible_from,status,created_at) VALUES (?,'plan',?,'План назначен',?,?,'active',?)",
    ).run(patientId, `plan:${draft.id}`, patientId, visible, iso(deps));
    return res.json({
      published_version: draft.version,
      undo: deps.makeUndo(req.user.id, 'plan.publish', 'plan_publish', draft.id),
    });
  });
  app.get('/api/v1/me/meds', (req, res) => {
    const plan = planRow(req.user.id, 'published', true);
    const patientMeds = db
      .prepare(
        "SELECT pm.id,pm.current_version,pm.reviewed_version,pm.status,pm.hidden_at,pv.inn_id,pv.product_id,pv.dose_value dose,pv.dose_unit unit,pv.times_json,i.name inn_name,dp.trade_name product_name FROM patient_meds pm JOIN patient_med_versions pv ON pv.patient_med_id=pm.id AND pv.version=pm.current_version JOIN inn i ON i.id=pv.inn_id JOIN drug_products dp ON dp.id=pv.product_id WHERE pm.patient_id=? AND pm.hidden_at IS NULL AND pm.status='active'",
      )
      .all(req.user.id)
      .map((x) => ({
        ...x,
        version: x.current_version,
        times: JSON.parse(x.times_json || '[]'),
        review: x.reviewed_version >= x.current_version ? 'seen' : 'not_seen',
        inn: { id: x.inn_id, name: x.inn_name },
        product: { id: x.product_id, name: x.product_name },
      }));
    const course = db.prepare('SELECT rule_key,week FROM course_support_shown WHERE patient_id=?').all(req.user.id);
    return res.json({ plan_items: planItems(plan, req.user.id), patient_meds: patientMeds, course_support: course });
  });
  function activePlanItem(patientId, key) {
    const plan = planRow(patientId, 'published', true);
    if (!plan) return null;
    return db
      .prepare(
        "SELECT pi.*,i.name inn_name FROM plan_items pi JOIN inn i ON i.id=pi.inn_id WHERE pi.plan_version_id=? AND pi.item_key=? AND pi.status='active'",
      )
      .get(plan.id, key);
  }
  function pendingProduct(patientId, innId, name) {
    const nameNorm = norm(name);
    let product = db
      .prepare("SELECT * FROM drug_products WHERE status='pending' AND author_id=? AND trade_name_norm=? AND inn_id=?")
      .get(patientId, nameNorm, innId);
    if (product) return product;
    const count = db
      .prepare(
        "SELECT count(*) n FROM drug_products WHERE status='pending' AND author_id=? AND date(created_at)=date(?)",
      )
      .get(patientId, iso(deps)).n;
    if (count >= 5) return 'limit';
    const id = Number(
      db
        .prepare(
          "INSERT INTO drug_products(inn_id,trade_name,trade_name_norm,status,source,author_id,created_at) VALUES (?,?,?,'pending','entered_by_patient',?,?)",
        )
        .run(innId, String(name).slice(0, 120), nameNorm, patientId, iso(deps)).lastInsertRowid,
    );
    return db.prepare('SELECT * FROM drug_products WHERE id=?').get(id);
  }
  function setPurchase(req, res, key) {
    const item = activePlanItem(req.user.id, key);
    if (!item) return err(req, res, 404, 'E-NOT-FOUND');
    let product;
    if (req.body.pending_name) product = pendingProduct(req.user.id, item.inn_id, req.body.pending_name);
    else product = db.prepare('SELECT * FROM drug_products WHERE id=?').get(Number(req.body.product_id));
    if (product === 'limit') return err(req, res, 429, 'E-DRUG-PENDING-LIMIT');
    if (!product) return err(req, res, 422, 'E-GENERIC-REQUIRED');
    const mismatch = product.inn_id !== item.inn_id;
    if (mismatch) return err(req, res, 422, 'E-VALIDATION');
    // Своя дозировка (необязательно): число > 0; совпадающая с назначенной не сохраняется.
    let ownDose = null;
    if (req.body.dose !== undefined && req.body.dose !== null && req.body.dose !== '') {
      const value = Number(req.body.dose);
      const unit = String(req.body.dose_unit || item.dose_unit || '').slice(0, 20);
      if (!Number.isFinite(value) || value <= 0 || value > 100000)
        return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'dose', key: 'err.e-validation' }] });
      if (value !== Number(item.dose_value) || unit !== String(item.dose_unit || '')) ownDose = { value, unit };
    }
    db.prepare(
      "UPDATE purchase_marks SET status='previous',replaced_at=? WHERE patient_id=? AND item_key=? AND status='current'",
    ).run(iso(deps), req.user.id, key);
    const markId = Number(
      db
        .prepare(
          "INSERT INTO purchase_marks(patient_id,item_key,product_id,entered_text,inn_mismatch,status,created_at) VALUES (?,?,?,?,?, 'current',?)",
        )
        .run(req.user.id, key, product.id, req.body.pending_name || null, 0, iso(deps)).lastInsertRowid,
    );
    if (!mismatch) {
      db.prepare(
        'INSERT INTO plan_item_acceptance(patient_id,item_key,accepted_at,review_needed) VALUES (?,?,?,0) ON CONFLICT(patient_id,item_key) DO UPDATE SET accepted_at=excluded.accepted_at,hidden_at=NULL',
      ).run(req.user.id, key, iso(deps));
      db.prepare(
        'UPDATE plan_item_acceptance SET patient_dose_value=?, patient_dose_unit=? WHERE patient_id=? AND item_key=?',
      ).run(ownDose ? ownDose.value : null, ownDose ? ownDose.unit : null, req.user.id, key);
      const times = JSON.parse(item.times_json || '[]');
      for (const time of times.length ? times : ['any'])
        db.prepare(
          "INSERT INTO reminders(patient_id,created_by,kind,plan_item_id,message,time_hhmm,active,created_at) VALUES (?,?,'med',?,'STAND-IN: напоминание о приёме',?,1,?)",
        ).run(req.user.id, req.user.id, item.id, reminderTimeOf(time), iso(deps));
    }
    const listed = planItems(planRow(req.user.id, 'published', true), req.user.id).find((x) => x.item_key === key);
    return res.json({ item: listed, undo: deps.makeUndo(req.user.id, 'med.accept', 'purchase_mark', markId) });
  }
  // Время напоминания по слову из плана («утро», «вечер»…): те же часы, с которых чат напоминает по умолчанию.
  const REMINDER_TIME = { утро: '08:00', день: '13:00', вечер: '19:00', 'на ночь': '22:00' };
  const reminderTimeOf = (time) => (/^\d\d:\d\d$/.test(time) ? time : REMINDER_TIME[time] || '09:00');
  app.post('/api/v1/me/plan-items/:key/accept', (req, res) => {
    if (!req.body.product_id && !req.body.pending_name) return err(req, res, 422, 'E-GENERIC-REQUIRED');
    return setPurchase(req, res, req.params.key);
  });
  app.post('/api/v1/me/plan-items/:key/purchase', (req, res) => setPurchase(req, res, req.params.key));
  app.get('/api/v1/me/plan-items/:key/where-to-buy', (req, res) => {
    const item = activePlanItem(req.user.id, req.params.key);
    if (!item) return err(req, res, 404, 'E-NOT-FOUND');
    let links = db.prepare('SELECT name,url_template FROM pharmacy_links WHERE active=1').all();
    const setting = deps.activeSetting('reference.pharmacies').value;
    if (setting?.items)
      links = setting.items.filter((x) => x.active).map((x) => ({ name: x.title, url_template: x.template }));
    const sorted = (setting?.order === 'alpha' ? links.sort((a, b) => a.name.localeCompare(b.name, 'ru')) : links).map(
      (x) => ({ title: x.name, url: x.url_template.replace('{inn}', encodeURIComponent(item.inn_name)) }),
    );
    return res.json({ links: sorted, stand_in: true });
  });
  app.post('/api/v1/me/med-marks', (req, res) => {
    const target = req.body.target || {};
    const current = iso(deps);
    const timezone = deps.activeSetting('org.timezone_hours').value?.timezone || 'Europe/Moscow';
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(current));
    const day = req.body.day === undefined ? today : req.body.day;
    if (
      typeof day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day ||
      day > today
    )
      return err(req, res, 422, 'E-VALIDATION');
    let item;
    if (target.type === 'plan_item') {
      item = db
        .prepare(
          "SELECT pi.* FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id JOIN plan_item_acceptance a ON a.patient_id=pv.patient_id AND a.item_key=pi.item_key AND a.hidden_at IS NULL WHERE pi.id=? AND pv.patient_id=? AND pv.status='published' AND pi.status='active' AND (pv.visible_from IS NULL OR pv.visible_from<=?)",
        )
        .get(Number(target.id), req.user.id, current);
    } else if (target.type === 'patient_med') {
      item = db
        .prepare(
          "SELECT pv.*,pm.created_at start_date FROM patient_meds pm JOIN patient_med_versions pv ON pv.patient_med_id=pm.id AND pv.version=pm.current_version WHERE pm.id=? AND pm.patient_id=? AND pm.status='active' AND pm.hidden_at IS NULL",
        )
        .get(Number(target.id), req.user.id);
    }
    if (!item) return err(req, res, 404, 'E-NOT-FOUND');
    const startDay =
      item.start_date &&
      (item.start_date.length === 10
        ? item.start_date
        : new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(item.start_date)));
    if ((startDay && day < startDay) || (item.end_date && day > item.end_date))
      return err(req, res, 422, 'E-VALIDATION');
    const slot = req.body.slot === undefined ? 'any' : req.body.slot;
    const times = JSON.parse(item.times_json || '[]');
    if (typeof slot !== 'string' || (req.body.slot !== undefined && !(times.length ? times : ['any']).includes(slot)))
      return err(req, res, 422, 'E-VALIDATION');
    const status =
      req.body.status === undefined ? 'taken' : req.body.status === 'remind_later' ? 'later' : req.body.status;
    if (!['taken', 'skipped', 'later', 'unknown'].includes(status)) return err(req, res, 422, 'E-VALIDATION');
    const key = target.type === 'plan_item' ? item.item_key : null;
    const ownId = target.type === 'patient_med' ? Number(target.id) : null;
    const write = db.transaction(() => {
      const existing = db
        .prepare(
          'SELECT id FROM med_log WHERE patient_id=? AND item_key IS ? AND patient_med_id IS ? AND day=? AND slot=? AND hidden_at IS NULL',
        )
        .get(req.user.id, key, ownId, day, slot);
      if (status === 'unknown') {
        if (existing) db.prepare('UPDATE med_log SET hidden_at=? WHERE id=?').run(current, existing.id);
      } else if (existing) {
        db.prepare('UPDATE med_log SET status=?,logged_at=? WHERE id=?').run(status, current, existing.id);
      } else {
        db.prepare(
          'INSERT INTO med_log(patient_id,item_key,patient_med_id,day,slot,status,logged_at) VALUES (?,?,?,?,?,?,?)',
        ).run(req.user.id, key, ownId, day, slot, status, current);
      }
    });
    write.immediate();
    return res.json({ ok: true });
  });
  app.get('/api/v1/me/reminders', (req, res) => {
    const items = db
      .prepare(
        'SELECT r.id,r.time_hhmm,r.days_mask,r.active,r.kind,CASE WHEN r.plan_item_id IS NOT NULL THEN (SELECT i.name FROM plan_items p JOIN inn i ON i.id=p.inn_id WHERE p.id=r.plan_item_id) END AS name FROM reminders r WHERE r.patient_id=? ORDER BY r.id',
      )
      .all(req.user.id);
    return res.json({ items });
  });
  app.put('/api/v1/me/reminders/:id', (req, res) => {
    const row = db
      .prepare('SELECT id FROM reminders WHERE id=? AND patient_id=?')
      .get(Number(req.params.id), req.user.id);
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    if (req.body.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(req.body.time)))
      return err(req, res, 422, 'E-VALIDATION');
    db.prepare('UPDATE reminders SET time_hhmm=COALESCE(?,time_hhmm),active=?,updated_at=? WHERE id=?').run(
      req.body.time === undefined ? null : String(req.body.time),
      req.body.enabled ? 1 : 0,
      iso(deps),
      row.id,
    );
    return res.json({ ok: true });
  });
  function patientMedView(id) {
    return db
      .prepare(
        'SELECT pm.id,pm.patient_id,pm.current_version version,pm.reviewed_version,pv.inn_id,pv.product_id,pv.dose_value dose,pv.dose_unit unit,pv.times_json,i.name inn_name,dp.trade_name product_name FROM patient_meds pm JOIN patient_med_versions pv ON pv.patient_med_id=pm.id AND pv.version=pm.current_version JOIN inn i ON i.id=pv.inn_id JOIN drug_products dp ON dp.id=pv.product_id WHERE pm.id=?',
      )
      .get(id);
  }
  function shapedMed(row) {
    return {
      ...row,
      times: JSON.parse(row.times_json || '[]'),
      review: row.reviewed_version >= row.version ? 'seen' : 'not_seen',
      inn: { id: row.inn_id, name: row.inn_name },
      product: { id: row.product_id, name: row.product_name },
    };
  }
  app.post('/api/v1/me/patient-meds', (req, res) => {
    if (patientArchived(db, req.user.id)) return err(req, res, 409, 'E-ARCHIVED');
    const product = db
      .prepare(
        "SELECT p.*,i.id inn_id FROM drug_products p JOIN inn i ON i.id=p.inn_id WHERE p.id=? AND p.status IN ('in_catalog','pending')",
      )
      .get(Number(req.body.product_id));
    if (!product) return err(req, res, 422, 'E-GENERIC-REQUIRED');
    const duplicate = activePlanItem(req.user.id, `inn:${product.inn_id}`);
    if (duplicate) return err(req, res, 409, 'E-DRUG-DUPLICATE');
    const id = Number(
      db
        .prepare("INSERT INTO patient_meds(patient_id,current_version,status,created_at) VALUES (?,1,'active',?)")
        .run(req.user.id, iso(deps)).lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO patient_med_versions(patient_med_id,version,inn_id,product_id,dose_value,dose_unit,times_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      id,
      1,
      product.inn_id,
      product.id,
      req.body.dose || null,
      req.body.unit || null,
      JSON.stringify(req.body.times || []),
      iso(deps),
    );
    return res.status(201).json({
      med: shapedMed(patientMedView(id)),
      undo: deps.makeUndo(req.user.id, 'patient_med.add', 'patient_med', id),
    });
  });
  app.put('/api/v1/me/patient-meds/:id', (req, res) => {
    const current = patientMedView(Number(req.params.id));
    if (!current || Number(current.patient_id) !== req.user.id) return err(req, res, 404, 'E-NOT-FOUND');
    if (Number(req.body.version) !== current.version) return err(req, res, 409, 'E-CONFLICT');
    const next = current.version + 1;
    db.prepare(
      'INSERT INTO patient_med_versions(patient_med_id,version,inn_id,product_id,dose_value,dose_unit,times_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      current.id,
      next,
      current.inn_id,
      current.product_id,
      req.body.dose ?? current.dose,
      req.body.unit ?? current.unit,
      JSON.stringify(req.body.times || JSON.parse(current.times_json || '[]')),
      iso(deps),
    );
    db.prepare('UPDATE patient_meds SET current_version=?,updated_at=? WHERE id=?').run(next, iso(deps), current.id);
    return res.json(shapedMed(patientMedView(current.id)));
  });
  app.post('/api/v1/patient-meds/:id/confirm', (req, res) => {
    const med = patientMedView(Number(req.params.id));
    if (!med) return err(req, res, 404, 'E-NOT-FOUND');
    if (Number(req.body.version) !== med.version) return err(req, res, 409, 'E-CONFLICT');
    db.prepare('UPDATE patient_meds SET reviewed_version=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(
      med.version,
      req.user.id,
      iso(deps),
      med.id,
    );
    return res.json({ ok: true });
  });
  app.post('/api/v1/patient-meds/:id/comments', (req, res) => {
    const med = patientMedView(Number(req.params.id));
    if (!med) return err(req, res, 404, 'E-NOT-FOUND');
    db.prepare('UPDATE patient_meds SET doctor_comment_enc=?,updated_at=? WHERE id=?').run(
      String(req.body.text || '').slice(0, 300),
      iso(deps),
      med.id,
    );
    return res.json({ ok: true });
  });
  // Очный бланк: врач на приёме отмечает ответы пациента в той же методике, что и онлайн, — баллы считает сервер
  // тем же ключом, результат сразу сохраняется в карточку (без черновика: врач сам видел ответы).
  const offlineFromAnswers = (req, res, patientId, code, upload) => {
    const ins = instrument(db, code);
    const answers = req.body.answers;
    if (!ins || !answers || typeof answers !== 'object' || Array.isArray(answers))
      return err(req, res, 422, 'E-VALIDATION');
    const missing = [];
    for (const q of ins.questions) {
      const value = answers[q.id];
      const filled = value !== undefined && value !== null && value !== '';
      if (!filled) {
        if (q.required) missing.push(q.id);
        continue;
      }
      if (q.type === 'single' && q.options && !q.options.some((o) => o.value === value)) missing.push(q.id);
      if (
        q.type === 'multi' &&
        (!Array.isArray(value) || value.some((x) => !(q.options || []).some((o) => o.value === x)))
      )
        missing.push(q.id);
    }
    if (missing.length)
      return err(req, res, 422, 'E-VALIDATION', {
        fields: missing.map((id) => ({ key: 'err.e-validation.choose', field: id })),
      });
    const clean = Object.fromEntries(
      ins.questions.filter((q) => answers[q.id] !== undefined).map((q) => [q.id, answers[q.id]]),
    );
    const { score, band, sub } = scoreAnswers(db, ins, clean, patientId);
    const risky = ins.questions.filter((q) => clean[q.id] !== undefined && crisisAnswer(q, clean[q.id]));
    const id = Number(
      db
        .prepare(
          "INSERT INTO offline_results(patient_id,entered_by,instrument,total_score,subscales_json,band,risk_flag,risk_reasons_json,test_date,entry_method,source_file_id,status,answers_json,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'form',?,'saved',?,?,?)",
        )
        .run(
          patientId,
          req.user.id,
          ins.code,
          score,
          sub ? JSON.stringify(sub) : null,
          band,
          risky.length ? 1 : 0,
          risky.length ? JSON.stringify(risky.map((q) => q.id)) : null,
          heldOn(req),
          upload ? upload.id : null,
          JSON.stringify(clean),
          iso(deps),
          iso(deps),
        ).lastInsertRowid,
    );
    if (upload) linkUpload(upload.id, id, patientId);
    // Тревожный ответ в кризисном пункте — та же эскалация, что у подтверждённого очного результата.
    if (risky.length)
      db.prepare(
        "INSERT INTO crisis_escalations(patient_id,source,tier,triggers_json,status,due_at,created_at) VALUES (?,'offline',2,?,'new',?,?)",
      ).run(
        patientId,
        JSON.stringify(risky.map((q) => q.id)),
        P.iso(new Date(now(config).getTime() + 60 * 60 * 1000)),
        iso(deps),
      );
    return res.status(201).json({
      id,
      draft: null,
      source_ref: upload ? { id: upload.id } : null,
      total_score: score,
      band,
      risk_flag: risky.length > 0,
    });
  };
  // Фото или скан бумажного бланка: временная загрузка врача (POST /uploads) становится исходником очного результата
  // и хранится в карточке пациента (stored_files: offline_source → offline_result), а не удаляется через 20 минут.
  const takeUpload = (req, uploadId) =>
    uploadId == null
      ? null
      : db
          .prepare(
            "SELECT id FROM stored_files WHERE id=? AND owner_user_id=? AND status='temp' AND (expires_at IS NULL OR expires_at>?) AND (mime LIKE 'image/%' OR mime='application/pdf')",
          )
          .get(Number(uploadId), req.user.id, iso(deps)) || false;
  const linkUpload = (fileId, resultId, patientId) =>
    db
      .prepare(
        "UPDATE stored_files SET purpose='offline_source',linked_type='offline_result',linked_id=?,patient_id=?,status='linked',expires_at=NULL WHERE id=?",
      )
      .run(resultId, patientId, fileId);
  const heldOn = (req) =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.held_on || '')) ? req.body.held_on : iso(deps).slice(0, 10);
  app.post('/api/v1/patients/:patientId/offline-results', (req, res) => {
    const patientId = patient(req);
    const code = String(req.body.instrument_code || '');
    const method = req.body.method === 'photo' ? 'photo' : 'form';
    const upload = takeUpload(req, req.body.upload_id);
    if (upload === false || (method === 'photo' && !upload)) return err(req, res, 422, 'E-VALIDATION');
    // Фото бланка можно сохранить по любой методике каталога — и по той, что онлайн не проходится
    // (рисунок, письмо от руки); бланк с ответами и черновик баллов — только по проходимой.
    const known = db
      .prepare("SELECT code FROM instruments WHERE code=? AND status NOT IN ('blocked','withdrawn')")
      .get(code);
    if (method === 'photo' && !req.body.scores && req.body.answers === undefined) {
      if (!known) return err(req, res, 403, 'E-INSTRUMENT-LICENSE');
      const id = Number(
        db
          .prepare(
            "INSERT INTO offline_results(patient_id,entered_by,instrument,total_score,subscales_json,test_date,entry_method,source_file_id,status,created_at) VALUES (?,?,?,NULL,NULL,?,'photo',?,'draft',?)",
          )
          .run(patientId, req.user.id, code, heldOn(req), upload.id, iso(deps)).lastInsertRowid,
      );
      linkUpload(upload.id, id, patientId);
      // Баллов с фото нет: бланк хранится как исходник, баллы врач может внести отдельно.
      return res.status(201).json({ id, draft: { total: null }, source_ref: { id: upload.id } });
    }
    if (!instrument(db, code)) return err(req, res, 403, 'E-INSTRUMENT-LICENSE');
    if (req.body.answers !== undefined) return offlineFromAnswers(req, res, patientId, code, upload);
    const draft = req.body.scores || {};
    const id = Number(
      db
        .prepare(
          "INSERT INTO offline_results(patient_id,entered_by,instrument,total_score,subscales_json,test_date,entry_method,source_file_id,status,created_at) VALUES (?,?,?,?,?,?,?,?, 'draft',?)",
        )
        .run(
          patientId,
          req.user.id,
          code,
          draft.total ?? null,
          JSON.stringify(draft),
          heldOn(req),
          method,
          upload ? upload.id : null,
          iso(deps),
        ).lastInsertRowid,
    );
    if (upload) linkUpload(upload.id, id, patientId);
    return res.status(201).json({ id, draft, source_ref: upload ? { id: upload.id } : null });
  });
  app.post('/api/v1/offline-results/:id/confirm', (req, res) => {
    const row = db
      .prepare('SELECT * FROM offline_results WHERE id=? AND entered_by=?')
      .get(Number(req.params.id), req.user.id);
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    const scores = req.body.scores || {};
    const total = Number(scores.total);
    if (!Number.isFinite(total) || total < 0 || total > 27) return err(req, res, 422, 'E-VALIDATION');
    db.prepare(
      "UPDATE offline_results SET total_score=?,item9_score=?,subscales_json=?,status='saved',confirmed_at=? WHERE id=?",
    ).run(total, scores.item9 ?? null, JSON.stringify(scores), iso(deps), row.id);
    if (Number(scores.item9 || 0) > 0)
      db.prepare(
        "INSERT INTO crisis_escalations(patient_id,source,tier,triggers_json,status,due_at,created_at) VALUES (?,'offline',2,'[\"item9\"]','new',?,?)",
      ).run(row.patient_id, P.iso(new Date(now(config).getTime() + 60 * 60 * 1000)), iso(deps));
    return res.json({ id: row.id, source: 'offline', total_score: total });
  });
  app.post('/api/v1/offline-results/:id/erroneous', (req, res) => {
    const row = db
      .prepare('SELECT * FROM offline_results WHERE id=? AND entered_by=?')
      .get(Number(req.params.id), req.user.id);
    if (!row) return err(req, res, 404, 'E-NOT-FOUND');
    db.prepare('UPDATE offline_results SET invalid_at=?,invalid_by=?,invalid_reason=? WHERE id=?').run(
      iso(deps),
      req.user.id,
      String(req.body.reason || '').slice(0, 300),
      row.id,
    );
    return res.json({ ok: true, status: 'erroneous' });
  });
}

module.exports = { install, ensureSeed, seedInstruments, norm };
