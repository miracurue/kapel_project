"""A1 X-2 п.1/4 (очный тест «ожидает ввода»), отмена назначения, пакет, срок/расписание. Пациент p1 (id 5), врач psy1."""
from a0_common import *


def log(*a):
    print(*a, flush=True)


with sync_playwright() as p:
    b = launch(p)
    ctx, psy = login(b, 'psy1')
    psy.goto(BASE + '/assignments')
    psy.locator('label:has-text("Светлова") input[name=patient_id]').check()
    psy.check('input[name=instrument][value=hdrs17]')
    psy.fill('input[name=comment]', 'Проверка ожидания ввода')
    psy.click('form[action="/assignments"] button[type=submit]')
    psy.wait_for_load_state()
    log('ASSIGN HDRS ->', psy.url.replace(BASE, ''), psy.inner_text('main')[:160].replace('\n', ' | '))
    psy.goto(BASE + '/patients/5/offline')
    t = psy.inner_text('main')
    i = t.find('Ожидают вашего ввода')
    log('WAITING BLOCK:', t[i:i + 300].replace('\n', ' | '))
    shot(psy, 'x2_waiting_entry_psy_desk', full=False)
    # пакет
    psy.goto(BASE + '/assignments')
    psy.locator('label:has-text("Светлова") input[name=patient_id]').check()
    psy.select_option('select[name=package]', index=3)
    psy.fill('input[name=due_date]', '2026-10-20')
    psy.fill('input[name=repeat_every]', '1')
    psy.click('form[action="/assignments"] button[type=submit]')
    psy.wait_for_load_state()
    log('PACKAGE ->', psy.url.replace(BASE, ''), psy.inner_text('main')[:600].replace('\n', ' | '))
    ctx.close()
    ctx, p1 = login(b, 'p1')
    p1.goto(BASE + '/tests')
    t = p1.inner_text('main')
    log('PATIENT sees HDRS:', 'Гамильтон' in t or 'HDRS' in t, '| sees comment/срок:', 'до 20.10' in t or '20.10.2026' in t, '|', t[:500].replace('\n', ' | '))
    shot(p1, 'x2_patient_tests_desk')
    ctx.close()
    # отмена
    ctx, psy = login(b, 'psy1')
    psy.goto(BASE + '/assignments?patient=5')
    n = psy.locator('form[action$="/cancel"]').count()
    log('cancel forms', n)
    if n:
        psy.locator('summary:has-text("Отменить назначение")').first.click()
        psy.locator('form[action$="/cancel"] button[type=submit]').first.click()
        psy.wait_for_load_state()
        log('CANCEL ->', psy.inner_text('main')[:200].replace('\n', ' | '))
    ctx.close()
    b.close()
