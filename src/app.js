'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const { locals } = require('./middleware');
const navigation = require('./navigation');
const format = require('./format');

const headers = require('./security/headers');
const csrf = require('./security/csrf');
const sessionPolicy = require('./security/session_policy');

const app = express();
const PORT = process.env.PORT || 3300;

// За обратным прокси (HTTPS-терминация): TRUST_PROXY=1 (число прыжков) или true; нужно для Secure-cookie и IP в лимитерах
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(headers.middleware); // W2.S: CSP, nosniff, Referrer-Policy, frame-ancestors, Permissions-Policy
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session(sessionPolicy.sessionOptions()));
app.use(sessionPolicy.idleMiddleware); // W2.S: таймаут бездействия
app.use(csrf.middleware); // W2.S: токен сессии и автоматическое поле _csrf во всех POST-формах
app.get('/csrf-token', csrf.tokenRoute);

// Динамические страницы не кэшируются: после выхода «Назад» не показывает данные (REQ-ALL-010).
// Статика отдаётся выше (express.static) со своими заголовками.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // страница ошибки узнаёт HTTP-статус (заголовок 403/404/500) без правок каждого роута
  const render = res.render.bind(res);
  res.render = (view, options, cb) => (view === 'error' ? render(view, { status: res.statusCode, ...options }, cb) : render(view, options, cb));
  next();
});

// W1.D: деактивация/сброс пароля завершают сессии; временный пароль требует смены; счётчики меню админа
app.use(require('./admin_session').middleware);
app.use(locals);
app.use(navigation.middleware);
app.use(format.middleware);
app.use(require('./patient_prefs').middleware);
app.use(require('./care').middleware); // W2.F: счётчики сообщений в меню
// W1.B1: проверка просрочки SLA на любом запросе клинициста/админа, счётчик очереди, оповещение-заглушка
app.use(require('./crisis_queue').middleware);
app.use(csrf.guard); // W2.S: любой POST/PUT/PATCH/DELETE без верного токена -> 403 (после middleware layout)

app.use(require('./routes/auth'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/patient'));
app.use(require('./routes/care'));
app.use(require('./routes/clinician'));
app.use(require('./routes/conclusions')); // W2.E: заключения психолога
app.use(require('./routes/account'));
app.use(require('./routes/admin'));
app.use(require('./routes/ai'));
app.use(require('./routes/ai_workspace'));

// 404 и необработанные ошибки — внутри общего layout, без стека и путей (REQ-ALL-005)
app.use((req, res) => {
  res.status(404).render('error', { status: 404, message: 'Такой страницы нет. Возможно, ссылка устарела или адрес набран с ошибкой.' });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).render('error', { status: 500, message: 'Не удалось выполнить действие. Попробуйте ещё раз или вернитесь на главную.' });
});

if (require.main === module) {
  require('./crisis_queue').startTimer(); // проверка SLA раз в минуту (REQ-CRI-003)
  require('./ai/workspace/store').startPurgeTimer(); // автоудаление просроченных материалов/диалогов ИИ-пространства (REQ-AID-012)
  setInterval(() => require('./assignments').runSchedules(), 60 * 60 * 1000).unref(); // повторные назначения по расписанию (REQ-CLN-020)
  app.listen(PORT, () => {
    console.log(`TDR MVP listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
