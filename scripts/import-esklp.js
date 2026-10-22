#!/usr/bin/env node
'use strict';

/**
 * Загрузка каталога ЕСКЛП (N03, N04A, N05, N06, N07B) в inn и drug_products.
 * Источник: config/defaults/esklp_psych_catalog.csv (собирается scripts/esklp-extract.py).
 * Идемпотентно: повторный запуск обновляет МНН и добавляет недостающие торговые наименования.
 * Записи stand-in с тем же МНН переходят на источник ESKLP, их фиктивные торговые наименования удаляются (если на них нет ссылок, иначе снимаются).
 *
 * Использование: DB_PATH=... node scripts/import-esklp.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'tdr.sqlite3');
const csvPath = path.join(root, 'config', 'defaults', 'esklp_psych_catalog.csv');
const dryRun = process.argv.includes('--dry-run');

const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const MOOD_ATC = /^(N03AG|N03AF|N03AX09)/;
function drugGroup(codes) {
  const has = (re) => codes.some((c) => re.test(c));
  if (has(/^N05AN/)) return 'mood_stabilizer';
  if (has(/^N04A/)) return 'corrector';
  if (has(/^N05A/)) return 'antipsychotic';
  if (has(/^N06A/)) return 'antidepressant';
  if (has(/^N05B/)) return 'anxiolytic';
  if (has(/^N05C/)) return 'hypnotic_sedative';
  if (has(MOOD_ATC)) return 'mood_stabilizer';
  return 'other';
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const sourceDate = rows[0].source_date;

const byInn = new Map();
for (const r of rows) {
  if (!byInn.has(r.inn)) byInn.set(r.inn, { atc: new Set(), rows: [] });
  const g = byInn.get(r.inn);
  r.atc_all.split(';').forEach((a) => a.trim() && a !== '~' && g.atc.add(a.trim()));
  g.rows.push(r);
}

const stats = {
  inn_added: 0,
  inn_updated: 0,
  products_added: 0,
  products_existing: 0,
  stand_in_deleted: 0,
  stand_in_withdrawn: 0,
};

db.exec('BEGIN IMMEDIATE');
try {
  const versionId = Number(
    db
      .prepare(
        "INSERT INTO reference_versions(kind,source,source_date,status,applied_at) VALUES ('drugs','ESKLP',?,'applied',?)",
      )
      .run(sourceDate, now).lastInsertRowid,
  );
  const findInn = db.prepare("SELECT * FROM inn WHERE name_norm=? AND status='in_catalog'");
  const addInn = db.prepare(
    "INSERT INTO inn(name,name_norm,drug_group,atc_code,status,source,source_date,version_added) VALUES (?,?,?,?,'in_catalog','ESKLP',?,?)",
  );
  const updInn = db.prepare(
    "UPDATE inn SET drug_group=?,atc_code=?,source='ESKLP',source_date=?,updated_at=? WHERE id=?",
  );
  const deleteStandIn = db.prepare(
    "DELETE FROM drug_products WHERE inn_id=? AND source='stand_in' AND id NOT IN (SELECT product_id FROM patient_med_versions UNION SELECT product_id FROM purchase_marks)",
  );
  const withdrawStandIn = db.prepare(
    "UPDATE drug_products SET status='withdrawn',version_removed=?,updated_at=? WHERE inn_id=? AND source='stand_in' AND status='in_catalog'",
  );
  const findProduct = db.prepare(
    "SELECT id FROM drug_products WHERE inn_id=? AND trade_name_norm=? AND IFNULL(dosage_form,'')=? AND IFNULL(strength,'')=? AND IFNULL(reg_number,'')=? AND source='ESKLP'",
  );
  const addProduct = db.prepare(
    "INSERT INTO drug_products(inn_id,trade_name,trade_name_norm,manufacturer,dosage_form,strength,reg_number,status,source,source_date,version_added) VALUES (?,?,?,?,?,?,?,'in_catalog','ESKLP',?,?)",
  );
  const log = db.prepare(
    'INSERT INTO catalog_change_log(version_id,entity_type,entity_id,change,before_json,after_json) VALUES (?,?,?,?,?,?)',
  );

  for (const [mnn, g] of byInn) {
    const name = mnn.toLowerCase();
    const codes = [...g.atc].sort();
    const group = drugGroup(codes);
    const atc = codes.join(';');
    let inn = findInn.get(norm(name));
    if (inn) {
      updInn.run(group, atc, sourceDate, now, inn.id);
      log.run(
        versionId,
        'inn',
        inn.id,
        'update',
        JSON.stringify(inn),
        JSON.stringify({ drug_group: group, atc_code: atc }),
      );
      stats.inn_updated += 1;
      stats.stand_in_deleted += deleteStandIn.run(inn.id).changes;
      stats.stand_in_withdrawn += withdrawStandIn.run(versionId, now, inn.id).changes;
    } else {
      const id = Number(addInn.run(name, norm(name), group, atc, sourceDate, versionId).lastInsertRowid);
      inn = { id };
      log.run(versionId, 'inn', id, 'add', null, JSON.stringify({ name, drug_group: group, atc_code: atc }));
      stats.inn_added += 1;
    }
    for (const r of g.rows) {
      const form = r.dosage_form.toLowerCase();
      const strength = r.strength === 'НЕ УКАЗАНО' ? '' : r.strength;
      if (findProduct.get(inn.id, norm(r.trade_name), form, strength, r.reg_number)) {
        stats.products_existing += 1;
        continue;
      }
      const id = Number(
        addProduct.run(
          inn.id,
          r.trade_name,
          norm(r.trade_name),
          r.manufacturer || null,
          form || null,
          strength || null,
          r.reg_number || null,
          sourceDate,
          versionId,
        ).lastInsertRowid,
      );
      log.run(
        versionId,
        'product',
        id,
        'add',
        null,
        JSON.stringify({ trade_name: r.trade_name, reg_number: r.reg_number }),
      );
      stats.products_added += 1;
    }
  }
  db.prepare('UPDATE reference_versions SET stats_json=? WHERE id=?').run(JSON.stringify(stats), versionId);
  if (dryRun) {
    db.exec('ROLLBACK');
    console.log('dry-run, откат', stats);
  } else {
    db.exec('COMMIT');
    console.log('загружено', stats);
  }
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
