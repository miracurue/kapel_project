"""A2: шаблоны (подстановка, экспорт 3 форматов), быстрая заметка -> сохранить, экспорт карточки, поиск, печать."""
from a2_common import *

OUT = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/'
with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/tools/templates/b-visit')
    log('TEMPL b-visit:', txt(d, 'main', 1800))
    log('forms', d.evaluate("[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type+(e.type=='select-one'?'('+[...e.options].map(o=>o.text).join('/')+')':'')).join(',')+']')"))
    shot(d, 'tools_template_visit_desk')
    log('links', d.eval_on_selector_all('main a, main button', 'e=>e.map(x=>(x.getAttribute("href")||x.getAttribute("formaction")||"")+" "+x.innerText.trim().slice(0,30))'))
    ctx.close()
    b.close()
