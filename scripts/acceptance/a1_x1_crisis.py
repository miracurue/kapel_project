"""A1 X-1: пациент p1 проходит назначенный PHQ-9 (id берётся с /dashboard) с пунктом 9 = 2 на 390px; затем врачи и админ смотрят очередь."""
import re
from a0_common import *


def log(*a):
    print(*a, flush=True)


with sync_playwright() as p:
    b = launch(p)
    ctx, pat = login(b, 'p1', MOB)
    pat.goto(BASE + '/dashboard')
    href = pat.eval_on_selector('a[href*="/take"]', 'e=>e.getAttribute("href")')
    pat.goto(BASE + href)
    for i in range(9):
        txt = pat.inner_text('main')
        n = pat.locator('input[type=radio]').count()
        pick = 2 if i == 8 else 0
        pat.locator('input[type=radio]').nth(pick).check(force=True)
        if i == 8:
            pat.wait_for_timeout(300)
            log('Q9 TEXT:', pat.inner_text('main')[:900].replace('\n', ' | '))
            shot(pat, 'x1_phq9_item9_p1_mob', full=False)
        pat.click('main form[action*="/answer"] button[type=submit] >> nth=0')
        pat.wait_for_load_state()
    log('AFTER LAST', pat.url.replace(BASE, ''), pat.inner_text('main')[:900].replace('\n', ' | '))
    shot(pat, 'x1_phq9_after_p1_mob')
    ctx.close()
    b.close()
