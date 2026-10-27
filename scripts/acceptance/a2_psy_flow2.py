"""A2 J-Y1 часть 2: протокол частями, возврат, черновик, подпись."""
from a2_common import *

PID = 8
SID = 2


def forms(pg):
    return pg.evaluate("""()=>[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type).join(',')+']')""")


with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'plg', DESK)
    go(pg, '/patients/%d/exam/%d' % (PID, SID))
    for code in ('luria10', 'schulte'):
        if not pg.locator('input[name=instrument][value=%s]' % code).is_visible():
            pg.locator('summary:has-text("Добавить методику")').first.click()
        pg.check('input[name=instrument][value=%s]' % code)
        pg.click('form[action$="/plan"] button[type=submit]')
        pg.wait_for_load_state()
    log('AFTER PLAN', txt(pg, 'main', 300))
    log('FORMS', forms(pg))
    shot(pg, 'y1_exam_planned_desk')
    # форма протокола
    body = pg.inner_text('main')
    i = body.find('Батарея')
    log('MAIN tail', body[-1800:].replace('\n', ' | '))
    ctx.close()
    b.close()
