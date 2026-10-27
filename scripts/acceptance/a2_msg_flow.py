"""A2: сообщения врач<->пациент: обычное, ответ, быстрые ответы, обработано, кризисная фраза, пациент без врача, 'недоступен до'."""
from a2_common import *
import datetime

with sync_playwright() as p:
    b = launch(p)
    ctx, pm = login(b, 'p1', MOB)
    go(pm, '/messages')
    log('PAT FORM', pm.evaluate("[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type).join(',')+']')"))
    sel = pm.locator('select[name=clinician_id], select[name=to]')
    log('doctor select count', sel.count())
    pm.fill('textarea[name=body], textarea[name=text]', 'Здравствуйте! Хотела уточнить: можно ли перенести приём на неделю позже?')
    pm.click('form[action="/messages"] button[type=submit]')
    pm.wait_for_load_state()
    log('SENT:', txt(pm, '[role=status],.flash', 200))
    shot(pm, 'msg_patient_sent_mob')
    # F5 / повторная отправка
    pm.reload()
    log('after reload url', pm.url.replace(BASE, ''))
    n = pm.inner_text('main').count('перенести приём')
    log('copies after F5:', n)
    ctx.close()
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/dashboard')
    log('DOC nav badge:', d.eval_on_selector_all('nav a[href="/inbox"]', 'e=>e.map(x=>x.innerText.replace(/\\n/g," "))'))
    go(d, '/inbox')
    shot(d, 'msg_doc_inbox_desk')
    go(d, '/patients/5/messages')
    log('DOC thread:', txt(d, 'main', 2200)[250:])
    log('DOC forms', d.evaluate("[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type).join(',')+']')"))
    shot(d, 'msg_doc_thread_desk')
    ctx.close()
    b.close()
