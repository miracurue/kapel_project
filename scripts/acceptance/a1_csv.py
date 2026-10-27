"""A1 TLS-004/SEC-013: экспорт сравнения: заголовки, ФИО/почты не утекают, формулы, источник (comparison_pairs), права."""
from a0_common import *
with sync_playwright() as p:
    b = launch(p)
    for who in ('psy1', 'plg'):
        ctx, pg = login(b, who)
        pg.goto(BASE + '/dashboard')
        print(who, 'nav export href:', pg.eval_on_selector_all('nav a', 'e=>e.filter(x=>/Экспорт/.test(x.innerText)).map(x=>x.getAttribute("href"))'))
        r = pg.request.get(BASE + '/export/comparisons.csv')
        t = r.text()
        lines = t.strip().splitlines()
        print(who, r.status, r.headers.get('content-disposition'), 'rows', len(lines) - 1)
        print(lines[0][:300])
        print(lines[1][:300] if len(lines) > 1 else '-')
        low = t.lower()
        print('leaks: names', any(n in t for n in ('Светлова', 'Громов', 'Зорина', 'Нестерова')), 'email', '@example' in low, 'formula-start cells', [c for l in lines[1:] for c in l.split(';') if c[:1] in '=+-@' and not c[1:2].isdigit()][:3])
        ctx.close()
    b.close()
