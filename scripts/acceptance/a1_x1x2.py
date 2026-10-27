"""A1: X-2 (назначил -> прошёл -> увидел) и X-1 (кризис PHQ-9 пункт 9 -> врач/очередь). Пациент p1 (Светлова, id 5), врач psy1.
BASE=... SHOTS=... python3 a1_x1x2.py"""
from a0_common import *


def log(*a):
    print(*a, flush=True)


with sync_playwright() as p:
    b = launch(p)
    ctx, psy = login(b, 'psy1')
    psy.goto(BASE + '/assignments')
    psy.check('input[name=patient_id] >> nth=3')  # Светлова
    psy.check('input[name=instrument][value=phq9]')
    psy.click('form[action="/assignments"] button[type=submit]')
    psy.wait_for_load_state()
    log('PREVIEW URL', psy.url.replace(BASE, ''))
    log(psy.inner_text('main')[:700].replace('\n', ' | '))
    shot(psy, 'x2_preview_psy_desk')
    # дубль
    psy.goto(BASE + '/assignments')
    psy.check('input[name=patient_id] >> nth=3')
    psy.check('input[name=instrument][value=phq9]')
    psy.click('form[action="/assignments"] button[type=submit]')
    psy.wait_for_load_state()
    log('DUP PREVIEW', psy.inner_text('main')[:500].replace('\n', ' | '))
    ctx.close()

    # пациент проходит PHQ-9: пункт 9 = 2
    ctx, pat = login(b, 'p1', MOB)
    pat.goto(BASE + '/tests')
    links = pat.eval_on_selector_all('a[href*="/take"]', 'e=>e.map(x=>[x.innerText.trim(),x.getAttribute("href")])')
    log('TAKE LINKS', links)
    phq = [l for l in pat.eval_on_selector_all('a[href*="/assignments/"]', 'e=>e.map(x=>x.getAttribute("href"))')]
    pat.goto(BASE + '/dashboard')
    txt = pat.inner_text('main')
    log('DASH', txt[:400].replace('\n', ' | '))
    ctx.close()
    b.close()
