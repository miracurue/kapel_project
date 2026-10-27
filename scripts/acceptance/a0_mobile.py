"""A0: мобильное меню, карточка пациента/назначение/прохождение на 390x844, замеры."""
from a0_common import *

with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'psy1', MOB)
    pg.goto(BASE + '/dashboard')
    print('menu expanded initially:', pg.get_attribute('#nav-toggle', 'aria-expanded'), 'nav visible', pg.is_visible('#sidenav'))
    shot(pg, 'mob_psy_dashboard_menu_closed', False)
    pg.click('#nav-toggle')
    print('after click expanded:', pg.get_attribute('#nav-toggle', 'aria-expanded'), 'nav visible', pg.is_visible('#sidenav'))
    shot(pg, 'mob_psy_menu_open', False)
    pg.goto(BASE + '/patients/5')
    shot(pg, 'mob_psy_patient_card', True)
    pg.locator('#assign').scroll_into_view_if_needed()
    pg.locator('#assign').screenshot(path=SHOTS + '/mob_assign_card.png')
    pg.locator('#protocols').screenshot(path=SHOTS + '/mob_protocol_card.png')
    print('nav tap target sizes', pg.eval_on_selector_all('#sidenav a', 'e=>e.map(x=>{const r=x.getBoundingClientRect();return [x.innerText,Math.round(r.width),Math.round(r.height)]})'))
    print('catalog item heights', pg.eval_on_selector_all('#assign .catalog-item', 'e=>e.slice(0,3).map(x=>Math.round(x.getBoundingClientRect().height))'))
    print('input font sizes', pg.eval_on_selector_all('input[type=text],input[type=search],input[type=number],textarea,select', 'e=>[...new Set(e.map(x=>getComputedStyle(x).fontSize))]'))
    # без JS
    c2 = b.new_context(java_script_enabled=False, **MOB)
    pj = c2.new_page(); pj.goto(BASE + '/login'); pj.fill('input[name=email]', ACC['psy1']); pj.fill('input[name=password]', PWD)
    pj.click('form[action="/login"] button[type=submit]'); pj.wait_for_load_state()
    pj.goto(BASE + '/patients/5'); print('noJS: card ok', pj.inner_text('h1')[:40], 'catalog items visible', pj.locator('#assign .catalog-item').count())
    # тёмная тема
    c3 = b.new_context(color_scheme='dark', **DESK)
    pd = c3.new_page(); pd.goto(BASE + '/login'); shot(pd, 'dark_login', False)
    # пациент mob
    ctx2, pt = login(b, 'p5', MOB)
    pt.goto(BASE + '/dashboard'); shot(pt, 'mob_patient5_dashboard', False)
    ctx3, p6 = login(b, 'p6', MOB); p6.goto(BASE + '/dashboard'); shot(p6, 'mob_patient6_nodoctor', False)
    ctx4, a = login(b, 'psy1', MOB); a.goto(BASE + '/crisis'); shot(a, 'mob_crisis_queue', False)
    # длинная вёрстка таблицы: контейнер прокручивается?
    pt.goto(BASE + '/dashboard')
    print('table-responsive overflow-x:', pt.eval_on_selector_all('.table-responsive', 'e=>e.map(x=>[getComputedStyle(x).overflowX, x.scrollWidth, x.clientWidth])'))
    b.close()
