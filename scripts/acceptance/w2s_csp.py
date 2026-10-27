"""W2.S: все экраны сида работают под CSP и CSRF. Обход ссылок по ролям, нарушения CSP из консоли и события
securitypolicyviolation, внешние запросы, JS-сценарии (чат, ИИ-пространство, автосохранение, меню, фильтр каталога),
вход и выход без JS. Запуск: BASE=http://localhost:3310 python3 scripts/acceptance/w2s_csp.py (сервер на сид-БД)."""
import json, re, sys, time
from a0_common import *

LIMIT = int(__import__('os').environ.get('LIMIT', '70'))
problems = []
stats = {'pages': 0, 'forms': 0}

INIT = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sourceFile||'') + ':' + (e.lineNumber||'')));
"""


def watch(page, tag):
    page.add_init_script(INIT)
    page.on('console', lambda m: problems.append(f'[{tag}] console {m.type}: {m.text[:200]}') if (m.type in ('error', 'warning') and re.search(r'Content Security Policy|Refused to|CSP', m.text)) else None)
    page.on('pageerror', lambda e: problems.append(f'[{tag}] pageerror: {str(e)[:200]}'))
    page.on('requestfailed', lambda r: problems.append(f'[{tag}] requestfailed {r.url[:120]}') if not r.url.startswith(BASE) else None)
    page.on('request', lambda r: problems.append(f'[{tag}] EXTERNAL {r.url[:120]}') if not (r.url.startswith(BASE) or r.url.startswith('data:')) else None)


def collect(page, tag, path):
    v = page.evaluate('window.__csp || []')
    for x in v:
        problems.append(f'[{tag}] CSP violation on {path}: {x}')
    stats['forms'] += page.evaluate('document.querySelectorAll("form[method=POST],form[method=post]").length')
    bad = page.evaluate('[...document.querySelectorAll("form[method=POST],form[method=post]")].filter(f=>f.querySelectorAll("input[name=_csrf]").length!==1).length')
    if bad:
        problems.append(f'[{tag}] {path}: форм без ровно одного _csrf: {bad}')


def crawl(b, who, profile=DESK):
    ctx, page = login(b, who, profile)
    tag = who + ('-mob' if profile is MOB else '')
    watch(page, tag)
    seen, queue = set(), ['/dashboard']
    n = 0
    while queue and n < LIMIT:
        u = queue.pop(0)
        if u in seen:
            continue
        seen.add(u)
        try:
            r = page.goto(BASE + u)
        except Exception:
            continue  # скачивание файла и т.п.
        if not r or r.status >= 400 or 'html' not in (r.headers.get('content-type') or ''):
            if r and r.status >= 500:
                problems.append(f'[{tag}] {u}: HTTP {r.status}')
            continue
        n += 1
        stats['pages'] += 1
        hdr = r.headers
        if "default-src 'self'" not in (hdr.get('content-security-policy') or ''):
            problems.append(f'[{tag}] {u}: нет CSP')
        page.wait_for_timeout(150)
        collect(page, tag, u)
        for h in page.eval_on_selector_all('a[href]', 'els=>els.map(e=>e.getAttribute("href"))'):
            h = h.split('#')[0]
            if h.startswith('/') and not h.startswith('//') and not re.search(r'logout|export|download|print|\.csv|\.docx|\.pdf|\.txt|\.js|\.css', h) and h not in seen:
                queue.append(h)
    ctx.close()


def scenarios(b):
    # пациент: чат с fetch (токен в заголовке), меню, форма дневника
    ctx, page = login(b, 'p1')
    watch(page, 'chat')
    page.goto(BASE + '/chat')
    ta = page.locator('#ai-input, textarea[name=text]').first
    ta.fill('Расскажи про дыхательное упражнение')
    responses = []
    page.on('response', lambda r: responses.append((r.url, r.status)) if r.request.method == 'POST' else None)
    page.locator('#ai-send').click()
    page.wait_for_timeout(2500)
    if not any('/chat/send' in u and s == 200 for u, s in responses):
        problems.append(f'chat: POST /chat/send не 200: {responses}')
    collect(page, 'chat', '/chat')
    ctx.close()

    # клиницист: ИИ-пространство, детектор ПДн (fetch POST JSON)
    ctx, page = login(b, 'psy1')
    watch(page, 'ws')
    page.goto(BASE + '/ai')
    page.locator('#ai-input, textarea[name=text]').first.fill('Позвоните +7 (999) 000-00-00 пациенту')
    responses = []
    page.on('response', lambda r: responses.append((r.url, r.status)) if r.request.method == 'POST' else None)
    page.locator('#ai-send').click()
    page.wait_for_timeout(2500)
    if not any('/ai/pii/detect' in u and s == 200 for u, s in responses):
        problems.append(f'ai workspace: POST /ai/pii/detect не 200: {responses}')
    collect(page, 'ws', '/ai')
    # загрузка файла (multipart, токен в поле формы)
    page.goto(BASE + '/ai')
    inp = page.locator('input[type=file]').first
    if inp.count():
        inp.set_input_files({'name': 'note.txt', 'mimeType': 'text/plain', 'buffer': 'Тестовый материал'.encode()})
        page.wait_for_timeout(1500)
        page.locator('#ws-attach summary').click()
        btn = page.locator('#ws-attach-form button[type=submit]')
        if btn.count() and btn.first.is_visible():
            btn.first.click()
            page.wait_for_load_state()
            if 'материал' not in page.content().lower() and 'файл' not in page.content().lower():
                problems.append('ai upload: страница предпросмотра не отрисована')
            if page.locator('h1:has-text("Нет доступа")').count():
                problems.append('ai upload: 403')
        else:
            problems.append('ai upload: кнопка отправки вложения не найдена/невидима')
    else:
        problems.append('ai upload: input[type=file] не найден')
    ctx.close()

    # импорт CSV (multipart без JS-вставки токена)
    ctx, page = login(b, 'psy1')
    watch(page, 'csv')
    page.goto(BASE + '/tools/import')
    page.set_input_files('input[type=file]', {'name': 'x.csv', 'mimeType': 'text/csv', 'buffer': 'fio,date\nИванов,2026-01-01\n'.encode()})
    page.click('form[action="/tools/import/upload"] button[type=submit]')
    page.wait_for_load_state()
    if page.locator('h1:has-text("Нет доступа")').count():
        problems.append('csv upload: 403')
    collect(page, 'csv', '/tools/import')
    # фильтр каталога
    page.goto(BASE + '/assignments')
    s = page.locator('.catalog-picker input[type=search]').first
    if s.count():
        s.fill('phq')
        page.wait_for_timeout(200)
        visible = page.locator('.catalog-item:visible').count()
        if visible == 0:
            problems.append('catalog picker: фильтр не работает или ничего не найдено')
    else:
        problems.append('catalog picker: не найден поиск (/assignments)')
    collect(page, 'csv', '/assignments')
    # кризисная очередь: SLA-таймер
    page.goto(BASE + '/crisis')
    page.wait_for_timeout(300)
    collect(page, 'csv', '/crisis')
    ctx.close()

    # психолог: автосохранение заключения (fetch POST form)
    ctx, page = login(b, 'plg')
    watch(page, 'concl')
    page.goto(BASE + '/dashboard')
    for cid in (1, 2, 3):
        page.goto(BASE + f'/conclusions/{cid}')
        if page.locator('form[data-autosave]').count():
            break
    form = page.locator('form[data-autosave]').first
    if form.count():
        area = form.locator('textarea').first
        if area.count() and area.is_editable():
            area.fill((area.input_value() or '') + ' проверка')
            page.wait_for_timeout(3500)
            st = page.locator('.concl-state, #autosave-state').first.inner_text() if page.locator('.concl-state, #autosave-state').count() else ''
            if 'Сохранено' not in st:
                problems.append(f'conclusion autosave: статус «{st}»')
    else:
        problems.append('conclusion autosave: форма не найдена на ' + page.url)
    collect(page, 'concl', page.url)
    ctx.close()

    # мобильное меню (nav.js) и выход через форму
    ctx, page = login(b, 'p1', MOB)
    watch(page, 'mob')
    page.goto(BASE + '/dashboard')
    t = page.locator('#nav-toggle')
    if t.count():
        before = t.get_attribute('aria-expanded')
        t.click()
        after = t.get_attribute('aria-expanded')
        if before == after:
            problems.append('nav toggle: aria-expanded не меняется')
    page.click('form[action="/logout"] button[type=submit]') if page.locator('form[action="/logout"] button').is_visible() else page.evaluate('document.querySelector("form[action=\\"/logout\\"]").submit()')
    page.wait_for_load_state()
    if '/login' not in page.url:
        problems.append('logout: не вернуло на /login ' + page.url)
    ctx.close()

    # без JS: вход и выход обычными формами
    ctx = b.new_context(java_script_enabled=False, **DESK)
    page = ctx.new_page()
    page.goto(BASE + '/login')
    page.fill('input[name=email]', ACC['psy1'])
    page.fill('input[name=password]', PWD)
    page.click('form[action="/login"] button[type=submit]')
    page.wait_for_load_state()
    if '/dashboard' not in page.url:
        problems.append('без JS: вход не удался ' + page.url)
    page.click('form[action="/logout"] button[type=submit]')
    page.wait_for_load_state()
    if '/login' not in page.url:
        problems.append('без JS: выход не удался ' + page.url)
    ctx.close()


with sync_playwright() as p:
    b = launch(p)
    for who in ['p1', 'p3', 'p6', 'p8', 'psy1', 'plg', 'admin']:
        crawl(b, who)
    crawl(b, 'p1', MOB)
    scenarios(b)
    b.close()

print(json.dumps({'stats': stats, 'problems': problems}, ensure_ascii=False, indent=1))
sys.exit(1 if problems else 0)
