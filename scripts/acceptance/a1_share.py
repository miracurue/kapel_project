"""A1 PAT-017/CLN-013/AID-003: переключатели «Поделиться с врачом» реально ли влияют на карточку врача и контекст ИИ.
p1 (Светлова, id 5) <-> psy1. Пишет в дневник заметку-маркер, переключает scores/notes, смотрит вкладку «Дневник» и ИИ «Сводка к приёму»."""
import re
from a0_common import *

MARK = 'МАРКЕР-ЗАМЕТКА-77'


def log(*a):
    print(*a, flush=True)


def set_share(b, scores, notes, chats=False):
    ctx, pat = login(b, 'p1')
    pat.goto(BASE + '/share')
    for n, v in (('scores', scores), ('notes', notes), ('chats', chats)):
        loc = pat.locator(f'input[name={n}]')
        if loc.is_checked() != v:
            loc.set_checked(v)
    pat.click('form[action="/share"] button[type=submit]')
    pat.wait_for_load_state()
    log('SHARE saved:', scores, notes, '->', pat.inner_text('main')[:120].replace('\n', ' | '))
    ctx.close()


def doctor_view(b, label):
    ctx, psy = login(b, 'psy1')
    psy.goto(BASE + '/patients/5/diary')
    t = psy.inner_text('main')
    log(f'[{label}] CARD DIARY: marker visible={MARK in t} | has "не делится"={"не делится" in t} | head:', t[300:700].replace('\n', ' | '))
    shot(psy, f'share_card_{label}_desk', full=False)
    # ИИ: тред по пациенту
    r = psy.request.post(BASE + '/ai/new', form={'patient_id': '5'}, max_redirects=0)
    loc = r.headers.get('location', '')
    psy.goto(BASE + loc)
    chip = psy.locator('button:has-text("Сводка к приёму")')
    chip.first.click()
    psy.wait_for_timeout(500)
    send = psy.locator('button:has-text("Отправить")')
    if send.count():
        send.first.click()
    psy.wait_for_timeout(6000)
    ai = psy.inner_text('main')
    log(f'[{label}] AI thread {loc}: marker in AI text={MARK in ai}; diary words=', re.findall(r'[^\n]*(?:дневник|настроени)[^\n]*', ai)[:6])
    shot(psy, f'share_ai_{label}_desk')
    ctx.close()


with sync_playwright() as p:
    b = launch(p)
    ctx, pat = login(b, 'p1')
    pat.goto(BASE + '/diary')
    pat.locator('input[name=mood_score]').nth(4).check(force=True)
    pat.fill('textarea[name=note]', MARK) if pat.locator('textarea[name=note]').is_visible() else pat.evaluate(f"document.querySelector('textarea[name=note]').value='{MARK}'")
    pat.click('form[action="/diary"] button[type=submit]')
    pat.wait_for_load_state()
    log('DIARY SAVED:', pat.inner_text('main')[:200].replace('\n', ' | '))
    ctx.close()
    set_share(b, scores=True, notes=False)
    doctor_view(b, 'default')
    set_share(b, scores=False, notes=False)
    doctor_view(b, 'scores_off')
    set_share(b, scores=True, notes=True)
    doctor_view(b, 'notes_on')
    set_share(b, scores=True, notes=False)
    b.close()
