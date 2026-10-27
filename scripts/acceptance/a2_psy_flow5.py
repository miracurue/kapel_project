"""A2 J-Y1 часть 5: правка=новая версия, выдача, пациент, психиатр, экспорт, негатив."""
from a2_common import *

U = open('/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/concl_url.txt').read()
OUT = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/'

with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'plg', DESK)
    pg.goto(U)
    # ревизия без причины
    pg.click('form[action$="/revise"] button[type=submit]')
    pg.wait_for_load_state()
    log('REVISE no reason:', pg.url.replace(BASE, ''), txt(pg, 'main', 200))
    pg.goto(U)
    pg.fill('form[action$="/revise"] input[name=reason]', 'Уточнена формулировка рекомендаций')
    pg.click('form[action$="/revise"] button[type=submit]')
    pg.wait_for_load_state()
    log('REVISED:', txt(pg, 'main', 400))
    pg.fill('textarea[name=recommendations]', 'Повторное обследование через 3 месяца; обсудить с лечащим врачом.')
    pg.click('form[action$="/conclusions/3"] button[type=submit]')
    pg.wait_for_load_state()
    log('SAVED v2:', txt(pg, 'main', 150))
    pg.fill('form[action$="/sign"] input[name=confirm_password]', PWD)
    pg.click('form[action$="/sign"] button[type=submit]')
    pg.wait_for_load_state()
    log('SIGN v2:', txt(pg, '[role=status],.flash', 200))
    hist = txt(pg, 'main', 6000)
    i = hist.find('История версий')
    log('HIST:', hist[i:i + 500])
    shot(pg, 'y1_signed_v2_desk')
    # старая версия
    pg.goto(U + '/versions/1')
    log('V1 view:', txt(pg, 'main', 200)[-150:])
    log('V1 rec:', 'через 3 месяца.' in pg.inner_text('main'), '| text has v2 phrase:', 'обсудить с лечащим' in pg.inner_text('main'))
    # попытка сохранить подписанную прямым POST
    r = pg.evaluate("""async (u)=>{const t=await (await fetch('/csrf-token')).json();const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-Token':t.token||t.csrfToken||Object.values(t)[0]},body:'summary=hack'});return r.status}""", U.replace(BASE, ''))
    log('POST signed ->', r)
    # экспорт
    for fmt in ('txt', 'docx', 'pdf'):
        resp = ctx.request.get(U + '/export.' + fmt)
        body = resp.body()
        open(OUT + 'c3.' + fmt, 'wb').write(body)
        log('EXPORT', fmt, resp.status, len(body), resp.headers.get('content-disposition'))
    # выдача
    pg.goto(U)
    log('RELEASE form text:', txt(pg, 'form[action$="/release"]', 300), pg.inner_text('form[action$="/release"]'))
    shot(pg, 'y1_before_release_desk')
    pg.click('form[action$="/release"] button[type=submit]')
    pg.wait_for_load_state()
    log('RELEASED:', txt(pg, '[role=status],.flash', 300))
    ctx.close()
    # пациент
    ctx, pg = login(b, 'patient4.inactive@example.com', MOB)
    go(pg, '/my-conclusions')
    log('PAT list:', txt(pg, 'main', 600))
    shot(pg, 'y1_patient_conclusions_mob')
    links = pg.eval_on_selector_all('main a[href^="/my-conclusions/"]', 'e=>e.map(x=>x.getAttribute("href"))')
    log('links', links)
    if links:
        go(pg, links[0])
        log('PAT view:', txt(pg, 'main', 1500), 'ovf', overflow(pg))
        shot(pg, 'y1_patient_conclusion_mob')
    go(pg, '/dashboard')
    log('PAT dash mentions conclusion:', 'аключен' in pg.inner_text('main'))
    ctx.close()
    # психиатр
    ctx, pg = login(b, 'psy1', DESK)
    pg.goto(U)
    log('PSY1 view status', pg.url.replace(BASE, ''), txt(pg, 'main', 300))
    log('PSY1 forms', pg.evaluate("[...document.forms].map(f=>f.getAttribute('action'))"))
    shot(pg, 'y1_psychiatrist_view_desk')
    ctx.close()
    b.close()
