"""A2 SEC-002: без CSRF-токена (форма без скрытого поля, ctx.request без заголовка, чужой токен) на изменяющих маршрутах волны 2."""
from a2_common import *
import sqlite3

DB = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/db.sqlite3'


def n(q):
    c = sqlite3.connect('file:' + DB + '?mode=ro', uri=True)
    return c.execute(q).fetchone()[0]


with sync_playwright() as p:
    b = launch(p)
    ctx, pm = login(b, 'p1', DESK)
    m0 = n('select count(*) from care_messages')
    r = ctx.request.post(BASE + '/messages', form={'clinician_id': '2', 'body': 'без токена (API)'}, max_redirects=0)
    log('API no token ->', r.status, 'messages +', n('select count(*) from care_messages') - m0)
    r = ctx.request.post(BASE + '/messages', form={'clinician_id': '2', 'body': 'чужой токен', '_csrf': 'a' * 64}, max_redirects=0)
    log('API wrong token ->', r.status, 'messages +', n('select count(*) from care_messages') - m0)
    go(pm, '/messages?with=2')
    pm.evaluate("document.querySelectorAll('input[name=_csrf]').forEach(e=>e.remove())")
    pm.fill('textarea[name=body]', 'форма без поля токена')
    pm.click('form[action="/messages"] button[type=submit]')
    pm.wait_for_load_state()
    log('FORM without _csrf ->', pm.url.replace(BASE, ''), txt(pm, 'main', 160), 'messages +', n('select count(*) from care_messages') - m0)
    shot(pm, 'csrf_forbidden_patient_desk')
    log('double submit: F5 on /messages after send')
    go(pm, '/messages?with=2')
    pm.fill('textarea[name=body]', 'двойная отправка')
    pm.evaluate("const f=document.querySelector('form[action=\"/messages\"]');f.requestSubmit();f.requestSubmit()")
    pm.wait_for_load_state(); pm.wait_for_timeout(800)
    log('after double requestSubmit copies:', n("select count(*) from care_messages where body='двойная отправка'"))
    ctx.close()
    ctx, d = login(b, 'plg', DESK)
    c0 = n('select count(*) from conclusions')
    r = ctx.request.post(BASE + '/patients/8/conclusions', form={'title': 'x'}, max_redirects=0)
    log('PLG create conclusion no token ->', r.status, 'conclusions +', n('select count(*) from conclusions') - c0)
    r = ctx.request.post(BASE + '/conclusions/1/sign', form={'confirm_password': PWD}, max_redirects=0)
    log('PLG sign no token ->', r.status)
    ctx.close()
    b.close()
