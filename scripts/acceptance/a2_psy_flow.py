"""A2 J-Y1: психолог: сеанс обследования -> протокол -> черновик -> подпись (ошибка пароля/успех) -> правка=новая версия -> выдача пациенту -> пациент видит."""
from a2_common import *
import re

PID = 8  # patient4.inactive (Лебедев), у психолога plg


def forms(pg):
    return pg.evaluate("""()=>[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type).join(',')+']')""")


with sync_playwright() as p:
    b = launch(p)
    for prof, pn in ((DESK, 'desk'), (MOB, 'mob')):
        ctx, pg = login(b, 'plg', prof)
        go(pg, '/patients/%d/conclusions' % PID)
        log(pn, 'FORMS list', forms(pg))
        shot(pg, 'y1_card_conclusions_%s' % pn)
        if pn == 'mob':
            ctx.close(); continue
        # создать сеанс
        pg.locator('form[action$="/exam"] button[type=submit]').first.click()
        pg.wait_for_load_state()
        log('EXAM URL', pg.url.replace(BASE, ''), txt(pg, 'main', 1800))
        log('EXAM FORMS', forms(pg))
        shot(pg, 'y1_exam_%s' % pn)
        exam_url = pg.url
        ctx.close()
    b.close()
