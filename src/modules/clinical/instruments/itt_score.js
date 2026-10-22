'use strict';

const N = require('./itt_norms');

// Группа норм выбирается на сервере по профилю пациента. Допущение демо (источник не говорит, кто «девушки»):
// «Девушки» — пол женский и возрастная группа 18–24 (профиль хранит только возрастную группу, моложе 18
// в системе нет); все остальные и случаи без данных — «Взрослые и юноши».
function pickGroup(profile) {
  if (!profile || !profile.sex || !profile.age_band) return { group: 'adult', reason: 'no_data' };
  if (profile.sex === 'f' && profile.age_band === '18-24') return { group: 'girls', reason: 'female_young' };
  return { group: 'adult', reason: 'default' };
}

// Подсчёт ИТТ: общий показатель = сумма баллов 0–3 (0–45); субшкала = сумма диагностических коэффициентов
// пунктов (ответ 3/2/1 — числа из таблицы, 0 — ноль). Станайны считаются сразу по обеим группам норм;
// «применённая» группа — выбранная сервером, врач может переключить показ.
function scoreItt(answers, scoring, profile) {
  const v = (n) => {
    const x = Number(answers[`q${n}`]);
    if (!Number.isInteger(x) || x < 0 || x > 3) throw new Error(`itt: bad answer q${n}`);
    return x;
  };
  let total = 0;
  const raw = {};
  for (const s of scoring.subscales) raw[s.code] = 0;
  scoring.key.forEach((k, i) => {
    const x = v(i + 1);
    total += x;
    if (x > 0) raw[k.scale] += k.coef[x];
  });
  const stanines = (get, value) => Object.fromEntries(N.GROUPS.map((g) => [g.key, N.stanineOf(get(g.key), value)]));
  const applied = pickGroup(profile);
  const sub = {
    scale: scoring.scale,
    norm_group: applied.group,
    norm_group_reason: applied.reason,
    norm_group_assumption: 'demo',
    total: { raw: total, max: N.TOTAL_MAX, stanine: stanines((g) => N.TOTAL[g], total) },
    subscales: Object.fromEntries(
      scoring.subscales.map((s) => [
        s.code,
        {
          raw: raw[s.code],
          max: N.SUBSCALE_MAX[s.code],
          stanine: stanines((g) => N.SUBSCALES[g][s.code], raw[s.code]),
        },
      ]),
    ),
  };
  return { total, sub };
}

module.exports = { scoreItt, pickGroup };
