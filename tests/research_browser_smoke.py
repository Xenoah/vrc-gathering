"""Research tools in Chromium: charts, graphs, filters, persisted edits and interval storage."""
import functools,json,tempfile,threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def end_headers(self):
        self.send_header('Content-Security-Policy',json.loads((ROOT/'extension/manifest.json').read_text())['content_security_policy']['extension_pages']);super().end_headers()
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'extension')))
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
  with tempfile.TemporaryDirectory(prefix='vrc-research-') as profile,sync_playwright() as p:
    context=p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,viewport={'width':1500,'height':1000})
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    base=f'http://127.0.0.1:{server.server_port}'
    page.goto(base+'/dashboard.html?demo=1');page.locator('[data-tab=research]').click()
    expect(page.locator('#researchStatus')).to_contain_text('記録開始')
    for tool in ['crowd','pairs','quality','replay','followers','events','traits','reports']:
      page.locator('[data-research-tool='+tool+']').click()
      expect(page.locator('#researchStatus')).to_contain_text('従来の履歴')
      assert 'NaN' not in page.locator('#researchPanel').inner_html(),tool
      if tool in ['pairs','replay']:
        expect(page.locator('#researchViewport')).to_be_visible()
        assert page.locator('#researchViewport canvas').evaluate('(c)=>c.width')>0
      if tool=='replay':
        page.locator('#researchReplay').fill('20');page.get_by_role('button',name='再生',exact=True).click();page.wait_for_timeout(950);page.get_by_role('button',name='停止',exact=True).click();assert int(page.locator('#researchReplay').input_value())>20
      if tool=='events':
        page.locator('#researchEvent').select_option('demo_event');expect(page.locator('#researchPanel tbody tr')).to_have_count(3)
      if tool=='followers':expect(page.locator('#researchPanel tbody')).to_contain_text('@demo')
    page.locator('[data-research-tool=pairs]').click();page.screenshot(path='/tmp/vrc-research-desktop.png',full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    for tool in ['crowd','pairs','quality','replay','followers','events','traits','reports']:
      page.locator('[data-research-tool='+tool+']').click()
      assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(tool,page.evaluate("[...document.querySelectorAll('#researchPanel *')].filter(e=>!e.closest('[hidden]')&&e.getBoundingClientRect().right>innerWidth+1).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width,e.getBoundingClientRect().right]).slice(0,15)"))
    page.screenshot(path='/tmp/vrc-research-mobile.png',full_page=True)
    page.set_viewport_size({'width':1500,'height':1000})
    # Real IndexedDB write/merge/reload. Only Chrome service-worker API boundary is replaced.
    page.evaluate('''async()=>{
      const {demoData}=await import('./demo.js'),{researchDemo}=await import('./research-demo.js'),{normalizeRecord}=await import('./sync-format.js'),{mergeSyncRecords,exportSyncRecords,exportAccount,mergeArchiveRecords,prune}=await import('./db.js');
      const d=demoData(),r=researchDemo(d,d.accountId);const rows=[];
      for(const kind of ['segments','crowd','coverage','followerHistory'])for(const value of r[kind])rows.push(normalizeRecord(kind,value));
      for(const kind of ['friends','worlds'])for(const value of d[kind])rows.push(normalizeRecord(kind,{...value,accountId:d.accountId}));
      await mergeSyncRecords(rows);await mergeSyncRecords(rows);const all=await exportSyncRecords();if(all.length!==rows.length)throw Error('duplicate merge');
      const account=await exportAccount(d.accountId);if(account.segments.length!==r.segments.length)throw Error('lost intervals');
      const old=normalizeRecord('reports',{accountId:d.accountId,id:'archive_report01',title:'Archive',observedAt:Date.now()-90*86400000,since:Date.now()-92*86400000,until:Date.now()-91*86400000,summary:{}});
      await mergeArchiveRecords([old]);await prune(30);if(!(await exportAccount(d.accountId)).reports.some(r=>r.id===old.value.id))throw Error('archive cache lost');if((await exportSyncRecords()).some(r=>r.key===old.key))throw Error('archive cache reuploaded');
      await mergeSyncRecords([normalizeRecord('reports',{accountId:d.accountId,id:'report_current01',title:'Current report',observedAt:Date.now(),since:Date.now()-86400000,until:Date.now()-1000,summary:{quality:{samples:10,complete:8,partial:2,errors:0,coverage:.8},worlds:[{name:'Test world',peak:3}],pairs:[],followers:[]}})]);
      sessionStorage.setItem('researchFixture',JSON.stringify({settings:{pollSeconds:180,retentionDays:30},accountMeta:{[d.accountId]:{displayName:'Research test'},usr_accountsecond01:{displayName:'Second account'}},state:{accountId:d.accountId,phase:'paused'}}));
    }''')
    page.add_init_script('''{
      const stored=JSON.parse(sessionStorage.getItem('researchFixture')||'{}');
      globalThis.chrome={storage:{local:{get:async keys=>{if(typeof keys==='string')keys=[keys];return Object.fromEntries((keys||Object.keys(stored)).map(k=>[k,stored[k]]));},set:async values=>Object.assign(stored,values)},onChanged:{addListener(fn){globalThis.researchStorageChanged=fn;}}},permissions:{contains:async()=>false},runtime:{getURL:path=>'/'+path,sendMessage:async message=>{
        if(message.type==='SAVE_RESEARCH'){const {normalizeRecord}=await import('/sync-format.js'),{mergeSyncRecords}=await import('/db.js');const record=normalizeRecord(message.kind,{...message.value,id:message.value.id||'item_'+crypto.randomUUID().replaceAll('-',''),observedAt:Date.now()});await mergeSyncRecords([record]);return {ok:true,record};}
        return {ok:true,skipped:true,reason:'disabled'};
      }}};
    }''')
    page.goto(base+'/dashboard.html');page.locator('[data-tab=research]').click();expect(page.locator('#researchStatus')).to_contain_text('記録開始')
    page.locator('[data-research-tool=events]').click();page.get_by_label('イベント名',exact=True).fill('<svg onload=alert(1)> Test');page.get_by_label('メモ',exact=True).fill('Persisted note');page.evaluate("researchStorageChanged({state:{newValue:{phase:'running'}}},'local')");page.wait_for_timeout(600);expect(page.get_by_label('メモ',exact=True)).to_have_value('Persisted note');expect(page.get_by_label('メモ',exact=True)).to_be_focused();page.get_by_role('button',name='イベントを保存',exact=True).click()
    expect(page.locator('#researchEvent option')).to_have_count(2);page.locator('#researchEvent').select_option(index=1);expect(page.get_by_label('メモ',exact=True)).to_have_value('Persisted note');assert page.locator('#researchPanel svg[onload]').count()==0
    page.get_by_label('メモ',exact=True).fill('Updated note');page.get_by_role('button',name='変更を保存',exact=True).click();expect(page.get_by_label('メモ',exact=True)).to_have_value('Updated note')
    page.locator('[data-research-tool=reports]').click();page.get_by_label('条件名',exact=True).fill('Weekly connections');page.get_by_label('定期レポート',exact=True).select_option('weekly');page.get_by_role('button',name='現在の条件を保存',exact=True).click();expect(page.locator('#researchView option')).to_have_count(2)
    page.get_by_text('Current report ·',exact=False).click();expect(page.locator('#researchPanel .chart-bar-name')).to_contain_text(['Test world'])
    page.locator('#researchView').select_option(index=1);page.get_by_role('button',name='この条件で表示',exact=True).click();expect(page.locator('[data-research-tool=events]')).to_have_class('selected')
    with page.expect_download() as downloaded:page.get_by_role('button',name='JSON書き出し',exact=True).click()
    assert json.loads(Path(downloaded.value.path()).read_text())['filters']['tool']=='events'
    page.reload();page.locator('[data-tab=research]').click();expect(page.locator('#researchStatus')).to_contain_text('記録開始');page.locator('[data-research-tool=events]').click();page.locator('#researchEvent').select_option(index=1);expect(page.get_by_label('メモ',exact=True)).to_have_value('Updated note')
    page.get_by_role('button',name='イベントを削除',exact=True).click();expect(page.locator('#researchEvent option')).to_have_count(1)
    page.locator('[data-research-tool=replay]').click();page.locator('#researchReplay').fill('20');page.get_by_role('button',name='再生',exact=True).click();page.evaluate("researchStorageChanged({state:{newValue:{phase:'running'}}},'local')");page.wait_for_timeout(1800);expect(page.get_by_role('button',name='停止',exact=True)).to_be_visible();assert int(page.locator('#researchReplay').input_value())>=22;page.get_by_role('button',name='停止',exact=True).click()
    page.locator('[data-research-tool=events]').click();page.get_by_label('イベント名',exact=True).fill('Account A draft');page.locator('#account').select_option('usr_accountsecond01');expect(page.get_by_label('イベント名',exact=True)).to_have_value('');page.locator('#account').select_option('usr_demoaccount0001');expect(page.get_by_label('イベント名',exact=True)).to_have_value('Account A draft')
    assert not errors,errors
    context.close();print('PASS research: 8 tools, replay, responsive layout, real IndexedDB compression storage, archive cache, persistent annotations and saved views')
finally:server.shutdown()
