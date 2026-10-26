import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_LIMIT, createSettingsBackup, parseSettingsBackup, resolveSettingsBackup } from '../extension/settings-backup.js';

const endpoint='https://script.google.com/macros/s/test/exec', token='backup_test_key_0123456789_abcdefghijklmnopqrstuvwxyz';
const saved={settings:{enabled:true,contact:'https://github.com/example',pollSeconds:300,retentionDays:90,offlineRefreshMinutes:180},
  cloudSync:{enabled:true,endpoint,token},imageCacheSettings:{enabled:true},state:{cooldownUntil:1234},cloudCheckpoint:{cursor:500},
  cloudDiagnostic:{message:'Not a preference'},accountMeta:{user:'Private name'}};

test('X concurrency is exported/restored, defaults to three for old files, and rejects values outside one to ten',()=>{
  const backup=createSettingsBackup({...saved,xFollowerSettings:{enabled:true,concurrency:10}});assert.equal(resolveSettingsBackup(backup).xFollowerSettings.concurrency,10);
  delete backup.settings.xFollowers.concurrency;assert.equal(resolveSettingsBackup(backup).xFollowerSettings.concurrency,3);
  for(const value of [0,11,1.5,'5',null,true]){backup.settings.xFollowers.concurrency=value;assert.throws(()=>validate(backup));}
  function validate(b){return parseSettingsBackup(JSON.stringify(b));}
});
test('all-profile mode and its destination round-trip, while old backups remain linked-only',()=>{
  const accountId='usr_scopefixture01',backup=createSettingsBackup({xFollowerSettings:{enabled:true,scope:'all',accountId,concurrency:5}});
  assert.deepEqual(resolveSettingsBackup(backup).xFollowerSettings,{enabled:true,scope:'all',bulkScope:'known',accountId,concurrency:5});
  for(const change of [{scope:'invalid'},{accountId:''},{accountId:null},{accountId:'https://x.com/person'}])assert.throws(()=>parseSettingsBackup(JSON.stringify({...backup,settings:{...backup.settings,xFollowers:{...backup.settings.xFollowers,...change}}})));
  delete backup.settings.xFollowers.scope;delete backup.settings.xFollowers.accountId;assert.equal(resolveSettingsBackup(backup).xFollowerSettings.scope,'linked');assert.equal(resolveSettingsBackup(backup).xFollowerSettings.accountId,'');
});

test('settings exports round-trip preferences and exclude runtime state and secrets by default',()=>{
  const exported=createSettingsBackup(saved,false,0), text=JSON.stringify(exported);
  for(const excluded of [token,'cooldownUntil','cursor','Private name','Not a preference'])assert.ok(!text.includes(excluded));
  assert.equal(exported.settings.collection.enabled,undefined);
  assert.deepEqual(parseSettingsBackup('\uFEFF'+text),exported);
  assert.equal(createSettingsBackup(saved,true).settings.sync.token,token);
  assert.equal(createSettingsBackup({}).settings.collection.pollSeconds,180);
});

test('keyless imports preserve a valid key only for the same endpoint and otherwise disable sync',()=>{
  const backup=createSettingsBackup(saved);
  const same=resolveSettingsBackup(backup,saved.cloudSync);
  assert.equal(same.cloudSync.token,token);assert.equal(same.cloudSync.enabled,true);assert.equal(same.tokenSource,'existing');
  assert.equal(same.settings.enabled,false);
  const different=resolveSettingsBackup(backup,{...saved.cloudSync,endpoint:endpoint.replace('/test/','/other/')});
  assert.equal(different.cloudSync.token,'');assert.equal(different.cloudSync.enabled,false);assert.equal(different.needsToken,true);
  const fresh=resolveSettingsBackup(backup);
  assert.equal(fresh.cloudSync.enabled,false);assert.equal(fresh.tokenSource,'missing');
  backup.settings.sync.token='';
  assert.equal(resolveSettingsBackup(backup,saved.cloudSync).cloudSync.token,'');
  const withKey=resolveSettingsBackup(createSettingsBackup(saved,true));
  assert.equal(withKey.cloudSync.token,token);assert.equal(withKey.cloudSync.enabled,true);
});

test('invalid files, versions, values and URLs are rejected without echoing secrets',()=>{
  for(const input of ['{SECRET_KEY','[]','null','{"schema":1,"friends":[]}',' '.repeat(BACKUP_LIMIT+1)]) {
    assert.throws(()=>parseSettingsBackup(input),error=>!error.message.includes('SECRET_KEY'));
  }
  for(const mutate of [b=>b.schema=2,b=>delete b.settings.images,b=>b.settings.collection.pollSeconds=1,
    b=>b.settings.collection.retentionDays=1.5,b=>b.settings.collection.offlineRefreshMinutes='60',
    b=>b.settings.collection.contact='<script>bad</script>',b=>b.settings.sync.enabled='true',
    b=>b.settings.sync.endpoint='https://attacker.example/exec',b=>b.settings.sync.endpoint='',
    b=>b.settings.sync.token='SECRET_KEY',b=>b.settings.sync.token=null,b=>b.settings.images.enabled=1]) {
    const backup=createSettingsBackup(saved);mutate(backup);
    assert.throws(()=>parseSettingsBackup(JSON.stringify(backup)),error=>!error.message.includes('SECRET_KEY'));
  }
});

test('unrecognized properties cannot become storage values or alter the prototype',()=>{
  const backup=createSettingsBackup(saved);
  backup.settings.collection.enabled=true;backup.settings.sync.cooldownUntil=0;
  const input=JSON.stringify(backup).replace('"schema":1','"schema":1,"__proto__":{"polluted":true},"state":{"cooldownUntil":0}');
  const parsed=parseSettingsBackup(input), restored=resolveSettingsBackup(parsed,saved.cloudSync);
  assert.equal({}.polluted,undefined);assert.equal(Object.hasOwn(parsed,'__proto__'),false);
  assert.equal(parsed.state,undefined);assert.equal(restored.cloudSync.cooldownUntil,undefined);assert.equal(restored.settings.enabled,false);
});

test('bulk scope is independent of opened-profile scope and survives backup, with conservative defaults',()=>{
 const backup=createSettingsBackup({...saved,xFollowerSettings:{enabled:true,scope:'linked',bulkScope:'friends',concurrency:10}});
 assert.equal(resolveSettingsBackup(backup).xFollowerSettings.bulkScope,'friends');assert.equal(resolveSettingsBackup(backup).xFollowerSettings.scope,'linked');
 delete backup.settings.xFollowers.bulkScope;assert.equal(resolveSettingsBackup(backup).xFollowerSettings.bulkScope,'known');
 backup.settings.xFollowers.bulkScope='all';assert.throws(()=>validate(backup));
});
