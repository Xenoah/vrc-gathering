import { DEFAULTS, VERSION, settings, validContact } from './core.js';
import { syncSettings } from './sync.js';

export const BACKUP_LIMIT = 64 * 1024;
const FORMAT = 'vrc-gathering-settings';
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = label => { throw Error(`設定ファイルの${label}が不正です。`); };

// Select preferences explicitly: observations, runtime state and credentials from other sources never belong here.
export function createSettingsBackup(saved, includeToken = false, now = Date.now()) {
  const { enabled, ...collection } = settings(saved.settings || DEFAULTS);
  const cloud = saved.cloudSync || {};
  return validateSettingsBackup({ format:FORMAT, schema:1, appVersion:VERSION, exportedAt:new Date(now).toISOString(),
    settings:{ collection, sync:{enabled:cloud.enabled === true, endpoint:cloud.endpoint || '',
      ...(includeToken ? {token:cloud.token || ''} : {})}, images:{enabled:saved.imageCacheSettings?.enabled === true} } });
}

export function validateSettingsBackup(input) {
  if (!object(input) || input.format !== FORMAT) throw Error('この拡張の設定ファイルを選んでください。履歴JSONは読み込めません。');
  if (input.schema !== 1) throw Error('未対応の設定ファイル形式です。対応する拡張バージョンで読み込んでください。');
  const group = input.settings;
  if (!object(group) || !object(group.collection) || !object(group.sync) || !object(group.images)) fail('項目');
  const c = group.collection, s = group.sync;
  if (typeof c.contact !== 'string' || c.contact.length > 180 || (c.contact && !validContact(c.contact))) fail('連絡先');
  for (const [key,min,max] of [['pollSeconds',60,3600],['retentionDays',1,365],['offlineRefreshMinutes',30,1440]]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) fail(key);
  }
  if (typeof s.enabled !== 'boolean' || typeof group.images.enabled !== 'boolean') fail('有効・無効');
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 2048) fail('GASのURL');
  const endpoint = syncSettings({endpoint:s.endpoint}).endpoint;
  if (s.enabled && !endpoint) fail('GASのURL');
  const hasToken = Object.hasOwn(s, 'token');
  if (hasToken && s.token !== '' && !validToken(s.token)) fail('同期キー（32〜256文字の英数字・ハイフン・アンダースコア）');
  return { format:FORMAT, schema:1, appVersion:typeof input.appVersion === 'string' ? input.appVersion.slice(0,40) : '',
    exportedAt:typeof input.exportedAt === 'string' ? input.exportedAt.slice(0,40) : '',
    settings:{collection:{contact:c.contact,pollSeconds:c.pollSeconds,retentionDays:c.retentionDays,offlineRefreshMinutes:c.offlineRefreshMinutes},
      sync:{enabled:s.enabled,endpoint,...(hasToken ? {token:s.token} : {})},images:{enabled:group.images.enabled}} };
}

export function parseSettingsBackup(content) {
  if (typeof content !== 'string' || content.length > BACKUP_LIMIT) throw Error('設定ファイルは64KiB以下のJSONを選んでください。');
  let input;
  try { input = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw Error('設定ファイルをJSONとして読み取れません。'); }
  return validateSettingsBackup(input);
}

export function resolveSettingsBackup(input, currentSync = {}) {
  const backup = validateSettingsBackup(input), {collection,sync,images} = backup.settings;
  const hasToken = Object.hasOwn(sync,'token');
  const keepToken = !hasToken && sync.endpoint === currentSync.endpoint && validToken(currentSync.token);
  const token = hasToken ? sync.token : keepToken ? currentSync.token : '';
  const needsToken = !!sync.endpoint && !validToken(token);
  return { settings:{...collection,enabled:false}, cloudSync:syncSettings({...sync,token,enabled:sync.enabled && !needsToken}),
    imageCacheSettings:{...images}, needsToken, tokenSource:hasToken && token ? 'file' : keepToken ? 'existing' : 'missing' };
}
