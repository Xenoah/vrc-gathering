import { normalizeRecord, mergeRecord } from './sync-format.js';
import { readXCache } from './x-profile.js';

export const X_FOLLOWER_ORIGINS = ['https://x.com/*'];
const CACHE_LIMIT=50000;
export function followerRecords(cache={},now=Date.now()) {
  const records=[];
  for(const value of Object.values(cache))try{records.push(normalizeRecord('xFollowers',value,now));}catch{}
  return records;
}
export function mergeFollowerCache(cache,records,now=Date.now()) {
  const next=new Map(followerRecords(cache,now).map(r=>[r.key,r]));
  for(const record of records){const valid=normalizeRecord('xFollowers',record.value,now);next.set(valid.key,mergeRecord(valid,next.get(valid.key)));}
  return Object.fromEntries([...next.values()].sort((a,b)=>b.value.observedAt-a.value.observedAt||a.key.localeCompare(b.key)).slice(0,CACHE_LIMIT).map(r=>[r.key,r.value]));
}
export function bestFollowerMetric(profiles,metrics,accountId,userId,now=Date.now()) {
  const profile=readXCache(profiles,accountId,userId,now);if(!profile)return null;
  let best=null;
  for(const url of profile.urls){const value=metrics?.['xFollowers:'+accountId+':'+url.slice(14)];if(!value)continue;
    try{const valid=normalizeRecord('xFollowers',value,now).value;if(valid.accountId!==accountId||valid.url!==url)continue;
      if(!best||valid.followers>best.followers||valid.followers===best.followers&&valid.observedAt>best.observedAt)best=valid;
    }catch{}
  }
  return best;
}
export function followerText(value) {return value?(value.approximate?'約':'')+value.followers.toLocaleString('ja-JP'):'未取得';}
