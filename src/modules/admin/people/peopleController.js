'use strict';

/**
 * W-39: контроллер «Люди и доступ». Тонкий слой: принимает запрос,
 * вызывает peopleService, возвращает JSON или ошибку через P.sendError.
 */

const platform = require('../../../platform');
const peopleService = require('./peopleService');

const P = platform;

function adminPeople(router) {
  // ---------- F-88: список и карточка ----------

  router.get('/people', (req, res) => {
    const { filter, q, page } = req.query;
    res.json(peopleService.listPeople({ filter, q, page }));
  });

  router.get('/people/:id', (req, res) => {
    const person = peopleService.getPerson(req.params.id);
    if (!person) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    res.json(person);
  });

  router.post('/people/:id/reveal-contacts', (req, res) => {
    const out = peopleService.revealContacts(req.user.id, req.params.id);
    if (!out) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    res.json(out);
  });
}

module.exports = { adminPeople };