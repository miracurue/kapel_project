'use strict';

// Подсчёт SCL-90-R на сервере по формулам из приложения Г3 (источник: .agents/tasks/2026-10-20-scl90r-source.md).
// Шкала = сумма баллов её пунктов / число пунктов; GSI = сумма 90 / 90; PSI = число пунктов с ответом 1–4;
// PDSI = GSI × 90 / PSI (при PSI = 0 — null). Значения не округляются: округление только при показе.
function scoreScl90r(answers, scales) {
  const v = (n) => {
    const x = Number(answers[`q${n}`]);
    if (!Number.isInteger(x) || x < 0 || x > 4) throw new Error(`scl90r: bad answer q${n}`);
    return x;
  };
  const out = {};
  for (const s of scales) {
    const sum = s.items.reduce((a, n) => a + v(n), 0);
    out[s.code] = { sum, count: s.items.length, mean: sum / s.items.length };
  }
  let total = 0;
  let psi = 0;
  for (let n = 1; n <= 90; n++) {
    const x = v(n);
    total += x;
    if (x >= 1) psi += 1;
  }
  const gsi = total / 90;
  return { total, scales: out, gsi, psi, pdsi: psi === 0 ? null : (gsi * 90) / psi };
}

module.exports = { scoreScl90r };
