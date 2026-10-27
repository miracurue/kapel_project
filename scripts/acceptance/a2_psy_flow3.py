"""A2 J-Y1 часть 3: автосохранение протокола, черновик, подпись, правка, выдача."""
from a2_common import *

PID, SID = 8, 2


def forms(pg):
    return pg.evaluate("""()=>[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type).join(',')+']')""")


with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'plg', DESK)
    go(pg, '/patients/%d/exam/%d' % (PID, SID))
    f = 'form[action$="/protocol/luria10"]'
    pg.fill(f + ' textarea[name=verbatim]', 'Дом, лес, стол, окно, кот (1-я попытка); дождь вместо дом.')
    pg.fill(f + ' input[name=score]', '7')
    pg.wait_for_timeout(2500)  # автосохранение
    log('autosave status:', txt(pg, f, 600)[-300:])
    pg.fill(f + ' textarea[name=observations]', 'Утомляем, темп ровный')
    # закрыть вкладку сразу, без ожидания: данные последнего поля?
    go(pg, '/dashboard')
    go(pg, '/patients/%d/exam/%d' % (PID, SID))
    log('AFTER RETURN: verbatim=', pg.input_value(f + ' textarea[name=verbatim]'), '| score=', pg.input_value(f + ' input[name=score]'), '| obs=', pg.input_value(f + ' textarea[name=observations]'))
    shot(pg, 'y1_exam_autosave_desk')
    # вторая методика через кнопку
    f2 = 'form[action$="/protocol/schulte"]'
    pg.fill(f2 + ' input[name=duration_sec]', '48')
    pg.fill(f2 + ' input[name=errors]', '2')
    pg.click(f2 + ' button[name=ready]')
    pg.wait_for_load_state()
    log('after ready:', txt(pg, 'main', 700)[300:700])
    # создать заключение
    go(pg, '/patients/%d/conclusions' % PID)
    pg.fill('form[action$="/conclusions"] input[name=title]', 'Заключение (приёмка A2)')
    pg.click('form[action$="/conclusions"] button[type=submit]')
    pg.wait_for_load_state()
    url = pg.url
    log('CONCLUSION URL', url.replace(BASE, ''))
    log('TEXT', txt(pg, 'main', 3500))
    log('FORMS', forms(pg))
    shot(pg, 'y1_conclusion_draft_desk')
    open('/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/concl_url.txt', 'w').write(url)
    ctx.close()
    ctx, pg = login(b, 'plg', MOB)
    pg.goto(url)
    log('MOB ovf', overflow(pg))
    shot(pg, 'y1_conclusion_draft_mob')
    b.close()
