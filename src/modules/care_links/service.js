'use strict';

// Связь специалистов вокруг пациента: вопрос пациенту после подключения нового специалиста,
// сами связи, уведомления, срезы «данных другого специалиста» и канал сообщений между специалистами.
// Закрепления связь не меняет; доступ — src/access/linked.js.

const { isFullyAssigned } = require('../../access/assignment');
const { linkedReadAccess, SPECIALIST_ROLES } = require('../../access/linked');

const ROLE_GEN = { psychiatrist: 'психиатру', psychologist: 'психологу' };

function createService({ db, P, config, now }) {
  const iso = () => P.iso(now(config));
  const pair = (x, y) => (x < y ? [x, y] : [y, x]);
  const person = (id) =>
    db.prepare("SELECT id, full_name, role FROM users WHERE id=? AND status='active'").get(id) || null;

  /** Специалисты, полностью закреплённые за пациентом (без signal_only). */
  function assigned(patientId) {
    return db
      .prepare(
        `SELECT DISTINCT u.id, u.full_name, u.role FROM care_assignments c JOIN users u ON u.id=c.clinician_id
         WHERE c.patient_id=? AND c.ended_at IS NULL AND COALESCE(c.end_reason,'')<>'signal_only'
           AND u.status='active' AND u.role IN ('psychiatrist','psychologist') ORDER BY u.id`,
      )
      .all(patientId);
  }

  function notify(recipientId, patientId, linkId, title) {
    const at = iso();
    db.prepare(
      "INSERT OR IGNORE INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'care',?,'patient',?,?,?,?,'active',?)",
    ).run(recipientId, `carelink:${linkId}`, patientId, title, patientId, at, at);
  }

  /** Вызывается после закрепления нового специалиста по коду: если есть кого соединить — заводит вопрос. */
  function onAttach(patientId, newClinicianId) {
    const others = assigned(patientId).filter((s) => s.id !== newClinicianId);
    if (!others.length) return null;
    return Number(
      db
        .prepare('INSERT INTO care_link_prompts(patient_id,new_clinician_id,created_at) VALUES (?,?,?)')
        .run(patientId, newClinicianId, iso()).lastInsertRowid,
    );
  }

  function patientView(patientId) {
    const current = assigned(patientId);
    const prompts = db
      .prepare(
        'SELECT id,new_clinician_id FROM care_link_prompts WHERE patient_id=? AND answered_at IS NULL ORDER BY id',
      )
      .all(patientId)
      .map((p) => {
        const fresh = current.find((s) => s.id === p.new_clinician_id);
        if (!fresh) return null;
        const options = current
          .filter((s) => s.id !== fresh.id)
          .filter((s) => {
            const [a, b] = pair(s.id, fresh.id);
            return !db
              .prepare(
                'SELECT 1 FROM care_links WHERE patient_id=? AND clinician_a=? AND clinician_b=? AND ended_at IS NULL',
              )
              .get(patientId, a, b);
          })
          .map((s) => ({ id: s.id, full_name: s.full_name, role: s.role }));
        return options.length
          ? { id: p.id, new_specialist: { id: fresh.id, full_name: fresh.full_name, role: fresh.role }, options }
          : null;
      })
      .filter(Boolean);
    const links = db
      .prepare(
        'SELECT id,clinician_a,clinician_b,created_at FROM care_links WHERE patient_id=? AND ended_at IS NULL ORDER BY id',
      )
      .all(patientId)
      .map((l) => ({
        id: l.id,
        created_at: l.created_at,
        a: person(l.clinician_a),
        b: person(l.clinician_b),
      }))
      .filter((l) => l.a && l.b);
    return {
      specialists: current.map((s) => ({ id: s.id, full_name: s.full_name, role: s.role })),
      prompts,
      links,
    };
  }

  /** Ответ пациента: соединить нового специалиста с выбранными. Пустой список — «ни с кем». */
  function answer(patientId, promptId, clinicianIds) {
    return db
      .transaction(() => {
        const prompt = db
          .prepare('SELECT * FROM care_link_prompts WHERE id=? AND patient_id=? AND answered_at IS NULL')
          .get(promptId, patientId);
        if (!prompt) return null;
        const fresh = person(prompt.new_clinician_id);
        const allowed = new Map(assigned(patientId).map((s) => [s.id, s]));
        if (!fresh || !allowed.has(fresh.id)) return null;
        const chosen = [...new Set(clinicianIds)].filter((id) => id !== fresh.id);
        if (chosen.some((id) => !allowed.has(id))) return { error: 'invalid' };
        const created = [];
        for (const id of chosen) {
          const [a, b] = pair(id, fresh.id);
          const have = db
            .prepare(
              'SELECT id FROM care_links WHERE patient_id=? AND clinician_a=? AND clinician_b=? AND ended_at IS NULL',
            )
            .get(patientId, a, b);
          if (have) continue;
          const linkId = Number(
            db
              .prepare('INSERT INTO care_links(patient_id,clinician_a,clinician_b,created_at) VALUES (?,?,?,?)')
              .run(patientId, a, b, iso()).lastInsertRowid,
          );
          const other = allowed.get(id);
          // Нейтрально: без имени пациента и клиники; пациент открывается по объекту уведомления.
          notify(id, patientId, linkId, `Ваш пациент подключился к ${ROLE_GEN[fresh.role]}: вы соединены`);
          notify(
            fresh.id,
            patientId,
            linkId,
            `Вы соединены с коллегой (${other.role === 'psychiatrist' ? 'психиатр' : 'психолог'}) по общему пациенту`,
          );
          created.push(linkId);
        }
        db.prepare('UPDATE care_link_prompts SET answered_at=? WHERE id=?').run(iso(), prompt.id);
        return { created };
      })
      .immediate();
  }

  function endLink(patientId, linkId, actorId) {
    const done = db
      .prepare('UPDATE care_links SET ended_at=?, ended_by=? WHERE id=? AND patient_id=? AND ended_at IS NULL')
      .run(iso(), actorId, linkId, patientId);
    return done.changes === 1;
  }

  // ---- срезы «данных другого специалиста» ----

  function testsOf(patientId, colleagueId) {
    const online = db
      .prepare(
        `SELECT r.instrument, r.total_score score, r.band, substr(r.created_at,1,10) date
         FROM online_results r JOIN instrument_assignments a ON a.id=r.assignment_id
         WHERE r.patient_id=? AND a.assigned_by=? AND r.invalid_at IS NULL`,
      )
      .all(patientId, colleagueId);
    const offline = db
      .prepare(
        `SELECT instrument, total_score score, band, test_date date FROM offline_results
         WHERE patient_id=? AND entered_by=? AND status='saved' AND invalid_at IS NULL`,
      )
      .all(patientId, colleagueId);
    return [...online, ...offline].sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, 20);
  }

  function medsOf(patientId) {
    const plan = db
      .prepare(
        "SELECT id,version FROM plan_versions WHERE patient_id=? AND status='published' AND (visible_from IS NULL OR visible_from<=?) ORDER BY version DESC LIMIT 1",
      )
      .get(patientId, iso());
    if (!plan) return [];
    return db
      .prepare(
        `SELECT i.name inn_name, pi.dose_value dose, pi.dose_unit unit, pi.times_json, pi.start_date, pi.end_date until
         FROM plan_items pi JOIN inn i ON i.id=pi.inn_id WHERE pi.plan_version_id=? AND pi.status='active'`,
      )
      .all(plan.id)
      .map(({ times_json, ...m }) => ({ ...m, times: JSON.parse(times_json || '[]') }));
  }

  /** Блок «данные другого специалиста» для карточки пациента; null — доступа нет. */
  function colleagueView(requester, patientId, audit) {
    const links = linkedReadAccess(db, requester.id, patientId);
    if (!links.length) return null;
    return links.map((l) => {
      const shared = {};
      if (requester.role === 'psychiatrist' && l.colleague.role === 'psychologist') {
        shared.tests = testsOf(patientId, l.colleague.id);
        audit('colleague.tests');
      }
      if (requester.role === 'psychologist' && l.colleague.role === 'psychiatrist') {
        shared.meds = medsOf(patientId);
        audit('colleague.meds');
      }
      const messages = db
        .prepare(
          'SELECT id,sender_id,body,created_at FROM care_link_messages WHERE link_id=? ORDER BY id DESC LIMIT 50',
        )
        .all(l.id)
        .reverse()
        .map((m) => ({ id: m.id, mine: m.sender_id === requester.id, body: m.body, created_at: m.created_at }));
      return { id: l.id, colleague: l.colleague, shared, messages };
    });
  }

  function postMessage(requester, patientId, linkId, text) {
    const link = linkedReadAccess(db, requester.id, patientId).find((l) => l.id === linkId);
    if (!link) return null;
    const id = Number(
      db
        .prepare('INSERT INTO care_link_messages(link_id,patient_id,sender_id,body,created_at) VALUES (?,?,?,?,?)')
        .run(linkId, patientId, requester.id, text, iso()).lastInsertRowid,
    );
    const at = iso();
    db.prepare(
      "INSERT OR IGNORE INTO notifications(recipient_id,type,event_key,object_type,object_id,title,patient_id,visible_from,status,created_at) VALUES (?,'message',?,'patient',?,?,?,?,'active',?)",
    ).run(
      link.colleague.id,
      `carelinkmsg:${id}`,
      patientId,
      'Новое сообщение коллеги по общему пациенту',
      patientId,
      at,
      at,
    );
    return { id };
  }

  return { onAttach, patientView, answer, endLink, colleagueView, postMessage, isFullyAssigned, SPECIALIST_ROLES };
}

module.exports = { createService };
