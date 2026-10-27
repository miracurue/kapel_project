"""A2 J-Y1 часть 7: revise после выдачи -> выдача снимается? Психиатр2 на подписанном; прямые POST психиатра."""
from a2_common import *

U = open('/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/concl_url.txt').read()
POST = """async ([u,b])=>{const t=await (await fetch('/csrf-token')).json();const r=await fetch(u,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-Token':Object.values(t).find(v=>typeof v==='string'&&v.length>20)},body:b});return r.status}"""

with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'plg', DESK)
    pg.goto(U)
    pg.fill('form[action$="/revise"] input[name=reason]', 'Проверка снятия выдачи')
    pg.click('form[action$="/revise"] button[type=submit]')
    pg.wait_for_load_state()
    log('after revise v3 release form:', pg.inner_text('form[action$="/release"]').replace('\n', ' | '))
    ctx.close()
    ctx, pg = login(b, 'patient4.inactive@example.com', DESK)
    go(pg, '/my-conclusions')
    log('PAT list after v3 draft:', txt(pg, 'main', 300))
    ctx.close()
    ctx, pg = login(b, 'psychiatrist2@example.com', DESK)
    go(pg, '/conclusions')
    log('PSY2 list:', txt(pg, 'main', 1200)[330:])
    links = pg.eval_on_selector_all('main a[href^="/conclusions/"]', 'e=>e.map(x=>x.getAttribute("href"))')
    log(links)
    for l in links[:2]:
        go(pg, l)
        log(l, 'forms', pg.evaluate("[...document.forms].map(f=>f.getAttribute('action'))"), txt(pg, 'main', 300)[200:300])
        for path, body in (('/sign', 'confirm_password=' + PWD), ('/revise', 'reason=x'), ('/release', 'release=1')):
            log('PSY2 POST', l + path, pg.evaluate(POST, [l + path, body]))
    shot(pg, 'y1_psychiatrist2_view_desk')
    ctx.close()
    b.close()
