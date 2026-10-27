"""A2 SEC-003: сессия истекла в середине формы (сервер с SESSION_IDLE_MIN_*=0.07 мин, порт 3618): теряется ли введённый текст? Заключение (автосохранение, кнопка), заметка дневника пациента."""
import os
os.environ['BASE'] = 'http://localhost:3618'
from a2_common import *
import a0_common
a0_common.BASE = 'http://localhost:3618'
import a2_common
a2_common.BASE = 'http://localhost:3618'

TEXT = 'ВАЖНЫЙ ТЕКСТ, введённый перед истечением сессии: наблюдения за 40 минут обследования.'
with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'plg', DESK)
    d.goto('http://localhost:3618/conclusions/2')
    d.wait_for_load_state()
    log('open', d.url, txt(d, 'h1', 100))
    d.fill('textarea[name=summary]', TEXT)
    d.wait_for_timeout(1500)
    d.wait_for_timeout(6000)   # сессия истекает
    d.fill('textarea[name=summary]', TEXT + ' (продолжение)')
    d.wait_for_timeout(3000)   # автосохранение пытается
    log('AUTOSAVE msg:', d.evaluate("document.body.innerText.match(/(Нет связи|Сохранено автоматически|войдите|Сессия)[^\\n]*/g)"))
    shot(d, 'session_conclusion_after_autosave_desk')
    d.click('form[action^="/conclusions/2"][action$="2"] button[type=submit]') if d.locator('form[action="/conclusions/2"] button[type=submit]').count() else None
    d.wait_for_load_state()
    log('AFTER SAVE CLICK url', d.url.replace('http://localhost:3618', ''), txt(d, 'main', 300))
    shot(d, 'session_conclusion_after_save_desk')
    # повторный вход: сохранилось ли?
    d.goto('http://localhost:3618/login')
    d.fill('input[name=email]', ACC['plg'])
    d.fill('input[name=password]', PWD)
    d.click('form[action="/login"] button[type=submit]')
    d.wait_for_load_state()
    log('after relogin url', d.url.replace('http://localhost:3618', ''))
    d.goto('http://localhost:3618/conclusions/2')
    log('SUMMARY after relogin contains text:', 'ВАЖНЫЙ ТЕКСТ' in d.input_value('textarea[name=summary]'), '| value:', d.input_value('textarea[name=summary]')[:80])
    ctx.close()
    # пациент: заметка дневника
    ctx, pm = login(b, 'p1', MOB)
    pm.goto('http://localhost:3618/diary')
    pm.locator('summary:has-text("подробности")').first.click()
    ta = pm.locator('textarea').first
    pm.locator('input[name=mood_score][value="6"], label:has-text("6") input').first.check(force=True)
    log('diary textarea count', pm.locator('textarea').count(), pm.url)
    ta.fill('Сегодня было трудно, записываю подробно: ' * 3)
    pm.wait_for_timeout(6500)
    forms = pm.evaluate("[...document.forms].map(f=>f.getAttribute('action'))")
    log('diary forms', forms)
    btn = pm.locator('form:has(textarea) button[type=submit]').first
    btn.click()
    pm.wait_for_load_state()
    log('AFTER diary save url', pm.url.replace('http://localhost:3618', ''), txt(pm, 'main', 300))
    shot(pm, 'session_diary_after_save_mob')
    pm.goto('http://localhost:3618/login')
    pm.fill('input[name=email]', ACC['p1'])
    pm.fill('input[name=password]', PWD)
    pm.click('form[action="/login"] button[type=submit]')
    pm.wait_for_load_state()
    pm.goto('http://localhost:3618/diary')
    log('diary after relogin has text:', 'записываю подробно' in pm.inner_text('main'))
    b.close()
