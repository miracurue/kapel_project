'use strict';

const express = require('express');

const db = require('../db');
const { listInstruments } = require('../instruments');
const { requireLogin } = require('../middleware');
const { isClinician } = require('../permissions');

const router = express.Router();

router.get('/dashboard', requireLogin, (req, res, next) => {
  const { id, role } = req.session.user;

  // кабинет пациента (главная «Сегодня») — src/routes/patient/home.js (W1.A)
  if (role === 'patient') return next();

  if (isClinician(role)) return require('./clinician_overview').summary(req, res);

  // W1.D: домашний экран администратора («Требует решения»)
  if (role === 'admin') return require('./admin').home(req, res);

  res.status(403).render('error', { message: 'Неизвестная роль.' });
});

module.exports = router;
