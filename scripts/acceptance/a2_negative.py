"""A2 негативные: изоляция (чужие пункты плана, сообщения, заключения), роли, CSRF без токена, перебор пароля, XSS в сообщении, права психолога (J-Y2)."""
from a2_common import *
import urllib.request, urllib.parse, http.cookiejar

TOK = """async ()=>{const t=await (await fetch('/csrf-token')).json();return Object.values(t).find(v=>typeof v==='string'&&v.length>20)}"""


def post(pg, path, body, token=True):
    return pg.evaluate("""async ([u,b,tok])=>{let h={'Content-Type':'application/x-www-form-urlencoded'};if(tok){const t=await (await fetch('/csrf-token')).json();h['X-CSRF-Token']=Object.values(t).find(v=>typeof v==='string'&&v.length>20)}
        const r=await fetch(u,{method:'POST',redirect:'manual',headers:h,body:b});return r.status+' '+r.type}""", [path, body, token])


with sync_playwright() as p:
    b = launch(p)
    # пациент 5: чужой пункт плана (id 3 у пациента 6), чужая выдача
    ctx, pm = login(b, 'p1', DESK)
    for path, body in (('/meds/3/ack', ''), ('/meds/3/end', ''), ('/meds/log', 'item_id=3&slot=any&status=taken')):
        log('P1 foreign med', path, post(pm, path, body))
    log('P1 GET /tools', go(pm, '/tools'), '| /conclusions', go(pm, '/conclusions'), '| /inbox', go(pm, '/inbox'), '| /conclusions/1', go(pm, '/conclusions/1'), '| /patients/5/messages', go(pm, '/patients/5/messages'), '| /conclusions/1/export.pdf', go(pm, '/conclusions/1/export.pdf'))
    log('P1 /my-conclusions/1 (foreign):', go(pm, '/my-conclusions/1'))
    log('P1 messages with=3 (foreign doctor not mine):', go(pm, '/messages?with=3'), txt(pm, 'main', 200))
    log('P1 msg to non-assigned clinician', post(pm, '/messages', 'clinician_id=3&body=hello'))
    # CSRF без токена
    log('P1 POST /messages without CSRF', post(pm, '/messages', 'clinician_id=2&body=nocsrf', token=False))
    ctx.close()
    # админ
    ctx, a = login(b, 'admin', DESK)
    for path in ('/inbox', '/tools', '/conclusions', '/conclusions/1', '/messages', '/my-conclusions', '/learn', '/meds', '/patients/5/messages', '/tools/export/5', '/previsit', '/patients/5/learn'):
        log('ADMIN', path, go(a, path))
    ctx.close()
    # психолог: J-Y2
    ctx, y = login(b, 'plg', DESK)
    log('PLG /patients/5/treatment', go(y, '/patients/5/treatment'), txt(y, 'main', 100)[-90:])
    t = y.inner_text('main')
    log('PLG treatment page has plan form?', y.locator('form[action$="/plan"]').count(), '| diagnos words:', [w for w in ('диагноз', 'Диагноз', 'назначить терапию') if w in t])
    log('PLG POST plan', post(y, '/patients/5/plan', 'name=X&how_text=Y'), '| POST treatment', post(y, '/patients/5/treatment', 'title=X'))
    log('PLG GET /patients/7/conclusions (not mine)', go(y, '/patients/7/conclusions'))
    log('PLG POST message to patient 7', post(y, '/patients/7/messages', 'body=x'))
    log('PLG psychoed assign ok?', post(y, '/patients/5/learn/assign', 'module=breathing_grounding'))
    ctx.close()
    # психиатр 2 к чужому
    ctx, s = login(b, 'psychiatrist2@example.com', DESK)
    log('PSY2 GET /patients/5/messages', go(s, '/patients/5/messages'), '| /conclusions/2 (draft of foreign patient)', go(s, '/conclusions/2'), '| /patients/5/exam/1', go(s, '/patients/5/exam/1'))
    ctx.close()
    # XSS в сообщении
    ctx, pm = login(b, 'p1', DESK)
    go(pm, '/messages?with=2')
    pm.fill('textarea[name=body]', '<img src=x onerror=window.__x=1><script>window.__y=1</script> проверка')
    pm.click('form[action="/messages"] button[type=submit]')
    pm.wait_for_load_state()
    log('XSS patient view executed:', pm.evaluate('!!(window.__x||window.__y)'), '| escaped shown:', '<img src=x' in pm.inner_text('main'))
    ctx.close()
    ctx, d = login(b, 'psy1', DESK)
    go(d, '/patients/5/messages')
    log('XSS doctor view executed:', d.evaluate('!!(window.__x||window.__y)'), '| escaped shown:', '<img src=x' in d.inner_text('main'))
    ctx.close()
    b.close()

# перебор пароля
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), urllib.request.HTTPRedirectHandler())
import re
def login_try(email, pw):
    r = op.open(BASE + '/login').read().decode()
    tok = re.search(r'name="_csrf" value="([^"]+)"', r).group(1)
    data = urllib.parse.urlencode({'email': email, 'password': pw, '_csrf': tok}).encode()
    try:
        resp = op.open(urllib.request.Request(BASE + '/login', data=data))
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

for i in range(7):
    st, body = login_try('psychologist2@example.com', 'wrong-%d' % i)
    m = re.search(r'(Слишком много[^<]*|Неверн[^<]*|не найден[^<]*)', body)
    log('LOGIN try', i, st, m.group(1)[:110] if m else '')
st, body = login_try('psychologist2@example.com', PWD)
log('LOGIN right pw during lockout', st, re.search(r'(Слишком много[^<]*)', body).group(1)[:100] if re.search(r'(Слишком много[^<]*)', body) else 'logged in?')
st, body = login_try('no.such.user@example.com', 'x')
log('LOGIN unknown user first try', st, re.search(r'(Слишком много[^<]*|Неверн[^<]*)', body).group(1)[:100] if re.search(r'(Слишком много[^<]*|Неверн[^<]*)', body) else '')
