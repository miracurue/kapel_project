"""A2: 'врач-минималист за 30 секунд': калькулятор (время, ничего не сохраняется), быстрая заметка, шаблон->DOCX/PDF/TXT, поиск, 390 px."""
from a2_common import *
import time, sqlite3, os

DB = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/db.sqlite3'
OUT = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/'


def counts():
    c = sqlite3.connect('file:' + DB + '?mode=ro', uri=True)
    t = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
    return {x: c.execute('select count(*) from "%s"' % x).fetchone()[0] for x in t}


with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    before = counts()
    t0 = time.time()
    go(d, '/dashboard')
    d.click('nav a[href="/tools"]')
    d.click('a[href="/tools/calculator"]')
    d.click('a[href="/tools/calculator/phq9"]')
    form = d.locator('main form').first
    log('calc form fields', d.evaluate("[...new Set([...document.querySelectorAll('main form input[type=radio]')].map(r=>r.name))].length"))
    names = d.evaluate("[...new Set([...document.querySelectorAll('main form input[type=radio]')].map(r=>r.name))]")
    vals = [1, 2, 1, 2, 1, 0, 1, 1, 2]
    for n, v in zip(names, vals):
        d.locator('input[name="%s"][value="%d"]' % (n, v)).check()
    d.click('main form button[type=submit]')
    d.wait_for_load_state()
    dt = time.time() - t0
    log('CALC time sec (incl. nav)', round(dt, 1), 'URL', d.url.replace(BASE, ''))
    log('CALC RESULT:', txt(d, 'main', 1500)[:1500])
    shot(d, 'tools_calc_result_desk')
    after = counts()
    diff = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
    log('DB diff after calc:', diff)
    log('copy button / textarea:', d.locator('button:has-text("Копировать")').count(), d.locator('textarea').count())
    # критический пункт
    go(d, '/tools/calculator/phq9')
    for n in names:
        d.locator('input[name="%s"][value="0"]' % n).check()
    d.locator('input[name="%s"][value="2"]' % names[8]).check()
    d.click('main form button[type=submit]')
    d.wait_for_load_state()
    log('CRIT RESULT:', txt(d, 'main', 900))
    shot(d, 'tools_calc_critical_desk')
    after2 = counts()
    log('DB diff after crit:', {k: (before[k], after2[k]) for k in before if before[k] != after2[k]})
    # быстрая заметка
    go(d, '/tools/quicknote')
    d.fill('textarea', 'Жалобы: плохой сон, тревога по утрам. Настроение снижено. Принимает препарат А. План: повторить PHQ-9 через 2 недели, обсудить режим.')
    d.click('main form button[type=submit]')
    d.wait_for_load_state()
    log('QUICKNOTE:', txt(d, 'main', 1800))
    shot(d, 'tools_quicknote_desk')
    log('QN forms', d.evaluate("[...document.forms].map(f=>f.getAttribute('action'))"))
    # шаблоны
    go(d, '/tools/templates')
    links = d.eval_on_selector_all('main a[href^="/tools/templates/"]', 'e=>e.map(x=>x.getAttribute("href")+" "+x.innerText)')
    log('TEMPL links', links)
    d.locator('main a[href^="/tools/templates/"]').first.click()
    d.wait_for_load_state()
    log('TEMPL page:', d.url.replace(BASE, ''), txt(d, 'main', 1500))
    shot(d, 'tools_template_desk')
    for fmt in ('txt', 'docx', 'pdf'):
        links = d.eval_on_selector_all('a[href*="%s"], button[formaction*="%s"]' % (fmt, fmt), 'e=>e.map(x=>x.getAttribute("href")||x.getAttribute("formaction"))')
        log('fmt', fmt, links[:2])
    log('TEMPL forms', d.evaluate("[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type).join(',')+']')"))
    ctx.close()
    ctx, m = login(b, 'psy1', MOB)
    for path in ('/tools', '/tools/calculator/phq9', '/tools/templates', '/tools/import'):
        go(m, path)
        log('MOB', path, 'ovf', overflow(m))
    shot(m, 'tools_import_mob')
    b.close()
