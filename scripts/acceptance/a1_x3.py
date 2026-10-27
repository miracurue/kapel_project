"""A1 X-3: (1) p1 отзывает научное согласие -> CSV экспорта до/после; (2) a1.new (привязан к psy1) запрашивает удаление ->
что видит врач, вход блокирован, админ исполняет -> проверка БД (скриптом снаружи) и входа. Печатает наблюдения."""
import re, sys
from a0_common import *


def log(*a):
    print(*a, flush=True)


def csv_rows(page):
    r = page.request.get(BASE + '/export/comparisons.csv')
    t = r.text()
    return r.status, len(t.strip().splitlines()) - 1, t[:150].replace('\n', ' / ')


with sync_playwright() as p:
    b = launch(p)
    ctx, psy = login(b, 'psy1')
    log('CSV before revoke', csv_rows(psy))
    ctx2, p1 = login(b, 'p1')
    p1.goto(BASE + '/privacy')
    p1.click('button:has-text("Отозвать согласие на научное использование")')
    p1.wait_for_load_state()
    log('REVOKE ->', p1.url.replace(BASE, ''), p1.inner_text('main')[:300].replace('\n', ' | '))
    if p1.locator('main button:has-text("Отозвать")').count():
        p1.locator('main button:has-text("Отозвать"), main button:has-text("Да")').first.click()
        p1.wait_for_load_state()
        log('REVOKE confirmed ->', p1.inner_text('main')[:300].replace('\n', ' | '))
    log('CSV after revoke', csv_rows(psy))
    ctx2.close()

    # удаление: a1.new
    ctx3 = b.new_context(**MOB)
    pn = ctx3.new_page()
    pn.goto(BASE + '/login')
    pn.fill('input[name=email]', 'a1.new@example.com')
    pn.fill('input[name=password]', 'demo-pass-123')
    pn.click('form[action="/login"] button[type=submit]')
    pn.wait_for_load_state()
    pn.goto(BASE + '/privacy')
    pn.click('a:has-text("Перейти к запросу на удаление")')
    pn.wait_for_load_state()
    log('DELETE PAGE', pn.url.replace(BASE, ''), pn.inner_text('main')[:1200].replace('\n', ' | '))
    shot(pn, 'x3_delete_request_mob')
    pn.click('button:has-text("Да, отозвать согласие")')
    pn.wait_for_load_state()
    log('DELETE REQUESTED ->', pn.url.replace(BASE, ''), pn.inner_text('main')[:500].replace('\n', ' | '))
    pn.goto(BASE + '/dashboard')
    log('DASH after request ->', pn.url.replace(BASE, ''))
    ctx3.close()
    ctx4 = b.new_context(**MOB)
    pl = ctx4.new_page()
    pl.goto(BASE + '/login')
    pl.fill('input[name=email]', 'a1.new@example.com')
    pl.fill('input[name=password]', 'demo-pass-123')
    pl.click('form[action="/login"] button[type=submit]')
    pl.wait_for_load_state()
    log('LOGIN after request ->', pl.url.replace(BASE, ''), pl.inner_text('main')[:300].replace('\n', ' | '))
    shot(pl, 'x3_login_blocked_mob', full=False)
    ctx4.close()

    # врач
    psy.goto(BASE + '/patients')
    t = psy.inner_text('main')
    log('PSY LIST mentions a1.new:', 'Тест Приёмки' in t, re.findall(r'[^\n]*Тест Приёмки[^\n]*\n?[^\n]*', t)[:1])
    link = psy.locator('a:has-text("Тест Приёмки")')
    if link.count():
        link.first.click()
        psy.wait_for_load_state()
        log('PSY CARD:', psy.inner_text('main')[:600].replace('\n', ' | '))
        shot(psy, 'x3_card_delete_requested_psy_desk', full=False)
        psy.goto(psy.url.split('?')[0] + '/offline')
        log('PSY assign attempt: has assign form', psy.locator('form[action="/assignments"]').count())
    ctx.close()

    # админ
    ctx, ad = login(b, 'admin')
    ad.goto(BASE + '/admin/deletion')
    t = ad.inner_text('main')
    log('ADMIN QUEUE', t[:500].replace('\n', ' | '))
    shot(ad, 'x3_admin_queue_desk')
    ad.locator('a:has-text("Открыть")').last.click()
    ad.wait_for_load_state()
    log('ADMIN DETAIL', ad.url.replace(BASE, ''), ad.inner_text('main')[:1600].replace('\n', ' | '))
    shot(ad, 'x3_admin_detail_desk')
    ad.locator('a:has-text("Исполнить"), a:has-text("Удалить")').first.click()
    ad.wait_for_load_state()
    ad.fill('input[name=confirm_email]', 'a1.new@example.com')
    ad.click('button:has-text("Удалить данные безвозвратно")')
    ad.wait_for_load_state()
    log('ADMIN EXECUTED', ad.url.replace(BASE, ''), ad.inner_text('main')[:1500].replace('\n', ' | '))
    shot(ad, 'x3_admin_report_desk')
    ctx.close()

    ctx5 = b.new_context(**MOB)
    pl = ctx5.new_page()
    pl.goto(BASE + '/login')
    pl.fill('input[name=email]', 'a1.new@example.com')
    pl.fill('input[name=password]', 'demo-pass-123')
    pl.click('form[action="/login"] button[type=submit]')
    pl.wait_for_load_state()
    log('LOGIN after deletion ->', pl.url.replace(BASE, ''), pl.inner_text('main')[:300].replace('\n', ' | '))
    ctx5.close()
    b.close()
