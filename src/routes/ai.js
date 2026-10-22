'use strict';

// ИИ-чат. mountChat — общая раскладка типового ИИ-чата (тредами владеет пользователь, см. src/ai/threads.js);
// сейчас смонтирована для пациента на /chat. ИИ-пространство врача (W1.C2) монтирует тот же каркас на /ai
// со своим cfg (permission 'ai_workspace.use', role 'clinician', свои подсказки и send).

const express = require('express');

const db = require('../db');
const { flash } = require('../middleware');
const { requirePermission } = require('../permissions');
const threads = require('../ai/threads');
const chatService = require('../ai/chatService');
const contact = require('../ai/contact');
const gate = require('../ai/crisisGate');
const texts = require('../ai/texts');

const router = express.Router();

function wantsJson(req) {
  return req.get('X-Requested-With') === 'fetch' || /application\/json/.test(req.get('Accept') || '');
}

function serialize(m) {
  return { id: m.id, role: m.role, kind: m.kind, text: m.text, created_at: m.created_at };
}

/**
 * cfg: { base, permission, role, title, chips, contactEnabled, send(req, {threadId, text}), retry(req, threadId),
 *        // необязательные расширения (ИИ-пространство врача, W1.C2); без них поведение чата пациента не меняется:
 *        maxLen, badge, intro, privacyNote, disclaimer, emptyTitle, emptyHint,
 *        locals(req, {thread, messages}) -> доп. переменные шаблона (например ws),
 *        listThreads(req) -> список тредов для панели, onOpen(req, thread), onDelete(req, thread) }
 */
function mountChat(r, cfg) {
  const guard = requirePermission(cfg.permission);
  const view = 'ai/chat';

  function render(req, res, { thread = null, draft = '', error = null, status = 200, help = false } = {}) {
    const user = req.session.user;
    if (cfg.role === 'patient') threads.migrateLegacyChat(user.id);
    const list = cfg.listThreads ? cfg.listThreads(req) : threads.listThreads(user.id, cfg.role);
    const messages = thread ? threads.listMessages(thread.id) : [];
    let showIntro = help;
    if (!help && !threads.introSeen(user.id)) {
      showIntro = true;
      threads.markIntroSeen(user.id); // повторно не навязываем (REQ-AIP-015)
    }
    const last = messages[messages.length - 1];
    res.status(status).render(view, {
      cfg, base: cfg.base, threads: list, thread, messages, draft, error, showIntro,
      canRetry: !!(last && last.kind === 'error'),
      hasClinician: cfg.role === 'patient' ? gate.hasClinician(user.id) : true,
      chips: cfg.chips, aiBadge: cfg.badge || texts.AI_BADGE, maxLen: cfg.maxLen || chatService.MAX_LEN, intro: cfg.intro || texts.INTRO,
      privacyNote: cfg.privacyNote || texts.PRIVACY_NOTE, disclaimer: cfg.disclaimer || null,
      emptyTitle: cfg.emptyTitle || 'С чего начнём?', emptyHint: cfg.emptyHint || 'Выберите подсказку или напишите своими словами.',
      ws: null, ...(cfg.locals ? cfg.locals(req, { thread, messages }) : {}),
    });
  }

  r.get(cfg.base, guard, (req, res) => render(req, res, { help: req.query.help === '1' }));

  r.get(`${cfg.base}/t/:id`, guard, (req, res) => {
    const thread = threads.getThread(req.session.user.id, req.params.id, cfg.role);
    if (!thread) return res.status(404).render('error', { message: 'Диалог не найден.' });
    if (cfg.onOpen) cfg.onOpen(req, thread);
    render(req, res, { thread, help: req.query.help === '1' });
  });

  r.post(`${cfg.base}/send`, guard, async (req, res) => {
    const { thread_id: threadId, text } = req.body || {};
    const out = await cfg.send(req, { threadId: threadId || null, text });
    if (wantsJson(req)) {
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      return res.json({
        thread: { id: out.thread.id, title: out.thread.title, url: `${cfg.base}/t/${out.thread.id}` },
        user: serialize(out.user), assistant: serialize(out.assistant), crisis: !!out.crisis, unavailable: !!out.unavailable,
        extras: out.extras || '', userExtras: out.userExtras || '',
      });
    }
    if (out.status !== 200) {
      const thread = threadId ? threads.getThread(req.session.user.id, threadId, cfg.role) : null;
      return render(req, res, { thread, draft: out.draft || '', error: out.error, status: out.status });
    }
    res.redirect(`${cfg.base}/t/${out.thread.id}#end`);
  });

  r.post(`${cfg.base}/t/:id/retry`, guard, async (req, res) => {
    const out = await cfg.retry(req, req.params.id);
    if (out.status === 404) return res.status(404).render('error', { message: out.error });
    if (wantsJson(req)) {
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      return res.json({ assistant: out.assistant ? serialize(out.assistant) : null, unavailable: !!out.unavailable, extras: out.extras || '' });
    }
    if (out.status !== 200) {
      return render(req, res, { thread: threads.getThread(req.session.user.id, req.params.id, cfg.role), error: out.error, status: out.status });
    }
    res.redirect(`${cfg.base}/t/${req.params.id}#end`);
  });

  r.post(`${cfg.base}/t/:id/rename`, guard, (req, res) => {
    const thread = threads.renameThread(req.session.user.id, req.params.id, req.body && req.body.title);
    if (!thread || thread.role !== cfg.role) return res.status(404).render('error', { message: 'Диалог не найден.' });
    if (wantsJson(req)) return res.json({ id: thread.id, title: thread.title });
    res.redirect(`${cfg.base}/t/${thread.id}`);
  });

  // Удаление: подтверждение отдельным экраном — работает и без JS.
  r.get(`${cfg.base}/t/:id/delete`, guard, (req, res) => {
    const thread = threads.getThread(req.session.user.id, req.params.id, cfg.role);
    if (!thread) return res.status(404).render('error', { message: 'Диалог не найден.' });
    res.render('ai/confirm_delete', { cfg, base: cfg.base, thread, note: cfg.deleteNote || texts.DELETE_CONFIRM });
  });

  r.post(`${cfg.base}/t/:id/delete`, guard, (req, res) => {
    const thread = threads.getThread(req.session.user.id, req.params.id, cfg.role);
    if (!thread) return res.status(404).render('error', { message: 'Диалог не найден.' });
    if (cfg.onDelete) cfg.onDelete(req, thread);
    threads.deleteThread(req.session.user.id, thread.id);
    threads.audit({ userId: req.session.user.id, role: req.session.user.role, threadId: thread.id, event: 'thread_deleted' });
    flash(req, 'Диалог удалён.', 'success');
    res.redirect(cfg.base);
  });

  // «Стоп» при потоковой печати: клиент сообщает, сколько символов успел показать; хранимый текст обрезается тем же.
  r.post(`${cfg.base}/m/:mid/stop`, guard, (req, res) => {
    const row = db
      .prepare('SELECT m.* FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.owner_user_id = ? AND t.role = ?')
      .get(Number(req.params.mid), req.session.user.id, cfg.role);
    if (!row || row.role !== 'assistant' || row.kind === 'crisis' || row.kind === 'error') return res.status(404).json({ error: 'not found' });
    const len = Math.max(1, Math.min(Number(req.body && req.body.len) || 1, row.text.length));
    const text = row.text.slice(0, len).trimEnd();
    db.prepare('UPDATE ai_messages SET text = ? WHERE id = ?').run(`${text} …`, row.id);
    res.json({ id: row.id, text: `${text} …` });
  });

  if (cfg.contactEnabled) {
    r.get(`${cfg.base}/contact`, guard, (req, res) => {
      const user = req.session.user;
      res.render('ai/contact', {
        cfg, base: cfg.base, hasClinician: gate.hasClinician(user.id), draft: contact.DEFAULT_TEXT, error: null,
        threadId: req.query.thread || '', maxLen: contact.MAX_LEN || 2000,
      });
    });

    r.post(`${cfg.base}/contact`, guard, (req, res) => {
      const user = req.session.user;
      const out = contact.createContactRequest({ user, text: req.body && req.body.text, threadId: req.body && req.body.thread_id });
      if (out.status !== 200) {
        return res.status(out.status).render('ai/contact', {
          cfg, base: cfg.base, hasClinician: gate.hasClinician(user.id), draft: out.draft || '', error: out.error,
          threadId: (req.body && req.body.thread_id) || '', maxLen: 2000,
        });
      }
      flash(req, out.message, 'info');
      res.redirect(req.body && req.body.thread_id ? `${cfg.base}/t/${Number(req.body.thread_id)}` : cfg.base);
    });
  }
}

mountChat(router, {
  base: '/chat',
  permission: 'chat.patient',
  role: 'patient',
  title: 'ИИ-помощник',
  chips: texts.CHIPS,
  contactEnabled: true,
  send: (req, { threadId, text }) => chatService.sendPatientMessage({ user: req.session.user, threadId, text }),
  retry: (req, threadId) => chatService.retryLast({ user: req.session.user, threadId }),
});

module.exports = router;
module.exports.mountChat = mountChat;
