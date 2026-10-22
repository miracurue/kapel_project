'use strict';

// Сводные помощники модуля «уход» (W2.F): карточки «Сегодня», счётчики меню, блок «К приёму».
const meds = require('./meds');
const messages = require('./messages');
const psychoed = require('./psychoed');
const previsit = require('./previsit');
const cfg = require('./config');
const permissions = require('../permissions');

/** Спокойные карточки для главной пациента (не более 2). Без красного и слов «просрочено». */
function todayCards(patientId, now = new Date()) {
  const cards = [];
  const due = meds.dueSlots(patientId, now);
  if (due.length) {
    const slot = due[0].slot;
    cards.push({ kind: 'care', title: `${cfg.SLOT_LABEL[slot]}: приём по плану`, text: due.filter((d) => d.slot === slot).map((d) => d.item.name).join(', '), href: '/meds', cta: 'Отметить' });
  }
  const unread = messages.unreadForPatient(patientId);
  if (unread) cards.push({ kind: 'care', title: 'Сообщение от врача', text: `Новых: ${unread}`, href: '/messages', cta: 'Открыть' });
  if (previsit.openFor(patientId)) cards.push({ kind: 'care', title: 'Короткая анкета перед приёмом', text: 'Врач попросил заполнить заранее. Все вопросы необязательны.', href: '/previsit', cta: 'Открыть' });
  const mod = psychoed.pendingAssigned(patientId)[0];
  if (mod) cards.push({ kind: 'care', title: 'Материал от врача', text: mod.title, href: `/learn/${mod.key}`, cta: 'Прочитать' });
  return cards.slice(0, 2);
}

function middleware(req, res, next) {
  const u = req.session && req.session.user;
  res.locals.careMsgUnread = 0;
  if (u && u.role === 'patient') res.locals.careMsgUnread = messages.unreadForPatient(u.id);
  else if (u && permissions.isClinician(u.role)) res.locals.careMsgUnread = messages.unreadForClinician(u.id);
  next();
}

module.exports = { todayCards, middleware, meds, messages, psychoed, previsit, config: cfg };
