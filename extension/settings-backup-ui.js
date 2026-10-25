import { BACKUP_LIMIT, createSettingsBackup, parseSettingsBackup, resolveSettingsBackup } from './settings-backup.js';
import { CLOUD_ORIGINS } from './sync.js';
import { X_FOLLOWER_ORIGINS } from './x-followers.js';
import { IMAGE_ORIGINS } from './image-cache.js';

export function initializeSettingsBackup({isDemo,download,stamp,call,onImported}) {
  const $ = id => document.getElementById(id), dialog = $('settingsImportDialog');
  let pending = null;
  const notice = message => { $('backupNotice').textContent = message; };
  for (const id of ['exportSettings','importSettings','includeSyncToken']) $(id).disabled = isDemo;
  if (isDemo) notice('デモ画面では設定の書き出し・読み込みは行いません。');

  $('exportSettings').addEventListener('click',async()=>{
    try {
      const saved = await chrome.storage.local.get(['settings','cloudSync','imageCacheSettings','xFollowerSettings']);
      const withToken = $('includeSyncToken').checked;
      const backup = createSettingsBackup(saved,withToken);
      download(`vrc-settings-${stamp()}${withToken ? '-with-key' : ''}.json`,JSON.stringify(backup,null,2),'application/json');
      notice('保存済みの設定を書き出しました。未保存の入力は含みません。');
    } catch { notice('設定を書き出せませんでした。保存済みの設定を確認してください。'); }
    finally { $('includeSyncToken').checked = false; }
  });
  $('importSettings').addEventListener('click',()=>{ $('settingsFile').value='';$('settingsFile').click(); });
  $('settingsFile').addEventListener('change',async()=>{
    const file = $('settingsFile').files[0];
    if (!file) return;
    try {
      if (file.size > BACKUP_LIMIT) throw Error('設定ファイルは64KiB以下のJSONを選んでください。');
      const backup = parseSettingsBackup(await file.text());
      const saved = await chrome.storage.local.get('cloudSync');
      const resolved = resolveSettingsBackup(backup,saved.cloudSync);
      pending = {backup,resolved};
      const c = resolved.settings, s = resolved.cloudSync;
      const fields = [['連絡先',c.contact || '未設定'],['更新間隔',`${c.pollSeconds}秒`],['保存日数',`${c.retentionDays}日`],
        ['名簿の再取得',`${c.offlineRefreshMinutes}分`],['GASのURL',s.endpoint || '未設定'],
        ['同期キー',{file:'ファイルから読み込みます',existing:'この端末の保存済みキーを維持します',missing:'含まれていません（既存キーは引き継ぎません）'}[resolved.tokenSource]],
        ['Google同期',s.enabled ? '有効（保存後に送受信します）' : resolved.needsToken ? '無効（読み込み後に同期キーを設定してください）' : '無効'],
        ['画像キャッシュ',resolved.imageCacheSettings.enabled ? '有効' : '無効'],['Xフォロワー数',resolved.xFollowerSettings?(resolved.xFollowerSettings.enabled?'有効':'無効'):'この端末の設定を維持します']];
      $('settingsImportFields').replaceChildren();
      for (const [label,value] of fields) {
        const dt=document.createElement('dt'), dd=document.createElement('dd');
        dt.textContent=label;dd.textContent=value;$('settingsImportFields').append(dt,dd);
      }
      $('settingsImportError').textContent='';dialog.showModal();
    } catch (error) { pending=null;notice(error.message); }
    finally { $('settingsFile').value=''; }
  });
  $('cancelSettingsImport').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{pending=null;});
  dialog.addEventListener('cancel',event=>{if($('confirmSettingsImport').disabled)event.preventDefault();});
  $('confirmSettingsImport').addEventListener('click',async()=>{
    if (!pending) return;
    const {backup,resolved} = pending;
    $('confirmSettingsImport').disabled=true;$('cancelSettingsImport').disabled=true;
    $('settingsImportError').textContent='設定を読み込み中です。実行中の処理が終わるまで待っています。';
    try {
      const origins=[...(resolved.cloudSync.enabled ? CLOUD_ORIGINS : []),...(resolved.imageCacheSettings.enabled ? IMAGE_ORIGINS : []),...(resolved.xFollowerSettings?.enabled ? X_FOLLOWER_ORIGINS : [])];
      if (origins.length && !await chrome.permissions.request({origins})) throw Error('必要な接続権限が許可されなかったため、設定は変更していません。');
      const response = await call({type:'IMPORT_SETTINGS',backup},{rethrow:true});
      if (!response) throw Error('設定を読み込めませんでした。画面のエラー内容を確認して再試行してください。');
      dialog.close();
      await onImported();
      notice('設定を読み込み、保存しました。収集を再開する場合は「収集を開始」を押してください。'+(response.needsToken?' Google同期には同期キーの入力・保存が必要です。':''));
    } catch (error) { $('settingsImportError').textContent=error.message; }
    finally { $('confirmSettingsImport').disabled=false;$('cancelSettingsImport').disabled=false; }
  });
}
