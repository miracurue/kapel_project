"""Общие хелперы приёмки A0 (Playwright sync). Сервер: BASE (по умолчанию http://localhost:3310) на сид-БД."""
import os, glob
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://localhost:3310')
PWD = 'demo-pass-123'
SHOTS = os.environ.get('SHOTS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'acceptance', 'A0'))
ACC = {
    'admin': 'admin@example.com', 'psy1': 'psychiatrist1@example.com', 'psy2': 'psychiatrist2@example.com',
    'plg': 'psychologist1@example.com', 'p1': 'patient1.improving@example.com', 'p2': 'patient2.worsening@example.com',
    'p3': 'patient3.crisis@example.com', 'p4': 'patient4.inactive@example.com', 'p5': 'patient5.mixed@example.com',
    'p6': 'patient6.nodoctor@example.com', 'p7': 'patient7.revoked@example.com', 'p8': 'patient8.new@example.com',
}
DESK = dict(viewport={'width': 1280, 'height': 800})
MOB = dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
NARROW = dict(viewport={'width': 360, 'height': 740}, is_mobile=True, has_touch=True)


def chromium():
    c = sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome')))
    return c[-1] if c else None


def launch(p):
    return p.chromium.launch(executable_path=chromium())


def login(browser, who, profile=DESK):
    ctx = browser.new_context(**profile)
    page = ctx.new_page()
    page.goto(BASE + '/login')
    page.fill('input[name=email]', ACC.get(who, who))
    page.fill('input[name=password]', PWD)
    page.click('form[action="/login"] button[type=submit]')
    page.wait_for_load_state()
    return ctx, page


def shot(page, name, full=True):
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)
