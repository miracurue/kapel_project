"""A1 J-P6 (AIP-001..016): чат пациента p3? нет — p1 (есть врач). Чип, диагноз/доза, длинный текст, кризис, удаление диалога, «Связаться с человеком»; потом психиатр видит обращение."""
from a0_common import *


def log(*a):
    print(*a, flush=True)


def send(pg, text):
    ta = pg.locator('textarea').first
    ta.fill(text)
    pg.locator('button:has-text("Отправить")').first.click()
    pg.wait_for_timeout(3500)


def last_ai(pg):
    m = pg.locator('.ai-msg, [data-role=assistant], .msg-assistant, .chat-msg--ai')
    return pg.inner_text('main')[-700:].replace('\n', ' | ')


with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'p1', MOB)
    pg.goto(BASE + '/chat')
    log('EMPTY:', pg.inner_text('main')[:900].replace('\n', ' | '))
    shot(pg, 'chat_empty_p1_mob')
    chips = pg.eval_on_selector_all('button.chip, .ai-chips button, [data-chip]', 'e=>e.map(x=>x.innerText.trim())')
    log('CHIPS', chips)
    if chips:
        pg.locator('button.chip, .ai-chips button, [data-chip]').first.click()
        pg.wait_for_timeout(300)
        log('chip filled textarea:', pg.input_value('textarea'))
    send(pg, 'Какой у меня диагноз и какую дозу сертралина мне принимать?')
    log('DIAG REQ ->', last_ai(pg))
    shot(pg, 'chat_diag_p1_mob')
    pg.locator('textarea').first.fill('я' * 2001)
    log('2001 chars: counter/disabled:', pg.inner_text('main')[-120:].replace('\n', ' | '), '| value len', len(pg.input_value('textarea')))
    pg.locator('textarea').first.fill('')
    send(pg, 'Не могу уснуть, что делать?')
    log('SLEEP ->', last_ai(pg))
    # Связаться с человеком
    pg.goto(BASE + '/chat/contact')
    log('CONTACT PAGE:', pg.inner_text('main')[:700].replace('\n', ' | '))
    pg.fill('textarea[name=text]', 'Прошу связаться, тяжёлая неделя')
    pg.click('form[action="/chat/contact"] button[type=submit]')
    pg.wait_for_load_state()
    log('CONTACT SENT ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:500].replace('\n', ' | '))
    shot(pg, 'chat_contact_sent_p1_mob')
    # удаление диалога
    pg.goto(BASE + '/chat')
    href = pg.eval_on_selector_all('a[href*="/chat/t/"]', 'e=>e.map(x=>x.getAttribute("href"))')
    log('THREAD LINKS', href[:5])
    if href:
        pg.goto(BASE + href[0] + '/delete')
        log('DELETE PAGE:', pg.inner_text('main')[:600].replace('\n', ' | '))
    ctx.close()
    ctx, psy = login(b, 'psy1')
    psy.goto(BASE + '/crisis')
    t = psy.inner_text('main')
    log('PSY CRISIS has contact request:', 'тяжёлая неделя' in t, '| Обращ' in t, t[:50])
    shot(psy, 'chat_psy_queue_desk')
    b.close()
