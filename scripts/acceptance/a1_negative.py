"""A1: негативные проверки. IDOR (чужие assignment/thread/patient/material/escalation), CSRF, XSS, права ролей, no-store после выхода, без JS, двойной сабмит."""
from a0_common import *


def log(*a):
    print(*a, flush=True)


def st(page, method, url, **kw):
    r = getattr(page.request, method)(BASE + url, max_redirects=0, **kw)
    return r.status, (r.headers.get('location') or '')


with sync_playwright() as p:
    b = launch(p)
    # пациент p1 (id 5): чужие объекты
    ctx, p1 = login(b, 'p1')
    for u in ['/assignments/72/result', '/assignments/72/take', '/chat/t/5', '/chat/t/4/delete', '/diary/191/edit', '/reminders/9/edit', '/patients/6', '/crisis', '/ai', '/admin/users', '/export', '/export/comparisons.csv', '/invites', '/assignments']:
        log('p1 GET', u, st(p1, 'get', u))
    log('p1 POST /assignments (назначить себе)', st(p1, 'post', '/assignments', form={'patient_id': '5', 'instrument': 'phq9'}))
    log('p1 POST answer чужого', st(p1, 'post', '/assignments/72/answer', form={'i': '0', 'value': '0'}))
    log('p1 POST submit чужого', st(p1, 'post', '/assignments/72/submit'))
    log('p1 POST crisis ack', st(p1, 'post', '/crisis/1/acknowledge'))
    ctx.close()
    # клиницист psy1: чужой пациент (7 у psy2/plg?), чужая эскалация
    ctx, psy = login(b, 'psy1')
    for u in ['/patients/7', '/patients/7/diary', '/patients/9', '/crisis/6', '/crisis/9999', '/ai/t/1', '/ai/t/4', '/ai/materials/1/download', '/admin', '/admin/users', '/export', '/export/comparisons.csv']:
        log('psy1 GET', u, st(psy, 'get', u))
    log('psy1 POST assign чужому', st(psy, 'post', '/assignments', form={'patient_id': '7', 'instrument': 'phq9'}))
    log('psy1 POST ack чужой эскалации', st(psy, 'post', '/crisis/6/acknowledge'))
    log('psy1 POST new thread чужой пациент', st(psy, 'post', '/ai/new', form={'patient_id': '7'}))
    # CSRF: форма без токена
    log('CSRF: psy1 POST /invites без токена', st(psy, 'post', '/invites'))
    log('CSRF: POST /logout без токена', st(psy, 'post', '/logout'))
    ctx.close()
    # психолог — права: у plg нет лечения/ИИ?
    ctx, plg = login(b, 'plg')
    for u in ['/patients/5/treatment', '/patients/5/notes', '/ai', '/invites']:
        log('plg GET', u, st(plg, 'get', u))
    ctx.close()
    # админ: клинические страницы
    ctx, ad = login(b, 'admin')
    for u in ['/patients', '/patients/5', '/crisis', '/ai', '/export', '/admin/audit?log=phi&format=csv']:
        log('admin GET', u, st(ad, 'get', u))
    ctx.close()
    # XSS: пациент пишет заметку/ФИО-подобное
    ctx, p8 = login(b, 'p1')
    p8.goto(BASE + '/diary')
    X = '<img src=x onerror=window.__x=1><script>window.__y=1</script>'
    p8.locator('input[name=mood_score]').nth(5).check(force=True)
    p8.evaluate("(x)=>{document.querySelector('textarea[name=note]').value=x; document.querySelector('input[name=triggers]').value=x}", X)
    p8.click('form[action="/diary"] button[type=submit]')
    p8.wait_for_load_state()
    p8.goto(BASE + '/diary?all=1')
    log('XSS patient diary executed:', p8.evaluate('!!window.__x || !!window.__y'), '| literal visible:', '<img' in p8.inner_text('body'))
    # чат XSS
    p8.goto(BASE + '/chat')
    p8.locator('textarea').first.fill(X)
    p8.locator('button:has-text("Отправить")').first.click()
    p8.wait_for_timeout(3500)
    log('XSS chat executed:', p8.evaluate('!!window.__x || !!window.__y'))
    ctx.close()
    # у врача: виден ли XSS в карточке (заметки включены?) и в журнале
    ctx, psy = login(b, 'psy1')
    for u in ['/patients/5/diary', '/patients/5/journal', '/patients/5']:
        psy.goto(BASE + u)
        log('XSS clinician', u, psy.evaluate('!!window.__x || !!window.__y'))
    # заметка врача
    psy.goto(BASE + '/patients/5/notes')
    log('notes forms', psy.eval_on_selector_all('form', 'f=>f.map(x=>x.getAttribute("action"))'))
    ctx.close()
    # без JS: вход -> главная -> дневник -> тест
    ctx = b.new_context(java_script_enabled=False, **MOB)
    pg = ctx.new_page()
    pg.goto(BASE + '/login')
    pg.fill('input[name=email]', ACC['p1'])
    pg.fill('input[name=password]', PWD)
    pg.click('form[action="/login"] button[type=submit]')
    pg.wait_for_load_state()
    log('noJS dash', pg.url.replace(BASE, ''), pg.inner_text('main')[:80].replace('\n', ' | '))
    pg.goto(BASE + '/diary')
    pg.locator('input[name=mood_score]').nth(6).check(force=True)
    pg.click('form[action="/diary"] button[type=submit]')
    pg.wait_for_load_state()
    log('noJS diary save:', pg.inner_text('main')[:90].replace('\n', ' | '))
    pg.goto(BASE + '/chat')
    log('noJS chat has form:', pg.locator('form').count(), pg.inner_text('main')[:120].replace('\n', ' | '))
    shot(pg, 'nojs_chat_p1_mob', full=False)
    pg.goto(BASE + '/dashboard')
    pg.click('a:has-text("Выйти"), button:has-text("Выйти")')
    pg.wait_for_load_state()
    pg.go_back()
    pg.wait_for_load_state()
    log('noJS back after logout ->', pg.url.replace(BASE, ''), pg.inner_text('body')[:80].replace('\n', ' | '))
    ctx.close()
    # назад после выхода (с JS)
    ctx, pg = login(b, 'p1', MOB)
    pg.goto(BASE + '/privacy')
    pg.click('button:has-text("Выйти")')
    pg.wait_for_load_state()
    pg.go_back()
    pg.wait_for_timeout(500)
    log('back after logout (JS) ->', pg.url.replace(BASE, ''), '| shows private:', 'Кто смотрел' in pg.inner_text('body'))
    ctx.close()
    b.close()
