"""A0: обход ссылок меню и страниц по ролям; переполнение, h1, баннер, 404/403, ссылки, формы."""
import json, os
from a0_common import *

OUT = os.environ.get('CRAWL_OUT', '/tmp/a0_crawl.json')

AUDIT = """() => ({
  sw: document.documentElement.scrollWidth, iw: window.innerWidth,
  h1: document.querySelectorAll('h1').length, lang: document.documentElement.lang,
  title: document.title,
  banner: /Демо-версия|заглушк/i.test(document.body.innerText),
  disclaimer: /не диагноз|гипотез/i.test(document.body.innerText),
  deadLinks: [...document.querySelectorAll('a')].filter(a=>{const h=a.getAttribute('href');return !h||h==='#';}).map(a=>a.innerText.trim()),
  unlabeled: [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=radio]),select,textarea')].filter(i=>!i.labels||!i.labels.length).filter(i=>!i.getAttribute('aria-label')).map(i=>i.name||i.type),
  inlineHandlers: document.querySelectorAll('[onclick],[onsubmit],[onchange]').length,
  inlineScripts: document.querySelectorAll('script:not([src])').length,
  postForms: document.querySelectorAll('form[method=POST],form[method=post]').length,
  csrf: [...document.querySelectorAll('form[method=POST],form[method=post]')].every(f=>f.querySelector('input[name*=csrf i]')),
  skip: !!document.querySelector('a.skip-link,a[href="#main"],a[href="#content"]'),
  navLinks: [...document.querySelectorAll('nav a, nav .is-disabled')].map(a=>[a.innerText.trim(),a.getAttribute('href')]),
  small: [...document.querySelectorAll('a,button,input,select')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.height<44||r.width<44)&&e.type!=='hidden'&&e.type!=='radio'&&e.type!=='checkbox'}).length,
  body: document.body.innerText.slice(0,160)
})"""

out = {}
with sync_playwright() as p:
    b = launch(p)
    for who in ['p1', 'p6', 'p8', 'psy1', 'plg', 'admin']:
        for pname, prof in [('desk', DESK), ('mob', MOB), ('nar', NARROW)]:
            ctx, page = login(b, who, prof)
            urls = ['/dashboard']
            links = page.eval_on_selector_all('a[href]', 'els=>els.map(e=>e.getAttribute("href"))')
            for l in links:
                if l.startswith('/') and not l.startswith('/logout'):
                    base = l.split('#')[0]
                    if base not in urls and 'export' not in base:
                        urls.append(base)
            urls += ['/nonexistent-page', '/patients/9999', '/crisis', '/admin', '/chat', '/patients/5']
            urls = list(dict.fromkeys(urls))
            res = {}
            for u in urls:
                try:
                    r = page.goto(BASE + u)
                except Exception as e:
                    res[u] = {'err': str(e)[:80]}
                    continue
                a = page.evaluate(AUDIT)
                a['status'] = r.status if r else None
                a['final'] = page.url.replace(BASE, '')
                res[u] = a
                if pname in ('desk', 'mob') and u in ('/dashboard', '/nonexistent-page', '/crisis', '/patients/9999'):
                    shot(page, f'crawl_{who}_{u.strip("/").replace("/", "_")}_{pname}')
            out[f'{who}:{pname}'] = res
            ctx.close()
    b.close()
json.dump(out, open(OUT, 'w'), ensure_ascii=False, indent=1)
for k, res in out.items():
    for u, a in res.items():
        if 'err' in a:
            print(k, u, 'ERR', a['err'])
            continue
        flags = []
        if a['sw'] > a['iw']: flags.append(f"OVERFLOW {a['sw']}>{a['iw']}")
        if a['h1'] != 1: flags.append(f"h1={a['h1']}")
        if not a['banner']: flags.append('no-banner')
        if a['deadLinks']: flags.append(f"dead={a['deadLinks']}")
        if a['unlabeled']: flags.append(f"unlabeled={a['unlabeled']}")
        if a['inlineHandlers'] or a['inlineScripts']: flags.append(f"inline h={a['inlineHandlers']} s={a['inlineScripts']}")
        if a['postForms'] and not a['csrf']: flags.append('noCSRF')
        if a['small'] and 'mob' in k: flags.append(f"small={a['small']}")
        print(k, u, a['status'], '->', a['final'], '|', a['title'][:25], '|', ' '.join(flags))
