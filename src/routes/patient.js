'use strict';

const express = require('express');


const router = express.Router();

// W1.A: кабинет пациента разнесён по src/routes/patient/*
// (главная, онбординг, «Мне плохо», тесты и прохождение, дневник, напоминания,
// «Поделиться с врачом»). Чат — src/routes/ai.js (W1.C1).
router.use(require('./patient/home'));
router.use(require('./patient/tests'));
router.use(require('./patient/diary'));
router.use(require('./patient/reminders'));

// Чат с ИИ-помощником вынесен в src/routes/ai.js (W1.C1).

module.exports = router;
