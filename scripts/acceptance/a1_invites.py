"""A1 J-P1/J-C11/J-P12: код-приглашение: создание врачом, регистрация с кодом (в т.ч. неверный код), привязка позже (p6), повтор кода, отзыв."""
import re, os
from a0_common import *


def log(*a):
    print(*a, flush=True)


with sync_playwright() as p:
    b = launch(p)
    ctx, psy = login(b, 'psy1')
    psy.goto(BASE + '/patients')
    log('PATIENTS has invite link:', psy.locator('a[href="/invites"]').count(), '| nav links', psy.eval_on_selector_all('nav a', 'e=>e.map(x=>x.innerText.trim())'))
    psy.goto(BASE + '/invites')
    psy.click('form[action="/invites"] button[type=submit]')
    psy.wait_for_load_state()
    txt = psy.inner_text('main')
    log('INVITE PAGE after create:', txt[:600].replace('\n', ' | '))
    codes = re.findall(r'[A-Z0-9]{4}-[A-Z0-9]{4}', txt)
    log('CODES', codes)
    shot(psy, 'inv_clinician_desk')
    code = os.environ.get('CODE') or (codes[0] if codes else 'XXXX-XXXX')
    ctx.close()

    # регистрация с неверным кодом
    ctx = b.new_context(**MOB)
    pg = ctx.new_page()
    pg.goto(BASE + '/register')
    pg.fill('input[name=full_name]', 'Тест Приёмки')
    pg.fill('input[name=email]', 'a1.new@example.com')
    pg.fill('input[name=password]', 'demo-pass-123')
    pg.fill('input[name=invite_code]', 'ZZZZ-9999')
    pg.check('input[name=consent_given]')
    pg.check('input[name=clinical_consent_given]')
    pg.click('main form button[type=submit]')
    pg.wait_for_load_state()
    log('BAD CODE ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:300].replace('\n', ' | '))
    shot(pg, 'inv_badcode_mob')
    log('form kept:', pg.input_value('input[name=full_name]') if pg.locator('input[name=full_name]').count() else 'no form')
    # корректная регистрация с кодом
    if pg.locator('input[name=full_name]').count() == 0:
        pg.goto(BASE + '/register')
        pg.fill('input[name=full_name]', 'Тест Приёмки')
        pg.fill('input[name=email]', 'a1.new@example.com')
        pg.fill('input[name=password]', 'demo-pass-123')
        pg.check('input[name=consent_given]')
        pg.check('input[name=clinical_consent_given]')
    pg.fill('input[name=password]', 'demo-pass-123')
    pg.check('input[name=consent_given]') if not pg.is_checked('input[name=consent_given]') else None
    pg.check('input[name=clinical_consent_given]') if not pg.is_checked('input[name=clinical_consent_given]') else None
    pg.fill('input[name=invite_code]', code)
    pg.click('main form button[type=submit]')
    pg.wait_for_load_state()
    log('REGISTER OK ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:400].replace('\n', ' | '))
    if '/login' in pg.url:
        pg.fill('input[name=email]', 'a1.new@example.com')
        pg.fill('input[name=password]', 'demo-pass-123')
        pg.click('form[action="/login"] button[type=submit]')
        pg.wait_for_load_state()
    log('AFTER LOGIN ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:500].replace('\n', ' | '))
    shot(pg, 'inv_onboarding_mob')
    ctx.close()

    ctx, psy = login(b, 'psy1')
    psy.goto(BASE + '/patients')
    log('PSY LIST has a1.new:', 'Тест Приёмки' in psy.inner_text('main'), psy.inner_text('main')[:300].replace('\n', ' | '))
    shot(psy, 'inv_patients_psy_desk')
    psy.goto(BASE + '/invites')
    log('INVITES after use:', psy.inner_text('main')[100:500].replace('\n', ' | '))
    ctx.close()

    b.close()
