"""A0: сквозные сценарии. S1 назначил-прошёл-увидел (психиатр и психолог), S2 clinician_entered, S3 пациент без врача, S4 кризис, права."""
import re
from a0_common import *

def log(*a): print(*a, flush=True)

def assign(page, pid, code):
    page.goto(f'{BASE}/patients/{pid}')
    page.check(f'#assign input[name=instrument][value={code}]')
    page.click('#assign button[type=submit]')
    page.wait_for_load_state()
    return page.inner_text('main') if page.query_selector('main') else page.inner_text('body')

def take(page, expect_stub=True):
    # открыть первое назначение на дашборде
    page.goto(BASE + '/dashboard')
    links = page.eval_on_selector_all('a[href*="/assignments/"]', 'e=>e.map(x=>[x.innerText.trim(),x.getAttribute("href")])')
    return links

with sync_playwright() as p:
    b = launch(p)
    # ---- S1: психиатр назначает zung_sds, психолог назначает bai одному пациенту p1 (id 5)
    ctx, psy = login(b, 'psy1')
    t = assign(psy, 5, 'zung_sds'); log('S1 psy assign:', 'назначена' in t, t[:100].replace('\n', ' '))
    shot(psy, 's1_psy_assigned_desk')
    ctx2, plg = login(b, 'plg')
    t = assign(plg, 5, 'bai'); log('S1 plg assign:', 'назначена' in t)
    # поиск: пикер
    plg.goto(f'{BASE}/patients/5')
    plg.fill('#assignPicker-search', 'цунг')
    vis = plg.eval_on_selector_all('#assignPicker .catalog-item', 'e=>e.filter(x=>x.style.display!=="none").length')
    log('S1 search "цунг" visible items', vis)
    plg.fill('#assignPicker-search', 'zzzz'); log('S1 empty-search msg visible', plg.is_visible('#assignPicker .catalog-empty'))
    n_cat = plg.eval_on_selector_all('#assignPicker .catalog-item', 'e=>e.length')
    n_prot = plg.eval_on_selector_all('#protocolPicker .catalog-item', 'e=>e.length')
    log('S1 picker counts assign/protocol', n_cat, n_prot)
    # пациент
    ctx3, pat = login(b, 'p1')
    pat.goto(BASE + '/dashboard')
    txt = pat.inner_text('body')
    log('S1 patient sees SDS:', 'Цунга (SDS)' in txt, 'BAI:', 'BAI' in txt)
    shot(pat, 's1_patient_dashboard_assigned_desk')
    ids = pat.eval_on_selector_all('a[href*="/assignments/"]', 'e=>e.map(x=>x.getAttribute("href"))')
    log('S1 take links', ids)
    for href in [i for i in ids if int(i.split('/')[2]) > 100]:
        pat.goto(BASE + href)
        log('  take page title/h1:', pat.inner_text('h1'), '| has disclaimer', 'Демонстрационная' in pat.inner_text('body'), '| progress', bool(re.search(r'вопрос \d+ из', pat.inner_text('body'))), '| back/later', 'позже' in pat.inner_text('body').lower())
        shot(pat, f's1_take_{href.split("/")[2]}_desk')
        # ответить макс
        for name in set(pat.eval_on_selector_all('input[type=radio]', 'e=>e.map(x=>x.name)')):
            radios = pat.query_selector_all(f'input[name={name}]')
            radios[-1].check()
        pat.click('form[action$="/submit"] button[type=submit]')
        pat.wait_for_load_state()
        log('  after submit url', pat.url.replace(BASE, ''))
    pat.goto(BASE + '/dashboard'); shot(pat, 's1_patient_after_desk')
    log('S1 patient history mentions stub badge:', 'заглушка' in pat.inner_text('body'))
    # врач видит
    psy.goto(f'{BASE}/patients/5'); tx = psy.inner_text('body')
    log('S1 psy sees results: SDS', 'Цунга (SDS)' in tx, 'BAI', 'BAI' in tx, 'disclaimer', 'Демонстрационн' in tx, 'badge заглушка', 'заглушка' in tx)
    shot(psy, 's1_psy_card_after_desk')
    plg.goto(f'{BASE}/patients/5'); log('S1 plg sees results:', 'BAI' in plg.inner_text('body'))
    # светофор/эскалации не изменились
    psy.goto(BASE + '/dashboard'); log('S1 crisis block still count:', re.findall(r'Открытые кризисные эскалации \(\d+\)', psy.inner_text('body')))
    # ---- S2: clinician_entered
    t = assign(psy, 5, 'hdrs17') if psy.query_selector('#assign input[value=hdrs17]') else 'нет hdrs17 в списке назначения'
    log('S2 hdrs17 in assign picker:', bool(psy.query_selector('#assign input[value=hdrs17]')))
    psy.goto(f'{BASE}/patients/5')
    log('S2 hdrs17 in protocol picker:', bool(psy.query_selector('#protocols input[value=hdrs17]')))
    psy.check('#protocols input[name=instrument][value=hdrs17]')
    psy.click('#protocols button[type=submit]'); psy.wait_for_load_state()
    log('S2 empty protocol saved:', psy.url.replace(BASE, ''), psy.inner_text('body')[:0])
    log('S2 card shows HDRS / черновик:', 'HDRS' in psy.inner_text('body'), 'черновик' in psy.inner_text('body'))
    shot(psy, 's2_protocol_saved_desk')
    log('S2 "Ожидает ввода" present:', 'жидает ввода' in psy.inner_text('body'))
    pat.goto(BASE + '/dashboard'); log('S2 patient sees HDRS:', 'HDRS' in pat.inner_text('body'))
    # ---- S3: пациент без врача
    ctx4, p6 = login(b, 'p6')
    p6.goto(BASE + '/dashboard'); shot(p6, 's3_nodoctor_desk'); shot(p6, 's3_nodoctor_mob_dummy', False)
    log('S3 p6 text:', p6.inner_text('main')[:600].replace('\n', ' | '))
    p6.goto(BASE + '/chat'); log('S3 chat ok', p6.inner_text('h1'))
    # ---- p8 empty
    ctx5, p8 = login(b, 'p8', MOB)
    p8.goto(BASE + '/dashboard'); shot(p8, 's5_empty_p8_mob')
    log('S5 p8 text:', p8.inner_text('main')[:500].replace('\n', ' | '))
    ctx6, d = login(b, 'psy2')
    d.goto(BASE + '/dashboard'); shot(d, 's4_psy2_crisis_desk')
    log('S4 psy2 text:', d.inner_text('main')[:700].replace('\n', ' | '))
    d.goto(BASE + '/crisis'); shot(d, 's4_crisis_queue_desk'); log('S4 crisis text:', d.inner_text('main')[:900].replace('\n', ' | '))
    # права: психолог на чужого пациента (psy2: 3,5 -> ids 7,9); plg ведёт 5,6,8,9
    plg.goto(f'{BASE}/patients/7'); log('perm plg->patient7(не ведёт):', plg.url.replace(BASE, ''), plg.inner_text('h1'))
    r = plg.request.post(BASE + '/assignments', form={'patient_id': '7', 'instrument': 'bai'}); log('perm plg POST assign patient 7:', r.status, r.url.replace(BASE, ''))
    ctx7, adm = login(b, 'admin')
    for u in ['/patients/5', '/crisis', '/dashboard', '/export/comparisons.csv']:
        r = adm.request.get(BASE + u, max_redirects=0); log('perm admin GET', u, r.status)
    r = pat.request.get(BASE + '/patients/5'); log('perm patient GET /patients/5', r.status)
    r = pat.request.get(BASE + '/assignments/1/take'); log('perm patient GET чужое назначение', r.status)
    r = pat.request.post(BASE + '/assignments', form={'patient_id': '5', 'instrument': 'bai'}); log('perm patient POST assign', r.status)
    # CSRF
    r = psy.request.post(BASE + '/assignments', form={'patient_id': '5', 'instrument': 'isi'}, max_redirects=0)
    log('CSRF: POST /assignments без токена', r.status)
    r = psy.request.post(BASE + '/logout', max_redirects=0); log('CSRF: POST /logout без токена', r.status)
    # заголовки
    r = psy.request.get(BASE + '/dashboard')
    log('headers', {k: v for k, v in r.headers.items() if k in ('content-security-policy', 'cache-control', 'x-content-type-options', 'x-frame-options', 'referrer-policy')})
    r = b.new_context().request.post(BASE + '/login', form={'email': 'x@x.x', 'password': 'bad'})
    for i in range(7):
        r = b.new_context().request.post(BASE + '/login', form={'email': ACC['p1'], 'password': 'bad'}, max_redirects=0)
    log('login x7 bad last status', r.status)
    # назад после выхода
    ctx8, o = login(b, 'p1')
    o.goto(BASE + '/dashboard')
    o.click('form[action="/logout"] button'); o.wait_for_load_state()
    o.go_back(); o.wait_for_load_state()
    log('back after logout url', o.url.replace(BASE, ''), 'has data', 'Тренд' in o.inner_text('body') or 'История' in o.inner_text('body'))
    b.close()
