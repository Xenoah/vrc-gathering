import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_LIMIT, createSettingsBackup, parseSettingsBackup, resolveSettingsBackup } from '../extension/settings-backup.js';

const endpoint='https://script.google.com/macros/s/test/exec', token='backup_test_key_0123456789_abcdefghijklmnopqrstuvwxyz';
const saved={settings:{enabled:true,contact:'https://github.com/example',pollSeconds:300,retentionDays:90,offlineRefreshMinutes:180},
  cloudSync:{enabled:true,endpoint,token},imageCacheSettings:{enabled:true},state:{cooldownUntil:1234},cloudCheckpoint:{cursor:500},
  cloudDiagnostic:{message:'Not a preference'},accountMeta:{user:'Private name'}};

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
