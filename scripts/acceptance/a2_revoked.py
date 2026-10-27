"""A2: пациент с отозванным клиническим согласием (p7): сообщения/лечение/анкета у пациента и у врача."""
from a2_common import *

with sync_playwright() as p:
    b = launch(p)
    ctx, pm = login(b, 'p7', MOB)
    for path in ('/messages', '/meds', '/previsit', '/learn'):
        log('P7', path, go(pm, path), txt(pm, 'main', 500)[:500])
    shot(pm, 'revoked_messages_mob')
    ctx.close()
    ctx, d = login(b, 'psy1', DESK)
    for path in ('/patients/11/messages', '/patients/11/treatment', '/patients/11/learn', '/patients/11/visit'):
        log('DOC', path, go(d, path), txt(d, 'main', 700)[200:700])
    log('DOC forms on messages:', d.evaluate("[...document.forms].map(f=>f.getAttribute('action'))") if go(d, '/patients/11/messages') else '')
    r = d.evaluate("""async ()=>{const t=await (await fetch('/csrf-token')).json();const r=await fetch('/patients/11/messages',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'body=hi'});return r.status}""")
    log('DOC POST message to revoked ->', r)
    b.close()
