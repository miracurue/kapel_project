"""A1 X-3 / J-A3: удаление пациента с контентом (a1.nodoc: чат, дневник, обращение, кризис-цитата). Запрос пациентом -> исполнение админом."""
from a0_common import *
def log(*a): print(*a, flush=True)
E='a1.nodoc@example.com'
with sync_playwright() as p:
    b = launch(p)
    ctx = b.new_context(**MOB); pn = ctx.new_page()
    pn.goto(BASE + '/login'); pn.fill('input[name=email]', E); pn.fill('input[name=password]', 'demo-pass-123')
    pn.click('form[action="/login"] button[type=submit]'); pn.wait_for_load_state()
    pn.goto(BASE + '/privacy/delete'); pn.click('button:has-text("Да, отозвать согласие")'); pn.wait_for_load_state()
    log('REQ', pn.inner_text('main')[:150].replace('\n',' | '))
    ctx.close()
    ctx, ad = login(b, 'admin')
    ad.goto(BASE + '/admin/deletion')
    ad.locator('a:has-text("Открыть")').first.click(); ad.wait_for_load_state()
    log('DETAIL', ad.inner_text('main')[:1200].replace('\n', ' | '))
    ad.locator('a:has-text("Исполнить"), a:has-text("Удалить")').first.click(); ad.wait_for_load_state()
    log('CONFIRM PAGE', ad.inner_text('main')[:700].replace('\n',' | '))
    ad.fill('input[name=confirm_email]', E)
    if ad.locator('input[name=force_open]').count(): ad.check('input[name=force_open]')
    ad.click('button:has-text("Удалить данные безвозвратно")'); ad.wait_for_load_state()
    log('EXECUTED', ad.inner_text('main')[:1800].replace('\n', ' | '))
    shot(ad, 'x3_admin_report2_desk')
    b.close()
