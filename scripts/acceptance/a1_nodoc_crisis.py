"""A1 J-P12 + «сквозная 1»: пациент без врача (новая регистрация без кода): Главная, «Мне плохо» -> обращение админу,
ИИ-чат с кризисной фразой, дневниковая заметка с кризисной фразой; затем что видит админ. Параллельно фраза в дневнике у пациента с врачом (p1)."""
import re
from a0_common import *

PH = 'Не хочу жить, думаю покончить с собой'
EMAIL = 'a1.nodoc@example.com'


def log(*a):
    print(*a, flush=True)


with sync_playwright() as p:
    b = launch(p)
    ctx = b.new_context(**MOB)
    pg = ctx.new_page()
    pg.goto(BASE + '/register')
    pg.fill('input[name=full_name]', 'Тест Безврача')
    pg.fill('input[name=email]', EMAIL)
    pg.fill('input[name=password]', 'demo-pass-123')
    pg.check('input[name=consent_given]')
    pg.check('input[name=clinical_consent_given]')
    pg.click('main form button[type=submit]')
    pg.wait_for_load_state()
    pg.fill('input[name=email]', EMAIL)
    pg.fill('input[name=password]', 'demo-pass-123')
    pg.click('form[action="/login"] button[type=submit]')
    pg.wait_for_load_state()
    log('ONBOARD', pg.url.replace(BASE, ''))
    for i in range(3):
        btn = pg.locator('main a:has-text("Дальше"), main button:has-text("Дальше"), main button:has-text("Готово"), main a:has-text("Готово"), main button:has-text("Начать")')
        if btn.count():
            btn.first.click()
            pg.wait_for_load_state()
    shot(pg, 'nodoc_onboard_end_mob', full=False)
    pg.goto(BASE + '/dashboard')
    log('DASH', pg.inner_text('main')[:700].replace('\n', ' | '))
    shot(pg, 'nodoc_dashboard_mob')
    # Мне плохо
    pg.click('a:has-text("Мне плохо")')
    pg.wait_for_load_state()
    log('HELP', pg.url.replace(BASE, ''))
    pg.fill('textarea[name=message]', 'Мне очень тяжело сегодня')
    pg.click('form[action="/help/contact"] button[type=submit]')
    pg.wait_for_load_state()
    log('HELP SENT ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:600].replace('\n', ' | '))
    shot(pg, 'nodoc_help_sent_mob')
    # чат с кризисной фразой
    pg.goto(BASE + '/chat')
    ta = pg.locator('textarea').first
    ta.fill(PH)
    pg.locator('button:has-text("Отправить")').first.click()
    pg.wait_for_timeout(4000)
    log('CHAT CRISIS:', pg.inner_text('main')[-1100:].replace('\n', ' | '))
    shot(pg, 'nodoc_chat_crisis_mob')
    # дневник с кризисной фразой
    pg.goto(BASE + '/diary')
    pg.locator('input[name=mood_score]').nth(0).check(force=True)
    pg.evaluate(f"document.querySelector('textarea[name=note]').value='{PH}'")
    pg.click('form[action="/diary"] button[type=submit]')
    pg.wait_for_load_state()
    log('DIARY CRISIS:', pg.inner_text('main')[:700].replace('\n', ' | '))
    shot(pg, 'nodoc_diary_crisis_mob')
    ctx.close()

    ctx, ad = login(b, 'admin')
    ad.goto(BASE + '/dashboard')
    log('ADMIN DASH', ad.inner_text('main')[:500].replace('\n', ' | '))
    ad.goto(BASE + '/admin/nobody')
    log('ADMIN NOBODY', ad.inner_text('main')[:2200].replace('\n', ' | '))
    shot(ad, 'nodoc_admin_nobody_desk')
    ctx.close()
    b.close()
