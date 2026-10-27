"""A2: шаблон -> 3 формата, быстрая заметка -> сохранить в карточку, поиск, экспорт карточки, печать."""
from a2_common import *

OUT = '/tmp/claude-1000/-home-morrigue-REPS-clinical-compass/b60fbee4-fc6f-478d-b900-7687ccc1b95c/scratchpad/pma2/'
with sync_playwright() as p:
    b = launch(p)
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/tools/templates/b-visit')
    d.fill('input[name=f1]', '15.10.2026')
    d.fill('input[name=f2]', 'Орлов П. С.')
    d.select_option('select[name=patient_id]', label='Демо Пациент Светлова Анна')
    for fmt in ('docx', 'pdf', 'txt'):
        with d.expect_download() as dl:
            d.locator('button[name=fmt][value=%s]' % fmt).click()
        f = dl.value
        f.save_as(OUT + 'tpl.' + fmt)
        log('TEMPLATE', fmt, f.suggested_filename)
    # печать
    d.locator('button[name=fmt][value=print]').click() if d.locator('button[name=fmt][value=print]').count() else None
    d.wait_for_load_state()
    log('PRINT page:', d.url.replace(BASE, ''), txt(d, 'main', 400))
    d.emulate_media(media='print')
    shot(d, 'tools_template_print_desk')
    d.emulate_media(media='screen')
    # быстрая заметка -> сохранить
    go(d, '/tools/quicknote')
    d.fill('textarea', 'Жалобы: плохой сон. План: повторить PHQ-9 через 2 недели.')
    d.click('form[action="/tools/quicknote"] button[type=submit]')
    d.wait_for_load_state()
    d.select_option('form[action="/tools/quicknote/save"] select', label='Демо Пациент Светлова Анна')
    d.click('form[action="/tools/quicknote/save"] button[type=submit]')
    d.wait_for_load_state()
    log('QN saved:', txt(d, '[role=status],.flash', 200))
    go(d, '/patients/5')
    go(d, '/patients/5/notes')
    log('NOTES tab has quicknote:', 'повторить PHQ-9' in d.inner_text('main'))
    # поиск
    go(d, '/tools/search')
    d.fill('input[name=q]', 'PHQ-9')
    d.press('input[name=q]', 'Enter')
    d.wait_for_load_state()
    log('SEARCH:', txt(d, 'main', 900))
    shot(d, 'tools_search_desk')
    d.fill('input[name=q]', 'Громов')
    d.press('input[name=q]', 'Enter'); d.wait_for_load_state()
    log('SEARCH name:', txt(d, 'main', 500))
    # экспорт карточки
    go(d, '/tools/export/5')
    log('EXPORT PAGE:', txt(d, 'main', 1500))
    shot(d, 'tools_export_card_desk')
    log('export forms', d.evaluate("[...document.forms].map(f=>f.getAttribute('action')+' ['+[...f.elements].filter(e=>e.name&&e.name!='_csrf').map(e=>e.name+':'+e.type+'='+e.value).join(',')+']')"))
    for fmt in ('docx', 'pdf', 'txt'):
        with d.expect_download() as dl:
            d.locator('button[value=%s], button[name=fmt][value=%s]' % (fmt, fmt)).first.click()
        dl.value.save_as(OUT + 'card.' + fmt)
        log('CARD EXPORT', fmt, dl.value.suggested_filename)
    # чужой пациент
    log('foreign patient export status:', go(d, '/tools/export/7'))
    # печать карточки
    go(d, '/patients/5/visit')
    d.emulate_media(media='print')
    log('PRINT visit nav visible:', d.locator('nav').first.is_visible() if d.locator('nav').count() else 'no nav', '| banner demo visible:', d.locator('.demo-banner, [data-demo-banner]').count())
    shot(d, 'visit_print_desk')
    b.close()
