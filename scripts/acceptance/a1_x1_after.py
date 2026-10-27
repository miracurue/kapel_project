"""A1 X-1 часть 2: отправка PHQ-9 (id аргументом), результат пациента, что видят psy1, plg, admin."""
import sys
from a0_common import *


def log(*a):
    print(*a, flush=True)


aid = sys.argv[1]
with sync_playwright() as p:
    b = launch(p)
    ctx, pat = login(b, 'p1', MOB)
    pat.goto(BASE + f'/assignments/{aid}/review')
    pat.click('form[action$="/submit"] button[type=submit]')
    pat.wait_for_load_state()
    log('RESULT', pat.url.replace(BASE, ''), pat.inner_text('main')[:1500].replace('\n', ' | '))
    shot(pat, 'x1_result_p1_mob')
    # F5 / двойная отправка
    r = pat.request.post(BASE + f'/assignments/{aid}/submit', max_redirects=0)
    log('RESUBMIT status', r.status)
    pat.goto(BASE + '/dashboard')
    log('DASH after', pat.inner_text('main')[:500].replace('\n', ' | '))
    ctx.close()
    for who in ('psy1', 'plg', 'admin'):
        ctx, pg = login(b, who)
        pg.goto(BASE + '/dashboard')
        log(who, 'DASH', pg.inner_text('main')[:900].replace('\n', ' | '))
        shot(pg, f'x1_dash_{who}_desk')
        pg.goto(BASE + '/crisis' if who != 'admin' else '/admin/nodoctor')
        log(who, 'CRISIS', pg.url.replace(BASE, ''), pg.inner_text('main')[:1300].replace('\n', ' | '))
        shot(pg, f'x1_crisis_{who}_desk')
        ctx.close()
    b.close()
