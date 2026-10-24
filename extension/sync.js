import { canonical, normalizeRecord, newerRecord, SYNC_BATCH_SIZE } from './sync-format.js';

export function syncSettings(input = {}) {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (endpoint && !/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(endpoint)) throw Error('GASのウェブアプリURL（https://script.google.com/macros/s/…/exec）を指定してください。');
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (input.enabled && (!endpoint || !/^[A-Za-z0-9_-]{32,256}$/.test(token))) throw Error('GASのURLと32文字以上の英数字・ハイフン・アンダースコアの同期キーが必要です。');
  return { enabled: input.enabled === true, endpoint, token };
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

export function createSync({ storage, exportRecords, mergeRecords, updateAccounts = createAccountUpdater(storage), fetcher = (...args) => fetch(...args), now = () => Date.now() }) {
  let active, suspended = false;
  async function run(force) {
    const saved = await storage.get(['cloudSync', 'cloudState', 'cloudCheckpoint', 'accountMeta', 'settings']);
    const config = syncSettings(saved.cloudSync);
    if (!config.enabled) return { skipped: true };
    const state = saved.cloudState || {};
    if ((state.retryAt || 0) > now() || (!force && now() - (state.lastAttemptAt || 0) < 60000)) return { skipped: true };
    const checkpoint = saved.cloudCheckpoint || { cursor: 0, receipts: {} };
    checkpoint.receipts ||= {};
    const status = { ...state, phase: 'syncing', message: 'スプレッドシートと同期中…', lastAttemptAt: now(), retryAt: 0 };
    await storage.set({ cloudState: status });
    const deadline = now() + 120000;
    let uploaded = 0, downloaded = 0, pending = false;
    async function request(body) {
      const response = await fetcher(config.endpoint, {
        method: 'POST', credentials: 'omit', redirect: 'follow', cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ protocol: 1, token: config.token, ...body }), signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) {
        const error = Error('同期サーバーに接続できません。HTTP ' + response.status);
        const retry = response.headers?.get('Retry-After');
        error.retryMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now()) || 0;
        throw error;
      }
      let data;
      try { data = await response.json(); } catch { throw Error('GASがJSONを返しませんでした。公開範囲とデプロイURLを確認してください。'); }
      if (!data || data.protocol !== 1 || data.ok !== true) {
        const messages = { AUTH: '同期キーが一致しません。設定を確認してください。', CONFIG: 'GASのスクリプトプロパティを確認してください。', BUSY: 'GASで別の同期が実行中です。後ほど再試行します。', LIMIT: 'スプレッドシートの保存上限です。GASの整理手順を確認してください。' };
        throw Error(messages[data?.code] || 'GASの同期に失敗しました。デプロイしたコードを確認してください。');
      }
      return data;
    }
    try {
      const local = await exportRecords();
      for (const [accountId, meta] of Object.entries(saved.accountMeta || {})) {
        if (meta.lastSuccessAt) local.push(normalizeRecord('accounts', {accountId, displayName: meta.displayName, observedAt: meta.lastSuccessAt}, now()));
      }
      // Discard receipts for locally pruned records; a receipt is saved only after server acknowledgement.
      const keys = new Set(local.map(r => r.key));
      checkpoint.receipts = Object.fromEntries(Object.entries(checkpoint.receipts).filter(([key]) => keys.has(key)));
      const outgoing = local.filter(r => checkpoint.receipts[r.key] !== canonical(r.value));
      let sent = 0;
      for (; sent < outgoing.length && sent < SYNC_BATCH_SIZE * 10 && now() < deadline; sent += SYNC_BATCH_SIZE) {
        const batch = outgoing.slice(sent, sent + SYNC_BATCH_SIZE);
        const response = await request({action:'push', records:batch});
        if (response.accepted !== batch.length) throw Error('同期サーバーの保存件数が一致しません。');
        for (const record of batch) checkpoint.receipts[record.key] = canonical(record.value);
        uploaded += batch.length;
        await storage.set({cloudCheckpoint:checkpoint});
      }
      pending = sent < outgoing.length;
      let more = true;
      const cutoff = now() - Math.max(1, Math.min(365, saved.settings?.retentionDays || 30)) * 86400000;
      for (let page = 0; more && page < 10 && now() < deadline; page++) {
        const response = await request({ action:'pull', cursor:checkpoint.cursor || 0, limit:SYNC_BATCH_SIZE });
        if (!Array.isArray(response.records) || response.records.length > SYNC_BATCH_SIZE ||
            !Number.isSafeInteger(response.cursor) || response.cursor < checkpoint.cursor || typeof response.hasMore !== 'boolean' ||
            (response.hasMore && response.cursor <= checkpoint.cursor)) throw Error('同期サーバーのページ情報が不正です。');
        const records = response.records.map(r => normalizeRecord(r.kind, r.value, now())).filter(r => r.value.observedAt >= cutoff);
        await mergeRecords(records.filter(r => r.kind !== 'accounts'));
        await updateAccounts(accounts => {
        for (const record of records) {
          const {accountId, observedAt} = record.value;
          if (!accounts[accountId]) accounts[accountId] = { displayName:accountId };
          const meta = accounts[accountId];
          if (record.kind === 'accounts') {
            const prior = meta.lastSuccessAt ? normalizeRecord('accounts', {accountId, displayName:meta.displayName, observedAt:meta.lastSuccessAt}, now()) : null;
            if (newerRecord(record, prior)) accounts[accountId] = {...meta, displayName:record.value.displayName, lastSuccessAt:observedAt};
          }
        }
        return accounts;
        });
        // Imported rows may have lost a conflict to a newer local row. Only matching values are acknowledged.
        const merged = await exportRecords();
        const received = new Map(records.map(r => [r.key, canonical(r.value)]));
        for (const record of merged) if (received.get(record.key) === canonical(record.value)) checkpoint.receipts[record.key] = canonical(record.value);
        checkpoint.cursor = response.cursor;
        await storage.set({cloudCheckpoint:checkpoint});
        downloaded += records.length;
        more = response.hasMore;
      }
      pending ||= more;
      await storage.set({cloudState:{...status, phase:pending ? 'pending' : 'ready', lastSuccessAt:pending ? state.lastSuccessAt || null : now(), failures:0,
        uploaded, downloaded, message:pending ? `同期の続きがあります（送信 ${uploaded} / 受信 ${downloaded}件）。次回続行します。` : `同期完了：送信 ${uploaded} / 受信 ${downloaded}件`}});
      return {uploaded, downloaded, pending};
    } catch (error) {
      const failures = (state.failures || 0) + 1;
      await storage.set({cloudState:{...status, phase:'error', failures, retryAt:now() + Math.max(error.retryMs || 0, Math.min(3600000, 60000 * 2 ** Math.min(failures - 1,6))),
        message:error.message, uploaded, downloaded}});
      throw error;
    }
  }
  return { sync({force = false} = {}) { if (suspended) return Promise.resolve({skipped:true}); if (!active) active = run(force).finally(() => { active = null; }); return active; },
    async pause() { suspended = true; await active?.catch(() => {}); },
    resume() { suspended = false; } };
}
