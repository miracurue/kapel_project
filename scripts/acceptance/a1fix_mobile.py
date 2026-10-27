"""W2.X: проверка мобильной вёрстки экранов из D6 (390 px). Запуск:
BASE=http://localhost:PORT SHOTS=docs/ui-wave2/a1-fixes PYTHONPATH=scripts/acceptance python3 scripts/acceptance/a1fix_mobile.py
Критерий: scrollWidth документа <= 390 (сравнение с константой). Скриншоты — по одному на экран."""
import os, sys
from a0_common import BASE, SHOTS, MOB, NARROW, launch, login, shot
from playwright.sync_api import sync_playwright

SCREENS = [
    ('psy1', '/dashboard', 'psy1_dashboard'),
    ('psy1', '/patients', 'psy1_patients'),
    ('psy1', '/assignments', 'psy1_assignments'),
    ('psy1', '/ai', 'psy1_ai'),
    ('psy1', '/invites', 'psy1_invites'),
    ('psy1', '/export', 'psy1_export'),
    ('psy1', '/patients/1', 'psy1_card'),
    ('psy1', '/patients/1/scales', 'psy1_card_scales'),
    ('psy1', '/patients/1/materials', 'psy1_card_materials'),
    ('psy1', '/patients/1/journal', 'psy1_card_journal'),
    ('psy1', '/crisis', 'psy1_crisis'),
    ('admin', '/admin/assignments', 'admin_assignments'),
    ('admin', '/admin/invites', 'admin_invites'),
    ('admin', '/admin/audit', 'admin_audit'),
    ('p1', '/dashboard', 'p1_dashboard'),
    ('p1', '/privacy', 'p1_privacy'),
    ('p1', '/share', 'p1_share'),
    ('p1', '/help', 'p1_help'),
    ('p1', '/chat', 'p1_chat'),
    ('p4', '/dashboard', 'p4_dashboard'),
]

W = int(os.environ.get('W', '390'))
bad = 0
with sync_playwright() as p:
    b = launch(p)
    ctxs = {}
    for who, url, name in SCREENS:
        if who not in ctxs:
            ctxs[who] = login(b, who, MOB if W == 390 else NARROW)
        ctx, page = ctxs[who]
        if '/patients/1' in url:  # id первого пациента врача берём из списка
            page.goto(BASE + '/patients')
            href = page.evaluate("document.querySelector('a[href^=\"/patients/\"]').getAttribute('href')")
            url = url.replace('/patients/1', href)
        r = page.goto(BASE + url)
        page.wait_for_load_state()
        sw = page.evaluate('document.documentElement.scrollWidth')
        status = r.status if r else '?'
        flag = 'OK ' if sw <= W else 'BAD'
        if sw > W:
            bad += 1
        print(f'{flag} {name:28s} {url:28s} http={status} scrollWidth={sw}')
        shot(page, name + f'_{W}', full=False)  # только первый экран: полностраничные снимки не читаются глазами
    b.close()
print('overflow screens:', bad)
sys.exit(1 if bad else 0)
