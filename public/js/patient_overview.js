'use strict';

window.CCPatientOverview = {
  async mount(root, { api, tx, esc }) {
    const holder = document.createElement('div');
    holder.className = 'patient-overview';
    holder.dataset.testid = 'msg.overview.title';
    root.before(holder);
    const t = (key, vars = {}) =>
      esc(Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), tx(`msg.overview.${key}`)));
    holder.innerHTML = `<p role="status">${t('loading')}</p>`;
    const psychiatrist = document.body.dataset.role === 'R-03';
    const id = root.dataset.patientId;
    const [card, plan] = await Promise.all([
      api(`/api/v1/patients/${id}?tab=overview`),
      psychiatrist ? api(`/api/v1/patients/${id}/plan`) : Promise.resolve(null),
    ]);
    const o = card?.overview;
    if (!o) {
      holder.innerHTML = `<p role="alert">${t('error')}</p><button type="button" data-testid="msg.overview.retry">${t('retry')}</button>`;
      holder.querySelector('button').addEventListener('click', () => {
        holder.remove();
        window.CCPatientOverview.mount(root, { api, tx, esc });
      });
      return;
    }
    const date = (value, withTime = false) =>
      new Intl.DateTimeFormat('ru-RU', {
        timeZone: o.timezone,
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
      }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
    const n = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
    const stat = (value, label, cls = '') =>
      `<div class="ov-number ${cls}"><strong>${n(value)}</strong><span>${label}</span></div>`;
    const section = (key, body, cls = '') =>
      `<section class="ov-section ${cls}" data-testid="msg.overview.${key}"><h2>${t(key)}</h2>${body}</section>`;
    const link = (href, label) => `<a class="ov-link" href="${href}">${t(label)} <span aria-hidden="true">→</span></a>`;
    const crisis = o.crisis;
    const safety = section(
      'crisis',
      `<div class="ov-safety ${crisis.active ? 'ov-attention' : ''}"><div><span class="ov-status">${t(crisis.active ? 'crisis.open' : 'crisis.clear')}</span><p>${t('crisis.definition')}</p></div>${stat(crisis.active, t('crisis.active'))}</div><div class="ov-counts">${stat(crisis.occurrences, t('crisis.occurrences'))}${stat(crisis.total, t('crisis.total'))}${stat(crisis.new, t('crisis.new'))}${stat(crisis.in_work, t('crisis.in_work'))}${stat(crisis.handled, t('crisis.handled'))}</div><p class="ov-note">${t('crisis.explain')}</p>${link('/work?tab=signals', 'signals.link')}`,
    );
    const visit = o.next_visit;
    const visitHtml = section(
      'visit',
      visit
        ? `<strong class="ov-main-value">${esc(date(visit.starts_at, true))}</strong><p>${t(visit.format === 'remote' ? 'visit.remote' : 'visit.in_person')}${visit.place ? ` · ${esc(visit.place)}` : ''}</p><small>${t('visit.zone', { timezone: o.timezone })}</small>`
        : `<strong class="ov-empty-value">${t('visit.empty')}</strong><p>${t('visit.empty.explain')}</p>`,
    );
    const duration = section(
      'duration',
      `${o.days_in_system === null ? `<strong class="ov-empty-value">${t('no_data')}</strong>` : stat(o.days_in_system, t('duration.days'))}<p>${o.registered_at ? t('duration.since', { date: date(o.registered_at) }) : t('no_data')}</p><small>${t('duration.definition')}</small>`,
    );
    const specs = [
      { key: 'mood', min: 1, max: 5, labels: [1, 2, 3, 4, 5].map((v) => tx(`msg.diary.mood.${v}`)) },
      {
        key: 'anxiety_score',
        min: 0,
        max: 2,
        labels: ['none', 'some', 'strong'].map((v) => tx(`msg.diary.anxiety.${v}`)),
      },
      { key: 'sleep_score', min: 0, max: 2, labels: ['bad', 'ok', 'good'].map((v) => tx(`msg.diary.sleep.${v}`)) },
    ];
    const dayMs = 86400000;
    const dayIndex = (day) => Math.round((Date.parse(day) - Date.parse(o.diary.from)) / dayMs);
    const graph = (spec) => {
      const points = o.diary.days.filter((d) => Number.isFinite(d[spec.key]));
      const last = points.at(-1);
      const label = (d) =>
        spec.key === 'mood' ? `${d.mood}/5 · ${spec.labels[d.mood - 1]}` : spec.labels[d[spec.key]];
      const x = (day) => 100 + dayIndex(day) * 29;
      const y = (v) => 118 - ((v - spec.min) / (spec.max - spec.min)) * 96;
      let svg = `<svg viewBox="0 0 500 152" role="img" aria-label="${t(`graph.${spec.key}`)}"><title>${t(`graph.${spec.key}`)} · ${esc(date(o.diary.from))} — ${esc(date(o.diary.to))}</title>`;
      for (let v = spec.min; v <= spec.max; v += 1)
        svg += `<line class="ov-grid" x1="100" x2="477" y1="${y(v)}" y2="${y(v)}"/><text class="ov-axis" x="90" y="${y(v) + 4}" text-anchor="end">${esc(spec.labels[v - spec.min])}</text>`;
      for (const offset of [0, 6, 13]) {
        const day = new Date(Date.parse(o.diary.from) + offset * dayMs).toISOString().slice(0, 10);
        svg += `<text class="ov-axis" x="${x(day)}" y="145" text-anchor="${offset === 0 ? 'start' : offset === 13 ? 'end' : 'middle'}">${esc(new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(day)))}</text>`;
      }
      points.forEach((p, i) => {
        const prev = points[i - 1];
        if (prev && dayIndex(p.day) - dayIndex(prev.day) === 1)
          svg += `<path class="ov-line" d="M${x(prev.day)} ${y(prev[spec.key])} H${x(p.day)} V${y(p[spec.key])}"/>`;
        svg += `<circle class="ov-point" cx="${x(p.day)}" cy="${y(p[spec.key])}" r="4"><title>${esc(date(p.day))}: ${esc(label(p))}</title></circle>`;
      });
      svg += '</svg>';
      return `<article class="ov-metric ov-${spec.key}"><div class="ov-metric-head"><h3>${t(`graph.${spec.key}`)}</h3><span>${t('graph.coverage', { count: points.length })}</span></div><div class="ov-metric-layout"><div class="ov-latest"><strong>${last ? esc(label(last)) : t('no_data')}</strong><small>${last ? t('graph.last', { date: date(last.day) }) : t('graph.empty')}</small></div><div class="ov-plot">${points.length ? svg : `<p class="ov-chart-empty">${t('graph.empty')}</p>`}</div></div></article>`;
    };
    const table = `<details class="ov-table"><summary>${t('graph.table')}</summary><div class="ov-table-scroll"><table><caption class="sr">${t('graph.table')}</caption><thead><tr><th scope="col">${t('graph.date')}</th>${specs.map((s) => `<th scope="col">${t(`graph.${s.key}`)}</th>`).join('')}</tr></thead><tbody>${o.diary.days.map((d) => `<tr><th scope="row">${esc(date(d.day))}</th>${specs.map((s) => `<td>${Number.isFinite(d[s.key]) ? esc(s.key === 'mood' ? `${d.mood}/5 · ${s.labels[d.mood - 1]}` : s.labels[d[s.key]]) : t('no_data')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
    const dynamics = section(
      'dynamics',
      `<p class="ov-period">${t('graph.period', { from: date(o.diary.from), to: date(o.diary.to) })}</p>${specs.map(graph).join('')}<p class="ov-note">${t('graph.definition')}</p>${o.diary.days.length ? table : ''}${link('?ptab=diary', 'diary.link')}`,
    );
    const activeItems = (plan?.published?.items || []).filter(
      (i) => (!i.until || i.until >= o.today) && (!i.start_date || i.start_date <= o.today),
    );
    const medRows = activeItems
      .map(
        (i) =>
          `<li><div><strong>${esc(i.inn_name)}</strong><span class="ov-dose">${i.dose != null ? `${esc(i.dose)} ${esc(i.unit)}` : t('meds.dose_unknown')}</span></div><p>${i.times?.length ? esc(i.times.join(' · ')) : t('meds.time_unknown')}${i.until ? ` · ${t('meds.until', { date: date(i.until) })}` : ''}</p><span class="ov-tag ${i.acceptance?.review_needed ? 'ov-tag-warn' : ''}">${t(!i.acceptance ? 'meds.waiting' : i.acceptance.review_needed ? 'meds.changed' : 'meds.accepted')}</span>${i.acceptance?.product ? `<p>${t('meds.product', { name: i.acceptance.product.name })}</p>` : ''}${i.patient_dose ? `<p class="ov-discrepancy">${t('meds.patient_dose', { dose: i.patient_dose.value, unit: i.patient_dose.unit })}</p>` : ''}</li>`,
      )
      .join('');
    const ownRows = (o.patient_meds || [])
      .map(
        (i) =>
          `<li><div><strong>${esc(i.trade_name)}</strong>${i.dose != null ? `<span class="ov-dose">${esc(i.dose)} ${esc(i.unit)}</span>` : ''}</div><p>${esc(i.inn_name)}${i.times.length ? ` · ${esc(i.times.join(' · '))}` : ''}</p></li>`,
      )
      .join('');
    const medications = section(
      'meds',
      psychiatrist
        ? `<h3>${t('meds.prescribed')}</h3>${!plan ? `<p role="alert">${t('meds.error')}</p>` : medRows ? `<ul class="ov-meds">${medRows}</ul>` : `<p>${t('meds.empty')}</p>`}${ownRows ? `<h3>${t('meds.patient')}</h3><ul class="ov-meds">${ownRows}</ul>` : ''}<p class="ov-note">${t('meds.definition')}</p>${link('?ptab=treatment', 'treatment.link')}`
        : `<p>${t('meds.restricted')}</p>`,
    );
    const ae = o.adverse_events;
    const adverse = section(
      'ae',
      ae
        ? `<div class="ov-counts">${stat(ae.total, t('ae.total'))}${stat(ae.pending, t('ae.pending'))}</div>${ae.latest.length ? `<ul class="ov-ae">${ae.latest.map((a) => `<li><strong>${esc(date(a.created_at))}</strong><span>${t(`ae.status.${a.status}`)}</span><p>${esc(a.text || tx('msg.overview.ae.no_text'))}</p></li>`).join('')}</ul>` : `<p>${t('ae.empty')}</p>`}<p class="ov-note">${t('ae.definition')}</p>${link('/work?tab=signals', 'signals.link')}`
        : `<p>${t('meds.restricted')}</p>`,
    );
    holder.innerHTML = `<div class="ov-intro"><h2>${t('title')}</h2><span>${t('updated', { date: date(o.as_of, true) })}</span></div><div class="ov-top">${duration}${visitHtml}</div>${safety}${dynamics}${medications}${adverse}`;
    if (window.CCColleague) window.CCColleague.mount(holder, id, { tx: (key) => tx(key), esc });
  },
};
