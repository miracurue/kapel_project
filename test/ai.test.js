'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W1.C1: ИИ-чат пациента и общий ИИ-каркас — кризисный приоритет, треды, провайдер-заглушка,
// ограничения ввода, аудит без текста, миграция старой истории, приватность, «Связаться с человеком».

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ai-'));
process.env.TDR_DB_PATH = path.join(tmp, 'ai.sqlite3');
process.env.SESSION_SECRET = 'test-secret';
process.env.CRISIS_MERGE_WINDOW_MIN = '0'; // W3.K: здесь проверяется «каждая кризисная фраза создаёт эскалацию»; схлопывание повторов — в security_fixes.test.js

// --- запрет исходящих соединений (REQ-AIP-008): разрешён только loopback (тест ходит на свой сервер) ---
const outbound = [];
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...args) {
  const o = args[0];
  const host = o && typeof o === 'object' ? o.host : undefined;
  if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    outbound.push(host);
    throw new Error(`outbound connection blocked: ${host}`);
  }
  return origConnect.apply(this, args);
};

const bcrypt = require('bcryptjs');
require('../scripts/gc-guard');
const db = require('../src/db');
const app = require('../src/app');
const provider = require('../src/ai/provider');
const outputFilter = require('../src/ai/outputFilter');
const chatService = require('../src/ai/chatService');
const threads = require('../src/ai/threads');
const texts = require('../src/ai/texts');

const PORT = 20000 + Math.floor(Math.random() * 20000); // случайный порт: тесты могут идти параллельно в разных worktree
const BASE = `http://127.0.0.1:${PORT}`;
let fails = 0;
let oks = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

function mkUser(email, role, name) {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, role, full_name, consent_given, clinical_consent_given, account_status)
       VALUES (?, ?, ?, ?, 1, 1, 'active')`
    )
    .run(email, bcrypt.hashSync('pw-test-123', 4), role, name);
  return Number(info.lastInsertRowid);
}

function jar() {
  const c = new Map();
  return {
    store(res) { for (const s of res.headers.getSetCookie()) { const [p] = s.split(';'); const i = p.indexOf('='); c.set(p.slice(0, i), p.slice(i + 1)); } },
    header() { return [...c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}

async function req(method, p, { body, j, json = false } = {}) {
  const headers = { Cookie: j.header() };
  let payload;
  if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
  if (json) { headers['X-Requested-With'] = 'fetch'; headers.Accept = 'application/json'; }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  j.store(res);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location'), json: json && text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null };
}

async function login(email) {
  const j = jar();
  const r = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password: 'pw-test-123' }).toString(), redirect: 'manual' });
  j.store(r);
  return j;
}

const escCount = (pid) => db.prepare('SELECT COUNT(*) n FROM crisis_escalations WHERE patient_id = ?').get(pid).n;

async function main() {
  const doc = mkUser('doc@t.test', 'psychiatrist', 'Д');
  const pA = mkUser('a@t.test', 'patient', 'A');
  const pB = mkUser('b@t.test', 'patient', 'B'); // без врача
  const pC = mkUser('c@t.test', 'patient', 'C');
  db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pA, doc);
  db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pC, doc);

  const server = app.listen(PORT);
  try {
    const jA = await login('a@t.test');
    const jB = await login('b@t.test');
    const jC = await login('c@t.test');
    const jD = await login('doc@t.test');

    // ---------- провайдер и пост-фильтр ----------
    check('заглушка отвечает без сети, помечена провайдером local_stub', async () => {
      const out = await provider.generate({ role: 'patient', messages: [{ role: 'user', text: 'Привет' }] });
      assert.ok(out.text.length > 10);
      assert.strictEqual(out.flags.provider, 'local_stub');
      assert.deepStrictEqual(out.sources, []);
    });
    check('заглушка: запрос диагноза и доз -> безопасный отказ с направлением к врачу', async () => {
      for (const q of ['какой у меня диагноз?', 'сколько таблеток принимать антидепрессанта']) {
        const out = await provider.generate({ role: 'patient', messages: [{ role: 'user', text: q }] });
        assert.ok(/врач/.test(out.text), q);
        assert.ok(outputFilter.check(out.text).ok, `ответ заглушки проходит свой фильтр: ${q}`);
      }
    });
    check('все подсказки-старты получают ответ заглушки, проходящий фильтр', async () => {
      for (const c of texts.CHIPS) {
        const out = await provider.generate({ role: 'patient', messages: [{ role: 'user', text: c }] });
        assert.ok(out.text && !out.flags.filtered, c);
      }
    });
    check('пост-фильтр: диагнозы, дозы, препараты, обещания блокируются; нейтральное проходит', () => {
      const bad = ['У вас депрессия, это ясно.', 'Принимайте по 50 мг утром', 'Попробуйте сертралин', 'Гарантирую, что всё пройдёт', 'Вам поставлен диагноз: тревожное расстройство', 'Возьмите мелатонин на ночь'];
      for (const s of bad) assert.strictEqual(outputFilter.check(s).ok, false, s);
      const good = ['Спасибо, что поделились. Расскажите врачу об этом.', 'Попробуйте медленное дыхание, несколько минут.'];
      for (const s of good) assert.strictEqual(outputFilter.check(s).ok, true, s);
    });
    check('фильтр применяется к ответу любого провайдера', async () => {
      provider.setProvider({ name: 'evil', async generate() { return { text: 'У вас депрессия. Принимайте 20 мг.', sources: [], flags: {} }; } });
      try {
        const out = await provider.generate({ role: 'patient', messages: [{ role: 'user', text: 'привет' }] });
        assert.strictEqual(out.text, texts.FILTERED_REPLY);
        assert.strictEqual(out.flags.filtered, true);
      } finally { provider.setProvider(null); }
    });
    check('роль clinician: заглушка не выдумывает ответ', async () => {
      const out = await provider.generate({ role: 'clinician', messages: [{ role: 'user', text: 'сводка' }] });
      assert.ok(/заглушк/i.test(out.text));
    });

    // ---------- кризисный приоритет ----------
    check('кризис (пациент с врачом): провайдер НЕ вызывается, эскалация создана, ответ честный', async () => {
      let calls = 0;
      provider.setProvider({ name: 'spy', async generate() { calls++; return { text: 'ok', sources: [], flags: {} }; } });
      try {
        const before = escCount(pA);
        const r = await req('POST', '/chat/send', { j: jA, body: { text: 'Я не хочу жить' }, json: true });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.crisis, true);
        assert.strictEqual(r.json.assistant.kind, 'crisis');
        assert.strictEqual(calls, 0, 'провайдер не должен вызываться');
        assert.strictEqual(escCount(pA), before + 1);
        const esc = db.prepare('SELECT * FROM crisis_escalations WHERE patient_id = ? ORDER BY id DESC LIMIT 1').get(pA);
        assert.strictEqual(esc.instrument, 'chatbot');
        assert.ok(esc.tier >= 2);
        assert.ok(db.prepare("SELECT 1 FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'specialist_notified'").get(esc.id));
        assert.ok(/передано вашему врачу и отобразится в его кабинете/.test(r.json.assistant.text));
        assert.ok(/112/.test(r.json.assistant.text));
        assert.ok(!/уведомл|свяжутся/i.test(r.json.assistant.text), 'нет обещания реального оповещения');
        // обычное сообщение — ровно один вызов
        await req('POST', '/chat/send', { j: jA, body: { text: 'Привет', thread_id: String(r.json.thread.id) }, json: true });
        assert.strictEqual(calls, 1);
      } finally { provider.setProvider(null); }
    });
    check('кризис без врача: эскалация создаётся (раньше пропускалась), ответ упоминает администратора', async () => {
      let calls = 0;
      provider.setProvider({ name: 'spy', async generate() { calls++; return { text: 'ok', sources: [], flags: {} }; } });
      try {
        const before = escCount(pB);
        const r = await req('POST', '/chat/send', { j: jB, body: { text: 'иногда думаю покончить с собой' }, json: true });
        assert.strictEqual(r.json.crisis, true);
        assert.strictEqual(calls, 0);
        assert.strictEqual(escCount(pB), before + 1);
        assert.ok(/администратор/.test(r.json.assistant.text) && /112/.test(r.json.assistant.text));
        assert.ok(!db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ?').get(pB));
      } finally { provider.setProvider(null); }
    });
    check('NSSI-фраза (триггер F) также идёт мимо провайдера в эскалацию', async () => {
      let calls = 0;
      provider.setProvider({ name: 'spy', async generate() { calls++; return { text: 'ok', sources: [], flags: {} }; } });
      try {
        const before = escCount(pC);
        const r = await req('POST', '/chat/send', { j: jC, body: { text: 'я режу себя иногда' }, json: true });
        assert.strictEqual(r.json.crisis, true);
        assert.strictEqual(calls, 0);
        assert.strictEqual(escCount(pC), before + 1);
      } finally { provider.setProvider(null); }
    });
    check('кризис при падающем провайдере: эскалация всё равно создана', async () => {
      provider.setProvider({ name: 'down', async generate() { throw new Error('boom'); } });
      try {
        const before = escCount(pA);
        const r = await req('POST', '/chat/send', { j: jA, body: { text: 'не хочу жить' }, json: true });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.crisis, true);
        assert.strictEqual(escCount(pA), before + 1);
      } finally { provider.setProvider(null); }
    });
    check('кризисная фраза в слишком длинном тексте не отбрасывается лимитом длины', async () => {
      const before = escCount(pA);
      const r = await req('POST', '/chat/send', { j: jA, body: { text: `${'я устал. '.repeat(300)} не хочу жить` }, json: true });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.crisis, true);
      assert.strictEqual(escCount(pA), before + 1);
    });

    // ---------- сбой провайдера ----------
    check('провайдер упал: сообщение сохранено, «недоступен», UI не 500, «Повторить» работает', async () => {
      provider.setProvider({ name: 'down', async generate() { throw new Error('boom'); } });
      let r;
      try {
        r = await req('POST', '/chat/send', { j: jC, body: { text: 'Расскажи про сон' }, json: true });
      } finally { provider.setProvider(null); }
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.unavailable, true);
      assert.strictEqual(r.json.assistant.kind, 'error');
      const tid = r.json.thread.id;
      assert.ok(db.prepare("SELECT 1 FROM ai_messages WHERE thread_id = ? AND role = 'user' AND text = 'Расскажи про сон'").get(tid));
      const page = await req('GET', `/chat/t/${tid}`, { j: jC });
      assert.strictEqual(page.status, 200);
      assert.ok(/Повторить/.test(page.text) && /временно недоступен/.test(page.text));
      const rr = await req('POST', `/chat/t/${tid}/retry`, { j: jC, json: true });
      assert.strictEqual(rr.status, 200);
      assert.strictEqual(rr.json.unavailable, false);
      assert.notStrictEqual(rr.json.assistant.kind, 'error');
      assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM ai_messages WHERE thread_id = ? AND kind = 'error'").get(tid).n, 0);
    });

    // ---------- треды ----------
    let tidA;
    check('создание треда без JS: редирект на тред, авто-название, ответ на странице, значок ИИ и пометка', async () => {
      const r = await req('POST', '/chat/send', { j: jA, body: { text: 'Не могу уснуть уже несколько дней, что делать' } });
      assert.strictEqual(r.status, 302);
      assert.ok(/^\/chat\/t\/\d+/.test(r.location));
      tidA = Number(r.location.match(/t\/(\d+)/)[1]);
      const page = await req('GET', `/chat/t/${tidA}`, { j: jA });
      assert.ok(page.text.includes('Не могу уснуть уже несколько дней, что д'), 'авто-название по первому сообщению');
      assert.ok(page.text.includes(texts.AI_BADGE));
      assert.ok(/msg-assistant[\s\S]*ai-pill/.test(page.text));
      assert.ok(/result-disclaimer/.test(page.text));
      assert.ok(/Связаться с человеком/.test(page.text));
      assert.ok(/href="tel:112"/.test(page.text));
    });
    check('переименование и удаление с подтверждением', async () => {
      let r = await req('POST', `/chat/t/${tidA}/rename`, { j: jA, body: { title: 'Мой сон' } });
      assert.strictEqual(r.status, 302);
      assert.strictEqual(threads.getThread(pA, tidA).title, 'Мой сон');
      // после ручного переименования авто-название не перезаписывается
      await req('POST', '/chat/send', { j: jA, body: { text: 'ещё вопрос', thread_id: String(tidA) } });
      assert.strictEqual(threads.getThread(pA, tidA).title, 'Мой сон');
      r = await req('GET', `/chat/t/${tidA}/delete`, { j: jA });
      assert.ok(r.status === 200 && /остаются в журнале инцидентов/.test(r.text), 'честное подтверждение с исключением');
      assert.ok(threads.getThread(pA, tidA), 'GET подтверждения ничего не удаляет');
      r = await req('POST', `/chat/t/${tidA}/delete`, { j: jA });
      assert.strictEqual(r.status, 302);
      assert.strictEqual(threads.getThread(pA, tidA), null);
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ai_messages WHERE thread_id = ?').get(tidA).n, 0);
    });
    check('список диалогов отсортирован по последней активности', async () => {
      const a = threads.createThread({ ownerUserId: pC, role: 'patient', title: 'старый' });
      const b = threads.createThread({ ownerUserId: pC, role: 'patient', title: 'новый' });
      db.prepare("UPDATE ai_threads SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(a.id);
      db.prepare("UPDATE ai_threads SET updated_at = '2030-01-01 00:00:00' WHERE id = ?").run(b.id);
      const list = threads.listThreads(pC).map((t) => t.title);
      assert.ok(list.indexOf('новый') < list.indexOf('старый'));
    });
    check('удаление диалога с кризисом: сообщения исчезают, журнал инцидентов и цитата остаются', async () => {
      const r = await req('POST', '/chat/send', { j: jB, body: { text: 'я хочу умереть' }, json: true });
      const tid = r.json.thread.id;
      const esc = db.prepare('SELECT * FROM crisis_escalations WHERE patient_id = ? ORDER BY id DESC LIMIT 1').get(pB);
      const logBefore = db.prepare('SELECT COUNT(*) n FROM crisis_incident_log WHERE escalation_id = ?').get(esc.id).n;
      await req('POST', `/chat/t/${tid}/delete`, { j: jB });
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ai_messages WHERE thread_id = ?').get(tid).n, 0);
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM crisis_incident_log WHERE escalation_id = ?').get(esc.id).n, logBefore);
      assert.ok(logBefore >= 1);
      assert.ok(/хочу умереть/.test(db.prepare('SELECT reasons_json FROM crisis_escalations WHERE id = ?').get(esc.id).reasons_json));
    });

    // ---------- приватность / чужой тред ----------
    check('чужой тред недоступен (просмотр, переименование, удаление, отправка), врач получает отказ', async () => {
      const mine = threads.createThread({ ownerUserId: pC, role: 'patient', title: 'секрет' });
      threads.addMessage(mine.id, { role: 'user', text: 'очень личное' });
      for (const [m, p, b] of [['GET', `/chat/t/${mine.id}`], ['POST', `/chat/t/${mine.id}/rename`, { title: 'x' }], ['POST', `/chat/t/${mine.id}/delete`], ['GET', `/chat/t/${mine.id}/delete`], ['POST', `/chat/t/${mine.id}/retry`]]) {
        const r = await req(m, p, { j: jA, body: b });
        assert.strictEqual(r.status, 404, `${m} ${p}`);
        assert.ok(!/очень личное/.test(r.text));
      }
      const r2 = await req('POST', '/chat/send', { j: jA, body: { text: 'привет', thread_id: String(mine.id) } });
      assert.strictEqual(r2.status, 404);
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM ai_messages WHERE thread_id = ?').get(mine.id).n, 1);
      assert.strictEqual(threads.getThread(pC, mine.id).title, 'секрет');
      for (const p of [`/chat/t/${mine.id}`, '/chat']) {
        const r = await req('GET', p, { j: jD });
        assert.strictEqual(r.status, 403, `врач ${p}`);
        assert.ok(!/очень личное/.test(r.text));
      }
    });

    // ---------- ввод ----------
    check('пустое и слишком длинное сообщение: ничего не сохраняется, текст возвращается в поле', async () => {
      chatService.resetRateLimit();
      const cnt = () => db.prepare("SELECT COUNT(*) n FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id WHERE t.owner_user_id = ?").get(pC).n;
      const before = cnt();
      let r = await req('POST', '/chat/send', { j: jC, body: { text: '   ' } });
      assert.strictEqual(r.status, 400);
      const long = 'а'.repeat(2001);
      r = await req('POST', '/chat/send', { j: jC, body: { text: long } });
      assert.strictEqual(r.status, 422);
      assert.ok(r.text.includes('Сообщение длиннее 2000') && r.text.includes(long), 'текст не потерян');
      assert.strictEqual(cnt(), before);
      r = await req('POST', '/chat/send', { j: jC, body: { text: 'а'.repeat(2000) } });
      assert.strictEqual(r.status, 302);
    });
    check('rate-limit: >20 сообщений в минуту -> вежливый 429', async () => {
      chatService.resetRateLimit();
      const statuses = [];
      for (let i = 0; i < 25; i++) statuses.push((await req('POST', '/chat/send', { j: jC, body: { text: `сообщение ${i}` }, json: true })).status);
      assert.strictEqual(statuses.filter((s) => s === 200).length, 20);
      assert.ok(statuses.filter((s) => s === 429).length >= 5);
      const r = await req('POST', '/chat/send', { j: jC, body: { text: 'ещё' } });
      assert.strictEqual(r.status, 429);
      assert.ok(/Слишком много сообщений/.test(r.text) && /ещё/.test(r.text));
      // кризис не режется лимитом
      const c = await req('POST', '/chat/send', { j: jC, body: { text: 'не хочу жить' }, json: true });
      assert.strictEqual(c.status, 200);
      chatService.resetRateLimit();
    });

    // ---------- аудит без текста ----------
    check('ai_audit: события есть, текста сообщений нет', async () => {
      const marker = 'уникальнаяфразамаркер';
      chatService.resetRateLimit();
      await req('POST', '/chat/send', { j: jA, body: { text: `привет ${marker}` }, json: true });
      const rows = db.prepare('SELECT * FROM ai_audit').all();
      assert.ok(rows.length > 0);
      assert.ok(rows.some((r) => r.crisis === 1));
      assert.ok(!JSON.stringify(rows).includes(marker));
      // W1.C2 добавил patient_id и files (REQ-AID-013): по-прежнему без текста
      assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['created_at', 'crisis', 'event', 'files', 'id', 'patient_id', 'provider', 'role', 'thread_id', 'user_id']);
    });

    // ---------- миграция старой истории ----------
    check('миграция chatbot_sessions/messages -> треды без потери и без дублей', async () => {
      const pM = mkUser('m@t.test', 'patient', 'M');
      const s = Number(db.prepare('INSERT INTO chatbot_sessions (patient_id) VALUES (?)').run(pM).lastInsertRowid);
      db.prepare("INSERT INTO chatbot_messages (session_id, sender, text) VALUES (?, 'user', 'старый вопрос')").run(s);
      db.prepare("INSERT INTO chatbot_messages (session_id, sender, text, intent) VALUES (?, 'bot', 'старый ответ', 'default')").run(s);
      const jM = await login('m@t.test');
      let r = await req('GET', '/chat', { j: jM });
      assert.ok(r.text.includes('старый вопрос'), 'тред в списке по названию первого сообщения');
      await req('GET', '/chat', { j: jM });
      const ths = threads.listThreads(pM);
      assert.strictEqual(ths.length, 1);
      assert.strictEqual(threads.listMessages(ths[0].id).length, 2);
      assert.strictEqual(threads.migrateLegacyChat(), 0, 'идемпотентно');
      r = await req('GET', `/chat/t/${ths[0].id}`, { j: jM });
      assert.ok(r.text.includes('старый ответ'));
      // удаление пациентом не воскрешается повторной миграцией
      await req('POST', `/chat/t/${ths[0].id}/delete`, { j: jM });
      threads.migrateLegacyChat();
      assert.strictEqual(threads.listThreads(pM).length, 0);
    });

    // ---------- памятка ----------
    check('памятка при первом открытии показывается один раз, по «?» — снова', async () => {
      const pI = mkUser('i@t.test', 'patient', 'I');
      const jI = await login('i@t.test');
      let r = await req('GET', '/chat', { j: jI });
      assert.ok(/Коротко о помощнике/.test(r.text));
      r = await req('GET', '/chat', { j: jI });
      assert.ok(!/Коротко о помощнике/.test(r.text));
      r = await req('GET', '/chat?help=1', { j: jI });
      assert.ok(/Коротко о помощнике/.test(r.text));
      assert.ok(pI);
    });

    // ---------- «Связаться с человеком» ----------
    check('связаться с человеком: с врачом -> запись врачу; без врача -> админу; кризис в тексте эскалируется', async () => {
      let r = await req('GET', '/chat/contact', { j: jA });
      assert.ok(/112/.test(r.text) && /отобразится в его кабинете/.test(r.text) && /не звонит/.test(r.text));
      r = await req('POST', '/chat/contact', { j: jA, body: { text: 'Прошу связаться со мной' } });
      assert.strictEqual(r.status, 302);
      const rowA = db.prepare('SELECT * FROM patient_appeals WHERE patient_id = ?').get(pA);
      assert.strictEqual(rowA.clinician_id, doc);
      assert.strictEqual(rowA.routed_to, 'clinician');
      r = await req('GET', '/chat/contact', { j: jB });
      assert.ok(/дежурный администратор/.test(r.text) && /не служба экстренной помощи/.test(r.text));
      await req('POST', '/chat/contact', { j: jB, body: { text: 'Мне нужна помощь' } });
      const rowB = db.prepare('SELECT * FROM patient_appeals WHERE patient_id = ?').get(pB);
      assert.strictEqual(rowB.clinician_id, null);
      assert.strictEqual(rowB.routed_to, 'admin');
      const before = escCount(pB);
      await req('POST', '/chat/contact', { j: jB, body: { text: 'я хочу покончить с собой' } });
      assert.strictEqual(escCount(pB), before + 1);
      const empty = await req('POST', '/chat/contact', { j: jA, body: { text: '  ' } });
      assert.strictEqual(empty.status, 400);
    });

    // ---------- сеть ----------
    check('за весь прогон нет исходящих соединений', () => {
      assert.deepStrictEqual(outbound, []);
    });

    for (const [name, fn] of queue) {
      try { await fn(); oks++; console.log(`  OK   ${name}`); } catch (e) { fails++; console.error(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); }
    }
  } finally {
    server.close();
  }
  console.log(`\nai: ${oks} OK, ${fails} FAIL`);
  if (fails) process.exit(1);
  console.log('Все проверки ИИ-чата прошли успешно.');
}

main().catch((e) => { console.error('FAIL (исключение)', e); process.exit(1); });
