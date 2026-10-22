'use strict';

/**
 * Аналитика для заказчика и специалиста (диагноз → кто ведёт → что назначают → что происходит → что получается → цена).
 *   GET  /api/v1/admin/insights                  — администратор: отчёт по участникам программы, без идентификаторов
 *   GET  /api/v1/admin/insights/export           — то же в CSV (в журнале выгрузок)
 *   GET  /api/v1/analytics/my-insights           — специалист: только свои пациенты, со ссылками на карточки
 *   GET/PUT /api/v1/me/clinician-profile         — специальность, место работы, журналы и конференции (необязательно)
 *   GET/PUT /api/v1/patients/{patient_id}/diagnosis — диагноз пациента, который врач может указать (необязательно)
 * Расчёт — report.js; чтение — data.js (представления без идентификаторов, соединение «только чтение»).
 */

const { loadInsights } = require('./data');
const { buildReport, SPECIALTY, ORG_KIND } = require('./report');
const { narrate } = require('./story');
const { shiftDay } = require('../analytics/facts');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`.,;:!?()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const clean = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim();

function install(app, { db, P, config, now, activeSetting, auditPatient }) {
  const today = () => P.iso(now(config)).slice(0, 10);
  const minGroup = () => Math.max(10, Number(activeSetting('analytics.min_group').value) || 10);
  const diagnoses = () => db.prepare('SELECT code,label,grp FROM diagnosis_catalog ORDER BY sort').all();

  function period(req) {
    const to = req.query.to === undefined ? today() : String(req.query.to);
    const from = req.query.from === undefined ? shiftDay(to, -179) : String(req.query.from);
    const valid = (s) =>
      DAY_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!valid(from) || !valid(to)) return null;
    const span = (Date.parse(to) - Date.parse(from)) / 86400000;
    return span < 0 || span > 730 ? null : { from, to };
  }
  function dxParam(req) {
    const dx = String(req.query.dx || 'all');
    if (dx === 'all' || dx === 'unknown') return dx;
    return diagnoses().some((d) => d.code === dx) ? dx : null;
  }

  function adminReport(range, dx) {
    const data = loadInsights(db, { scope: 'program', ...range, now: P.iso(now(config)) });
    return narrate(
      buildReport(data, { audience: 'admin', dx, minGroup: minGroup(), diagnoses: diagnoses(), ...range }),
    );
  }

  app.get('/api/v1/admin/insights', (req, res) => {
    const range = period(req);
    const dx = dxParam(req);
    if (!range || !dx) return P.sendError(req, res, 422, 'E-VALIDATION');
    return res.json(adminReport(range, dx));
  });

  // CSV: только то, что уже показано в отчёте (скрытые ячейки пусты), с определениями в первых строках.
  app.get('/api/v1/admin/insights/export', (req, res) => {
    const range = period(req);
    const dx = dxParam(req);
    if (!range || !dx) return P.sendError(req, res, 422, 'E-VALIDATION');
    const r = adminReport(range, dx);
    const rows = [['раздел', 'показатель', 'значение', 'единица', 'примечание']];
    const add = (section, name, value, unit = '', note = '') =>
      rows.push([
        section,
        name,
        value === null || value === undefined ? '' : value,
        unit,
        value === null || value === undefined ? 'скрыто или нет данных' : note,
      ]);
    const sec = Object.fromEntries(r.sections.map((s) => [s.key, s]));
    add('Кто они', 'Пациентов', sec.who.n_patients, 'чел.');
    for (const d of sec.who.dynamics) add('Кто они', `Начали наблюдение, ${d.month}`, d.n_patients, 'чел.');
    for (const s of sec.clinicians.specialties)
      add('Кто их ведёт', `Специальность: ${s.label}`, s.n_patients, 'пациентов');
    for (const s of sec.clinicians.org_kinds)
      add('Кто их ведёт', `Тип организации: ${s.label}`, s.n_patients, 'пациентов');
    for (const s of sec.clinicians.regions) add('Кто их ведёт', `Регион: ${s.label}`, s.n_patients, 'пациентов');
    for (const s of sec.clinicians.organizations)
      add('Кто их ведёт', `Организация: ${s.label}`, s.n_patients, 'пациентов');
    for (const j of sec.doctors.journals) add('Чем живут врачи', `Журнал: ${j.title}`, j.n_doctors, 'специалистов');
    for (const j of sec.doctors.conferences)
      add('Чем живут врачи', `Конференция: ${j.title}`, j.n_doctors, 'специалистов');
    for (const s of sec.prescribed.by_inn) add('Что назначают', `Препарат: ${s.label}`, s.n_patients, 'пациентов');
    for (const s of sec.prescribed.duration) add('Что назначают', `Срок: ${s.label}`, s.n, 'назначений');
    for (const s of sec.reality.funnel) add('Что реально происходит', s.label, s.n_patients, 'пациентов');
    for (const s of sec.reality.adherence)
      add('Что реально происходит', `Приём: ${s.label}`, s.n_patients, 'пациентов');
    for (const m of sec.outcomes.measures) {
      add('Что получается', `${m.label}: пациентов в расчёте`, m.n_patients, 'чел.', m.cut_text);
      add('Что получается', `${m.label}: улучшение`, m.share_improved, '%');
      add('Что получается', `${m.label}: медиана времени до улучшения`, m.median_days, 'дн.');
    }
    add('Какова цена', 'Сообщили о побочных эффектах', sec.cost.n_reporters, 'чел.');
    for (const c of sec.cost.complaints) add('Какова цена', `Жалоба: ${c.label}`, c.n_patients, 'пациентов');
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const head = [
      `# Clinical Compass: аналитика программы, ${r.diagnosis.selected.label}, ${range.from} — ${range.to}`,
      `# Предварительные данные (${r.formula_version}); группы меньше ${r.min_group} человек скрыты; идентификаторов нет.`,
    ];
    const csv = `﻿${[...head, ...rows.map((row) => row.map(q).join(','))].join('\n')}\n`;
    db.prepare(
      "INSERT INTO export_log(actor_id,kind,filter_json,row_count,recipient_class,created_at) VALUES (?,'program',?,?,'sponsor_aggregate',?)",
    ).run(req.user.id, JSON.stringify({ kind: 'insights', dx, ...range }), rows.length - 1, P.iso(now(config)));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="insights.csv"');
    return res.send(csv);
  });

  // Специалист: свои пациенты. Права и согласия применяют представления (текущее закрепление + базовое согласие).
  app.get('/api/v1/analytics/my-insights', (req, res) => {
    const range = period(req);
    const dx = dxParam(req);
    if (!range || !dx) return P.sendError(req, res, 422, 'E-VALIDATION');
    const data = loadInsights(db, { scope: 'current', clinicianId: req.user.id, ...range, now: P.iso(now(config)) });
    const report = narrate(
      buildReport(data, { audience: req.user.role, dx, diagnoses: diagnoses(), withSubjects: true, ...range }),
    );
    // Код субъекта → карточка: только среди пациентов этого специалиста.
    const mine = new Map(
      db
        .prepare(
          `SELECT s.subject_code AS code, u.id AS id, u.full_name AS name FROM analytics_subjects s
           JOIN users u ON u.id = s.patient_id JOIN care_assignments a ON a.patient_id = u.id
           WHERE a.clinician_id = ? AND a.ended_at IS NULL AND COALESCE(a.end_reason,'') <> 'signal_only'`,
        )
        .all(req.user.id)
        .map((r) => [r.code, r]),
    );
    report.patients = report.per_subject
      .filter((s) => mine.has(s.code))
      .map(({ code, ...rest }) => ({ id: mine.get(code).id, name: mine.get(code).name, ...rest }));
    delete report.per_subject;
    return res.json(report);
  });

  // ---- профиль специалиста
  function profileOf(userId) {
    const p = db
      .prepare(
        `SELECT p.specialty, p.analytics_consent, o.name, o.kind, o.region, o.city FROM clinician_profiles p
         LEFT JOIN organizations o ON o.id = p.organization_id WHERE p.user_id = ?`,
      )
      .get(userId);
    const interests = db
      .prepare('SELECT kind,title,year FROM clinician_interests WHERE user_id = ? ORDER BY id')
      .all(userId);
    return {
      specialty: p?.specialty || null,
      organization: p?.name ? { name: p.name, kind: p.kind, region: p.region, city: p.city || '' } : null,
      analytics_consent: p?.analytics_consent === 1,
      journals: interests.filter((i) => i.kind === 'journal').map((i) => i.title),
      conferences: interests.filter((i) => i.kind === 'conference').map((i) => ({ title: i.title, year: i.year })),
      options: {
        specialties: Object.entries(SPECIALTY).map(([code, label]) => ({ code, label })),
        org_kinds: Object.entries(ORG_KIND).map(([code, label]) => ({ code, label })),
      },
    };
  }
  app.get('/api/v1/me/clinician-profile', (req, res) => res.json(profileOf(req.user.id)));
  app.put('/api/v1/me/clinician-profile', (req, res) => {
    const b = req.body || {};
    const bad = (field) => P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field, key: 'err.e-validation' }] });
    const specialty =
      b.specialty === null || b.specialty === undefined || b.specialty === '' ? null : String(b.specialty);
    if (specialty && !SPECIALTY[specialty]) return bad('specialty');
    let org = null;
    if (b.organization) {
      org = {
        name: clean(b.organization.name),
        kind: String(b.organization.kind || ''),
        region: clean(b.organization.region),
        city: clean(b.organization.city),
      };
      if (org.name.length < 2 || org.name.length > 120) return bad('organization.name');
      if (!ORG_KIND[org.kind]) return bad('organization.kind');
      if (org.region.length < 2 || org.region.length > 80 || org.city.length > 80) return bad('organization.region');
    }
    const titles = (list, field) => {
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list) || list.length > 15) return null;
      const out = [];
      for (const item of list) {
        const title = clean(typeof item === 'object' && item ? item.title : item);
        const year = typeof item === 'object' && item && item.year ? Number(item.year) : null;
        if (
          title.length < 2 ||
          title.length > 120 ||
          (year !== null && !(Number.isInteger(year) && year >= 1990 && year <= 2100))
        )
          return null;
        if (!out.some((x) => norm(x.title) === norm(title))) out.push({ title, year });
      }
      return out;
    };
    const journals = titles(b.journals);
    if (!journals) return bad('journals');
    const conferences = titles(b.conferences);
    if (!conferences) return bad('conferences');
    const consent = b.analytics_consent === true ? 1 : 0;
    const stamp = P.iso(now(config));
    db.exec('BEGIN IMMEDIATE');
    try {
      let orgId = null;
      if (org) {
        const key = norm(org.name);
        const found = db
          .prepare('SELECT id FROM organizations WHERE name_norm = ? AND region = ?')
          .get(key, org.region);
        orgId = found
          ? found.id
          : Number(
              db
                .prepare('INSERT INTO organizations(name,name_norm,kind,region,city,created_at) VALUES (?,?,?,?,?,?)')
                .run(org.name, key, org.kind, org.region, org.city || null, stamp).lastInsertRowid,
            );
      }
      const before = db
        .prepare('SELECT analytics_consent, consent_at FROM clinician_profiles WHERE user_id = ?')
        .get(req.user.id);
      const consentAt = consent ? (before?.analytics_consent === 1 ? before.consent_at : stamp) : null;
      db.prepare(
        `INSERT INTO clinician_profiles(user_id,specialty,organization_id,analytics_consent,consent_at,updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET specialty=excluded.specialty, organization_id=excluded.organization_id,
           analytics_consent=excluded.analytics_consent, consent_at=excluded.consent_at, updated_at=excluded.updated_at`,
      ).run(req.user.id, specialty, orgId, consent, consentAt, stamp);
      db.prepare('DELETE FROM clinician_interests WHERE user_id = ?').run(req.user.id);
      const add = db.prepare(
        'INSERT INTO clinician_interests(user_id,kind,title,title_norm,year,created_at) VALUES (?,?,?,?,?,?)',
      );
      for (const j of journals) add.run(req.user.id, 'journal', j.title, norm(j.title), null, stamp);
      for (const c of conferences) add.run(req.user.id, 'conference', c.title, norm(c.title), c.year, stamp);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return res.json(profileOf(req.user.id));
  });

  // ---- диагноз пациента (необязательно; доступ к пациенту проверяет общий перехватчик)
  const dxOf = (patientId) =>
    db
      .prepare(
        `SELECT d.code, c.label, d.set_at FROM patient_diagnoses d JOIN diagnosis_catalog c ON c.code = d.code
         WHERE d.patient_id = ? AND d.ended_at IS NULL`,
      )
      .get(patientId) || null;
  app.get('/api/v1/patients/:patient_id/diagnosis', (req, res) => {
    const id = Number(req.params.patient_id);
    return res.json({ current: dxOf(id), options: diagnoses().map(({ code, label }) => ({ code, label })) });
  });
  app.put('/api/v1/patients/:patient_id/diagnosis', (req, res) => {
    const id = Number(req.params.patient_id);
    const code = req.body?.code === null || req.body?.code === '' ? null : String(req.body?.code || '');
    if (code !== null && !diagnoses().some((d) => d.code === code))
      return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'code', key: 'err.e-validation' }] });
    const stamp = P.iso(now(config));
    const cur = dxOf(id);
    if ((cur?.code || null) !== code) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE patient_diagnoses SET ended_at = ? WHERE patient_id = ? AND ended_at IS NULL').run(
          stamp,
          id,
        );
        if (code)
          db.prepare('INSERT INTO patient_diagnoses(patient_id,code,set_by,set_at) VALUES (?,?,?,?)').run(
            id,
            code,
            req.user.id,
            stamp,
          );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      auditPatient(req, id, 'allow', 'diagnosis');
    }
    return res.json({ current: dxOf(id), options: diagnoses().map(({ code: c, label }) => ({ code: c, label })) });
  });
}

module.exports = { install, norm };
