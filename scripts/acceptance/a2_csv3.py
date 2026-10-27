"""A2 TLS-003: подтверждение импорта, откат партии, эскалация BDI-II п.9 остаётся."""
from a2_common import *
import sqlite3

OUT = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/'
DB = OUT + 'db.sqlite3'


def cnt(t, where='1'):
    c = sqlite3.connect('file:' + DB + '?mode=ro', uri=True)
    return c.execute('select count(*) from %s where %s' % (t, where)).fetchone()[0]


with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    o0, e0, p0 = cnt('offline_results'), cnt('crisis_escalations'), cnt('catalog_protocols')
    go(d, '/tools/import/draft/1')
    d.click('form[action$="/confirm"] button[type=submit]')
    d.wait_for_load_state()
    log('CONFIRMED:', d.url.replace(BASE, ''), txt(d, 'main', 1500))
    shot(d, 'csv_applied_desk')
    o1, e1 = cnt('offline_results'), cnt('crisis_escalations')
    log('offline_results +', o1 - o0, ' escalations +', e1 - e0)
    # F5 повторное подтверждение
    r = d.evaluate("""async ()=>{const t=await (await fetch('/csrf-token')).json();const r=await fetch('/tools/import/draft/1/confirm',{method:'POST',redirect:'manual',headers:{'X-CSRF-Token':Object.values(t).find(v=>typeof v==='string'&&v.length>20)}});return r.status}""")
    log('double confirm status', r, 'offline_results now +', cnt('offline_results') - o0)
    go(d, '/tools/import')
    log('IMPORT LIST:', txt(d, 'main', 1500)[300:])
    links = d.eval_on_selector_all('main form', 'e=>e.map(x=>x.getAttribute("action"))')
    log('forms', links)
    rb = d.locator('form[action$="/rollback"] button[type=submit]').first
    log('rollback btn', rb.inner_text())
    rb.click()
    d.wait_for_load_state()
    log('ROLLED BACK:', txt(d, '[role=status],.flash', 300))
    o2, e2 = cnt('offline_results'), cnt('crisis_escalations')
    log('after rollback offline_results +', o2 - o0, ' escalations +', e2 - e0)
    log('PAGE after:', txt(d, 'main', 1200)[200:])
    shot(d, 'csv_rolled_back_desk')
    ctx.close()
    b.close()
