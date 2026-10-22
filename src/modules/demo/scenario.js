'use strict';

// Stable identities for the explicitly fictional customer demonstration.
const PEOPLE = {
  patient: { email: 'journey.patient@demo.example.test', name: 'Александра Миронова' },
  psychologist: { email: 'journey.psychologist@demo.example.test', name: 'Елена Соколова' },
  psychiatrist: { email: 'journey.psychiatrist@demo.example.test', name: 'Михаил Воронцов' },
};

function selectDemoUser(db, role) {
  const person = PEOPLE[role];
  if (person) {
    const user = db
      .prepare("SELECT * FROM users WHERE email=? AND role=? AND status='active' AND is_demo=1")
      .get(person.email, role);
    if (user) return user;
  }
  return db
    .prepare(
      "SELECT * FROM users WHERE role=? AND status='active' ORDER BY (email LIKE '%cc.example.test') DESC,id LIMIT 1",
    )
    .get(role);
}

module.exports = { PEOPLE, selectDemoUser };
