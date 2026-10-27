"""A2: пациент без врача (p6): сообщения, лечение, обучение, предвизит, заключения; кризис в «обращении»; врач 'недоступен до'."""
from a2_common import *
import datetime

with sync_playwright() as p:
    b = launch(p)
    ctx, pm = login(b, 'p6', MOB)
    for path in ('/dashboard', '/messages', '/meds', '/learn', '/previsit', '/my-conclusions', '/tests'):
        st = go(pm, path)
        log('NODOC', path, st, 'ovf', overflow(pm), '|', txt(pm, 'main', 700))
        shot(pm, 'nodoc_%s_mob' % path.strip('/'))
    # личный список без врача и отметка
    go(pm, '/meds')
    pm.fill('input[name=name]', 'Мелатонин (мой список)')
    pm.click('form[action="/meds"] button[type=submit]')
    pm.wait_for_load_state()
    log('NODOC add own med:', txt(pm, '[role=status],.flash', 150))
    go(pm, '/messages')
    log('NODOC msg forms', pm.evaluate("[...document.forms].map(f=>f.getAttribute('action'))"))
    ctx.close()
    # 'недоступен до' у psy1
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/inbox')
    until = (datetime.date.today() + datetime.timedelta(days=5)).isoformat()
    log('settings fields', d.evaluate("[...document.querySelector('form[action=\"/inbox/settings\"]').elements].map(e=>e.name+':'+e.type)"))
    d.fill('form[action="/inbox/settings"] input[type=date]', until)
    d.click('form[action="/inbox/settings"] button[type=submit]')
    d.wait_for_load_state()
    log('AWAY set:', txt(d, '[role=status],.flash', 200))
    ctx.close()
    ctx, pm = login(b, 'p1', MOB)
    go(pm, '/messages')
    log('P1 messages while doctor away:', txt(pm, 'main', 1200))
    shot(pm, 'msg_doctor_away_mob')
    log('P1 forms', pm.evaluate("[...document.forms].map(f=>f.getAttribute('action'))"))
    ctx.close()
    # вернуть
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/inbox')
    d.fill('form[action="/inbox/settings"] input[type=date]', '')
    d.click('form[action="/inbox/settings"] button[type=submit]')
    d.wait_for_load_state()
    log('AWAY cleared:', txt(d, '[role=status],.flash', 100))
    b.close()
