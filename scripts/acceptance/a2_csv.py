"""A2 J-C4/TLS-003: импорт CSV (cp1251, ';') с ошибками: чужой пациент, неверная дата, балл вне диапазона, пустая строка, формула, дубль; предпросмотр; применение; откат."""
from a2_common import *
import sqlite3

OUT = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/'
DB = OUT + 'db.sqlite3'


def cnt(t):
    c = sqlite3.connect('file:' + DB + '?mode=ro', uri=True)
    return c.execute('select count(*) from %s' % t).fetchone()[0]


with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/tools/import')
    link = d.locator('a:has-text("Скачать шаблон")').first
    href = link.get_attribute('href')
    r = ctx.request.get(BASE + href)
    tpl = r.body()
    open(OUT + 'tpl.csv', 'wb').write(tpl)
    log('TEMPLATE', href, r.headers.get('content-type'), tpl[:400].decode('utf-8', 'replace'))
    ctx.close()
    b.close()
