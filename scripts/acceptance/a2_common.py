"""Общие хелперы приёмки A2 (волна 2).
Запуск: BASE=http://localhost:PORT SHOTS=docs/acceptance/A2 PYTHONPATH=scripts/acceptance python3 scripts/acceptance/a2_*.py
"""
import os, sys
os.environ.setdefault('SHOTS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'acceptance', 'A2'))
import a0_common
from a0_common import *  # noqa


def log(*a):
    print(*a, flush=True)


def txt(pg, sel='main', n=1500):
    try:
        return pg.inner_text(sel)[:n].replace('\n', ' | ')
    except Exception as e:
        return 'ERR ' + str(e)[:100]


def go(pg, path):
    r = pg.goto(BASE + path)
    pg.wait_for_load_state()
    return r.status if r else None


def overflow(pg):
    return pg.evaluate('document.documentElement.scrollWidth - window.innerWidth')


def peek(who, paths, prof=DESK, tag='', n=1200, snap=True):
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = login(b, who, prof)
        for path in paths:
            st = go(pg, path)
            log('==', who, path, st, 'ovf', overflow(pg))
            log(txt(pg, 'main', n))
            if snap:
                name = (tag or who) + '_' + path.strip('/').replace('/', '_').replace('?', '_') + ('_mob' if prof is MOB else '_desk')
                shot(pg, name)
        b.close()
