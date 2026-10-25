import { normalizeRecord } from './sync-format.js';
const userId=v=>typeof v==='string'&&/^(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/.test(v);
export const NOTE_SCAN_INTERVAL=30*60000,NOTE_CACHE_TTL=10*60000;
export function officialNote(raw,accountId,observedAt,{targetId=''}={}) {
  if(!raw||typeof raw!=='object'||!userId(accountId))throw Error('公式ノートの応答形式が不正です。');
  const id=targetId||raw.targetUserId;
  if(!userId(id)||targetId&&raw.id!==targetId||!targetId&&raw.userId!==accountId)throw Error('公式ノートのアカウントまたはユーザーが一致しません。');
  if(typeof raw.note!=='string'||raw.note.length>8000)throw Error('公式ノートの本文を確認できませんでした。保存済みの内容を保持します。');
  let noteId='',createdAt=null;
  if(!targetId){
    if(typeof raw.id!=='string'||!/^unt_[a-zA-Z0-9-]{8,64}$/.test(raw.id))throw Error('公式ノートIDが不正です。');noteId=raw.id;
    createdAt=Date.parse(raw.createdAt);if(!Number.isSafeInteger(createdAt)||createdAt<=0||createdAt>observedAt+300000)throw Error('公式ノートの作成日時が不正です。');
  }
  return {accountId,userId:id,note:raw.note,observedAt,noteId,createdAt,displayName:typeof (targetId?raw.displayName:raw.targetUser?.displayName)==='string'?(targetId?raw.displayName:raw.targetUser.displayName).slice(0,128):''};
}
export function noteChanges(previous,samples) {
  const latest=new Map(previous.filter(r=>r.kind==='userNotes').map(r=>[r.value.accountId+':'+r.value.userId,r.value])),writes=new Map();
  for(const sample of [...samples].sort((a,b)=>a.observedAt-b.observedAt)){
    const key=sample.accountId+':'+sample.userId,old=latest.get(key);if(old&&old.observedAt>sample.observedAt)continue;
    const same=old?.note===sample.note;
    // Confirmations update one latest-state row; only content changes add history.
    if(same&&sample.observedAt===old.observedAt&&(!sample.noteId||sample.noteId===old.noteId)&&(!sample.displayName||sample.displayName===old.displayName))continue;
    const value={...sample,source:'vrchat-user-note',changedAt:same?old.changedAt:sample.observedAt,
      noteId:sample.noteId||(same?old.noteId:''),createdAt:sample.createdAt??(same?old.createdAt:null),displayName:sample.displayName||old?.displayName||sample.userId};
    const snapshot=normalizeRecord('userNotes',value);writes.set(snapshot.key,snapshot);latest.set(key,snapshot.value);
    if(!same){const change=normalizeRecord('userNoteHistory',value);writes.set(change.key,change);}
  }
  return [...writes.values()];
}
export function noteChecks(cache,accountId,userId,checkedAt) {
  const entries=Object.entries({...cache,[accountId+':'+userId]:checkedAt}).filter(([,at])=>Number.isSafeInteger(at)&&at>0).sort((a,b)=>b[1]-a[1]);return Object.fromEntries(entries.slice(0,500));
}
