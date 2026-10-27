"""A2: психиатр публикует план приёма -> пациент отмечает -> врач видит приверженность. + личный список, пропуск, share-переключатели."""
from a2_common import *

with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/patients/5/treatment')
    d.fill('form[action$="/plan"] input[name=title]' if d.locator('form[action$="/plan"] input[name=title]').count() else 'form[action$="/plan"] input[type=text]', 'Препарат Б (демо-название)')
    log('PLAN FORM', d.evaluate("[...document.querySelector('form[action$=\"/plan\"]').elements].map(e=>e.name+':'+e.type)"))
    d.locator('form[action$="/plan"] button[type=submit]').first.click()
    d.wait_for_load_state()
    log('ADDED:', txt(d, '[role=status],.flash', 200))
    shot(d, 'meds_doc_added_desk')
    ctx2, pm = login(b, 'p1', MOB)
    go(pm, '/meds')
    log('PATIENT sees Б before publish:', 'Препарат Б' in pm.inner_text('main'))
    # опубликовать
    d.reload()
    item = d.locator('li:has-text("Препарат Б"), .card:has-text("Препарат Б"), article:has-text("Препарат Б")').last
    log('buttons in item:', item.inner_text()[:300].replace('\n', ' | '))
    item.locator('button:has-text("Показать пациенту")').first.click()
    d.wait_for_load_state()
    log('PUBLISHED:', txt(d, '[role=status],.flash', 200))
    pm.reload()
    log('PATIENT sees Б after publish:', 'Препарат Б' in pm.inner_text('main'))
    shot(pm, 'meds_patient_after_publish_mob')
    blk = pm.locator('section:has-text("Препарат Б"), article:has-text("Препарат Б"), .card:has-text("Препарат Б")').last
    log('PATIENT item:', blk.inner_text()[:400].replace('\n', ' | '))
    log('PATIENT forms', pm.evaluate("[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+'='+(e.value||'')).join(',')+']')"))
    ctx2.close(); ctx.close(); b.close()
