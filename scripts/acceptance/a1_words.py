"""A1 PAT-004/ALL-007/сквозная 7-8: слова «риск», «просрочено», красный цвет и обещания в пациентском UI. Контекст вокруг найденных слов."""
import re
from a0_common import *
URLS = ['/dashboard', '/tests?tab=done', '/tests?tab=progress', '/consent', '/help', '/privacy', '/share', '/diary', '/reminders', '/chat', '/profile', '/onboarding?step=1', '/onboarding?step=2', '/onboarding?step=3']
PAT = re.compile(r'.{60}(риск|просрочен|диагноз(?!ом)|оповест|свяжутся|позвонит|уведомл).{60}', re.I | re.S)
with sync_playwright() as p:
    b = launch(p)
    for who in ('p1', 'p3'):
        ctx, pg = login(b, who)
        for u in URLS:
            pg.goto(BASE + u)
            t = pg.inner_text('main').replace('\n', ' ')
            hits = {m.group(0) for m in PAT.finditer(t)}
            red = pg.evaluate("()=>[...document.querySelectorAll('main *')].filter(e=>{const c=getComputedStyle(e);const m=c.backgroundColor.match(/\\d+/g);const f=c.color.match(/\\d+/g);const isRed=a=>a&&(+a[0]>150&&+a[1]<70&&+a[2]<70);return isRed(m)||isRed(f)}).length")
            if who == 'p1' or u in ('/tests?tab=done', '/dashboard'):
                for h in list(hits)[:4]:
                    if 'не диагноз' in h.lower() or 'диагноза' in h.lower() and 'не ставит' in h.lower():
                        continue
                    print(who, u, '|', h)
                if red:
                    print(who, u, 'RED elements:', red)
        ctx.close()
    b.close()
