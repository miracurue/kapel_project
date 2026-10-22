'use strict';

const { RULES, DAILY_MAX, STEP_PRICE, MAX_STEPS, WATER_MAX_STEPS, STAGES } = require('./rules');
const { shiftDay } = require('../analytics/facts');

const SCAN_MARGIN_DAYS = 3;

function stageFor(steps) {
  let index = 0;
  STAGES.forEach((s, i) => {
    if (steps >= s.from) index = i;
  });
  return index;
}

/** @param {{ now: () => string, today: () => string }} clock now — ISO UTC, today — день по поясу организации */
function create(db, clock) {
  const q = {
    state: db.prepare('SELECT * FROM flower_state WHERE patient_id=?'),
    open: db.prepare('INSERT OR IGNORE INTO flower_state(patient_id,started_at,synced_at) VALUES (?,?,?)'),
    touch: db.prepare('UPDATE flower_state SET synced_at=? WHERE patient_id=?'),
    has: db.prepare('SELECT 1 FROM flower_ledger WHERE patient_id=? AND idem_key=?'),
    sum: db.prepare(
      "SELECT COALESCE(SUM(CASE WHEN kind='earn' THEN amount END),0) earned_today, COALESCE(SUM(CASE WHEN kind='earn' AND action=? THEN amount END),0) action_today FROM flower_ledger WHERE patient_id=? AND day=?",
    ),
    insert: db.prepare(
      'INSERT INTO flower_ledger(patient_id,kind,action,amount,steps,idem_key,source,day,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ),
    totals: db.prepare(
      "SELECT COALESCE(SUM(amount),0) balance, COALESCE(SUM(CASE WHEN kind='earn' THEN amount END),0) earned, COALESCE(SUM(steps),0) steps FROM flower_ledger WHERE patient_id=?",
    ),
    todayEarned: db.prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM flower_ledger WHERE patient_id=? AND kind='earn' AND day=?",
    ),
    recent: db.prepare(
      "SELECT id,action,amount,created_at FROM flower_ledger WHERE patient_id=? AND kind='earn' AND amount>0 ORDER BY id DESC LIMIT 8",
    ),
    eligible: db.prepare(
      "SELECT 1 FROM users u WHERE u.id=? AND u.role='patient' AND u.status='active' AND NOT EXISTS(SELECT 1 FROM data_subject_requests r WHERE r.patient_id=u.id AND r.request_type='erasure' AND r.status IN ('submitted','in_work','waiting_crisis'))",
    ),
  };

  function ensure(patientId, startedAt) {
    q.open.run(patientId, startedAt || clock.now(), clock.now());
    return q.state.get(patientId);
  }

  /** Одно начисление. Возвращает фактически начисленные капли (0 — уже было или упёрлись в предел). */
  function grant(patientId, action, key, source) {
    const rule = RULES[action];
    if (!rule || q.has.get(patientId, key)) return 0;
    const day = clock.today();
    const used = q.sum.get(action, patientId, day);
    const amount = Math.max(0, Math.min(rule.drops, rule.dailyCap - used.action_today, DAILY_MAX - used.earned_today));
    q.insert.run(patientId, 'earn', action, amount, 0, key, source, day, clock.now());
    return amount;
  }

  /** События-источники с момента последнего просмотра. Ключ делает начисление идемпотентным. */
  function sources(patientId, from, today) {
    const recentDay = shiftDay(today, -1);
    const out = [];
    const add = (action, rows) => rows.forEach((r) => out.push({ action, key: r.key, source: r.source }));
    const allowDay = (rule, day) => rule.backdated !== false || day >= recentDay;
    add(
      'diary',
      db
        .prepare(
          'SELECT entry_date d, id FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL AND (mood IS NOT NULL OR sleep IS NOT NULL OR anxiety IS NOT NULL) AND substr(created_at,1,10)>=? ORDER BY id',
        )
        .all(patientId, from)
        .filter((r) => allowDay(RULES.diary, r.d))
        .map((r) => ({ key: `diary:${r.d}`, source: `mood_entries:${r.id}` })),
    );
    add(
      'habit',
      db
        .prepare(
          'SELECT habit_id h, day d, MIN(id) id FROM diary_habit_values WHERE patient_id=? AND hidden_at IS NULL AND substr(recorded_at,1,10)>=? GROUP BY habit_id, day ORDER BY MIN(id)',
        )
        .all(patientId, from)
        .filter((r) => allowDay(RULES.habit, r.d))
        .map((r) => ({ key: `habit:${r.h}:${r.d}`, source: `diary_habit_values:${r.id}` })),
    );
    add(
      'med',
      db
        .prepare(
          "SELECT id, day d, COALESCE(item_key, 'own' || patient_med_id) k, slot FROM med_log WHERE patient_id=? AND status='taken' AND hidden_at IS NULL AND substr(logged_at,1,10)>=? ORDER BY id",
        )
        .all(patientId, from)
        .filter((r) => allowDay(RULES.med, r.d))
        .map((r) => ({ key: `med:${r.k}:${r.d}:${r.slot}`, source: `med_log:${r.id}` })),
    );
    add(
      'test',
      db
        .prepare(
          'SELECT id FROM online_results WHERE patient_id=? AND invalid_at IS NULL AND substr(created_at,1,10)>=? ORDER BY id',
        )
        .all(patientId, from)
        .map((r) => ({ key: `test:${r.id}`, source: `online_results:${r.id}` })),
    );
    add(
      'note',
      db
        .prepare(
          "SELECT note_id n, day d FROM diary_day_notes WHERE patient_id=? AND text<>'' AND substr(created_at,1,10)>=? ORDER BY created_at",
        )
        .all(patientId, from)
        .filter((r) => allowDay(RULES.note, r.d))
        .map((r) => ({ key: `note:${r.n}`, source: 'diary_day_notes' })),
    );
    add(
      'ai',
      db
        .prepare(
          "SELECT m.id FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id WHERE t.owner_user_id=? AND m.role='user' AND m.kind='normal' AND substr(m.created_at,1,10)>=? ORDER BY m.id",
        )
        .all(patientId, from)
        .map((r) => ({ key: `ai:${r.id}`, source: `ai_messages:${r.id}` })),
    );
    add(
      'plan',
      db
        .prepare(
          'SELECT id, item_key k FROM plan_item_acceptance WHERE patient_id=? AND hidden_at IS NULL AND substr(accepted_at,1,10)>=? ORDER BY id',
        )
        .all(patientId, from)
        .map((r) => ({ key: `plan:${r.k}`, source: `plan_item_acceptance:${r.id}` })),
    );
    add(
      'visit',
      db
        .prepare("SELECT id FROM visits WHERE patient_id=? AND status='done' AND substr(starts_at,1,10)>=? ORDER BY id")
        .all(patientId, from)
        .map((r) => ({ key: `visit:${r.id}`, source: `visits:${r.id}` })),
    );
    add(
      'start',
      db
        .prepare('SELECT 1 FROM user_prefs WHERE user_id=? AND onboarding_done_at IS NOT NULL')
        .all(patientId)
        .map(() => ({ key: 'start:onboarding', source: 'user_prefs' })),
    );
    return out;
  }

  const syncTx = db.transaction((patientId) => {
    const state = ensure(patientId);
    const today = clock.today();
    const startDay = state.started_at.slice(0, 10);
    const from = [startDay, shiftDay(state.synced_at.slice(0, 10), -SCAN_MARGIN_DAYS)].sort().pop();
    const gains = [];
    for (const ev of sources(patientId, from, today)) {
      const amount = grant(patientId, ev.action, ev.key, ev.source);
      if (amount > 0) gains.push({ action: ev.action, amount });
    }
    q.touch.run(clock.now(), patientId);
    return gains;
  });

  /** Просмотреть источники и начислить новое. Ошибка начисления не должна ломать само действие пациента. */
  function sync(patientId) {
    try {
      if (!q.eligible.get(patientId)) return { gained: 0, items: [] };
      const items = syncTx.immediate(patientId);
      return { gained: items.reduce((n, x) => n + x.amount, 0), items };
    } catch (error) {
      console.error(JSON.stringify({ event: 'flower.sync.failed', message: String(error.message || error) }));
      return { gained: 0, items: [] };
    }
  }

  /** Событие без собственной таблицы (прочтение статьи): ключ задаёт вызывающий. */
  function award(patientId, action, key, source = '') {
    try {
      if (!q.eligible.get(patientId)) return 0;
      return db
        .transaction(() => {
          ensure(patientId);
          return grant(patientId, action, key, source);
        })
        .immediate();
    } catch (error) {
      console.error(JSON.stringify({ event: 'flower.award.failed', message: String(error.message || error) }));
      return 0;
    }
  }

  function totals(patientId) {
    return q.totals.get(patientId);
  }

  function state(patientId) {
    ensure(patientId);
    const { balance, earned, steps } = totals(patientId);
    const stage = stageFor(steps);
    const next = STAGES[stage + 1] || null;
    const full = steps >= MAX_STEPS;
    const affordable = Math.min(Math.floor(balance / STEP_PRICE), MAX_STEPS - steps, WATER_MAX_STEPS);
    return {
      day: clock.today(),
      balance,
      earned_total: earned,
      steps,
      max_steps: MAX_STEPS,
      stage: { index: stage + 1, key: STAGES[stage].key, count: STAGES.length },
      next: next
        ? {
            key: next.key,
            steps_to_go: next.from - steps,
            drops_to_go: Math.max(0, (next.from - steps) * STEP_PRICE - balance),
          }
        : null,
      price: STEP_PRICE,
      can_water: !full && affordable >= 1,
      water_steps: Math.max(0, affordable),
      full,
      today_drops: q.todayEarned.get(patientId, clock.today()).n,
      daily_max: DAILY_MAX,
      recent: q.recent.all(patientId),
      sources: Object.entries(RULES).map(([action, r]) => ({
        action,
        drops: r.drops,
        daily_cap: r.dailyCap,
        once: Boolean(r.once),
      })),
    };
  }

  /** Полить: тратит STEP_PRICE за шаг. Идемпотентно по ключу. Возвращает { error } или { steps, drops }. */
  function water(patientId, requested, key) {
    return db
      .transaction(() => {
        ensure(patientId);
        const idem = `water:${key}`;
        if (q.has.get(patientId, idem)) return { replay: true, steps: 0, drops: 0 };
        const { balance, steps } = totals(patientId);
        if (steps >= MAX_STEPS) return { error: 'full' };
        const cap = Math.min(Math.floor(balance / STEP_PRICE), MAX_STEPS - steps, WATER_MAX_STEPS);
        const n = requested ? Math.min(requested, cap) : cap;
        if (n < 1) return { error: 'no_drops' };
        q.insert.run(patientId, 'spend', 'water', -n * STEP_PRICE, n, idem, '', clock.today(), clock.now());
        return { steps: n, drops: n * STEP_PRICE };
      })
      .immediate();
  }

  function exportData(patientId) {
    return {
      state: db.prepare('SELECT started_at FROM flower_state WHERE patient_id=?').get(patientId) || null,
      ledger: db
        .prepare('SELECT kind,action,amount,steps,day,created_at FROM flower_ledger WHERE patient_id=? ORDER BY id')
        .all(patientId),
    };
  }

  return { ensure, sync, award, state, water, exportData, balance: (patientId) => totals(patientId).balance };
}

module.exports = { create, stageFor };
