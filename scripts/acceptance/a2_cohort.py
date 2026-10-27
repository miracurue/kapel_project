"""A2 TLS-008: когорта при >=5 пациентах (в сиде ни у одного врача нет 5: привязываем patient6 к психологу через SQL во временной БД), ФИО нет, CSV."""
from a2_common import *
import sqlite3, re

OUT = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/'
c = sqlite3.connect(OUT + 'db.sqlite3')
if not c.execute('select 1 from care_assignments where patient_id=10 and clinician_id=4').fetchone():
    c.execute("insert into care_assignments(patient_id,clinician_id) values (10,4)")
    c.commit()
c.close()
with sync_playwright() as p:
    b = launch(p)
    for prof, pn in ((DESK, 'desk'), (MOB, 'mob')):
        ctx, d = login(b, 'plg', prof)
        go(d, '/tools/cohort')
        t = d.inner_text('main')
        log(pn, 'COHORT:', t[:2000].replace('\n', ' | '), 'ovf', overflow(d))
        log('names leaked:', [n for n in ('Светлова', 'Громов', 'Лебедев', 'Нестерова', 'Фомин') if n in t])
        shot(d, 'tools_cohort_%s' % pn)
        if pn == 'desk':
            l = d.locator('a[href*=".csv"]')
            if l.count():
                r = ctx.request.get(BASE + l.first.get_attribute('href'))
                log('CSV', r.status, r.body().decode('utf-8', 'replace')[:500])
        ctx.close()
    b.close()
