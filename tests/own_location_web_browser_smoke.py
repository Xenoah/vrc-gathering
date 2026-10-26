"""Official-Web sidebar shape, using only synthetic IDs/content and routed local files."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OWNER='usr_sidebarfixture01'
WORLD='wrld_sidebarfixture01'
CARD=f'''<div class="css-fixture"><div class=" location-card size-normal card"><div>
<a title="Fixture cafe" href="/home/launch?worldId={WORLD}&amp;instanceId=123~region(jp)" target="_blank"><img class="img-thumbnail location-img" alt="Fixture cafe"></a>
<h6 class="location-title"><span class="badge bg-secondary">1&nbsp;<svg><title>Number of friends in instance</title></svg></span>
<a title="Fixture cafe" href="/home/launch?worldId={WORLD}&amp;instanceId=123~region(jp)" target="_blank">Fixture cafe : <div aria-label="Region Badge"><img alt="jp"></div> Public</a></h6><div class="clearfix"></div>
</div></div></div>'''
HTML=f'''<!doctype html><meta charset="utf-8"><style>body{{margin:0}}#side{{width:260px}}a{{display:block;min-height:25px}}.location-card{{height:180px}}main{{position:absolute;left:300px}}</style>
<div id="side"><div><a href="/home/user/{OWNER}">Fixture self</a></div>{CARD}<a href="/home/friends">Friends</a><a href="/home/groups">Groups</a></div><main><h1>Profile</h1></main>'''

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900})
    def route(req):
        name=req.request.url.split('?')[0].rsplit('/',1)[-1]
        file=ROOT/'extension'/name
        if name.endswith('.js') and file.is_file():req.fulfill(body=file.read_text(),content_type='text/javascript; charset=utf-8')
        else:req.fulfill(body=HTML,content_type='text/html; charset=utf-8')
    page.route('**/*',route)
    page.goto('https://vrchat.com/home')
    page.evaluate("async()=>{window.readCard=(await import('/own-location-web.js')).readOwnLocationCard;}")
    def read():return page.evaluate('(id)=>readCard(id)',OWNER)
    def reset():page.evaluate('(html)=>document.body.innerHTML=html',HTML.split('</style>')[1])
    found=read();assert found=={'accountId':OWNER,'worldId':WORLD,'instanceId':'123~region(jp)','worldName':'Fixture cafe'},found
    # A friend's main-panel card cannot override the current sidebar.
    page.evaluate('(card)=>document.querySelector("main").innerHTML+=card',CARD.replace('123~','456~'))
    assert read()==found
    # The same location can have image/title links; a different target is ambiguous.
    reset();page.evaluate("document.querySelector('.location-title a').href=document.querySelector('.location-title a').href.replace('123~','456~')");assert read() is None
    # Reject other profiles, hidden/removed navigation, duplicate cards and unknown ownership.
    reset();page.evaluate("document.querySelector('#side a').href='/home/user/usr_otherfixture01'");assert read() is None
    reset();page.evaluate("document.querySelector('#side').hidden=true");assert read() is None
    reset();page.evaluate("document.querySelector('#side').setAttribute('aria-hidden','true')");assert read() is None
    reset();page.evaluate("document.querySelector('#side a').remove()");assert read() is None
    reset();page.evaluate('(card)=>document.querySelector("#side").innerHTML+=card',CARD);assert read() is None
    reset();page.evaluate("document.querySelector('#side').style.width='900px'");assert read() is None
    reset();page.evaluate("document.querySelector('#side').innerHTML=document.querySelector('#side').innerHTML.replace('/home/groups','/other')");assert read() is None
    reset();page.evaluate("document.querySelector('main').append(document.querySelector('#side'))");assert read() is None
    # SPA update / removal and narrow viewport keep the same ownership constraints.
    reset();page.evaluate("document.querySelector('#side').innerHTML=document.querySelector('#side').innerHTML.replaceAll('123~','456~')");assert read()['instanceId']=='456~region(jp)'
    page.evaluate("document.querySelector('.location-card').remove()");assert read() is None
    reset();page.set_viewport_size({'width':390,'height':844});assert read()==found
    print('PASS: own sidebar DOM, launch parameters, title/image deduplication, friend/main/hidden/ambiguous cards, account binding, SPA changes/removal and mobile; badge and images excluded')
    browser.close()
