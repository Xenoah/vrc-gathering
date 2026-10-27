import {followerRecords} from './x-followers.js';
import {readXCache} from './x-profile.js';

const number=value=>value.toLocaleString('ja-JP');
export const MAX_HISTOGRAM_BINS=100;
export const histogramBinCount=value=>Number.isInteger(value)&&value>=1&&value<=MAX_HISTOGRAM_BINS?value:null;
// Each X URL contributes its latest observation once, independent of how many
// VRChat users link it. A missing observation is never a measured zero.
export function followerHistogram(metrics,profiles,{accountId='',friends=[],scope='all',scale='log',binCount=null,now=Date.now()}={}) {
  const friendIds=new Set(friends.filter(f=>f.isFriend&&f.accountId===accountId).map(f=>f.id)),known=new Set(),latest=new Map();
  for(const value of Object.values(profiles||{})){
    if(value?.accountId!==accountId||scope==='friends'&&!friendIds.has(value.userId))continue;
    const p=readXCache(profiles,accountId,value.userId,now);if(p)for(const url of p.urls)known.add(url);
  }
  for(const {value} of followerRecords(metrics,now)){
    if(value.accountId!==accountId||scope==='friends'&&!known.has(value.url))continue;
    const old=latest.get(value.url);if(!old||value.observedAt>old.observedAt)latest.set(value.url,value);
  }
  const rows=[...latest.values()].sort((a,b)=>a.followers-b.followers||a.url.localeCompare(b.url)),max=rows.at(-1)?.followers??0,bins=[];
  const requestedBinCount=histogramBinCount(binCount);
  const add=(min,max)=>bins.push({min,max,label:min===max?number(min):number(min)+'〜'+number(max),count:0,approximate:0});
  if(rows.length){
    if(scale==='log'&&requestedBinCount===null){
      add(0,0);for(let min=1;min<=max;min*=10)add(min,Math.min(Number.MAX_SAFE_INTEGER,min*10-1));
    }else{
      // Counts are integers: each bin needs at least one possible value. Clamp
      // rounded boundaries to leave room for all remaining bins, including zero.
      const count=Math.min(requestedBinCount??10,max+1),extent=max+1;
      let min=0;
      for(let i=1;i<=count;i++){
        const boundary=scale==='log'?Math.floor(Math.expm1(Math.log1p(extent)*(i/count))):Math.floor(extent*(i/count));
        const end=i===count?extent:Math.min(extent-(count-i),Math.max(min+1,boundary));
        add(min,end-1);min=end;
      }
    }
    for(const row of rows){const bin=bins.find(b=>row.followers>=b.min&&row.followers<=b.max);bin.count++;if(row.approximate)bin.approximate++;}
  }
  const middle=Math.floor(rows.length/2),median=rows.length?rows.length%2?rows[middle].followers:rows[middle-1].followers/2+rows[middle].followers/2:null;
  return {rows,bins,requestedBinCount,total:rows.length,missing:[...known].filter(url=>!latest.has(url)).length,approximate:rows.filter(r=>r.approximate).length,median,max:rows.length?max:null,
    oldest:rows.reduce((n,r)=>Math.min(n,r.observedAt),Infinity),newest:rows.reduce((n,r)=>Math.max(n,r.observedAt),0)};
}
