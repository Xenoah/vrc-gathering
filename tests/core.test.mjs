import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION, settings, validContact, location, friend, currentUser, rosterObservations, reconcile, retryDelay, csv, world, userAgentRule } from '../extension/core.js';
import { demoData } from '../extension/demo.js';
const uid='usr_01234567-1111-2222-3333-012345678901',wid='wrld_01234567-1111-2222-3333-012345678901';
const sample=(time=1000,loc=wid+':123~region(jp)')=>friend({id:uid,displayName:'架空のフレンド',location:loc,status:'active'},time,'online');
test('private/unknown/traveling never disclose a remembered world',()=>{
  for(const loc of ['private','traveling','','null','something-new'])assert.equal(location(loc).worldId,'');
  assert.equal(location('private').kind,'private');assert.equal(location(wid+':123','offline').kind,'offline');
});
test('instance access and region parsing',()=>{
  assert.equal(location(wid+':123~hidden('+uid+')~region(jp)').access,'friends-plus');
  assert.equal(location(wid+':123~friends('+uid+')').access,'friends');
  assert.equal(location(wid+':123~private('+uid+')~canRequestInvite~region(eu)').access,'invite-plus');
  assert.equal(location(wid+':123~group(grp_test)~groupAccessType(public)~region(use)').access,'group-public');
  assert.equal(location(wid+':123~region(jp)').region,'jp');
});
test('authentication and friend objects are explicitly allowlisted',()=>{
  const secret={id:uid,displayName:'友達',friends:[uid],authToken:'SECRET',email:'SECRET',discordId:'SECRET',friendKey:'SECRET',bio:'SECRET'};
  assert.ok(!JSON.stringify(currentUser(secret)).includes('SECRET'));
  assert.ok(!JSON.stringify(friend(secret,1000)).includes('SECRET'));
  assert.ok(!JSON.stringify(world({id:wid,name:'部屋',unityPackages:[{assetUrl:'SECRET'}]},uid,1000)).includes('SECRET'));
  assert.throws(()=>currentUser({requiresTwoFactorAuth:['totp']}));
  assert.throws(()=>currentUser({}));assert.equal(friend({},1000),null);
});
test('repeated observations do not create duplicate transitions; private clears current world',()=>{
  let changes=reconcile([], [sample()], 'owner',1000);
  assert.equal(changes.events.length,1);
  let repeat=reconcile(changes.records,[sample(2000)],'owner',2000);
  assert.equal(repeat.events.length,0);assert.equal(repeat.records[0].observedAt,2000);
  let hidden=reconcile(repeat.records,[sample(3000,'private')],'owner',3000);
  assert.equal(hidden.events.length,1);assert.equal(hidden.events[0].previousObservedAt,2000);
  assert.equal(hidden.records[0].location.worldId,'');assert.equal(hidden.events[0].previous.location.worldId,wid);
});
test('missing partial results do not imply offline/unfriend; explicit roster changes do',()=>{
  const previous=reconcile([],[sample()],'owner',1000).records;
  assert.equal(reconcile(previous,[],'owner',2000).events.length,0);
  assert.equal(reconcile(previous,[],'owner',2000,[]).records[0].isFriend,false);
  const online={friends:[uid],offlineFriends:[],onlineFriends:[uid],activeFriends:[]};
  assert.equal(rosterObservations(online,previous,2000).length,0);
  const offline={...online,onlineFriends:[],offlineFriends:[uid]};
  const observations=rosterObservations(offline,previous,2000);
  assert.equal(observations[0].presence,'offline');assert.equal(observations[0].location.worldId,'');
  assert.equal(observations[0].profileObservedAt,1000);
});
test('duplicate IDs use newest observation and account ownership is explicit',()=>{
  const result=reconcile([],[sample(3000,'private'),sample(1000)],'ownerB',4000);
  assert.equal(result.records.length,1);assert.equal(result.records[0].location.kind,'private');
  assert.equal(result.records[0].accountId,'ownerB');assert.equal(result.events[0].accountId,'ownerB');
});
test('Retry-After supports seconds/date and is never shortened by our cap',()=>{
  const now=Date.UTC(2026,0,1);assert.equal(retryDelay('86400',now,1),86400000);
  assert.equal(retryDelay(new Date(now+86400000).toUTCString(),now,1),86400000);
  assert.ok(retryDelay(null,now,2)>retryDelay(null,now,1));assert.ok(retryDelay('bad',now,1)>=120000);
});
test('CSV protects formula cells, UTF-8 Japanese, quotes and line breaks',()=>{
  const value=csv([['名前','=1+1',' \t@SUM(A1)','hello "world"','複数\n行','-2']]);
  assert.ok(value.startsWith('\uFEFF'));assert.ok(value.includes("\"'=1+1\""));
  assert.ok(value.includes("' \t@SUM"));assert.ok(value.includes('hello ""world""'));assert.ok(value.includes('複数\n行'));
});
test('configuration bounds and UA scope prevent host-wide header mutation',()=>{
  assert.equal(settings({pollSeconds:1}).pollSeconds,60);assert.equal(settings({retentionDays:999}).retentionDays,365);
  assert.equal(validContact('https://github.com/Xenoah'),true);assert.equal(validContact('abc\r\nHeader:value'),false);
  const rule=userAgentRule('abcdefghijklmnop','Chrome/test','https://github.com/example');
  assert.deepEqual(rule.condition.initiatorDomains,['abcdefghijklmnop']);
  assert.equal(rule.condition.urlFilter,'|https://vrchat.com/api/1/');assert.ok(rule.action.requestHeaders[0].value.includes('VRCFriendsObserver/'+VERSION));
});
test('manifest permissions are bounded and code does not accept arbitrary URLs or messages from websites',()=>{
  const m=JSON.parse(fs.readFileSync(new URL('../extension/manifest.json',import.meta.url)));
  assert.deepEqual(m.host_permissions,['https://vrchat.com/*']);assert.equal(m.manifest_version,3);
  for(const p of ['cookies','history','debugger','webRequest','tabs','nativeMessaging'])assert.ok(!m.permissions.includes(p));
  assert.equal(m.externally_connectable,undefined);assert.equal(m.content_scripts,undefined);
});
test('demo data is valid and contains visible/private/offline/stale examples',()=>{
  const d=demoData();assert.equal(d.friends.length,9);assert.equal(d.events.length,15);
  assert.equal(d.friends.filter(f=>f.location.kind==='private').length,2);
  assert.equal(d.friends.filter(f=>f.presence==='offline').length,1);
  assert.ok(d.friends.some(f=>Date.now()-f.observedAt>600000));
});
