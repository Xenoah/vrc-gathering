/* Deploy with Protocol.gs. Authentication precedes all spreadsheet access. */
const TABLES = {friends:'VRCFriends',events:'VRCEvents',worlds:'VRCWorlds',runs:'VRCRuns',accounts:'VRCAccounts',visits:'VRCVisits',encounters:'VRCEncounters',profiles:'VRCProfiles',xFollowers:'VRCXFollowers',segments:'VRCUserSegments',crowd:'VRCWorldCrowd',coverage:'VRCCoverage',followerHistory:'VRCFollowerHistory',annotations:'VRCAnnotations',views:'VRCViews',reports:'VRCReports',userNotes:'VRCUserNotes',userNoteHistory:'VRCUserNoteHistory'};
const LEGACY_HEADERS = ['key','version','kind','accountId','observedAt','displayName','presence','worldId','instanceId','worldName','payload'];
const HEADERS = ['record_id','revision','record_kind','account_id','observed_at_ms','display_name','presence','world_id','instance_id','world_name','payload_json','schema_version','operation','entity_id','received_at_ms','extensions_json'];
const FIELDS = {friends:['platform','state_first_observed_at_ms','is_friend'],events:['event_kind','previous_observed_at_ms','previous_world_id','previous_instance_id'],worlds:['author_name','capacity'],runs:['started_at_ms','completed_at_ms','observed_count','changed_count'],accounts:[],visits:['started_at_ms','last_seen_at_ms','ended_at_ms'],encounters:['started_at_ms','last_seen_at_ms','ended_at_ms','visit_started_at_ms','relation','other_instance_id'],profiles:['x_urls_json'],xFollowers:['x_url','followers_count','approximate','source'],segments:['collector_id','started_at_ms','last_seen_at_ms','ended_at_ms','sample_count'],crowd:['collector_id','started_at_ms','last_seen_at_ms','count','instances','complete'],coverage:['collector_id','started_at_ms','last_seen_at_ms','outcome','reason','sample_count'],followerHistory:['x_url','followers_count','approximate','started_at_ms','last_seen_at_ms','sample_count'],annotations:['title','start_ms','end_ms','deleted'],views:['title','schedule','deleted'],reports:['title','view_id','since_ms','until_ms'],userNotes:['user_id','note_id','note_created_at_ms','changed_at_ms','note_text','source'],userNoteHistory:['user_id','note_id','note_created_at_ms','changed_at_ms','note_text','source']};
const MAX_RECORDS = 50000;
function configuration_(detailed = false) {
  const props=PropertiesService.getScriptProperties(), spreadsheetId=(props.getProperty('SPREADSHEET_ID') || '').trim(),token=props.getProperty('SYNC_TOKEN');
  const days=Number(props.getProperty('RETENTION_DAYS') || 0);
  function invalid(message) { throw Error(detailed ? message : 'CONFIG'); }
  if (!spreadsheetId) invalid('SPREADSHEET_ID が未設定です。スクリプトプロパティにスプレッドシートIDを設定してください。');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) invalid('SYNC_TOKEN は32〜256文字の英数字・ハイフン・アンダースコアにしてください（現在 '+(token || '').length+' 文字）。createSyncToken を実行すると生成できます。');
  if (!Number.isInteger(days) || days<0 || days>365) invalid('RETENTION_DAYS は0〜365の整数にしてください。0または未設定は全期間を保管します。');
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
  const v=record.value,s=record.kind==='events'?v.current:record.kind==='segments'?v.state:v;
  const extra={friends:[v.platform,v.stateFirstObservedAt,v.isFriend],events:[v.kind,v.previousObservedAt,v.previous?.location?.worldId,v.previous?.location?.instanceId],worlds:[v.authorName,v.capacity],runs:[v.startedAt,v.completedAt,v.observedCount,v.changedCount],accounts:[],visits:[v.startedAt,v.lastSeenAt,v.endedAt],encounters:[v.startedAt,v.lastSeenAt,v.endedAt,v.visitStartedAt,v.relation,v.otherInstanceId],profiles:[canonical(v.urls)],xFollowers:[v.url,v.followers,v.approximate,v.source],segments:[v.collectorId,v.startedAt,v.lastSeenAt,v.endedAt,v.sampleCount],crowd:[v.collectorId,v.startedAt,v.lastSeenAt,v.count,v.instances,v.complete],coverage:[v.collectorId,v.startedAt,v.lastSeenAt,v.outcome,v.reason,v.sampleCount],followerHistory:[v.url,v.followers,v.approximate,v.startedAt,v.lastSeenAt,v.sampleCount],annotations:[v.title,v.start,v.end,v.deleted],views:[v.title,v.schedule,v.deleted],reports:[v.title,v.viewId,v.since,v.until],userNotes:[v.userId,v.noteId,v.createdAt,v.changedAt,v.note,v.source],userNoteHistory:[v.userId,v.noteId,v.createdAt,v.changedAt,v.note,v.source]}[record.kind];
  return [record.key,revision,record.kind,v.accountId,v.observedAt,safeCell_(v.displayName||s.displayName||v.title||v.name),safeCell_(s.presence),
    safeCell_(s.location?.worldId||v.worldId||(record.kind==='worlds'?v.id:'')),safeCell_(s.location?.instanceId),safeCell_(record.kind==='worlds'?v.name:''),
    canonical(v),2,'upsert',v.id||v.userId||(record.kind==='runs'?String(v.startedAt):record.kind==='xFollowers'?v.url.slice(14):v.accountId),receivedAt,canonical(v.extensions||{}),
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
  if(datasetId!==metadata.dataset_id){if(!metadata.legacy_migrated)metadata.legacy_migrated='false';writeValues_(registry,2,[['schema_version','2'],['dataset_id',datasetId],['legacy_migrated',metadata.legacy_migrated],['spreadsheet_id',config.spreadsheetId]]);}
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
  return {book,tables,rows,datasetId,sequence,seqKey};
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
    if(![1,2].includes(request.protocol)||!['hello','push','pull','range'].includes(request.action))throw Error('REQUEST');
    protocol=request.protocol;
    lock=LockService.getScriptLock();if(!lock.tryLock(10000))throw Error('BUSY');
    const db=database_(config),now=Date.now(),cutoff=config.days?now-config.days*86400000:0;
    if(request.action==='hello')return json_({ok:true,datasetId:db.datasetId,protocols:[1,2],recordSchemas:[1,2],operations:['upsert'],kinds:SYNC_KINDS,maxBatch:SYNC_BATCH_SIZE,serverTime:now,retentionDays:config.days,features:['changeIntervals','monthlyArchives','rangePull']},protocol);
    if(protocol===2&&request.datasetId!==db.datasetId)throw Error('DATASET');
    if(request.action==='push'){
      if(!Array.isArray(request.records)||request.records.length>SYNC_BATCH_SIZE)throw Error('REQUEST');
      const records=request.records.map(r=>normalizeEnvelope(r,now));
      if(db.rows.length+records.length>MAX_RECORDS-500)archiveHistory_(db,true);
      const positions=new Set(db.rows.map(r=>r[0])),archived=archiveLocations_(db,records);
      if(db.rows.length+new Set(records.filter(r=>!positions.has(r.key)&&!archived.has(r.key)).map(r=>r.key)).size>MAX_RECORDS)throw Error('LIMIT');
      let sequence=db.sequence;const writes=new Map(),metadata=new Map();
      for(const record of records){let t=db.tables[record.kind],i=t.rows.findIndex(r=>r[0]===record.key),old;
        if(i>=0)old=normalizeRecord(record.kind,JSON.parse(t.rows[i][10]),now);
        const stored=archived.get(record.key);
        if(stored){const prior=normalizeRecord(record.kind,JSON.parse(readCandidate_({table:stored.table,index:stored.index})[10]),now);old=mergeRecord(prior,old);if(i<0){t=stored.table;i=stored.index;}}
        const merged=mergeRecord(record,old);if(old&&canonical(merged.value)===canonical(old.value))continue;
        if(i<0)i=t.rows.length;const next=row_(merged,++sequence,now);t.rows[i]=next;
        if(!writes.has(t))writes.set(t,new Map());writes.get(t).set(i,next);
        if(t.entry){t.entry[3]=Math.max(Number(t.entry[3]),sequence);t.entry[4]=Math.max(Number(t.entry[4]),merged.value.observedAt);metadata.set(t.entry[1],t.entry);}
      }
      // Reserve revisions before writing; interrupted pushes may leave gaps, never reused revisions.
      config.props.setProperty(db.seqKey,String(sequence));
      // Publish conservative bounds first: a failed archive write cannot hide an already written revision.
      for(const entry of metadata.values())saveArchive_(db,entry);SpreadsheetApp.flush();
      for(const [table,changes] of writes)writeChanges_(table,changes);
      SpreadsheetApp.flush();return json_({ok:true,datasetId:db.datasetId,accepted:records.length},protocol);
    }
    if(!Number.isSafeInteger(request.cursor)||request.cursor<0||request.cursor>db.sequence||!Number.isInteger(request.limit)||request.limit<1||request.limit>SYNC_BATCH_SIZE)throw Error('REQUEST');
    const kinds=protocol===2 && request.kinds!==undefined ? request.kinds : LEGACY_SYNC_KINDS;
    if(!Array.isArray(kinds) || !kinds.length || kinds.length>SYNC_KINDS.length || kinds.some(kind=>!SYNC_KINDS.includes(kind)))throw Error('REQUEST');
    const ranged=request.action==='range';
    if(request.since!==undefined&&(!Number.isSafeInteger(request.since)||request.since<0))throw Error('REQUEST');
    if(ranged&&(!Number.isSafeInteger(request.since)||!Number.isSafeInteger(request.until)||request.until<=request.since||request.until>now+300000||typeof request.accountId!=='string'||!/^usr_[A-Za-z0-9_-]{8,100}$/.test(request.accountId)))throw Error('REQUEST');
    const candidates=pullCandidates_(db,kinds,request.cursor,Math.max(cutoff,request.since||0)),selected=candidates.slice(0,request.limit),hasMore=candidates.length>selected.length;
    const records=selected.map(c=>{const r=readCandidate_(c);return {...normalizeRecord(r[2],JSON.parse(r[10]),now),revision:Number(r[1])};}).filter(r=>!ranged||r.value.accountId===request.accountId&&(ARCHIVE_KINDS.includes(r.kind)||Number(r.value.startedAt||r.value.observedAt)<request.until));
    return json_({ok:true,datasetId:db.datasetId,records,cursor:hasMore?Number(selected[selected.length-1].row[1]):db.sequence,hasMore},protocol);
  }catch(error){return json_({ok:false,code:['AUTH','CONFIG','BUSY','LIMIT','REQUEST','SCHEMA','DATASET','MIGRATION'].includes(error.message)?error.message:'SERVER'},protocol);}
  finally{if(lock?.hasLock())lock.releaseLock();}
}
// Run manually in the editor. Keys are never returned or written to execution logs.
function createSyncToken() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000))throw Error('別の処理が実行中です。少し待ってから再実行してください。');
  try {
    const props=PropertiesService.getScriptProperties(),current=props.getProperty('SYNC_TOKEN');
    let message;
    if(/^[A-Za-z0-9_-]{32,256}$/.test(current || '')) {
      message='有効な SYNC_TOKEN が既にあるため上書きしませんでした。プロジェクトの設定 → スクリプトプロパティで確認し、拡張にも同じ値を設定してください。';
    } else {
      const token=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'');
      props.setProperty('SYNC_TOKEN',token);
      message='64文字の SYNC_TOKEN を生成・保存しました。プロジェクトの設定 → スクリプトプロパティからコピーし、拡張の同期キー欄へ貼り付けて保存してください。';
    }
    Logger.log(message);
    return message;
  } finally { lock.releaseLock(); }
}
function setup(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(10000))throw Error('BUSY');
  try{const db=database_(configuration_(true));archiveHistory_(db);if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='pruneRecords'))ScriptApp.newTrigger('pruneRecords').timeBased().everyDays(1).create();return '16種類の記録テーブルとVRCSchema、日次整理を設定しました。過去月はVRCArchivesに記載した月別ファイルへ整理します。旧VRCRecordsは移行元として残しています。';}
  finally{lock.releaseLock();}
}
function pruneRecords(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(10000))return;
  try{const config=configuration_(),db=database_(config),cutoff=config.days?Date.now()-config.days*86400000:0;
    config.props.setProperty(db.seqKey,String(db.sequence));
    archiveHistory_(db);
    const archived=config.days?archives_(db).flatMap(e=>archiveTables_(e,HISTORY_KINDS)):[];
    // Latest profile checks are snapshots, independent of observation-history retention.
    for(const t of [...Object.entries(db.tables).filter(([kind])=>!ARCHIVE_KINDS.includes(kind)).map(([,t])=>t),...archived])for(let i=t.rows.length-1;i>=0;){if(Number(t.rows[i][4])>=cutoff){i--;continue;}const end=i;while(i>=0&&Number(t.rows[i][4])<cutoff)i--;t.sheet.deleteRows(i+3,end-i);}
  }finally{lock.releaseLock();}
}

// Each archive file holds at most MAX_RECORDS rows. The main manifest is small;
// pull scans only revision/time indexes and reads payloads for the requested page.
const ARCHIVE_HEADERS=['month','spreadsheet_id','rows','max_revision','max_observed_at'];
function archives_(db){return rows_(sheet_(db.book,'VRCArchives',ARCHIVE_HEADERS),ARCHIVE_HEADERS.length);}
function recordMonth_(row){const v=JSON.parse(row[10]);return new Date(v.startedAt||v.observedAt).toISOString().slice(0,7);}
function archiveTables_(entry,kinds){
  const book=SpreadsheetApp.openById(entry[1]),tables=[];
  for(const kind of kinds){const sheet=book.getSheetByName(TABLES[kind]);if(!sheet)continue;const width=HEADERS.length+FIELDS[kind].length;tables.push({sheet,width,kind,entry,rows:rows_(sheet,5)});}
  return tables;
}
function saveArchive_(db,entry){const manifest=sheet_(db.book,'VRCArchives',ARCHIVE_HEADERS),entries=rows_(manifest,ARCHIVE_HEADERS.length),i=entries.findIndex(e=>e[1]===entry[1]);writeValues_(manifest,(i<0?entries.length:i)+2,[entry]);}
function archiveHistory_(db,force=false){
  const month=new Date().toISOString().slice(0,7),entries=archives_(db);
  for(const kind of HISTORY_KINDS){const source=db.tables[kind],moving=[];
    source.rows.forEach((r,i)=>{const v=JSON.parse(r[10]);if(v.endedAt===null)return;const m=recordMonth_(r);if(m<month||force)moving.push({row:r,index:i,month:m});});
    if(!moving.length)continue;
    const existing=archiveLocations_(db,moving.map(item=>({kind,key:item.row[0],value:JSON.parse(item.row[10])}))),destinations=new Map(),copied=[],repair=new Map();
    for(const item of moving){const prior=existing.get(item.row[0]);
      if(prior){if(Number(prior.row[1])<Number(item.row[1])){writeValues_(prior.table.sheet,prior.index+2,[item.row]);prior.table.entry[3]=Math.max(Number(prior.table.entry[3]),Number(item.row[1]));prior.table.entry[4]=Math.max(Number(prior.table.entry[4]),Number(item.row[4]));SpreadsheetApp.flush();saveArchive_(db,prior.table.entry);}repair.set(prior.table.entry[1],prior.table.entry);copied.push(item.index);continue;}
      let destination=destinations.get(item.month);
      if(!destination||destination.entry[2]>=MAX_RECORDS){
        let entry=entries.find(e=>e[0]===item.month&&Number(e[2])<MAX_RECORDS);
        if(!entry){const book=SpreadsheetApp.create('VRC Gathering '+item.month+' archive '+(entries.filter(e=>e[0]===item.month).length+1));entry=[item.month,book.getId(),0,0,0];entries.push(entry);saveArchive_(db,entry);}
        const book=SpreadsheetApp.openById(entry[1]),headers=[...HEADERS,...FIELDS[kind]],sheet=sheet_(book,TABLES[kind],headers),rows=rows_(sheet,headers.length);
        destination={entry,sheet,width:headers.length,rows,positions:new Map(rows.map((r,i)=>[r[0],i])),changes:new Map()};destinations.set(item.month,destination);
      }
      const t=destination,i=t.positions.get(item.row[0]),index=i==null?t.rows.length:i,old=t.rows[index];
      if(!old||Number(item.row[1])>Number(old[1])){t.rows[index]=item.row;t.changes.set(index,item.row);}
      if(i==null){t.positions.set(item.row[0],index);t.entry[2]=Number(t.entry[2])+1;}
      t.entry[3]=Math.max(Number(t.entry[3]),Number(item.row[1]));t.entry[4]=Math.max(Number(t.entry[4]),Number(item.row[4]));copied.push(item.index);
      // Flush a full shard before replacing its destination object.
      if(t.entry[2]>=MAX_RECORDS){writeChanges_(t,t.changes);SpreadsheetApp.flush();saveArchive_(db,t.entry);t.changes.clear();}
    }
    for(const t of destinations.values()){writeChanges_(t,t.changes);SpreadsheetApp.flush();saveArchive_(db,t.entry);}
    for(const entry of repair.values()){const rows=archiveTables_(entry,HISTORY_KINDS).flatMap(t=>t.rows);entry[2]=rows.length;entry[3]=rows.reduce((n,r)=>Math.max(n,Number(r[1])),0);entry[4]=rows.reduce((n,r)=>Math.max(n,Number(r[4])),0);saveArchive_(db,entry);}
    // Copy and manifest are durable before source deletion. A retry deduplicates by key/revision.
    SpreadsheetApp.flush();for(let i=copied.length-1;i>=0;){const end=copied[i],last=end;while(i>0&&copied[i-1]===copied[i]-1)i--;const first=copied[i];source.sheet.deleteRows(first+2,last-first+1);i--;}
    const removed=new Set(copied);source.rows=source.rows.filter((_,i)=>!removed.has(i));
  }
  db.rows=Object.values(db.tables).flatMap(t=>t.rows);
}
function archiveLocations_(db,records){
  const found=new Map(),months=new Set(records.filter(r=>HISTORY_KINDS.includes(r.kind)).map(r=>new Date(r.value.startedAt||r.value.observedAt).toISOString().slice(0,7))),keys=new Set(records.map(r=>r.key)),kinds=[...new Set(records.map(r=>r.kind))];
  for(const entry of archives_(db).filter(e=>months.has(e[0])))for(const t of archiveTables_(entry,kinds))t.rows.forEach((r,i)=>{if(keys.has(r[0])){const old=found.get(r[0]);if(!old||Number(r[1])>Number(old.row[1]))found.set(r[0],{table:t,index:i,row:r});}});
  return found;
}
function readCandidate_(candidate){if(!candidate.table)return candidate.row;const t=candidate.table,cached=t.rows[candidate.index];return cached.length>=t.width?cached:t.sheet.getRange(candidate.index+2,1,1,t.width).getValues()[0];}
function pullCandidates_(db,kinds,cursor,cutoff){
  const records=new Map();const add=(row,table,index)=>{if(!kinds.includes(row[2])||Number(row[1])<=cursor||!ARCHIVE_KINDS.includes(row[2])&&Number(row[4])<cutoff)return;const old=records.get(row[0]);if(!old||Number(row[1])>Number(old.row[1]))records.set(row[0],{row,table,index});};
  db.rows.forEach(r=>add(r,null,0));
  for(const entry of archives_(db).filter(e=>Number(e[3])>cursor&&Number(e[4])>=cutoff))for(const t of archiveTables_(entry,kinds.filter(k=>HISTORY_KINDS.includes(k))))t.rows.forEach((r,i)=>add(r,t,i));
  return [...records.values()].sort((a,b)=>Number(a.row[1])-Number(b.row[1]));
}
