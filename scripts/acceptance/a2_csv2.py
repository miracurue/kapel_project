"""A2 TLS-003: загрузка CSV cp1251 с ошибками, предпросмотр, применение, откат."""
from a2_common import *
import sqlite3

OUT = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/'
DB = OUT + 'db.sqlite3'


def cnt(t, where='1'):
    c = sqlite3.connect('file:' + DB + '?mode=ro', uri=True)
    return c.execute('select count(*) from %s where %s' % (t, where)).fetchone()[0]


hdr = 'patient_id;scale;date;score;item9;subscale_a;subscale_d;stai_state;stai_trait;mmpi_2;mmpi_7;mmpi_9;note'
rows = [
    '12;phq9;2026-10-01;8;;;;;;;;;Тревога усилилась',
    '5;gad7;01.10.2026;9;;;;;;;;;',
    '5;phq9;31.02.2026;5;;;;;;;;;',
    '5;phq9;2026-10-02;99;;;;;;;;;',
    '7;phq9;2026-10-02;5;;;;;;;;;',
    '12;who5;2026-10-03;12;;;;;;;;;=cmd|calc',
    ';;;;;;;;;;;;',
    '12;bdi2;2026-10-04;20;3;;;;;;;;',
    '12;phq9;2026-10-01;8;;;;;;;;;Тревога усилилась',
    '5;фыва;2026-10-02;5;;;;;;;;;',
]
open(OUT + 'imp.csv', 'wb').write((hdr + '\r\n' + '\r\n'.join(rows) + '\r\n').encode('cp1251'))

with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/tools/import')
    d.set_input_files('input[type=file]', OUT + 'imp.csv')
    d.click('main form button[type=submit]')
    d.wait_for_load_state()
    log('PREVIEW URL', d.url.replace(BASE, ''))
    log('PREVIEW:', txt(d, 'main', 3500))
    shot(d, 'csv_preview_desk')
    log('forms', d.evaluate("[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type).join(',')+']')"))
    o_before, e_before = cnt('offline_results'), cnt('crisis_escalations')
    # шаг сопоставления?
    btn = d.locator('button:has-text("Применить"), button:has-text("Импортировать"), button:has-text("Подтвердить")').first
    log('apply btn text:', btn.inner_text() if btn.count() else None)
    ctx.close()
    b.close()
