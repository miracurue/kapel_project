'use strict';

// Cohorts use identifier-free views and a separate read-only connection.
const { readOnly } = require('./cohort');
const { METRICS } = require('./metrics');
const ROLES = ['patient', 'psychiatrist', 'psychologist'];
const dimension = (value) => {
  try {
    return JSON.parse(value);
  } catch (_) {
    return value || null;
  }
};
const round = (n) => Math.round(n * 1000) / 1000;

function summarize(events, members, minGroup = 0) {
  const groups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.metric, event.dimension, event.unit]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.values()].map((rows) => {
    const first = rows[0];
    const contributors = new Set(rows.map((r) => r.subject_code || 'individual')).size;
    const hidden = members < minGroup || contributors < minGroup;
    const numeric = rows.filter((r) => r.value !== null).map((r) => r.value);
    const sum = numeric.reduce((a, b) => a + b, 0);
    const comparable = first.metric !== 'test_score' || dimension(first.dimension)?.version != null;
    return {
      metric: first.metric,
      dimension: first.dimension ? dimension(first.dimension) : null,
      unit: first.unit,
      definition: METRICS[first.metric] || null,
      formula_version: 'event_summary_v1',
      aggregation: comparable
        ? 'event_count_and_numeric_mean_within_identical_dimension_and_unit'
        : 'event_count_only_unknown_test_version',
      n_people: hidden ? null : contributors,
      n_events: hidden ? null : rows.length,
      numerator: hidden || !numeric.length || !comparable ? null : round(sum),
      denominator: hidden ? null : numeric.length,
      mean: hidden || !numeric.length || !comparable ? null : round(sum / numeric.length),
      missing_numeric: hidden ? null : rows.length - numeric.length,
      missing_people: hidden ? null : members - contributors,
      missing_policy: 'absent_events_are_unknown_not_zero;missing_numeric_is_not_a_score',
      suppressed: hidden,
    };
  });
}

function patientReport(db, patientId, period, audience = 'clinician', asOf = new Date().toISOString()) {
  const role = typeof audience === 'object' ? audience.role : audience;
  const isPatient = role === 'patient';
  const allowedAdverse = isPatient
    ? null
    : new Set(
        db
          .prepare(
            'SELECT id FROM adverse_events WHERE patient_id=? AND psychiatrist_id=? AND (visible_from IS NULL OR visible_from<=?)',
          )
          .all(patientId, typeof audience === 'object' ? audience.id || null : null, asOf)
          .map((r) => String(r.id)),
      );
  // Authorisation is enforced by access middleware before this function. Patient reads own source facts;
  // specialist reads only facts allowed by current visibility and base consent.
  const sql = isPatient
    ? 'SELECT * FROM analytics_source_events WHERE patient_id=? AND day BETWEEN ? AND ? ORDER BY day,source,source_id'
    : 'SELECT * FROM analytics_shared_events WHERE patient_id=? AND day BETWEEN ? AND ? ORDER BY day,source,source_id';
  const events = db
    .prepare(sql)
    .all(patientId, period.from, period.to)
    .filter((e) => role !== 'psychologist' || !['medication_status', 'adverse_event'].includes(e.metric))
    .filter((e) => isPatient || e.metric !== 'adverse_event' || allowedAdverse.has(e.source_id))
    .map((e) => {
      // Patient-facing test results expose completion only, in line with the existing test flow.
      if (isPatient && e.metric === 'test_score')
        return { ...e, metric: 'test_completed', value: 1, unit: 'completion' };
      return e;
    });
  return {
    scope: 'individual',
    period,
    formula_version: 'event_summary_v1',
    rows: summarize(events, 1),
    events: events.map(({ patient_id: _patientId, clinician_visible: _visible, ...event }) => event),
    coverage: 'recorded_sources_only;no_inference_of_adherence_or_clinical_outcome',
  };
}

function cohortReport(db, { scope, clinicianId, from, to, minGroup, actorRole }) {
  if (!['current', 'historical', 'program'].includes(scope)) throw new Error('invalid analytics scope');
  const ro = readOnly(db);
  const members = ro
    .prepare(
      `SELECT COUNT(DISTINCT subject_code) AS n FROM analytics_reporting_members
    WHERE scope=? AND (clinician_id=? OR (?='program' AND clinician_id IS NULL))
    AND (started_day IS NULL OR started_day<=?) AND (ended_day IS NULL OR ended_day>=?)`,
    )
    .get(scope, clinicianId || null, scope, to, from).n;
  const events = ro
    .prepare(
      `SELECT subject_code,day,source,source_id,metric,dimension,value,unit,recorded_at
    FROM analytics_reporting_events WHERE scope=? AND (clinician_id=? OR (?='program' AND clinician_id IS NULL))
    AND day BETWEEN ? AND ?`,
    )
    .all(scope, clinicianId || null, scope, from, to)
    .filter(
      (e) =>
        scope === 'program' ||
        actorRole !== 'psychologist' ||
        !['medication_status', 'adverse_event'].includes(e.metric),
    );
  return {
    scope,
    period: { from, to },
    min_group: minGroup,
    n_people: members < minGroup ? null : members,
    members_suppressed: members < minGroup,
    rows: summarize(events, members, minGroup),
    formula_version: 'event_summary_v1',
    cohort_policy:
      scope === 'historical'
        ? 'assignment_and_episode_at_event_day;current_base_consent'
        : scope === 'program'
          ? 'current_base_and_program_consent;not_all_users'
          : 'current_assignment_and_base_consent',
    habits_policy: 'excluded_without_common_metric_definition_and_aggregate_permission',
    day_policy: 'inclusive_UTC_source_days;assignment_boundaries_day_precision',
  };
}

function productReport(db, { from, to, minGroup }) {
  const ro = readOnly(db);
  const current = ro.prepare('SELECT role,people FROM analytics_product_users').all();
  const events = ro
    .prepare(
      `SELECT subject_code,role,event,session_code,recorded_at FROM analytics_product_events
    WHERE substr(recorded_at,1,10) BETWEEN ? AND ?`,
    )
    .all(from, to);
  const historicalStart = ro
    .prepare("SELECT value FROM analytics_product_metadata WHERE key='history_started_at'")
    .get().value;
  const rows = ROLES.map((role) => {
    const selected = events.filter((e) => e.role === role && e.event !== 'role_snapshot');
    const activity = selected.filter((e) => !['registered'].includes(e.event));
    const unique = new Set(activity.map((e) => e.subject_code)).size;
    const people = current.find((r) => r.role === role)?.people || 0;
    const hiddenActivity = unique < minGroup;
    return {
      role,
      current_people: people < minGroup ? null : people,
      current_suppressed: people < minGroup,
      active_people: hiddenActivity ? null : unique,
      n_events: hiddenActivity ? null : activity.length,
      n_sessions: hiddenActivity
        ? null
        : new Set(activity.filter((e) => e.event === 'session_started').map((e) => e.session_code)).size,
      activity_suppressed: hiddenActivity,
    };
  });
  // A person may change role within the period; total must deduplicate across role snapshots.
  const active = events.filter((e) => ROLES.includes(e.role) && !['role_snapshot', 'registered'].includes(e.event));
  const total = new Set(active.map((e) => e.subject_code)).size;
  // Complementary suppression: never reveal a total that reconstructs one hidden role.
  const safeTotal = total >= minGroup && rows.every((r) => !r.activity_suppressed);
  return {
    scope: 'product_users',
    period: { from, to },
    min_group: minGroup,
    history_started_at: historicalStart,
    history_policy: 'no_activity_or_role_backfill;role_at_event;initial_role_snapshot_is_not_activity',
    current_policy: 'all_non_tombstone_accounts_including_demo_blocked_deactivated;current_not_period_count',
    active_people: safeTotal ? total : null,
    total_suppressed: !safeTotal,
    rows,
    formula_version: 'product_people_v1',
  };
}

function recordProductEvent(db, session, event) {
  const userId = session?.user?.id || session?.user_id || session?.data?.userId;
  if (!userId || !/^[a-z][a-z0-9_.-]{0,79}$/i.test(event)) return;
  db.prepare(
    `INSERT INTO analytics_product_activity(user_id,role,event,session_code)
    SELECT id,role,?,? FROM users WHERE id=? AND status<>'tombstone'`,
  ).run(event, session?.sid_hash || null, userId);
}

module.exports = { summarize, patientReport, cohortReport, productReport, recordProductEvent };
