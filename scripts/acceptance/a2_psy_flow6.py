"""A2 J-Y1 часть 6: подпись v2 после лимита, что видит пациент (выдача снимается?), психиатр на подписанном, права психолога, негатив."""
from a2_common import *
import time

U = open('/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/concl_url.txt').read()

with sync_playwright() as p:
    b = launch(p)
    time.sleep(65)
    ctx, pg = login(b, 'plg', DESK)
    pg.goto(U)
    pg.fill('form[action$="/sign"] input[name=confirm_password]', PWD)
    pg.click('form[action$="/sign"] button[type=submit]')
    pg.wait_for_load_state()
    log('SIGN v2:', txt(pg, '[role=status],[role=alert],.flash', 200))
    log('release form:', pg.inner_text('form[action$="/release"]').replace('\n', ' | '))
    ctx.close()
    ctx, pg = login(b, 'patient4.inactive@example.com', DESK)
    go(pg, '/my-conclusions')
    log('PAT list after v2 signed:', txt(pg, 'main', 300))
    go(pg, '/my-conclusions/3')
    log('PAT view:', txt(pg, 'main', 200)[:160], '| has hack:', 'hack' in pg.inner_text('main'))
    ctx.close()
    # Психиатр на подписанном заключении Нестеровой (id 9)
    ctx, pg = login(b, 'psy1', DESK)
    go(pg, '/conclusions')
    log('PSY1 list:', txt(pg, 'main', 900))
    shot(pg, 'y1_psychiatrist_list_desk')
    ctx.close()
    ctx, pg = login(b, 'psy1', DESK)
    go(pg, '/patients/9/conclusions')
    log('PSY1 pat9 concl:', txt(pg, 'main', 600)[300:])
    links = pg.eval_on_selector_all('main a[href^="/conclusions/"]', 'e=>e.map(x=>x.getAttribute("href"))')
    log(links)
    if links:
        go(pg, links[0])
        log('PSY1 forms', pg.evaluate("[...document.forms].map(f=>f.getAttribute('action'))"))
        shot(pg, 'y1_psychiatrist_view_signed_desk')
        # прямые POST
        for path, body in (('/sign', 'confirm_password=' + PWD), ('/revise', 'reason=x'), ('/release', 'release=1')):
            r = pg.evaluate("""async ([u,b])=>{const t=await (await fetch('/csrf-token')).json();const r=await fetch(u,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-Token':Object.values(t).find(v=>typeof v==='string'&&v.length>20)},body:b});return r.status}""", [links[0] + path, body])
            log('PSY1 POST', path, r)
    ctx.close()
    b.close()
