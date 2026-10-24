/* Deploy with Protocol.gs. The spreadsheet stays private; requests authenticate in the POST body. */
const SHEET_NAME = 'VRCRecords';
const HEADERS = ['key','version','kind','accountId','observedAt','displayName','presence','worldId','instanceId','worldName','payload'];
const MAX_RECORDS = 50000;

function configuration_() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty('SPREADSHEET_ID'), token = props.getProperty('SYNC_TOKEN');
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) throw new Error('CONFIG');
  const days = Number(props.getProperty('RETENTION_DAYS') || 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('CONFIG');
  return {props, spreadsheetId, token, days};
}
function sheet_(config) {
  const book = SpreadsheetApp.openById(config.spreadsheetId);
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  const headers = sheet.getRange(1,1,1,HEADERS.length).getValues()[0];
  if (headers.join('|') !== HEADERS.join('|')) throw new Error('CONFIG');
  return sheet;
}
function rows_(sheet) {
  const count = Math.max(0,sheet.getLastRow()-1);
  if (count > MAX_RECORDS) throw new Error('LIMIT');
  return count ? sheet.getRange(2,1,count,HEADERS.length).getValues() : [];
}
function sequence_(config, rows) {
  return rows.reduce((n,row) => Math.max(n,Number(row[1]) || 0), Number(config.props.getProperty('SYNC_SEQUENCE')) || 0);
}
function safeCell_(value) {
  const s = String(value == null ? '' : value);
  return /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(s) ? "'" + s : s;
}
function row_(record, sequence) {
  const value = record.value, state = record.kind === 'events' ? value.current : value;
  return [record.key,sequence,record.kind,value.accountId,value.observedAt,safeCell_(value.displayName || value.name),
    safeCell_(state.presence),safeCell_(state.location?.worldId || (record.kind === 'worlds' ? value.id : '')),
    safeCell_(state.location?.instanceId),safeCell_(record.kind === 'worlds' ? value.name : ''),canonical(value)];
}
function json_(data) { return ContentService.createTextOutput(JSON.stringify({protocol:1,...data})).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return json_({ok:false,code:'POST_REQUIRED'}); }
function doPost(event) {
  let lock;
  try {
    const config = configuration_();
    const body = event?.postData?.contents || '';
    if (body.length > 5000000) throw new Error('LIMIT');
    let request;
    try { request = JSON.parse(body); } catch { throw new Error('REQUEST'); }
    if (!request || request.token !== config.token) throw new Error('AUTH');
    if (request.protocol !== 1 || !['push','pull'].includes(request.action)) throw new Error('REQUEST');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error('BUSY');
    const sheet = sheet_(config), rows = rows_(sheet), now = Date.now();
    let sequence = sequence_(config,rows);
    const cutoff = now - config.days * 86400000;
    if (request.action === 'push') {
      if (!Array.isArray(request.records) || request.records.length > SYNC_BATCH_SIZE) throw new Error('REQUEST');
      // Validate the entire batch before making any writes. Local DB keys and unknown fields are never stored.
      const records = request.records.map(record => normalizeRecord(record.kind,record.value,now));
      const positions = new Map(rows.map((row,i) => [row[0],i]));
      const additions = new Set(records.filter(r => r.value.observedAt >= cutoff && !positions.has(r.key)).map(r => r.key));
      if (rows.length + additions.size > MAX_RECORDS) throw new Error('LIMIT');
      const changes = new Map();
      for (const record of records) {
        if (record.value.observedAt < cutoff) continue;
        const i = positions.get(record.key);
        const previous = i == null ? null : {kind:rows[i][2],key:rows[i][0],value:JSON.parse(rows[i][10])};
        if (!newerRecord(record,previous)) continue;
        const next = row_(record,++sequence);
        if (i == null) { positions.set(record.key,rows.length); changes.set(rows.length,next); rows.push(next); }
        else { rows[i] = next; changes.set(i,next); }
      }
      // Adjacent changed rows are written in one Sheets operation.
      const indexes = [...changes.keys()].sort((a,b) => a-b);
      for (let i=0;i<indexes.length;) {
        const first=indexes[i], group=[changes.get(first)]; i++;
        while (i<indexes.length && indexes[i]===first+group.length) group.push(changes.get(indexes[i++]));
        sheet.getRange(first+2,1,group.length,HEADERS.length).setValues(group);
      }
      SpreadsheetApp.flush();
      config.props.setProperty('SYNC_SEQUENCE',String(sequence));
      return json_({ok:true,accepted:request.records.length});
    }
    if (!Number.isSafeInteger(request.cursor) || request.cursor<0 || request.cursor>sequence || !Number.isInteger(request.limit) || request.limit<1 || request.limit>SYNC_BATCH_SIZE) throw new Error('REQUEST');
    const candidates = rows.filter(row => Number(row[1])>request.cursor && Number(row[4])>=cutoff).sort((a,b)=>Number(a[1])-Number(b[1]));
    const selected = candidates.slice(0,request.limit), hasMore = candidates.length>selected.length;
    return json_({ok:true,records:selected.map(row=>({kind:row[2],key:row[0],value:JSON.parse(row[10])})),
      cursor:hasMore ? Number(selected[selected.length-1][1]) : sequence,hasMore});
  } catch (error) {
    const code = ['AUTH','CONFIG','BUSY','LIMIT','REQUEST'].includes(error.message) ? error.message : 'SERVER';
    return json_({ok:false,code});
  } finally { if (lock?.hasLock()) lock.releaseLock(); }
}

// Run once in the Apps Script editor after setting Script Properties.
function setup() {
  const config=configuration_();
  sheet_(config);
  if (!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='pruneRecords')) {
    ScriptApp.newTrigger('pruneRecords').timeBased().everyDays(1).create();
  }
  return 'VRCRecordsと日次保存期間チェックを作成しました。';
}
function pruneRecords() {
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const config=configuration_(), sheet=sheet_(config), rows=rows_(sheet);
    // Never reset the sequence when deleting rows: other clients retain incremental cursors.
    config.props.setProperty('SYNC_SEQUENCE',String(sequence_(config,rows)));
    const cutoff=Date.now()-config.days*86400000;
    for (let i=rows.length-1;i>=0;) {
      if (Number(rows[i][4])>=cutoff) { i--; continue; }
      const end=i;
      while (i>=0 && Number(rows[i][4])<cutoff) i--;
      sheet.deleteRows(i+3,end-i);
    }
  } finally { lock.releaseLock(); }
}
