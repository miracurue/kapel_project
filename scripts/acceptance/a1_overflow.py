"""A1: горизонтальное переполнение и цели <44px на ключевых экранах (мобильный 390, узкий 360, планшет 768 для /ai)."""
from a0_common import *

PAGES = {
    'psy1': ['/dashboard', '/crisis', '/patients', '/patients/5', '/patients/5/scales', '/patients/5/offline', '/patients/5/journal', '/assignments', '/ai', '/ai/t/12', '/invites', '/patients/5/visit'],
    'p1': ['/dashboard', '/tests', '/diary', '/chat', '/share', '/privacy', '/profile', '/reminders', '/help', '/consent'],
    'admin': ['/dashboard', '/admin/nobody', '/admin/users', '/admin/assignments', '/admin/audit', '/admin/consents', '/admin/system', '/admin/invites', '/admin/deletion'],
}
JS = "()=>{const iw=innerWidth;const over=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.right>iw+1&&r.width>0&&getComputedStyle(e).position!=='fixed'}).slice(0,3).map(e=>e.tagName+'.'+e.className+':'+Math.round(e.getBoundingClientRect().right));return {sw:document.documentElement.scrollWidth,iw,over}}"
with sync_playwright() as p:
    b = launch(p)
    for prof_name, prof in (('mob390', MOB), ('nar360', NARROW), ('tab768', dict(viewport={'width': 768, 'height': 1024}, has_touch=True))):
        for who, urls in PAGES.items():
            ctx, pg = login(b, who, prof)
            for u in urls:
                if prof_name == 'tab768' and not u.startswith('/ai'):
                    continue
                pg.goto(BASE + u)
                r = pg.evaluate(JS)
                W0 = {'mob390': 390, 'nar360': 360, 'tab768': 768}[prof_name]
                if r['sw'] > W0:
                    print(prof_name, who, u, r)
            ctx.close()
    b.close()
