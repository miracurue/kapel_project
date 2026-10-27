"""A1: NFR-012 (двойная отправка), PAT-019 (профиль, пароль), NFR-006 (тёмная тема/крупный шрифт), PAT-024 (напоминания), R-вход/выход."""
from a0_common import *


def log(*a):
    print(*a, flush=True)


with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'patient10.private@example.com', MOB)
    for i in range(2):
        r = pg.request.post(BASE + '/help/contact', form={'message': 'двойная отправка'}, max_redirects=0)
        log('help/contact POST', i, r.status)
    pg.goto(BASE + '/profile')
    log('PROFILE:', pg.inner_text('main')[:900].replace('\n', ' | '))
    log('profile forms', pg.eval_on_selector_all('form', 'f=>f.map(x=>x.getAttribute("action")+":"+[...x.elements].map(e=>e.name).join(","))'))
    shot(pg, 'misc_profile_p10_mob')
    pg.goto(BASE + '/reminders')
    log('REMINDERS:', pg.inner_text('main')[:700].replace('\n', ' | '))
    ctx.close()
    ctx = b.new_context(color_scheme='dark', **MOB)
    pg = ctx.new_page()
    pg.goto(BASE + '/login')
    pg.fill('input[name=email]', ACC['p1'])
    pg.fill('input[name=password]', PWD)
    pg.click('form[action="/login"] button[type=submit]')
    pg.wait_for_load_state()
    shot(pg, 'misc_dark_p1_dashboard_mob', full=False)
    pg.goto(BASE + '/chat')
    shot(pg, 'misc_dark_p1_chat_mob', full=False)
    ctx.close()
    ctx, ad = login(b, 'admin')
    n = ad.request.get(BASE + '/admin/nobody').text().count('Тест Безврача')
    log('admin nobody still lists deleted nodoc patient name:', n)
    ctx.close()
    b.close()
