"""A2: повторная проверка дефектов A1 (закрыты ли W2.X): D1, D3, D4, D5, D9, D13, D16, D19, D20, D22, D25 (+ мобильное переполнение клиницистских экранов)."""
from a2_common import *

with sync_playwright() as p:
    b = launch(p)
    # D1: выключить оценки у p1 -> врач видит 'не делится'
    ctx, pm = login(b, 'p1', DESK)
    go(pm, '/share')
    log('D9 /share chats toggle present:', pm.locator('input[name=chats]').count(), '| text:', 'диалог' in pm.inner_text('main').lower())
    log('share inputs', pm.evaluate("[...document.querySelectorAll('form input[type=checkbox]')].map(e=>e.name+'='+e.checked)"))
    pm.uncheck('input[name=scores]') if pm.locator('input[name=scores]').count() else None
    pm.click('form[action="/share"] button[type=submit]')
    pm.wait_for_load_state()
    ctx.close()
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/patients/5/visit')
    t = d.inner_text('main')
    log('D1 visit with scores off:', [l for l in t.split('\n') if 'Дневник' in l or 'не делится' in l][:3])
    go(d, '/patients/5/diary')
    log('D1 diary tab:', txt(d, 'main', 700)[330:700])
    ctx.close()
    ctx, pm = login(b, 'p1', DESK)
    go(pm, '/share')
    pm.check('input[name=scores]') if pm.locator('input[name=scores]').count() else None
    pm.click('form[action="/share"] button[type=submit]')
    ctx.close()
    # D3/D25: p6 без врача, /help
    ctx, n = login(b, 'p6', MOB)
    go(n, '/help')
    log('D3 /help nodoc:', txt(n, 'main', 900))
    log('D25 quick exit present:', n.locator('button:has-text("Быстрый выход"), a:has-text("Быстрый выход")').count())
    h = n.evaluate("(()=>{const e=[...document.querySelectorAll('a,button')].find(x=>/Мне плохо/.test(x.innerText));return e?e.getBoundingClientRect().height:null})()")
    log('D20 "Мне плохо" height px:', h)
    shot(n, 'a1chk_help_nodoc_mob')
    ctx.close()
    # D4, D16, D22, D19, D13
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/dashboard')
    log('D4 menu has Приглашения:', d.locator('nav a:has-text("Приглашения")').count(), '| D19 red banner on dashboard:', txt(d, 'main', 200))
    go(d, '/patients')
    log('D16 patients:', txt(d, 'main', 700))
    go(d, '/export')
    log('D22 /export page:', txt(d, 'main', 500))
    go(d, '/patients/5/materials')
    log('D5 materials:', txt(d, 'main', 700)[330:])
    go(d, '/ai')
    log('D13 empty alert strip:', d.evaluate("[...document.querySelectorAll('.flash,[role=alert],[role=status]')].filter(e=>e.offsetHeight>0&&!e.innerText.trim()).length"))
    ctx.close()
    ctx, d = login(b, 'psy1', MOB)
    for path in ('/patients', '/assignments', '/ai', '/dashboard', '/inbox', '/patients/5', '/patients/5/treatment', '/tools', '/crisis'):
        go(d, path)
        log('D6 MOB', path, 'ovf', overflow(d))
    ctx.close()
    b.close()
