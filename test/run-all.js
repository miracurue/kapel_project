'use strict';

// Последовательный запуск тестов (`npm test`). Единственное отличие от цепочки
// `a && b && c`: известный сбой teardown Node 24 + better-sqlite3
// (Assertion failed: (env) != nullptr в RemoveEnvironmentCleanupHook, exit 134,
// см. комментарий в smoke.test.js) засчитывается ТОЛЬКО если тест уже напечатал
// строку успеха, не напечатал ни одного FAIL, а в stderr именно эта assertion.
// Любой другой ненулевой код — провал.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TESTS = ['scoring', 'permissions', 'catalog', 'migration', 'seed', 'triage_rules', 'clinician_dash', 'clinician_card', 'conclusions', 'admin', 'ai', 'ai_workspace', 'tools', 'layout', 'patient', 'care', 'a1fixes', 'security', 'security_review', 'security_fixes', 'smoke'];
const SUCCESS = /Все проверки (каталога |миграции |сида |ИИ-чата |ИИ-пространства врача |инструментов врача |каркаса |кабинета пациента |ухода и сообщений |исправлений приёмки A1 |исправлений безопасности )?прошли успешно\.|Все проверки (защиты веб-уровня|ревью безопасности|светофора|кабинета клинициста|карточки пациента|кабинета администратора|заключений психолога) прошли успешно\.|^permissions: \d+ OK, 0 FAIL/m;

let failed = false;
for (const name of TESTS) {
  const file = path.join(__dirname, `${name}.test.js`);
  console.log(`\n> node test/${name}.test.js`);
  // stdout/stderr пишем в файлы: при abort() потомка данные в pipe теряются
  // (последняя часть вывода не успевает сброситься), в файл — синхронно.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const outFd = fs.openSync(path.join(tmp, 'out'), 'w');
  const errFd = fs.openSync(path.join(tmp, 'err'), 'w');
  // better-sqlite3 13.x устранил abort (env != nullptr) под нагрузкой на Node 24 (W0.6);
  // обход --min-semi-space-size убран. Оговорка про teardown ниже оставлена как страховка.
  const r = spawnSync(process.execPath, [file], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd); fs.closeSync(errFd);
  r.stdout = fs.readFileSync(path.join(tmp, 'out'), 'utf8');
  r.stderr = fs.readFileSync(path.join(tmp, 'err'), 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(r.stdout || '');
  const knownTeardown =
    r.status === null || r.status === 134
      ? /RemoveEnvironmentCleanupHook/.test(r.stderr || '') && /Assertion failed: \(env\) != nullptr/.test(r.stderr || '')
      : false;
  const hasFail = /^\s*FAIL\b/m.test((r.stdout || '') + (r.stderr || ''));
  if (r.status === 0 && !hasFail) continue;
  if (knownTeardown && SUCCESS.test(r.stdout || '') && !hasFail) {
    console.log(`  (известный сбой teardown better-sqlite3/Node 24 после успешного прогона: exit ${r.status}, засчитано)`);
    continue;
  }
  process.stderr.write(r.stderr || '');
  console.error(`ПРОВАЛ: test/${name}.test.js, exit ${r.status}`);
  failed = true;
  break;
}
process.exit(failed ? 1 : 0);
