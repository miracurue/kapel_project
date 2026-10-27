"""A1 CRI-001/002/003: бейдж в <title>, таймер SLA без перезагрузки (psy3 после переназначения), двойное подтверждение двумя врачами (psy1/plg — общий пациент)."""
from a0_common import *
with sync_playwright() as p:
    b = launch(p)
    ctx = b.new_context(**DESK)
    pg = ctx.new_page()
    pg.goto(BASE + '/login')
    pg.fill('input[name=email]', 'psychiatrist3@example.com')
    pg.fill('input[name=password]', PWD)
    pg.click('form[action="/login"] button[type=submit]')
    pg.wait_for_load_state()
    print('title on dashboard:', pg.title())
    pg.goto(BASE + '/crisis')
    t1 = pg.inner_text('main')
    import re
    m1 = re.findall(r'осталось \d+ мин|просрочено на [^\n]+', t1)
    pg.wait_for_timeout(65000)
    t2 = pg.inner_text('main')
    m2 = re.findall(r'осталось \d+ мин|просрочено на [^\n]+', t2)
    print('timer before/after 65s without reload:', m1[:2], m2[:2])
    ctx.close()
    # два врача на одного пациента: Громов (id 6) psy1 + plg
    ctx1, a = login(b, 'psy1')
    ctx2, c = login(b, 'plg')
    a.goto(BASE + '/crisis')
    c.goto(BASE + '/crisis')
    fa = a.locator('form[action$="/acknowledge"]')
    ids = a.eval_on_selector_all('form[action$="/acknowledge"]', 'e=>e.map(x=>x.getAttribute("action"))')
    print('open acks psy1', ids)
    shared = [i for i in ids if c.locator(f'form[action="{i}"]').count()]
    print('shared with plg', shared)
    if shared:
        r1 = a.request.post(BASE + shared[0], max_redirects=0)
        r2 = c.request.post(BASE + shared[0], max_redirects=0)
        print('ack by psy1', r1.status, '| second ack by plg', r2.status)
        c.goto(BASE + '/crisis')
        print('plg queue after:', c.inner_text('main')[250:500].replace('\n', ' | '))
    b.close()
