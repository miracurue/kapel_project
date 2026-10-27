"""A2: отметки приёма пациентом, нейтральность текста, отражение у врача, переключатель share_med_log."""
from a2_common import *

with sync_playwright() as p:
    b = launch(p)
    ctx, pm = login(b, 'p1', MOB)
    go(pm, '/meds')
    before = pm.inner_text('main')
    f = 'form[action="/meds/log"]:has(input[name=item_id][value="5"])'
    pm.click(f + ' button[value=skipped]')
    pm.wait_for_load_state()
    log('SKIPPED ->', pm.url.replace(BASE, ''), txt(pm, '[role=status],.flash', 200))
    blk = pm.locator('article:has-text("Препарат Б"), section:has-text("Препарат Б"), .card:has-text("Препарат Б")').last.inner_text()
    log('ITEM STATE after skip:', blk.replace('\n', ' | ')[:300])
    shot(pm, 'meds_skipped_patient_mob')
    # цвет: красного нет
    red = pm.evaluate("""()=>[...document.querySelectorAll('main *')].filter(e=>{const c=getComputedStyle(e);const m=c.color.match(/\\d+/g)||[];const bg=(c.backgroundColor.match(/\\d+/g)||[]);return (+m[0]>180&&+m[1]<80&&+m[2]<80)||(+bg[0]>180&&+bg[1]<80&&+bg[2]<80&&(bg[3]===undefined||+bg[3]>0))}).length""")
    log('RED elements in /meds:', red)
    pm.click(f + ' button[value=taken]')
    pm.wait_for_load_state()
    log('TAKEN after skip (overwrite?):', pm.locator('article:has-text("Препарат Б"), section:has-text("Препарат Б"), .card:has-text("Препарат Б")').last.inner_text().replace('\n', ' | ')[:300])
    go(pm, '/dashboard')
    log('DASH:', txt(pm, 'main', 700))
    ctx.close()
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/patients/5/treatment')
    t = d.inner_text('main')
    i = t.find('Отметки приёма')
    log('DOC adherence:', t[i:i + 400].replace('\n', ' | '))
    shot(d, 'meds_doc_adherence_desk')
    ctx.close()
    # переключатель share_med_log
    ctx, pm = login(b, 'p1', DESK)
    go(pm, '/share')
    log('SHARE page:', txt(pm, 'main', 2500))
    shot(pm, 'share_patient_desk')
    b.close()
