'use strict';

// Страницы: регистрация (пациент / специалист на одном адресе), тексты документов, повторное согласие, принятие
// соглашения специалистом, «заявка ожидает подтверждения». Тексты — ключами locales/ru.json, без inline-кода.

const { render, esc } = require('./markdown');
const { URL_OF, isRequired } = require('./service');

const SPECIALTIES = ['psychiatrist', 'psychotherapist', 'clinical_psychologist', 'neurologist', 'somatic', 'other'];
const RENEW_STEPS = ['base', 'ai', 'research']; // номер шага в /onboarding/consent/{n}
const STYLES = ['/css/register.css'];

function createPages({ shell, t, config, service }) {
  const tx = (key, vars = {}) => {
    let text = t(key);
    for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
    return text;
  };
  const date = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  };
  const link = (kind, key) =>
    `<a href="${URL_OF[kind]}" target="_blank" rel="noopener" data-testid="${key}">${esc(tx(key))}</a>`;
  // Шаблон «Принимаю {a} и {b}» -> текст с ссылками (всё остальное экранировано).
  const withLinks = (key, links) =>
    esc(tx(key)).replace(/\{(\w+)\}/g, (m, name) => (links[name] !== undefined ? links[name] : m));
  const AUTH_FOOT = `<p class="page-foot"><a href="/legal">${esc(tx('msg.register.foot.legal'))}</a> · <a href="/account/help">${esc(tx('msg.register.foot.help'))}</a> · ${esc(tx('msg.register.foot.crisis'))}</p>`;

  const checkbox = (name, key, inner, { required = false, hint = true } = {}) =>
    `<label class="check-row reg-check"><input type="checkbox" name="${name}" value="${name}" data-testid="${key}"${required ? ' aria-required="true"' : ''}><span>${inner}${hint ? ` <small class="muted">· ${esc(tx(required ? 'msg.register.required' : 'msg.register.optional'))}</small>` : ''}</span></label>`;

  const field = (name, key, attrs, hintKey) =>
    `<label class="field">${esc(tx(key))}<input data-testid="${key}" name="${name}" ${attrs}>${hintKey ? `<small class="muted">${esc(tx(hintKey))}</small>` : ''}<span class="field-err" data-err="${name}" aria-live="polite"></span></label>`;

  function registerPage(as) {
    const staff = as === 'specialist';
    const seg = `<nav class="seg reg-seg" aria-label="${esc(tx('msg.register.as.label'))}"><a href="/register" data-as="patient" data-testid="msg.register.as.patient"${staff ? '' : ' aria-current="page"'}>${esc(tx('msg.register.as.patient'))}</a><a href="/register?as=specialist" data-as="specialist" data-testid="msg.register.as.specialist"${staff ? ' aria-current="page"' : ''}>${esc(tx('msg.register.as.specialist'))}</a></nav>`;
    const patient = `<form id="register-form" class="form reg-form" data-panel="patient" novalidate${staff ? ' hidden' : ''}>
${field('email', 'msg.register.email', 'type="email" autocomplete="email" inputmode="email" required')}
${field('password', 'msg.register.password', 'type="password" autocomplete="new-password" minlength="10" required', 'msg.register.password.hint')}
<details class="reg-code"><summary data-testid="msg.register.code.fold">${esc(tx('msg.register.code.fold'))}</summary>${field('invite_code', 'msg.register.code', 'autocomplete="off" autocapitalize="characters" spellcheck="false"', 'msg.register.code.hint')}</details>
<fieldset class="reg-consents"><legend data-testid="msg.register.consents.title">${esc(tx('msg.register.consents.title'))}</legend>
${checkbox('base', 'msg.register.consent.base', withLinks('msg.register.consent.base', { agreement: link('agreement', 'msg.register.link.agreement'), policy: link('privacy', 'msg.register.link.policy'), consent: link('base', 'msg.register.link.base') }), { required: true })}
${checkbox('ai', 'msg.register.consent.ai', withLinks('msg.register.consent.ai', { consent: link('ai', 'msg.register.link.ai') }), { required: isRequired('ai') })}
${checkbox('research', 'msg.register.consent.research', `${esc(tx('msg.register.consent.research'))} · ${link('research', 'msg.register.fulltext')}`)}
<p class="small muted" data-testid="msg.register.consents.note">${esc(tx('msg.register.consents.note'))}</p>
<p class="form-error" data-err="consents" aria-live="polite"></p></fieldset>
<button class="btn primary wide-btn" type="submit" data-testid="msg.register.next">${esc(tx('msg.register.next'))}</button>
<p class="form-error" data-form-error aria-live="polite"></p>
</form>`;
    const specialtyOptions = SPECIALTIES.map(
      (code) => `<option value="${code}">${esc(tx(`msg.register.staff.specialty.${code}`))}</option>`,
    ).join('');
    const roleChoice = (value, checked) =>
      `<label class="choice"><input type="radio" name="role" value="${value}" data-testid="msg.register.staff.role.${value}"${checked ? ' checked' : ''}>${esc(tx(`msg.register.staff.role.${value}`))}</label>`;
    const specialist = `<form id="register-staff-form" class="form reg-form" data-panel="specialist" novalidate${staff ? '' : ' hidden'}>
${field('full_name', 'msg.register.staff.name', 'autocomplete="name" required')}
${field('email', 'msg.register.email', 'type="email" autocomplete="email" inputmode="email" required')}
${field('password', 'msg.register.password', 'type="password" autocomplete="new-password" minlength="10" required', 'msg.register.password.hint')}
<fieldset class="choices reg-roles"><legend>${esc(tx('msg.register.staff.role'))}</legend>${roleChoice('psychologist', true)}${roleChoice('psychiatrist', false)}</fieldset>
<label class="field">${esc(tx('msg.register.staff.specialty'))}<select name="specialty" data-testid="msg.register.staff.specialty">${specialtyOptions}</select></label>
${field('workplace', 'msg.register.staff.workplace', 'autocomplete="organization" required', 'msg.register.staff.workplace.hint')}
${field('qualification', 'msg.register.staff.qualification', 'autocomplete="off"', 'msg.register.staff.qualification.hint')}
<fieldset class="reg-consents"><legend>${esc(tx('msg.register.consents.title'))}</legend>
${checkbox('staff_pd', 'msg.register.staff.consent.pd', withLinks('msg.register.staff.consent.pd', { consent: link('staff_pd', 'msg.register.staff.link.pd') }), { required: true })}
${checkbox('agreement', 'msg.register.staff.consent.agreement', withLinks('msg.register.staff.consent.agreement', { agreement: link('agreement', 'msg.register.link.agreement'), policy: link('privacy', 'msg.register.link.policy') }), { required: true })}
<p class="form-error" data-err="consents" aria-live="polite"></p></fieldset>
<button class="btn primary wide-btn" type="submit" data-testid="msg.register.staff.submit">${esc(tx('msg.register.staff.submit'))}</button>
<p class="form-error" data-form-error aria-live="polite"></p>
</form>
<section class="callout reg-done" data-done hidden><h2 data-testid="msg.register.staff.done.title">${esc(tx('msg.register.staff.done.title'))}</h2><p>${esc(tx('msg.register.staff.done.text'))}</p><p><a class="btn primary" href="/login" data-testid="msg.register.staff.done.login">${esc(tx('msg.register.staff.done.login'))}</a></p></section>`;
    return shell({
      page: 'P-03',
      title: tx('msg.register.seo.title'),
      demo: config.demoMode,
      styles: STYLES,
      scripts: ['/js/register.js'],
      body: `<div class="reg" id="reg" data-as="${staff ? 'specialist' : 'patient'}"><h1 data-testid="msg.register.title">${esc(tx('msg.register.title'))}</h1>${seg}<p class="lead reg-lead" data-lead="patient"${staff ? ' hidden' : ''}>${esc(tx('msg.register.lead.patient'))}</p><p class="lead reg-lead" data-lead="specialist"${staff ? '' : ' hidden'}>${esc(tx('msg.register.lead.specialist'))}</p>${patient}${specialist}<p class="auth-links"><a href="/login">${esc(tx('msg.register.have_account'))}</a></p></div>${AUTH_FOOT}`,
    });
  }

  /** Текст документа: заголовок из первой строки `# …`, версия и дата, тело. */
  function docPage(user, kind) {
    const row = service.current(kind);
    const lines = String(row.body_md).split('\n');
    const first = lines.findIndex((l) => /^#\s+/.test(l));
    const title = first >= 0 ? lines[first].replace(/^#\s+/, '').trim() : kind;
    const body = first >= 0 ? lines.slice(first + 1).join('\n') : row.body_md;
    return shell({
      page: 'P-09',
      title,
      user,
      demo: config.demoMode,
      styles: STYLES,
      body: `<p class="muted"><a href="/legal" data-testid="msg.legal.back">${esc(tx('msg.legal.back'))}</a></p><article class="legal-doc" data-kind="${esc(kind)}" data-version="${row.version}" data-sha256="${esc(row.body_sha256)}"><h1>${esc(title)}</h1><p class="legal-meta" data-testid="msg.legal.version">${esc(tx('msg.legal.version', { v: row.version, date: date(row.published_at) }))}${row.is_stand_in ? ` · ${esc(tx('msg.legal.draft'))}` : ''}</p>${render(body)}</article>`,
    });
  }

  /** Экран «текст изменился, подтвердите» (P0-5, T-7). step: 1 основное, 2 ИИ, 3 исследования; без номера — первый несогласованный. */
  function renewPage(user, step) {
    const stale = service.patientConsents(user.id).filter((c) => c.stale && c.kind !== 'program');
    const wanted = step ? RENEW_STEPS[step - 1] : stale[0]?.kind;
    const item = stale.find((c) => c.kind === wanted) || service.status(user.id, wanted || 'base');
    const kind = item.kind;
    const row = service.current(kind);
    const title = (String(row.body_md).match(/^#\s+(.+)$/m) || [null, kind])[1];
    const nothing = !stale.length && !step;
    const blocking = kind === 'base';
    const extra = stale.filter((c) => c.kind !== kind).length;
    return shell({
      page: 'P-06',
      title: tx('msg.consent.renew.title'),
      user,
      demo: config.demoMode,
      styles: STYLES,
      scripts: ['/js/consent_renew.js'],
      body: nothing
        ? `<h1 data-testid="msg.consent.renew.title">${esc(tx('msg.consent.renew.title'))}</h1><p class="lead">${esc(tx('msg.consent.renew.none'))}</p><p><a class="btn primary" href="/app">${esc(tx('msg.consent.renew.continue'))}</a></p>`
        : `<div class="reg renew" id="renew" data-kind="${kind}" data-version="${row.version}" data-blocking="${blocking ? 1 : 0}" data-more="${extra}"><p class="kicker">${esc(tx('msg.consent.new_version'))}</p><h1 data-testid="msg.consent.renew.title">${esc(tx('msg.consent.renew.title'))}</h1><section class="card soft"><h2>${esc(title)}</h2><p class="muted" data-testid="msg.consent.version">${esc(tx('msg.consent.version', { v: row.version, date: date(row.published_at) }))}</p><p><a href="${URL_OF[kind]}" target="_blank" rel="noopener" data-testid="msg.consent.full_text">${esc(tx('msg.consent.full_text'))}</a></p></section>${blocking ? `<p class="callout" data-testid="msg.consent.new_version.required">${esc(tx('msg.consent.new_version.required'))}</p>` : ''}<label class="check-row reg-check"><input type="checkbox" data-testid="msg.consent.renew.check"><span>${esc(tx('msg.consent.renew.check'))}</span></label><p class="form-error" data-form-error aria-live="polite"></p><div class="acts"><button class="btn primary" type="button" data-testid="msg.consent.agree" data-accept>${esc(tx('msg.consent.renew.accept'))}</button>${blocking ? `<a class="btn ghost" href="/account/data" data-testid="msg.consent.renew.data">${esc(tx('msg.consent.renew.data'))}</a>` : `<a class="btn ghost" href="/onboarding/consent/later" data-testid="msg.consent.not_now">${esc(tx('msg.consent.renew.later'))}</a>`}</div></div>`,
    });
  }

  /** Принятие соглашения и согласия на обработку ПДн специалистом или администратором (Т-6). */
  function termsPage(user, next) {
    const agreement = service.status(user.id, 'agreement');
    const pd = service.status(user.id, 'staff_pd');
    const row = (c) =>
      `<li>${link(c.kind, `msg.terms.link.${c.kind}`)} <small class="muted">· ${esc(tx('msg.consent.version', { v: c.version, date: date(c.published_at) }))}</small></li>`;
    return shell({
      page: 'P-06',
      title: tx('msg.terms.title'),
      user,
      demo: config.demoMode,
      styles: STYLES,
      scripts: ['/js/consent_renew.js'],
      body: `<div class="reg renew" id="terms" data-terms="1" data-next="${esc(next)}"><h1 data-testid="msg.terms.title">${esc(tx('msg.terms.title'))}</h1><p class="lead">${esc(tx('msg.terms.lead'))}</p><ul class="legal-links">${row(agreement)}${row(service.status(user.id, 'privacy'))}${row(pd)}</ul><label class="check-row reg-check"><input type="checkbox" data-testid="msg.terms.check"><span>${esc(tx('msg.terms.check'))}</span></label><p class="form-error" data-form-error aria-live="polite"></p><div class="acts"><button class="btn primary" type="button" data-testid="msg.terms.accept" data-accept>${esc(tx('msg.terms.accept'))}</button></div></div>`,
    });
  }

  /** Заявка специалиста при попытке входа: на рассмотрении или отклонена (с причиной). */
  function applicationPage(application) {
    const rejected = application.status === 'rejected';
    return shell({
      page: 'P-02',
      title: tx(rejected ? 'msg.register.rejected.title' : 'msg.register.pending.title'),
      demo: config.demoMode,
      styles: STYLES,
      body: `<div class="reg"><section class="callout reg-done" data-testid="${rejected ? 'msg.register.rejected.title' : 'msg.register.pending.title'}"><h1>${esc(tx(rejected ? 'msg.register.rejected.title' : 'msg.register.pending.title'))}</h1><p>${esc(rejected ? tx('msg.register.rejected.text', { reason: application.reject_reason || '—' }) : tx('msg.register.pending.text'))}</p><p><a class="btn" href="${rejected ? '/register?as=specialist' : '/login'}">${esc(tx(rejected ? 'msg.register.rejected.again' : 'msg.register.pending.back'))}</a></p></section></div>${AUTH_FOOT}`,
    });
  }

  return { registerPage, docPage, renewPage, termsPage, applicationPage, SPECIALTIES, RENEW_STEPS };
}

module.exports = { createPages, SPECIALTIES };
