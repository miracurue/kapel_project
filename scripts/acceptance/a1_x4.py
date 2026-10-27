"""A1 X-4 / J-A2 / PAT-020: уход врача psy2 (id 3): админ переназначает пациентов на psy3 и деактивирует psy2; что видят пациент p3, psy3, psy2.
Затем: админ создаёт сотрудника, входит он с временным паролем (обязательная смена)."""
import re
from a0_common import *


def log(*a):
    print(*a, flush=True)


with sync_playwright() as p:
    b = launch(p)
    ctx, p3 = login(b, 'p3', MOB)
    p3.goto(BASE + '/dashboard')
    log('P3 BEFORE:', p3.inner_text('main')[:400].replace('\n', ' | '))
    ctx.close()
    ctx, ad = login(b, 'admin')
    ad.goto(BASE + '/admin/assignments/reassign?from=3')
    ad.select_option('select[name=to]', label='Демо Психиатр Беляев Д. К. (психиатр)')
    ad.click('button:has-text("Переназначить выбранных")')
    ad.wait_for_load_state()
    log('REASSIGN ->', ad.url.replace(BASE, ''), ad.inner_text('main')[:400].replace('\n', ' | '))
    ad.goto(BASE + '/admin/users/3/deactivate')
    log('DEACT PAGE', ad.inner_text('main')[:500].replace('\n', ' | '))
    ad.click('main form button[type=submit]')
    ad.wait_for_load_state()
    log('DEACT ->', ad.url.replace(BASE, ''), ad.inner_text('main')[:300].replace('\n', ' | '))
    ctx.close()
    ctx, p3 = login(b, 'p3', MOB)
    p3.goto(BASE + '/dashboard')
    log('P3 AFTER:', p3.inner_text('main')[:700].replace('\n', ' | '))
    shot(p3, 'x4_p3_after_mob')
    ctx.close()
    ctx, ps3 = b.new_context(**DESK), None
    pg = ctx.new_page()
    pg.goto(BASE + '/login')
    pg.fill('input[name=email]', 'psychiatrist3@example.com')
    pg.fill('input[name=password]', 'demo-pass-123')
    pg.click('form[action="/login"] button[type=submit]')
    pg.wait_for_load_state()
    log('PSY3 DASH:', pg.inner_text('main')[:900].replace('\n', ' | '))
    shot(pg, 'x4_psy3_dash_desk')
    pg.goto(BASE + '/crisis')
    log('PSY3 CRISIS:', pg.inner_text('main')[:700].replace('\n', ' | '))
    ctx.close()
    ctx = b.new_context(**DESK)
    pg = ctx.new_page()
    pg.goto(BASE + '/login')
    pg.fill('input[name=email]', 'psychiatrist2@example.com')
    pg.fill('input[name=password]', 'demo-pass-123')
    pg.click('form[action="/login"] button[type=submit]')
    pg.wait_for_load_state()
    log('PSY2 (deactivated) login ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:200].replace('\n', ' | '))
    ctx.close()
    # создание сотрудника
    ctx, ad = login(b, 'admin')
    ad.goto(BASE + '/admin/users/new')
    ad.fill('input[name=full_name]', 'Тест Новый Врач')
    ad.fill('input[name=email]', 'a1.doc@example.com')
    ad.select_option('select[name=role]', 'psychiatrist')
    ad.click('main form button[type=submit]')
    ad.wait_for_load_state()
    t = ad.inner_text('main')
    log('CREATED:', t[:500].replace('\n', ' | '))
    shot(ad, 'x4_admin_temp_pwd_desk')
    m = re.search(r'(?:пароль|Пароль)[^\n]*\n\s*([^\s\n]{8,})', t)
    ctx.close()
    pwd = None
    for tok in re.findall(r'\S{10,}', t):
        if re.search(r'[A-Za-z]', tok) and re.search(r'\d', tok) and '@' not in tok:
            pwd = tok
    log('TEMP PWD guess:', bool(pwd))
    if pwd:
        ctx = b.new_context(**DESK)
        pg = ctx.new_page()
        pg.goto(BASE + '/login')
        pg.fill('input[name=email]', 'a1.doc@example.com')
        pg.fill('input[name=password]', pwd)
        pg.click('form[action="/login"] button[type=submit]')
        pg.wait_for_load_state()
        log('NEW DOC LOGIN ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:400].replace('\n', ' | '))
        shot(pg, 'x4_forced_change_desk', full=False)
        pg.goto(BASE + '/dashboard')
        log('NEW DOC tries /dashboard before change ->', pg.url.replace(BASE, ''))
        ctx.close()
    b.close()
