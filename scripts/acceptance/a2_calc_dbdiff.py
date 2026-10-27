"""A2 TLS-001: контроль — изменение таблиц БД от одного только просмотра Сводки против расчёта в калькуляторе."""
from a2_common import *
import sqlite3, time

DB = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/db.sqlite3'


def counts():
    c = sqlite3.connect('file:' + DB + '?mode=ro', uri=True)
    t = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
    return {x: c.execute('select count(*) from "%s"' % x).fetchone()[0] for x in t}


def diff(a, b):
    return {k: (a[k], b[k]) for k in a if a[k] != b[k]}


with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    a = counts()
    go(d, '/dashboard'); time.sleep(1)
    c1 = counts()
    log('dashboard only:', diff(a, c1))
    go(d, '/tools/calculator/phq9')
    names = d.evaluate("[...new Set([...document.querySelectorAll('main form input[type=radio]')].map(r=>r.name))]")
    for n in names:
        d.locator('input[name="%s"][value="1"]' % n).check()
    d.locator('input[name="%s"][value="2"]' % names[8]).check()
    d.click('main form button[type=submit]')
    d.wait_for_load_state(); time.sleep(1)
    c2 = counts()
    log('calc (crit item):', diff(c1, c2))
    go(d, '/dashboard'); time.sleep(1)
    log('dashboard again:', diff(c2, counts()))
    b.close()
