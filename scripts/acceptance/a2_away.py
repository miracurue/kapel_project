"""A2 MSG-004: врач 'недоступен до' -> пациент открывает диалог именно с ним; прямой POST."""
from a2_common import *
import datetime

POST = """async ([u,b])=>{const t=await (await fetch('/csrf-token')).json();const r=await fetch(u,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-Token':Object.values(t).find(v=>typeof v==='string'&&v.length>20)},body:b});return r.status}"""
with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/inbox')
    d.fill('form[action="/inbox/settings"] input[type=date]', (datetime.date.today() + datetime.timedelta(days=5)).isoformat())
    d.fill('form[action="/inbox/settings"] input[name=reply_note]', 'Отпуск')
    d.click('form[action="/inbox/settings"] button[type=submit]')
    d.wait_for_load_state()
    ctx.close()
    ctx, pm = login(b, 'p1', MOB)
    go(pm, '/messages?with=2')
    log('AWAY thread:', txt(pm, 'main', 1400))
    log('forms', pm.evaluate("[...document.forms].map(f=>f.getAttribute('action'))"))
    shot(pm, 'msg_doctor_away2_mob')
    log('direct POST while away ->', pm.evaluate(POST, ['/messages', 'clinician_id=2&body=test+away']))
    ctx.close()
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/inbox')
    d.fill('form[action="/inbox/settings"] input[type=date]', '')
    d.fill('form[action="/inbox/settings"] input[name=reply_note]', 'Отвечаю в рабочие дни до 18:00')
    d.click('form[action="/inbox/settings"] button[type=submit]')
    b.close()
