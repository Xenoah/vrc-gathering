/* Deploy with Protocol.gs. Authentication precedes all spreadsheet access. */
const TABLES = {friends:'VRCFriends',events:'VRCEvents',worlds:'VRCWorlds',runs:'VRCRuns',accounts:'VRCAccounts'};
const LEGACY_HEADERS = ['key','version','kind','accountId','observedAt','displayName','presence','worldId','instanceId','worldName','payload'];
const HEADERS = ['record_id','revision','record_kind','account_id','observed_at_ms','display_name','presence','world_id','instance_id','world_name','payload_json','schema_version','operation','entity_id','received_at_ms','extensions_json'];
const FIELDS = {friends:['platform','state_first_observed_at_ms','is_friend'],events:['event_kind','previous_observed_at_ms','previous_world_id','previous_instance_id'],worlds:['author_name','capacity'],runs:['started_at_ms','completed_at_ms','observed_count','changed_count'],accounts:[]};
const MAX_RECORDS = 50000;
function configuration_() {
  const props=PropertiesService.getScriptProperties(), spreadsheetId=props.getProperty('SPREADSHEET_ID'),token=props.getProperty('SYNC_TOKEN');
  const days=Number(props.getProperty('RETENTION_DAYS') || 30);
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{32,256}$/.test(token || '') || !Number.isInteger(days) || days<1 || days>365) throw Error('CONFIG');
  return {props,spreadsheetId,token,days};
}
function writeValues_(sheet,start,values) {
  const end=start+values.length-1,width=values[0].length;
  if(end>sheet.getMaxRows())sheet.insertRowsAfter(sheet.getMaxRows(),end-sheet.getMaxRows());
  if(width>sheet.getMaxColumns())sheet.insertColumnsAfter(sheet.getMaxColumns(),width-sheet.getMaxColumns());
  sheet.getRange(start,1,values.length,width).setValues(values);
}
function sheet_(book,name,headers) {
  let sheet=book.getSheetByName(name);
  if (!sheet) {sheet=book.insertSheet(name);writeValues_(sheet,1,[headers]);sheet.setFrozenRows(1);}
  if (sheet.getRange(1,1,1,headers.length).getValues()[0].join('|')!==headers.join('|')) throw Error('CONFIG');
  return sheet;
}
function rows_(sheet,width) {
  const count=Math.max(0,sheet.getLastRow()-1);
  if (count>MAX_RECORDS) throw Error('LIMIT');
  return count?sheet.getRange(2,1,count,width).getValues():[];
}
function safeCell_(value) {const s=String(value == null?'':value);return /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(s)?"'"+s:s;}
function row_(record,revision,receivedAt) {
  const v=record.value,s=record.kind==='events'?v.current:v;
  const extra={friends:[v.platform,v.stateFirstObservedAt,v.isFriend],events:[v.kind,v.previousObservedAt,v.previous?.location?.worldId,v.previous?.location?.instanceId],worlds:[v.authorName,v.capacity],runs:[v.startedAt,v.completedAt,v.observedCount,v.changedCount],accounts:[]}[record.kind];
  return [record.key,revision,record.kind,v.accountId,v.observedAt,safeCell_(v.displayName||v.name),safeCell_(s.presence),
    safeCell_(s.location?.worldId||(record.kind==='worlds'?v.id:'')),safeCell_(s.location?.instanceId),safeCell_(record.kind==='worlds'?v.name:''),
    canonical(v),2,'upsert',v.id||v.userId||(record.kind==='runs'?String(v.startedAt):v.accountId),receivedAt,canonical(v.extensions||{}),
    ...extra.map(v=>typeof v==='number'||typeof v==='boolean'?v:safeCell_(v))];
}
function writeChanges_(table,changes) {
  const indexes=[...changes.keys()].sort((a,b)=>a-b);
  for(let i=0;i<indexes.length;){const first=indexes[i],group=[changes.get(first)];i++;
    while(i<indexes.length&&indexes[i]===first+group.length)group.push(changes.get(indexes[i++]));
    writeValues_(table.sheet,first+2,group);
  }
}
function database_(config) {
  const book=SpreadsheetApp.openById(config.spreadsheetId), tables={};
  for(const kind of SYNC_KINDS){const headers=[...HEADERS,...FIELDS[kind]],sheet=sheet_(book,TABLES[kind],headers);tables[kind]={sheet,width:headers.length,rows:rows_(sheet,headers.length)};}
  const registry=sheet_(book,'VRCSchema',['name','value']);
  // Dataset identity survives redeploys of this GAS project. One project owns each spreadsheet.
  let metadata=Object.fromEntries(rows_(registry,2));
  if(metadata.schema_version && Number(metadata.schema_version)!==2)throw Error('SCHEMA');
  const datasetId=metadata.dataset_id && metadata.spreadsheet_id===config.spreadsheetId ? metadata.dataset_id : Utilities.getUuid();
  if(datasetId!==metadata.dataset_id){metadata.legacy_migrated ||= 'false';writeValues_(registry,2,[['schema_version','2'],['dataset_id',datasetId],['legacy_migrated',metadata.legacy_migrated],['spreadsheet_id',config.spreadsheetId]]);}
  if(metadata.legacy_migrated!=='true') {
    const legacy=book.getSheetByName('VRCRecords');
    if(legacy){
      if(legacy.getRange(1,1,1,LEGACY_HEADERS.length).getValues()[0].join('|')!==LEGACY_HEADERS.join('|'))throw Error('MIGRATION');
      let records;try{records=rows_(legacy,LEGACY_HEADERS.length).map(row=>({record:normalizeRecord(row[2],JSON.parse(row[10])),revision:Number(row[1])}));}catch{throw Error('MIGRATION');}
      // Idempotent: if execution stops, the next setup/request resumes without deleting the original table.
      for(const kind of SYNC_KINDS){const t=tables[kind],positions=new Map(t.rows.map((r,i)=>[r[0],i])),changes=new Map();
        for(const {record,revision} of records.filter(r=>r.record.kind===kind)){
          if(!Number.isSafeInteger(revision)||revision<1)throw Error('MIGRATION');
          const i=positions.get(record.key),old=i==null?null:normalizeRecord(kind,JSON.parse(t.rows[i][10]));
          const merged=mergeRecord(record,old);
          if(old && canonical(merged.value)===canonical(old.value))continue;
          const index=i==null?t.rows.length:i,next=row_(merged,Math.max(revision,i==null?0:Number(t.rows[i][1])),Date.now());
          t.rows[index]=next;positions.set(record.key,index);changes.set(index,next);
        }
        writeChanges_(t,changes);
      }
    }
    SpreadsheetApp.flush();writeValues_(registry,4,[['legacy_migrated','true']]);
  }
  const rows=Object.values(tables).flatMap(t=>t.rows);
  if(rows.length>MAX_RECORDS)throw Error('LIMIT');
  const seqKey='SEQ_'+datasetId;
  const sequence=rows.reduce((n,r)=>Math.max(n,Number(r[1])||0),Math.max(Number(config.props.getProperty(seqKey))||0,book.getSheetByName('VRCRecords')?Number(config.props.getProperty('SYNC_SEQUENCE'))||0:0));
  config.props.setProperty(seqKey,String(sequence));
  return {tables,rows,datasetId,sequence,seqKey};
}
function json_(data,protocol=2) {return ContentService.createTextOutput(JSON.stringify({protocol,...data})).setMimeType(ContentService.MimeType.JSON);}
function doGet(){return json_({ok:false,code:'POST_REQUIRED'});}
function doPost(event){
  let lock,protocol=2;
  try{
    const config=configuration_(),body=event?.postData?.contents||'';
    if(body.length>5000000)throw Error('LIMIT');
    let request;try{request=JSON.parse(body);}catch{throw Error('REQUEST');}
    if(!request||request.token!==config.token)throw Error('AUTH');
    if(![1,2].includes(request.protocol)||!['hello','push','pull'].includes(request.action))throw Error('REQUEST');
    protocol=request.protocol;
    lock=LockService.getScriptLock();if(!lock.tryLock(10000))throw Error('BUSY');
    const db=database_(config),now=Date.now(),cutoff=now-config.days*86400000;
    if(request.action==='hello')return json_({ok:true,datasetId:db.datasetId,protocols:[1,2],recordSchemas:[1,2],operations:['upsert'],kinds:SYNC_KINDS,maxBatch:SYNC_BATCH_SIZE,serverTime:now},protocol);
    if(protocol===2&&request.datasetId!==db.datasetId)throw Error('DATASET');
    if(request.action==='push'){
      if(!Array.isArray(request.records)||request.records.length>SYNC_BATCH_SIZE)throw Error('REQUEST');
      const records=request.records.map(r=>normalizeEnvelope(r,now));
      const positions=new Map(db.rows.map(r=>[r[0],true]));
      if(db.rows.length+new Set(records.filter(r=>r.value.observedAt>=cutoff&&!positions.has(r.key)).map(r=>r.key)).size>MAX_RECORDS)throw Error('LIMIT');
      let sequence=db.sequence;
      const writes=[];
      for(const kind of SYNC_KINDS){const t=db.tables[kind],indexes=new Map(t.rows.map((r,i)=>[r[0],i])),changes=new Map();
        for(const record of records.filter(r=>r.kind===kind&&r.value.observedAt>=cutoff)){
          const i=indexes.get(record.key),old=i==null?null:normalizeRecord(kind,JSON.parse(t.rows[i][10]),now),merged=mergeRecord(record,old);
          if(old&&canonical(merged.value)===canonical(old.value))continue;
          const index=i==null?t.rows.length:i,next=row_(merged,++sequence,now);
          t.rows[index]=next;indexes.set(record.key,index);changes.set(index,next);
        }
        writes.push([t,changes]);
      }
      // Reserve revisions before writing; interrupted pushes may leave gaps, never reused revisions.
      config.props.setProperty(db.seqKey,String(sequence));
      for(const [table,changes] of writes)writeChanges_(table,changes);
      SpreadsheetApp.flush();return json_({ok:true,datasetId:db.datasetId,accepted:records.length},protocol);
    }
    if(!Number.isSafeInteger(request.cursor)||request.cursor<0||request.cursor>db.sequence||!Number.isInteger(request.limit)||request.limit<1||request.limit>SYNC_BATCH_SIZE)throw Error('REQUEST');
    const candidates=db.rows.filter(r=>Number(r[1])>request.cursor&&Number(r[4])>=cutoff).sort((a,b)=>Number(a[1])-Number(b[1]));
    const selected=candidates.slice(0,request.limit),hasMore=candidates.length>selected.length;
    return json_({ok:true,datasetId:db.datasetId,records:selected.map(r=>({...normalizeRecord(r[2],JSON.parse(r[10]),now),revision:Number(r[1])})),cursor:hasMore?Number(selected.at(-1)[1]):db.sequence,hasMore},protocol);
  }catch(error){return json_({ok:false,code:['AUTH','CONFIG','BUSY','LIMIT','REQUEST','SCHEMA','DATASET','MIGRATION'].includes(error.message)?error.message:'SERVER'},protocol);}
  finally{if(lock?.hasLock())lock.releaseLock();}
}
function setup(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(10000))throw Error('BUSY');
  try{database_(configuration_());if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='pruneRecords'))ScriptApp.newTrigger('pruneRecords').timeBased().everyDays(1).create();return '5種類の記録テーブルとVRCSchema、日次整理を設定しました。旧VRCRecordsは移行元として残しています。';}
  finally{lock.releaseLock();}
}
function pruneRecords(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(10000))return;
  try{const config=configuration_(),db=database_(config),cutoff=Date.now()-config.days*86400000;
    config.props.setProperty(db.seqKey,String(db.sequence));
    for(const t of Object.values(db.tables))for(let i=t.rows.length-1;i>=0;){if(Number(t.rows[i][4])>=cutoff){i--;continue;}const end=i;while(i>=0&&Number(t.rows[i][4])<cutoff)i--;t.sheet.deleteRows(i+3,end-i);}
  }finally{lock.releaseLock();}
}
