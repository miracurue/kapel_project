"""A2: обход экранов волны 2 по ролям, desktop+mobile: скриншоты, переполнение по горизонтали, мелкие цели касания."""
from a2_common import *

TOUR = {
    'p1': ['/dashboard', '/learn', '/learn/thought_diary', '/meds', '/messages', '/previsit', '/my-conclusions', '/share'],
    'psy1': ['/inbox', '/patients/5', '/patients/5/messages', '/patients/5/treatment', '/patients/5/learn', '/patients/5/visit',
             '/tools', '/tools/calculator', '/tools/calculator/phq9', '/tools/quicknote', '/tools/templates', '/tools/import',
             '/tools/cohort', '/tools/reminders', '/tools/search', '/tools/export/5', '/conclusions', '/patients/5/conclusions'],
    'plg': ['/conclusions', '/patients/5/conclusions', '/patients/5', '/tools', '/inbox'],
    'admin': ['/dashboard', '/admin/system'],
}
if __name__ == '__main__':
    with sync_playwright() as p:
        b = launch(p)
        for prof, pn in ((DESK, 'desk'), (MOB, 'mob')):
            for who, paths in TOUR.items():
                ctx, pg = login(b, who, prof)
                for path in paths:
                    st = go(pg, path)
                    small = pg.evaluate("""()=>[...document.querySelectorAll('a,button,input:not([type=hidden]),select,textarea')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&(r.height<40||r.width<40)&&getComputedStyle(e).visibility!='hidden'}).length""")
                    log(pn, who, path, st, 'ovf', overflow(pg), 'small', small, '|', txt(pg, 'main', 100))
                    shot(pg, 't_%s_%s_%s' % (who, path.strip('/').replace('/', '_') or 'root', pn))
                ctx.close()
        b.close()
