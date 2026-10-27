"""A1 J-C7 (AID-001..019): ИИ-пространство врача psy1: файлы-ловушки, маскирование ПДн, привязка к пациенту, экспорт DOCX/PDF/TXT, копирование.
Тестовые файлы создаются во временной папке OUTDIR (по умолчанию /tmp/a1files)."""
import os, zipfile, re
from a0_common import *

OUT = os.environ.get('OUTDIR', '/tmp/a1files')
os.makedirs(OUT, exist_ok=True)
PII = ('Выписка. Пациентка Иванова Мария Петровна, 12.03.1985 г.р., тел. +7 (912) 345-67-89, e-mail masha@example.com, '
       'СНИЛС 123-456-789 01, паспорт 4510 123456. Жалобы на сниженное настроение, нарушение сна 3 недели. Принимает сертралин.')
open(f'{OUT}/vypiska.txt', 'w').write(PII)
with zipfile.ZipFile(f'{OUT}/vypiska.docx', 'w') as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + PII + '</w:t></w:r></w:p></w:body></w:document>')
open(f'{OUT}/fake.pdf', 'wb').write(b'MZ\x90\x00\x03\x00\x00\x00' + b'\x00' * 200)
open(f'{OUT}/scan.pdf', 'wb').write(b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')
open(f'{OUT}/big.txt', 'w').write('a' * (15 * 1024 * 1024))


def log(*a):
    print(*a, flush=True)


def attach(pg, fname):
    pg.locator('#ws-attach summary').click()
    pg.set_input_files('#ws-files', f'{OUT}/{fname}')
    pg.click('#ws-attach-form button[type=submit]')
    pg.wait_for_load_state()


with sync_playwright() as p:
    b = launch(p)
    ctx, pg = login(b, 'psy1')
    pg.goto(BASE + '/ai')
    pg.click('text=Новый диалог')
    pg.wait_for_load_state()
    log('NEW THREAD', pg.url.replace(BASE, ''))
    thread = pg.url.replace(BASE, '')
    for f in ('fake.pdf', 'scan.pdf', 'big.txt'):
        pg.goto(BASE + thread)
        attach(pg, f)
        log(f'UPLOAD {f} ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:350].replace('\n', ' | '))
    pg.goto(BASE + thread)
    attach(pg, 'vypiska.docx')
    log('DOCX PREVIEW ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:1500].replace('\n', ' | '))
    shot(pg, 'aiws_preview_psy_desk')
    pg.click('button:has-text("Сохранить в диалог")')
    pg.wait_for_load_state()
    log('SAVED ->', pg.url.replace(BASE, ''), pg.inner_text('main')[:500].replace('\n', ' | '))
    pg.locator('textarea').first.fill('Что уточнить на приёме?')
    pg.locator('button:has-text("Отправить")').first.click()
    pg.wait_for_timeout(6000)
    t = pg.inner_text('main')
    log('AI ANSWER has Материал cite:', 'Материал 1' in t, '| ЧЕРНОВИК:', 'ЧЕРНОВИК' in t, '| leaks Иванова:', 'Иванова' in t, '| leaks phone:', '345-67-89' in t)
    shot(pg, 'aiws_answer_psy_desk')
    # экспорт
    for fmt in ('docx', 'pdf', 'txt'):
        r = pg.request.get(BASE + thread + f'/export.{fmt}')
        body = r.body()
        log(f'EXPORT {fmt}', r.status, r.headers.get('content-type'), len(body), body[:4])
        open(f'{OUT}/exp.{fmt}', 'wb').write(body)
    # привязка к пациенту, не своему
    r = pg.request.post(BASE + '/ai/new', form={'patient_id': '7'}, max_redirects=0)
    log('NEW THREAD for foreign patient (7, у psy2):', r.status, r.headers.get('location'))
    # PII-детектор вставленного текста
    r = pg.request.post(BASE + '/ai/pii/detect', form={'text': 'Пациент Петров Иван Сергеевич тел 89123456789'})
    log('PII detect', r.status, r.text()[:200])
    b.close()
