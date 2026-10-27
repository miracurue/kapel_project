"""A1 X-3 часть 2: админ исполняет запрос на удаление пациента a1.new@example.com (первый в очереди)."""
from a0_common import *
def log(*a): print(*a, flush=True)
with sync_playwright() as p:
    b = launch(p)
    ctx, ad = login(b, 'admin')
    ad.goto(BASE + '/admin/deletion')
    ad.locator('a:has-text("Открыть")').first.click(); ad.wait_for_load_state()
    log('DETAIL', ad.url.replace(BASE, ''), ad.inner_text('main')[:900].replace('\n', ' | '))
    ad.locator('a:has-text("Исполнить"), a:has-text("Удалить")').first.click(); ad.wait_for_load_state()
    ad.fill('input[name=confirm_email]', 'a1.new@example.com')
    ad.click('button:has-text("Удалить данные безвозвратно")'); ad.wait_for_load_state()
    log('EXECUTED', ad.url.replace(BASE, ''), ad.inner_text('main')[:1500].replace('\n', ' | '))
    shot(ad, 'x3_admin_report_desk')
    b.close()
