import { canonical, normalizeRecord, normalizeEnvelope, mergeRecord, SYNC_BATCH_SIZE, SYNC_KINDS, LEGACY_SYNC_KINDS, ARCHIVE_KINDS } from './sync-format.js';

async function receipt(record){const data=new TextEncoder().encode(canonical(record.value));return 'sha256:'+ [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(n=>n.toString(16).padStart(2,'0')).join('');}

export function syncSettings(input = {}) {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (endpoint && !/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(endpoint)) throw Error('GASのウェブアプリURL（https://script.google.com/macros/s/…/exec）を指定してください。');
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (input.enabled && (!endpoint || !/^[A-Za-z0-9_-]{32,256}$/.test(token))) throw Error('GASのURLと32文字以上の英数字・ハイフン・アンダースコアの同期キーが必要です。');
  return { enabled: input.enabled === true, endpoint, token };
}

export const CLOUD_ORIGINS = ['https://script.google.com/*','https://script.googleusercontent.com/*'];
export const PUBLIC_ACCESS_MESSAGE = 'GASの公開範囲が「全員」になっていません。デプロイを管理 → 編集で「アクセスできるユーザー：全員」にし、新バージョンでデプロイしてください。';
const GAS_MESSAGES = {
  AUTH:'同期キーが一致しません。GASのSYNC_TOKENを拡張の同期キー欄へ貼り付け直し、設定を保存してください。',
  CONFIG:'GASのスクリプトプロパティを確認してください。エディターでsetupを実行すると不正な項目が表示されます。',
  BUSY:'GASで別の同期が実行中です。後ほど再試行します。',
  LIMIT:'スプレッドシートの保存上限です。GASの整理手順を確認してください。',
  SCHEMA:'未対応のデータ形式です。拡張とGASを更新してください。',
  DATASET:'同期先のデータセットが変更されました。次回同期で再接続します。',
  MIGRATION:'旧シートの移行に失敗しました。GASのsetupを実行して確認してください。',
  REQUEST:'GASがこの要求に対応していません。デプロイしたコードを確認してください。',
  SERVER:'GASの処理に失敗しました。Apps Scriptの実行数でエラーを確認してください。',
};
export function serverRetryDeadline(state = {}) {
  if (Number.isFinite(state.serverRetryAt)) return state.serverRetryAt;
  // Old versions did not record the source of the delay. Preserve old HTTP error waits conservatively.
  return /HTTP \d{3}/.test(state.message || '') ? state.retryAt || 0 : 0;
}
function syncError(message, code, diagnostic, retryMs = 0, protocol) {
  return Object.assign(Error(message), {code,diagnostic:{...diagnostic,responseCode:code},retryMs,protocol});
}
function publicResponseUrl(value, token) {
  try {
    const url=new URL(value);
    if (!['https:','http:'].includes(url.protocol)) return '';
    // Google redirect URLs can contain temporary credentials in their query; never persist those.
    const path=url.hostname==='script.google.com' || url.hostname==='script.googleusercontent.com' ? url.pathname : '';
    return (url.origin+path).replaceAll(token || '\0','[redacted]').slice(0,1600);
  } catch { return ''; }
}
export async function requestGas(config, body, {fetcher=(...args)=>fetch(...args),now=()=>Date.now(),onResponse=()=>{}} = {}) {
  const diagnostic={action:body.action,httpStatus:null,finalUrl:'',responseCode:'',protocol:null};
  let response;
  try {
    response=await fetcher(config.endpoint,{method:'POST',credentials:'omit',redirect:'follow',cache:'no-store',
      headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify({...body,token:config.token}),signal:AbortSignal.timeout(25000)});
  } catch {
    throw syncError('GASへ通信できませんでした。Googleへの接続権限、ネット接続、公開URLと公開範囲「全員」を確認してください。','NETWORK',diagnostic);
  }
  diagnostic.httpStatus=response.status || null;
  diagnostic.finalUrl=publicResponseUrl(response.url,config.token);
  onResponse({...diagnostic});
  const retry=response.headers?.get('Retry-After');
  const duration=retry && /^\d+$/.test(retry) ? Number(retry)*1000 : Math.max(0,Date.parse(retry)-now());
  const retryMs=Number.isFinite(duration) && duration>0 ? duration : 0;
  let login=false;
  try {login=new URL(response.url).hostname==='accounts.google.com';} catch {}
  if(login || /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers?.get('Content-Type') || '')) {
    throw syncError(PUBLIC_ACCESS_MESSAGE,'PUBLIC_ACCESS',diagnostic,retryMs);
  }
  if(!response.ok)throw syncError('同期サーバーに接続できません。HTTP '+response.status,'HTTP',diagnostic,retryMs);
  let data;
  try {data=await response.json();}
  catch {throw syncError('GASがJSONを返しませんでした。公開範囲「全員」と /exec のデプロイURLを確認してください。','NON_JSON',diagnostic,retryMs);}
  diagnostic.protocol=[1,2].includes(data?.protocol)?data.protocol:null;
  if(!data || ![1,2].includes(data.protocol) || data.ok!==true) {
    const code=Object.hasOwn(GAS_MESSAGES,data?.code)?data.code:'INVALID_RESPONSE';
    throw syncError(GAS_MESSAGES[code] || 'GASの応答形式が不正です。デプロイしたコードを確認してください。',code,diagnostic,retryMs,diagnostic.protocol);
  }
  if(data.protocol!==body.protocol || (body.action!=='hello' && body.protocol===2 && data.datasetId!==body.datasetId)) {
    throw syncError('同期サーバーの形式またはデータセットが一致しません。','INVALID_RESPONSE',diagnostic,retryMs);
  }
  onResponse({...diagnostic,responseCode:'OK'});
  return data;
}
function validateHello(hello) {
  if(!hello.protocols?.includes(2) || !hello.recordSchemas?.includes(2) || !hello.operations?.includes('upsert') ||
      !Number.isInteger(hello.maxBatch) || hello.maxBatch<SYNC_BATCH_SIZE || typeof hello.datasetId!=='string' || !hello.datasetId || hello.datasetId.length>200) {
    throw syncError('GASの機能情報が不正です。最新版を再デプロイしてください。','CAPABILITIES',{});
  }
}

export function createAccountUpdater(storage) {
  let queue = Promise.resolve();
  return update => {
    const next = queue.then(async () => {
      const saved = await storage.get('accountMeta');
      await storage.set({accountMeta:update(saved.accountMeta || {})});
    });
    queue = next.catch(() => {});
    return next;
  };
}

export function createSync({ storage, exportRecords, mergeRecords, updateAccounts = createAccountUpdater(storage), hasPermission = async()=>true, fetcher = (...args) => fetch(...args), now = () => Date.now() }) {
  let active, activeKind, suspended = false;
  async function run(force) {
    const saved = await storage.get(['cloudSync', 'cloudState', 'cloudCheckpoint', 'accountMeta', 'settings']);
    const config = syncSettings(saved.cloudSync);
    if (!config.enabled) return {skipped:true,reason:'disabled'};
    const state = saved.cloudState || {};
    const serverRetryAt=serverRetryDeadline(state);
    if(serverRetryAt>now())return {skipped:true,reason:'backoff',retryAt:serverRetryAt,retrySource:'server'};
    if(!force && (state.retryAt || 0)>now())return {skipped:true,reason:'backoff',retryAt:state.retryAt,retrySource:'client'};
    if(!force && now()-(state.lastAttemptAt || 0)<60000)return {skipped:true,reason:'throttled',retryAt:state.lastAttemptAt+60000};
    const checkpoint = saved.cloudCheckpoint || { cursor: 0, receipts: {} };
    checkpoint.receipts ||= {};
    const status = { ...state, phase: 'syncing', message:'Googleへの接続権限を確認中…',stage:'permission',progressAt:now(),lastAttemptAt: now(), retryAt: 0, serverRetryAt:0, lastResponse:null };
    await storage.set({ cloudState: status });
    const deadline = now() + 120000;
    let uploaded = 0, downloaded = 0, pending = false, protocol = 2, supportedKinds=LEGACY_SYNC_KINDS,retentionDays=null,upgradeRequired=true;
    async function progress(stage,message){Object.assign(status,{stage,message,progressAt:now()});await storage.set({cloudState:status});}
    async function request(body){
      await progress(body.action,{hello:'GASへの接続を確認中…',push:'GASへ記録を送信中…',pull:'GASから記録を受信中…'}[body.action]);
      return requestGas(config,{protocol,...(protocol===2 && body.action!=='hello'?{datasetId:checkpoint.datasetId}:{}),...body},
        {fetcher,now,onResponse:info=>{status.lastResponse=info;}});
    }
    try {
      if(!await hasPermission())throw syncError('Googleへの接続権限がありません。同期設定の「Googleへの接続を許可」を押してください。','PERMISSION',{});
      try {
        const hello=await request({action:'hello'});
        validateHello(hello);
        retentionDays=Number.isInteger(hello.retentionDays)?hello.retentionDays:null;
        if(Array.isArray(hello.kinds))supportedKinds=SYNC_KINDS.filter(kind=>hello.kinds.includes(kind));
        if(!supportedKinds.length)throw Error('同期サーバーに対応する記録形式がありません。');
        upgradeRequired=retentionDays===null||!SYNC_KINDS.every(kind=>supportedKinds.includes(kind));
        if (checkpoint.datasetId !== hello.datasetId) {checkpoint.cursor=0;checkpoint.receipts={};checkpoint.datasetId=hello.datasetId;}
      } catch(error) {
        // Only the legacy implementation's explicit unsupported request response permits fallback.
        if (error.protocol!==1 || error.code!=='REQUEST') throw error;
        protocol=1;
        if(checkpoint.datasetId){checkpoint.cursor=0;checkpoint.receipts={};delete checkpoint.datasetId;}
      }
      status.protocol=protocol;
      // Older GAS acknowledged out-of-retention records without storing them. Re-send after
      // a capability/retention change instead of trusting those historical acknowledgements.
      if(canonical(checkpoint.kinds || LEGACY_SYNC_KINDS)!==canonical(supportedKinds)||checkpoint.retentionDays!==retentionDays){checkpoint.cursor=0;checkpoint.receipts={};}
      checkpoint.kinds=supportedKinds;
      checkpoint.retentionDays=retentionDays;
      await progress('export','この端末の送信対象を読み込み中…');
      const local = await exportRecords();
      for (const [accountId, meta] of Object.entries(saved.accountMeta || {})) {
        if (meta.lastSuccessAt) local.push(normalizeRecord('accounts', {accountId, displayName: meta.displayName, observedAt: meta.lastSuccessAt, extensions:meta.extensions}, now()));
      }
      // Discard receipts for locally pruned records; a receipt is saved only after server acknowledgement.
      const keys = new Set(local.map(r => r.key));
      checkpoint.receipts = Object.fromEntries(Object.entries(checkpoint.receipts).filter(([key]) => keys.has(key)));
      const unsupported=local.filter(r=>!supportedKinds.includes(r.kind)).length;
      const hashes=new Map(await Promise.all(local.map(async r=>[r.key,await receipt(r)])));
      const outgoing = local.filter(r => supportedKinds.includes(r.kind) && checkpoint.receipts[r.key] !== hashes.get(r.key));
      let sent = 0;
      for (; sent < outgoing.length && sent < SYNC_BATCH_SIZE * 10 && now() < deadline; sent += SYNC_BATCH_SIZE) {
        const batch = outgoing.slice(sent, sent + SYNC_BATCH_SIZE);
        const response = await request({action:'push', records:batch});
        if (response.accepted !== batch.length) throw Error('同期サーバーの保存件数が一致しません。');
        for (const record of batch) checkpoint.receipts[record.key] = hashes.get(record.key);
        uploaded += batch.length;
        await storage.set({cloudCheckpoint:checkpoint});
      }
      pending = sent < outgoing.length;
      let more = true;
      const cutoff = now() - Math.max(1, Math.min(365, saved.settings?.retentionDays || 30)) * 86400000;
      for (let page = 0; more && page < 10 && now() < deadline; page++) {
        const response = await request({ action:'pull', cursor:checkpoint.cursor || 0, limit:SYNC_BATCH_SIZE,...(protocol===2?{kinds:supportedKinds}:{}) });
        if (!Array.isArray(response.records) || response.records.length > SYNC_BATCH_SIZE ||
            !Number.isSafeInteger(response.cursor) || response.cursor < checkpoint.cursor || typeof response.hasMore !== 'boolean' ||
            (response.hasMore && response.cursor <= checkpoint.cursor)) throw Error('同期サーバーのページ情報が不正です。');
        const records = response.records.map(r => normalizeEnvelope(r, now())).filter(r => ARCHIVE_KINDS.includes(r.kind)||r.value.observedAt >= cutoff);
        await progress('merge','受信した記録をこの端末へ保存中…');
        await mergeRecords(records.filter(r => r.kind !== 'accounts'));
        await updateAccounts(accounts => {
        for (const record of records) {
          const {accountId, observedAt} = record.value;
          if (!accounts[accountId]) accounts[accountId] = { displayName:accountId };
          const meta = accounts[accountId];
          if (record.kind === 'accounts') {
            const prior = meta.lastSuccessAt ? normalizeRecord('accounts', {accountId, displayName:meta.displayName, observedAt:meta.lastSuccessAt, extensions:meta.extensions}, now()) : null;
            const merged=mergeRecord(record,prior);
            accounts[accountId] = {...meta, displayName:merged.value.displayName, lastSuccessAt:merged.value.observedAt, extensions:merged.value.extensions};
          }
        }
        return accounts;
        });
        // Imported rows may have lost a conflict to a newer local row. Only matching values are acknowledged.
        const merged = await exportRecords({keys:records.map(r=>r.key)});
        const received = new Map(records.map(r => [r.key, canonical(r.value)]));
        for (const record of merged) if (received.get(record.key) === canonical(record.value)) checkpoint.receipts[record.key] = await receipt(record);
        checkpoint.cursor = response.cursor;
        await storage.set({cloudCheckpoint:checkpoint});
        downloaded += records.length;
        more = response.hasMore;
      }
      pending ||= more;
      await storage.set({cloudState:{...status, phase:pending ? 'pending' : upgradeRequired?'partial':'ready',stage:pending?'pending':upgradeRequired?'upgrade':'complete', lastError:'',lastErrorAt:null, lastSuccessAt:pending||upgradeRequired ? state.lastSuccessAt || null : now(), failures:0,
        uploaded, downloaded, unsupported,retentionDays,upgradeRequired, message:(pending ? `同期の続きがあります（送信 ${uploaded} / 受信 ${downloaded}件）。次回続行します。` : `${unsupported?'一部の記録は未同期':upgradeRequired?'旧GASとの互換同期':'同期完了'}：送信 ${uploaded} / 受信 ${downloaded}件${protocol===1 ? ' · 旧GAS互換モード（GAS更新を推奨）' : ''}`)+(unsupported?` GAS未対応の記録 ${unsupported}件（訪問・同席・Xリンク・フォロワー数など）は未送信です。GASの2ファイルを更新し、setup・再デプロイしてください。`:upgradeRequired?' 全収集データの保存にはGASのCode.gs・Protocol.gsの更新、setup・再デプロイが必要です。':'')+(retentionDays>0?` GASは${retentionDays}日で整理します。全期間を保管する場合はRETENTION_DAYSを0に設定してください。`:'')}});
      return {uploaded, downloaded, pending, unsupported};
    } catch (error) {
      const failures = (state.failures || 0) + 1;
      await storage.set({cloudState:{...status, phase:'error', failures, retryAt:now() + Math.max(error.retryMs || 0, Math.min(3600000, 60000 * 2 ** Math.min(failures - 1,6))),
        serverRetryAt:error.retryMs>0?now()+error.retryMs:0,lastError:error.message,lastErrorAt:now(),lastResponse:error.diagnostic || status.lastResponse,
        message:error.message, uploaded, downloaded}});
      throw error;
    }
  }
  async function testConnection() {
    const saved=await storage.get(['cloudSync','cloudState','cloudDiagnostic']);
    const deadline=serverRetryDeadline(saved.cloudState);
    if(deadline>now())return {skipped:true,reason:'backoff',retryAt:deadline,retrySource:'server'};
    let info={testedAt:now(),phase:'testing',httpStatus:null,finalUrl:'',responseCode:'',message:'保存済みの設定で接続テスト中…'};
    await storage.set({cloudDiagnostic:info});
    try {
      const config=syncSettings({...saved.cloudSync,enabled:true});
      if(!await hasPermission())throw syncError('Googleへの接続権限がありません。同期設定の「Googleへの接続を許可」を押してください。','PERMISSION',{});
      const hello=await requestGas(config,{protocol:2,action:'hello'},{fetcher,now,onResponse:value=>{info={...info,...value};}});
      validateHello(hello);
      info={...info,phase:'success',message:'接続成功：GASのhello応答を確認しました。同期を有効にして保存後、「今すぐ同期」で記録を送受信できます。'};
    } catch(error) {
      const legacy=error.protocol===1 && error.code==='REQUEST';
      info={...info,...error.diagnostic,phase:legacy?'legacy':'error',responseCode:error.code || 'SETTINGS',
        message:legacy?'GASへ到達しましたが旧版のためhelloに未対応です。Code.gsとProtocol.gsを更新して再デプロイしてください。':error.message};
      if(error.retryMs>0){
        const state=saved.cloudState || {},serverRetryAt=now()+error.retryMs;
        await storage.set({cloudState:{...state,serverRetryAt:Math.max(serverRetryDeadline(state),serverRetryAt),retryAt:Math.max(state.retryAt||0,serverRetryAt)}});
      }
    }
    await storage.set({cloudDiagnostic:info});
    return {connected:info.phase==='success',diagnostic:info};
  }
  function start(kind,run) {
    if(suspended)return Promise.resolve({skipped:true,reason:'paused'});
    if(active)return activeKind===kind?active:Promise.resolve({skipped:true,reason:'busy'});
    activeKind=kind;
    active=run().finally(()=>{active=null;activeKind=null;});
    return active;
  }
  return {sync:({force=false}={})=>start('sync',()=>run(force)),testConnection:()=>start('test',testConnection),
    async pause(){suspended=true;await active?.catch(()=>{});},resume(){suspended=false;}};
}
