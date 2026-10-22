'use strict';

const express = require('express');

const researchExport = require('../research_export');
const { requirePermission } = require('../permissions');

const router = express.Router();

// W1.B1: сводка, список пациентов, кризисная очередь
router.use(require('./clinician_overview'));

// W1.B2: назначения/коды-приглашения и карточка пациента (вкладки, ввод результатов, заметки)
router.use(require('./clinician_assign'));
router.use(require('./clinician_card'));

// W2.G: быстрые инструменты врача (/tools)
router.use(require('./tools'));

// Кризисная очередь (/crisis…), сводка и список пациентов — src/routes/clinician_overview.js (W1.B1).

// ---------- Anonymized export (read-only research contour) ----------
//
// Отдельный контур для научного экспорта (RES-3 "anonymization-requirements"):
// псевдонимизированный patient_id, только структурированные баллы, дата
// округлена до недели, фильтр по действующему согласию на научный экспорт,
// каждый запуск журналируется в export_audit_log. См. src/research_export.js —
// этот модуль не имеет доступа к свободнотекстовым полям (дневник, чат).

// D22: перед скачиванием — пояснение, что внутри и чьи строки
router.get('/export', requirePermission('export.research'), (req, res) => {
  res.render('clinician/export', { title: 'Экспорт' });
});

router.get('/export/comparisons.csv', requirePermission('export.research'), (req, res) => {
  const rows = researchExport.generateComparisonExport({ runBy: req.session.user.id, clinicianId: req.session.user.id });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="comparisons_anonymized.csv"');
  res.send(researchExport.toCsv(rows));
});

module.exports = router;
