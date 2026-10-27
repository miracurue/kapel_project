'use strict';

// Stable identities for the explicitly fictional customer demonstration.
const PEOPLE = {
  patient: { email: 'journey.patient@demo.example.test', name: 'Александра Миронова' },
  psychologist: { email: 'journey.psychologist@demo.example.test', name: 'Елена Соколова' },
  psychiatrist: { email: 'journey.psychiatrist@demo.example.test', name: 'Михаил Воронцов' },
};
// Вход «администратором» в демо — под демо-админом из seed-demo.js (у него отметка «проверяет справочник»).
// Отдельно от PEOPLE: тех создаёт seed-demo-journey.js, а этого — основной демо-сид.
const DEMO_LOGIN = { ...PEOPLE, admin: { email: 'demo.admin@example.test' } };

function selectDemoUser(db, role) {
  const person = DEMO_LOGIN[role];
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
