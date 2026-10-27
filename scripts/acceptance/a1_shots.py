"""A1: скриншоты экранов по ролям/профилям. python3 a1_shots.py <who> <desk|mob> url1 url2 ...  (имя файла = who_url_profile)"""
import sys, re
from a0_common import *

who, prof = sys.argv[1], sys.argv[2]
urls = sys.argv[3:]
with sync_playwright() as p:
    b = launch(p)
    ctx, page = login(b, who, DESK if prof == 'desk' else MOB)
    for u in urls:
        page.goto(BASE + u)
        name = re.sub(r'[^a-zA-Z0-9]+', '_', u.strip('/')) or 'root'
        shot(page, f'{who}_{name}_{prof}', full=True)
        print(u, page.url.replace(BASE, ''), page.evaluate('document.documentElement.scrollHeight'))
    b.close()
