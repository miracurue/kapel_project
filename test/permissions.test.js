'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const P = require('../src/permissions');

let ok = 0;
const t = (name, fn) => { fn(); ok++; console.log('OK  ', name); };

const CLIN = ['test.assign', 'test.assign.any_catalog', 'offline_result.enter', 'patient.view_card',
  'patient.notes.write', 'crisis.view_queue', 'crisis.acknowledge', 'conclusion.view',
  'ai_workspace.use', 'export.research'];
const PSYCHOLOGIST_ONLY = ['conclusion.write', 'conclusion.sign_psychologist', 'conclusion.release']; // W2.E: психиатр читает, не подписывает
const ONLY_PSY = ['medication.prescribe_plan', 'diagnosis.record'];
const ADMIN = ['admin.users', 'admin.deletion_requests', 'admin.audit_view'];

t('psychiatrist has all clinical permissions', () => {
  for (const p of [...CLIN, ...ONLY_PSY]) assert.ok(P.can('psychiatrist', p), p);
  for (const p of P.CLINICAL_PERMISSIONS.filter((x) => !PSYCHOLOGIST_ONLY.includes(x))) assert.ok(P.can('psychiatrist', p), p);
});
t('W2.E: conclusion write/sign/release only for psychologist; psychiatrist reads', () => {
  for (const p of PSYCHOLOGIST_ONLY) {
    assert.ok(P.can('psychologist', p), p);
    for (const r of ['psychiatrist', 'patient', 'admin']) assert.ok(!P.can(r, p), r + ' ' + p);
  }
  assert.ok(P.can('psychiatrist', 'conclusion.view') && P.can('psychologist', 'conclusion.view'));
  assert.ok(!P.can('patient', 'conclusion.view') && !P.can('admin', 'conclusion.view'));
});
t('psychologist has shared clinical but not prescribe/diagnosis', () => {
  for (const p of [...CLIN, ...PSYCHOLOGIST_ONLY]) assert.ok(P.can('psychologist', p), p);
  for (const p of ONLY_PSY) assert.ok(!P.can('psychologist', p), p);
});
t('psychiatrist is superset of psychologist (except psychologist-only conclusion rights)', () => {
  for (const p of P.ROLE_PERMISSIONS.psychologist) if (!PSYCHOLOGIST_ONLY.includes(p)) assert.ok(P.can('psychiatrist', p), p);
});
t('patient has no clinical or admin permissions', () => {
  for (const p of [...CLIN, ...ONLY_PSY, ...ADMIN]) assert.ok(!P.can('patient', p), p);
  assert.ok(P.can('patient', 'test.take') && P.can('patient', 'messages.send'));
});
t('admin has service permissions only, no clinical (incl. patient.view_card)', () => {
  for (const p of ADMIN) assert.ok(P.can('admin', p), p);
  for (const p of P.CLINICAL_PERMISSIONS) assert.ok(!P.can('admin', p), p);
  assert.ok(!P.can('admin', 'patient.view_card'));
});
t('clinicians have no admin permissions', () => {
  for (const r of ['psychiatrist', 'psychologist']) for (const p of ADMIN) assert.ok(!P.can(r, p), r + p);
});
t('anonymous calculator available to everyone', () => {
  for (const r of P.ROLES) assert.ok(P.can(r, 'tools.anonymous_calculator'));
});
t('unknown role / permission denied', () => {
  assert.ok(!P.can('hacker', 'test.take'));
  assert.ok(!P.can('constructor', 'test.take'));
  assert.ok(!P.can(undefined, 'test.take'));
  assert.ok(!P.can('psychiatrist', 'nonexistent.perm'));
});
t('isClinician', () => {
  assert.ok(P.isClinician('psychiatrist') && P.isClinician('psychologist'));
  assert.ok(!P.isClinician('patient') && !P.isClinician('admin'));
});

function run(mw, session) {
  const out = {};
  const res = {
    status(c) { out.status = c; return this; },
    render(v, d) { out.view = v; out.data = d; },
    redirect(u) { out.redirect = u; },
  };
  let nexted = false;
  mw({ session }, res, () => { nexted = true; });
  return { out, nexted };
}
t('requirePermission middleware allows / denies like requireRole', () => {
  const mw = P.requirePermission('medication.prescribe_plan');
  assert.ok(run(mw, { user: { role: 'psychiatrist' } }).nexted);
  const d = run(mw, { user: { role: 'psychologist' } });
  assert.ok(!d.nexted && d.out.status === 403 && d.out.view === 'error');
  const a = run(mw, {});
  assert.ok(!a.nexted && a.out.status === 403);
  assert.ok(run(P.requirePermission('a.x', 'test.take'), { user: { role: 'patient' } }).nexted);
});

const db = new Database(':memory:');
db.exec('CREATE TABLE care_assignments (patient_id INTEGER, clinician_id INTEGER)');
db.prepare('INSERT INTO care_assignments VALUES (10, 1)').run();
t('canAccessPatient scope', () => {
  assert.ok(P.canAccessPatient({ id: 1, role: 'psychiatrist' }, 10, db));
  assert.ok(P.canAccessPatient({ id: 1, role: 'psychologist' }, '10', db));
  assert.ok(!P.canAccessPatient({ id: 2, role: 'psychiatrist' }, 10, db));
  assert.ok(!P.canAccessPatient({ id: 1, role: 'psychiatrist' }, 11, db));
  assert.ok(P.canAccessPatient({ id: 10, role: 'patient' }, 10, db));
  assert.ok(!P.canAccessPatient({ id: 11, role: 'patient' }, 10, db));
  assert.ok(!P.canAccessPatient({ id: 1, role: 'admin' }, 10, db));
  assert.ok(!P.canAccessPatient(null, 10, db));
  assert.ok(!P.canAccessPatient({ id: 1, role: 'psychiatrist' }, 'abc', db));
});

console.log(`permissions: ${ok} OK, 0 FAIL`);
