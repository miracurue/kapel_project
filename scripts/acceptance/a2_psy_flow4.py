"""A2 J-Y1 часть 4: подпись (неверный пароль, 5 попыток -> блокировка), подпись верным, правка после подписи, новая версия, выдача, пациент."""
from a2_common import *

U = open('/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/concl_url.txt').read()


def forms(pg):
    return pg.evaluate("""()=>[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type).join(',')+']')""")


with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'plg', DESK)
    pg.goto(U)
    pg.fill('textarea[name=summary]', 'Данные демонстрационные. Снижение темпа к концу задания, по наблюдению.')
    pg.fill('textarea[name=recommendations]', 'Повторное обследование через 3 месяца.')
    pg.click('form[action$="/conclusions/3"] button[type=submit]')
    pg.wait_for_load_state()
    log('SAVED:', txt(pg, 'main', 200))
    # подпись неверным паролем
    for i in range(6):
        pg.fill('form[action$="/sign"] input[name=confirm_password]', 'wrong-%d' % i)
        pg.click('form[action$="/sign"] button[type=submit]')
        pg.wait_for_load_state()
        log('WRONG', i, pg.url.replace(BASE, ''), txt(pg, '[role=alert],.flash,.alert', 250))
        if i == 0:
            shot(pg, 'y1_sign_wrong_desk')
    # верный пароль во время блокировки
    pg.fill('form[action$="/sign"] input[name=confirm_password]', PWD)
    pg.click('form[action$="/sign"] button[type=submit]')
    pg.wait_for_load_state()
    log('RIGHT during lockout:', txt(pg, '[role=alert],.flash,.alert', 250))
    # подпись ФИО+флажок
    pg.fill('form[action$="/sign"] input[name=confirm_name]', 'Демо Психолог Белова Е. Н.')
    pg.check('form[action$="/sign"] input[name=confirm_check]')
    pg.click('form[action$="/sign"] button[type=submit]')
    pg.wait_for_load_state()
    log('SIGN by name:', txt(pg, 'main', 1500))
    log('FORMS', forms(pg))
    shot(pg, 'y1_signed_desk')
    ctx.close()
    b.close()
