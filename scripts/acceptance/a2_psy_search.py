"""A2 PSY-009: поиск по заключениям и протоколам."""
from a2_common import *

with sync_playwright() as p:
    b = launch(p)
    ctx, y = login(b, 'plg', DESK)
    go(y, '/conclusions')
    log('fields', y.evaluate("[...document.querySelectorAll('main form')].map(f=>f.getAttribute('action')+' '+[...f.elements].map(e=>e.name).join(','))"))
    for q in ('Заключение по результатам', 'Лурия', 'zzzz-нет'):
        y.fill('input[name=q]', q)
        y.click('main form button[type=submit]')
        y.wait_for_load_state()
        t = y.inner_text('main')
        i = t.find('Найти')
        log('SEARCH', q, '->', t[i:i + 500].replace('\n', ' | '))
    shot(y, 'psy_search_desk')
    y.fill('input[name=q]', '')
    y.select_option('select[name=status]', 'signed')
    y.click('main form button[type=submit]'); y.wait_for_load_state()
    t = y.inner_text('main'); i = t.find('Найти')
    log('FILTER signed ->', t[i:i + 400].replace('\n', ' | '))
    b.close()
