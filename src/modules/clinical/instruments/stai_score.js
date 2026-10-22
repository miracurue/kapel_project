'use strict';

// Две независимые шкалы по буквальному ключу приложения Г5, PDF с.103.
// total — реактивная тревожность для единственного поля total_score в существующей схеме;
// обе шкалы сохраняются в sub. Суммарный показатель по 40 пунктам не вычисляется.
function scoreStai(answers, scoring) {
  for (let n = 1; n <= 40; n++) {
    const x = Number(answers[`q${n}`]);
    if (answers[`q${n}`] === undefined || !Number.isInteger(x) || x < 1 || x > 4)
      throw new Error(`stai: bad answer q${n}`);
  }
  const sub = Object.fromEntries(
    scoring.subscales.map((s) => {
      const sum = (items) => items.reduce((v, n) => v + Number(answers[`q${n}`]), 0);
      const raw = sum(s.direct) - sum(s.reverse) + s.offset;
      return [s.code, { raw, band: scoring.bands.find((b) => raw >= b.min && raw <= b.max)?.label }];
    }),
  );
  return { total: sub.reactive.raw, sub };
}

module.exports = { scoreStai };
