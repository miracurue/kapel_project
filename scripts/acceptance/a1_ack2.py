"""A1 J-C5: повторное подтверждение уже обработанной эскалации вторым врачом: что видит человек."""
from a0_common import *
with sync_playwright() as p:
    b = launch(p)
    ctx1, a = login(b, 'psy1')
    ctx2, c = login(b, 'plg')
    ids = a.eval_on_selector_all('form[action$="/acknowledge"]', 'e=>e.map(x=>x.getAttribute("action"))') if a.goto(BASE + '/crisis') else []
    c.goto(BASE + '/crisis')
    shared = [i for i in ids if c.locator(f'form[action="{i}"]').count()]
    print('shared', shared)
    tgt = shared[0]
    a.locator(f'form[action="{tgt}"] button[type=submit]').first.click()
    a.wait_for_load_state()
    print('psy1 ack ->', a.inner_text('main')[:120].replace('\n', ' | '))
    c.locator(f'form[action="{tgt}"] button[type=submit]').first.click()
    c.wait_for_load_state()
    print('plg stale ack ->', c.url.replace(BASE, ''), c.inner_text('main')[:260].replace('\n', ' | '))
    shot(c, 'ack_collision_plg_desk', full=False)
    b.close()
