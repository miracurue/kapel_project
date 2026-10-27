"""A1: BFS-обход GET-ссылок по ролям и профилям; статусы, переполнение, h1, мёртвые ссылки, внешние хосты, JS-ошибки.
Запуск: BASE=http://localhost:PORT CRAWL_OUT=/path/out.json python3 scripts/acceptance/a1_crawl.py [роли через запятую]"""
import json, os, sys, re
from a0_common import *

OUT = os.environ.get('CRAWL_OUT', '/tmp/a1_crawl.json')
ROLES = (sys.argv[1] if len(sys.argv) > 1 else 'p1,p3,p6,p8,psy1,psy2,plg,admin').split(',')
SKIP = re.compile(r'/logout|\.csv|/export|/download|/delete|/stop|\.docx|\.pdf|\.txt')
AUDIT = """() => ({
  sw: document.documentElement.scrollWidth, iw: window.innerWidth,
  h1: document.querySelectorAll('h1').length, title: document.title,
  deadLinks: [...document.querySelectorAll('a')].filter(a=>{const h=a.getAttribute('href');return !h||h==='#';}).map(a=>a.innerText.trim().slice(0,40)),
  unlabeled: [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea')].filter(i=>(!i.labels||!i.labels.length)&&!i.getAttribute('aria-label')).map(i=>i.name||i.type),
  noCsrf: [...document.querySelectorAll('form[method=POST],form[method=post]')].filter(f=>!f.querySelector('input[name*=csrf i]')).length,
  small: [...document.querySelectorAll('a,button,input:not([type=hidden]),select')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&(r.height<40)&&e.type!=='radio'&&e.type!=='checkbox'}).length,
  words: (document.body.innerText.match(/риск|диагноз|ошибка|undefined|null|NaN|\\[object|lorem|TODO/gi)||[]).slice(0,6),
  h: document.documentElement.scrollHeight
})"""
out = {}
with sync_playwright() as p:
    b = launch(p)
    for who in ROLES:
        for pname, prof in [('desk', DESK), ('mob', MOB)]:
            ctx, page = login(b, who, prof)
            ext, cons = set(), []
            page.on('request', lambda r: ext.add(r.url.split('/')[2]) if not r.url.startswith(BASE) and r.url.startswith('http') else None)
            page.on('pageerror', lambda e: cons.append(str(e)[:100]))
            seen, queue, res = set(), ['/dashboard'], {}
            while queue and len(seen) < 70:
                u = queue.pop(0)
                if u in seen:
                    continue
                seen.add(u)
                try:
                    r = page.goto(BASE + u)
                except Exception as e:
                    res[u] = {'err': str(e)[:80]}
                    continue
                a = page.evaluate(AUDIT)
                a['status'] = r.status if r else None
                a['final'] = page.url.replace(BASE, '')
                res[u] = a
                for l in page.eval_on_selector_all('a[href]', 'e=>e.map(x=>x.getAttribute("href"))'):
                    if l.startswith('/') and not l.startswith('//'):
                        l2 = l.split('#')[0]
                        if l2 and l2 not in seen and not SKIP.search(l2):
                            queue.append(l2)
            out[f'{who}:{pname}'] = {'pages': res, 'external': sorted(ext), 'jserrors': cons}
            ctx.close()
    b.close()
json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=1)
for k, v in out.items():
    print('==', k, 'pages', len(v['pages']), 'external', v['external'], 'jserr', v['jserrors'])
    for u, a in v['pages'].items():
        if 'err' in a:
            print(' ', u, 'ERR', a['err'])
            continue
        f = []
        if a['status'] != 200: f.append(f"HTTP{a['status']}")
        if a['sw'] > a['iw']: f.append(f"OVERFLOW {a['sw']}>{a['iw']}")
        if a['h1'] != 1: f.append(f"h1={a['h1']}")
        if a['deadLinks']: f.append(f"dead={a['deadLinks']}")
        if a['unlabeled']: f.append(f"unlabeled={a['unlabeled'][:4]}")
        if a['noCsrf']: f.append(f"noCSRF={a['noCsrf']}")
        if a['words']: f.append(f"words={a['words']}")
        if 'mob' in k and a['small']: f.append(f"small={a['small']}")
        if f: print(' ', u, a['final'] if a['final'] != u else '', ' | '.join(f))
