'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const { flash, requireLogin } = require('../middleware');
const core = require('../admin_core');
const limits = require('../security/rate_limit');
const secAudit = require('../security/audit');

const router = express.Router();

// Финальный текст согласия — ComplianceCounsel, RES-3, документ
// «informed-consent» (ревизия 1). Три самостоятельные части: пациент может
// согласиться с 1 и 2 (обязательны для использования сервиса) и отдельно
// отказаться от 3 (научный экспорт, опционально) — см. RES-6.
const CONSENT_VERSION = 'RES-3-informed-consent-rev1';

const CONSENT_PARTS = {
  personalData: {
    required: true,
    short:
      'Мы собираем ваше имя, контакт, результаты тестов, записи дневника настроения и переписку с ботом, ' +
      'чтобы психиатр и психолог могли следить за вашим состоянием. Данные о здоровье — особая категория ' +
      'сведений, поэтому закон (152-ФЗ) требует отдельного явного согласия именно на их обработку.',
    full:
      'Мы — сервис [название сервиса], помогающий врачу-психиатру и клиническому психологу наблюдать за ' +
      'вашим состоянием при тревожно-депрессивном расстройстве. Что мы собираем: ваше имя (или псевдоним), ' +
      'возраст, контакт для связи, результаты тестов-опросников (например, PHQ-9, GAD-7), записи дневника ' +
      'настроения, результаты патопсихологических методик, которые вводит психолог, переписку со встроенным ' +
      'чат-ботом поддержки. Кто увидит ваши данные: вы сами, психиатр и клинический психолог, которые ведут ' +
      'вас в сервисе. Мы не продаём и не передаём ваши данные рекламным или третьим сервисам. Срок хранения: ' +
      'данные хранятся, пока вы пользуетесь сервисом, и дополнительный срок после удаления аккаунта для ' +
      'технических нужд, затем удаляются. Ваши права в любой момент: посмотреть, какие данные о вас ' +
      'сохранены; попросить исправить неточность; отозвать это согласие — тогда мы прекратим обрабатывать ' +
      'ваши данные и удалим их, за исключением случаев, когда закон обязывает нас их сохранить; попросить ' +
      'удалить аккаунт и данные полностью. Чтобы воспользоваться любым из этих прав — раздел «Настройки → ' +
      'Мои данные» или обращение к своему врачу в сервисе.',
    checkboxLabel: 'Я прочитал(а) и согласен(на) с обработкой моих персональных данных, включая данные о здоровье, на условиях выше.',
  },
  clinicalUse: {
    required: true,
    short:
      'Встроенный ИИ-помощник не ставит диагноз и не назначает лечение — он может показать гипотезу со ' +
      'ссылкой на шкалу, это подсказка врачу, а не медицинское заключение. Диагноз ставит только психиатр, ' +
      'психологическое заключение готовит только клинический психолог. Решение всегда принимает врач.',
    full:
      'Отдельно от согласия на хранение данных, закон (323-ФЗ) требует вашего согласия именно на то, что ' +
      'результаты тестов и записи будут использоваться врачом и психологом для принятия решений о вашем ' +
      'наблюдении и помощи. Важно понимать: встроенный ИИ-помощник не ставит диагноз и не назначает лечение. ' +
      'Он может показать гипотезу («по результатам теста есть признаки, похожие на...») со ссылкой на шкалу ' +
      'или источник — это подсказка врачу, а не медицинское заключение. Диагноз ставит только психиатр. ' +
      'Психологическое заключение готовит только клинический психолог. Окончательное решение о вашем лечении ' +
      'и наблюдении принимает врач, а не программа. Вы можете в любой момент отказаться от конкретного теста ' +
      'или методики — это не повлияет на вашу возможность получать помощь от врача. Если тест покажет признаки ' +
      'риска для вашей жизни (мысли о самоповреждении), сервис передаст сигнал живому специалисту.',
    checkboxLabel: 'Я понимаю, как используются результаты тестов, и согласен(на), что они передаются моему психиатру/психологу для наблюдения.',
  },
  researchExport: {
    required: false,
    short:
      'Мы сравниваем результаты теста, пройденного онлайн, и того же теста очно у врача — это помогает ' +
      'понять, насколько можно доверять онлайн-тестированию. В выборку попадают только баллы под случайным ' +
      'псевдонимом, без имени, дневника и переписки. Это необязательно и не влияет на то, как вас ведёт врач.',
    full:
      'Если вы согласитесь: ваши результаты (только числовые баллы по шкалам, без имени, без текста дневника ' +
      'и переписки) попадут в научную выборку под случайным псевдонимом; исследовательский CSV не будет ' +
      'содержать ваше имя, email, дневник или переписку, а служебная таблица связи псевдонима с пациентом ' +
      'хранится отдельно и ограничена сроком жизни. Это никак не повлияет на то, как вас ведёт врач. Если вы откажетесь или отозовёте это ' +
      'согласие позже — вы продолжите пользоваться сервисом как обычно, в научную выборку ваши данные просто ' +
      'не попадут.',
    checkboxLabel: 'Я согласен(на), что мои псевдонимизированные результаты тестов могут использоваться в научном сравнении офлайн- и онлайн-тестирования.',
  },
};

// Дисклеймер кризисного протокола для онбординга (ClinicalLead, RES-2
// «crisis-protocol-clinical-draft», раздел 5) — показывается до начала
// использования сервиса, не в момент кризиса.
const CRISIS_ONBOARDING_DISCLAIMER =
  'Этот сервис — помощник вашего врача, а не служба экстренной помощи и не замена вызову скорой помощи. ' +
  'Если жизни угрожает прямая опасность, звоните 112 сразу, не дожидаясь ответа бота или специалиста.';

router.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect('/dashboard');
});

function renderRegister(res, status, form, errors) {
  res.status(status).render('register', {
    consentParts: CONSENT_PARTS,
    crisisOnboardingDisclaimer: CRISIS_ONBOARDING_DISCLAIMER,
    consentVersion: CONSENT_VERSION,
    form,
    errors,
  });
}

// REQ-ALL-014: список врачей анонимам не показываем; регистрация создаёт только пациентов.
router.get('/register', (req, res) => {
  renderRegister(res, 200, {}, []);
});

// Полный текст согласий (версия CONSENT_VERSION), текст не менялся.
router.get('/consent', (req, res) => {
  res.render('consent', { consentParts: CONSENT_PARTS, consentVersion: CONSENT_VERSION });
});

router.post('/register', (req, res) => {
  const regHit = limits.register.hit(req.ip);
  if (!regHit.allowed) {
    res.set('Retry-After', String(Math.ceil(regHit.retryAfterMs / 1000)));
    return res.status(429).render('error', { status: 429, message: `Слишком много попыток регистрации с этого адреса. Повторите через ${limits.waitText(regHit.retryAfterMs)}` });
  }
  const { email, password, full_name, role, invite_code, consent_given, clinical_consent_given, anonymized_export_opt_in } = req.body;
  if (role && role !== 'patient') {
    return res.status(403).render('error', {
      message: 'Публичная регистрация доступна только пациентам. Учётные записи специалистов создаёт администратор.',
    });
  }
  const form = {
    full_name: full_name || '',
    email: email || '',
    invite_code: invite_code || '',
    consent_given: !!consent_given,
    clinical_consent_given: !!clinical_consent_given,
    anonymized_export_opt_in: !!anonymized_export_opt_in,
  };
  const errors = [];
  if (!full_name || !String(full_name).trim()) errors.push({ field: 'full_name', text: 'Укажите, как к вам обращаться (имя или псевдоним).' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({ field: 'email', text: 'Проверьте e-mail: он должен выглядеть как name@example.com.' });
  if (!password || password.length < 8) errors.push({ field: 'password', text: 'Пароль должен быть не короче 8 символов.' });
  else if (email && password.toLowerCase() === String(email).toLowerCase()) errors.push({ field: 'password', text: 'Пароль не должен совпадать с e-mail.' });
  if (!consent_given) errors.push({ field: 'consent_given', text: 'Нужно ваше согласие на обработку персональных данных (часть 1) — без него сервис не может работать.' });
  if (!clinical_consent_given) errors.push({ field: 'clinical_consent_given', text: 'Нужно ваше согласие на использование результатов врачом (часть 2) — без него сервис не может работать.' });

  if (email && !errors.some((e) => e.field === 'email') && db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(String(email))) {
    errors.push({ field: 'email', text: 'Пользователь с таким e-mail уже есть. Попробуйте войти.' });
  }
  let invite = null;
  if (invite_code && String(invite_code).trim()) {
    const codeLock = limits.inviteCode.check(req.ip);
    if (codeLock.blocked) {
      res.set('Retry-After', String(Math.ceil(codeLock.retryAfterMs / 1000)));
      errors.push({ field: 'invite_code', text: `Слишком много неверных кодов. Повторите через ${limits.waitText(codeLock.retryAfterMs)} или оставьте поле пустым и введите код позже.` });
      return renderRegister(res, 429, form, errors);
    }
    invite = db.prepare('SELECT * FROM invite_codes WHERE UPPER(code) = ?').get(String(invite_code).trim().toUpperCase().replace(/\s+/g, ''));
    const exp = invite ? Date.parse(String(invite.expires_at).replace(' ', 'T') + (/[Z+]/.test(invite.expires_at) ? '' : 'Z')) : 0;
    if (!invite || invite.used_at || invite.revoked_at || exp < Date.now()) {
      errors.push({ field: 'invite_code', text: 'Код не подошёл (неверный, использован или истёк). Его можно оставить пустым и ввести позже.' });
      invite = null;
      const f = limits.inviteCode.fail(req.ip);
      if (f.justLocked) secAudit.lockout('invite_code', { key: req.ip, retryAfterMs: f.retryAfterMs });
    }
  }
  if (errors.length) return renderRegister(res, 400, form, errors);

  const passwordHash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, role, full_name, consent_given, consent_version, consent_at, clinical_consent_given, clinical_consent_at, anonymized_export_opt_in)
       VALUES (?, ?, 'patient', ?, 1, ?, ?, 1, ?, ?)`
    )
    .run(email, passwordHash, String(full_name).trim(), CONSENT_VERSION, now, now, anonymized_export_opt_in ? 1 : 0);

  db.prepare('INSERT INTO user_prefs (user_id, onboarding_pending) VALUES (?, 1)').run(info.lastInsertRowid);
  if (invite) {
    db.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL').run(info.lastInsertRowid, now, invite.id);
    db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(info.lastInsertRowid, invite.clinician_id);
  }

  flash(req, 'Регистрация выполнена. Теперь войдите в систему.', 'success');
  res.redirect('/login');
});

// Безопасный возврат после входа: только относительный путь (REQ-SEC-016, ALL-009).
function safeNext(target) {
  if (typeof target !== 'string' || !/^\/(?!\/)[^\\:\s]*$/.test(target)) return null;
  return target;
}

// хэш для выравнивания времени ответа при неизвестном e-mail
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

router.get('/login', (req, res) => {
  res.render('login', { next: safeNext(req.query.next) || '' });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const emailKey = String(email || '').trim().toLowerCase().slice(0, 254);
  const key = `${req.ip}|${emailKey}`;
  const tooMany = (retryAfterMs) => {
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    res.locals.flash = { message: `Слишком много неудачных попыток входа. Подождите ${limits.waitText(retryAfterMs)} и попробуйте снова.`, kind: 'error' };
    return res.status(429).render('login', { next: safeNext(req.body.next) || '' });
  };
  // блокировка действует и при верном пароле: иначе перебор не замедляется
  const lk = limits.login.check(key);
  if (lk.blocked) return tooMany(lk.retryAfterMs);
  const lkIp = limits.loginIp.check(req.ip);
  if (lkIp.blocked) return tooMany(lkIp.retryAfterMs);

  const user = typeof email === 'string' ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : undefined; // email[]=… / вложенные объекты не должны давать 500
  // bcrypt выполняется и для несуществующего e-mail: время ответа не выдаёт, есть ли такая учётная запись
  const okPassword = bcrypt.compareSync(String(password || ''), user ? user.password_hash : DUMMY_HASH) && !!user;
  if (!okPassword) {
    const f1 = limits.login.fail(key);
    const f2 = limits.loginIp.fail(req.ip);
    if (f1.justLocked) secAudit.lockout('login', { targetUserId: user ? user.id : null, key, retryAfterMs: f1.retryAfterMs });
    else if (f2.justLocked) secAudit.lockout('login_ip', { key: req.ip, retryAfterMs: f2.retryAfterMs });
    if (f1.locked) return tooMany(f1.retryAfterMs);
    if (f2.locked) return tooMany(f2.retryAfterMs);
    flash(req, 'Неверный email или пароль.', 'error');
    return res.redirect('/login');
  }
  limits.login.success(key);
  if (user.account_status !== 'active') {
    flash(req, 'Этот аккаунт деактивирован по запросу об удалении данных (152-ФЗ, ст.14/21).', 'error');
    return res.redirect('/login');
  }
  if (user.deactivated_at) {
    flash(req, 'Учётная запись отключена администратором. Обратитесь в администрацию сервиса.', 'error');
    return res.redirect('/login');
  }
  // at — момент выдачи сессии (W1.D): сброс/смена пароля и деактивация делают более ранние сессии недействительными
  // regenerate: новый id сессии при входе (защита от фиксации сессии); токен CSRF создаётся заново вместе с сессией
  req.session.regenerate((err) => {
    if (err) {
      console.error('session regenerate failed');
      return res.status(500).render('error', { status: 500, message: 'Не удалось войти. Попробуйте ещё раз.' });
    }
    req.session.user = { id: user.id, email: user.email, role: user.role, full_name: user.full_name, since: Date.now(), at: new Date().toISOString() };
    req.session.lastSeen = Date.now();
    if (user.must_change_password) {
      flash(req, 'Вы вошли с временным паролем. Задайте новый пароль, чтобы продолжить.', 'info');
      return res.redirect('/account/password');
    }
    res.redirect(safeNext(req.body.next) || '/dashboard');
  });
});

// ---------- Смена пароля (REQ-SEC-012, REQ-ADM-004) ----------

router.get('/account/password', requireLogin, (req, res) => {
  res.render('account_password', { pageTitle: 'Смена пароля', forced: !!res.locals.mustChangePassword, min: core.PASSWORD_MIN });
});

router.post('/account/password', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const { current_password, new_password, confirm_password } = req.body;
  const fail = (msg) => {
    flash(req, msg, 'error');
    return res.redirect('/account/password');
  };
  const pk = `pw:${req.session.user.id}`;
  const lk = limits.password.check(pk);
  if (lk.blocked) return fail(`Слишком много неверных паролей. Подождите ${limits.waitText(lk.retryAfterMs)} и повторите.`);
  if (!user || !bcrypt.compareSync(current_password || '', user.password_hash)) {
    const f = limits.password.fail(pk);
    if (f.justLocked) secAudit.lockout('password', { actorId: req.session.user.id, targetUserId: req.session.user.id, key: pk, retryAfterMs: f.retryAfterMs });
    return fail('Текущий пароль указан неверно.');
  }
  limits.password.success(pk);
  if (new_password !== confirm_password) return fail('Новый пароль и повтор не совпадают.');
  const pwError = core.validatePassword(new_password, user.email);
  if (pwError) return fail(pwError);
  if (bcrypt.compareSync(new_password, user.password_hash)) return fail('Новый пароль должен отличаться от текущего.');
  const at = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, sessions_valid_from = ? WHERE id = ?').run(
    bcrypt.hashSync(new_password, 10), at, at, user.id
  );
  // остальные сессии завершаются; текущая остаётся
  req.session.user.at = at;
  flash(req, 'Пароль изменён. Остальные ваши сессии завершены.', 'success');
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

module.exports = router;
module.exports.CONSENT_VERSION = CONSENT_VERSION;
module.exports.CONSENT_PARTS = CONSENT_PARTS;
