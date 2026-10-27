"""A1: размеры целей касания на мобильном (390): дневник (оценки), тест (варианты), «Мне плохо», кризисные кнопки."""
from a0_common import *
JS = "(sel)=>[...document.querySelectorAll(sel)].map(e=>{const l=e.labels&&e.labels[0]?e.labels[0]:e;const r=l.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]}).slice(0,12)"
with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'p1', MOB)
    pg.goto(BASE + '/diary')
    print('diary mood targets (w,h):', pg.evaluate(JS, 'input[name=mood_score]'))
    pg.goto(BASE + '/dashboard')
    href = pg.eval_on_selector('a[href*="/take"]', 'e=>e.getAttribute("href")')
    pg.goto(BASE + href)
    print('test option targets:', pg.evaluate(JS, 'input[type=radio]'))
    print('Мне плохо:', pg.evaluate("()=>{const r=[...document.querySelectorAll('a')].find(a=>/Мне плохо/.test(a.innerText)).getBoundingClientRect();return [r.width,r.height]}"))
    ctx.close()
    b.close()
