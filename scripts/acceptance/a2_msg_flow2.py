"""A2: быстрые ответы, ответ, обработано; пациент видит; кризисная фраза в сообщении; без врача; недоступен."""
from a2_common import *

with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/patients/5/messages')
    btn = d.locator('a:has-text("Давайте обсудим")').first
    log('quick btn type/attrs', btn.evaluate("e=>[e.type,e.name,e.value,e.formAction,e.title,e.innerText]"))
    btn.click()
    d.wait_for_load_state()
    log('after quick click url', d.url.replace(BASE, ''), 'textarea=', d.input_value('textarea[name=body]')[:200], '| flash', txt(d, '[role=status],.flash', 150))
    if not d.input_value('textarea[name=body]'):
        pass
    d.click('form[action$="/messages"] button:has-text("Отправить")')
    d.wait_for_load_state()
    log('SENT reply:', txt(d, '[role=status],.flash', 200))
    hb = d.locator('form[action$="/messages/handled"] button[type=submit]')
    log('handled button present after reply:', hb.count())
    if hb.count():
        hb.first.click()
        d.wait_for_load_state()
        log('HANDLED:', txt(d, '[role=status],.flash', 200))
    log('INBOX status:', txt(d, 'main', 700)[250:600])
    ctx.close()
    ctx, pm = login(b, 'p1', MOB)
    go(pm, '/dashboard')
    log('PAT nav badge:', pm.evaluate("[...document.querySelectorAll('a[href=\"/messages\"]')].map(a=>a.innerText.replace(/\\n/g,' '))"), '| dashboard mentions msg:', 'ообщен' in pm.inner_text('main').split('Разделы')[0])
    go(pm, '/messages')
    log('PAT sees:', txt(pm, 'main', 1500)[-700:])
    shot(pm, 'msg_patient_thread_mob')
    # кризисная фраза
    pm.fill('textarea[name=body]', 'Мне очень плохо, не хочу жить, думаю покончить с собой')
    pm.click('form[action="/messages"] button[type=submit]')
    pm.wait_for_load_state()
    log('CRISIS MSG:', txt(pm, 'main', 1800))
    shot(pm, 'msg_patient_crisis_mob')
    ctx.close()
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/crisis')
    log('DOC crisis queue:', txt(d, 'main', 1500))
    shot(d, 'msg_crisis_queue_desk')
    b.close()
