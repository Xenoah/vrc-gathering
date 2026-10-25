import { friend, reconcile, location } from './core.js';
export function demoData() {
  const now = Date.now(), accountId = 'usr_demoaccount0001';
  const rows = [
    ['星灯り', 'join me', 'wrld_demoobservatory:31415~region(jp)', 'standalonewindows', '星を見にきました'],
    ['蒼のアトリエ', 'active', 'wrld_demoatelier000:21042~friends(usr_demohost000001)~region(jp)', 'standalonewindows', '作業しながら雑談'],
    ['mikan', 'busy', 'private', 'android', ''],
    ['Nagi', 'active', 'wrld_demoobservatory:31415~region(jp)', 'standalonewindows', ''],
    ['白雨', 'ask me', 'private', 'standalonewindows', 'おやすみモード'],
    ['Riku', 'active', 'wrld_democafe000000:27182~hidden(usr_demohost000002)~region(use)', 'standalonewindows', '音楽とコーヒー'],
    ['雪のかけら', 'active', 'offline', 'standalonewindows', ''],
    ['木漏れ日', 'active', '', 'web', '週末に会いましょう'],
    ['Haru', 'join me', 'wrld_democafe000000:27182~region(jp)', 'android', '']
  ];
  const samples = rows.map(([displayName, status, location, platform, statusDescription], i) => friend({ id: `usr_demofriend${String(i).padStart(4,'0')}`, displayName, status, location, platform, statusDescription }, now - (i === 8 ? 720000 : 45000), i === 6 ? 'offline' : i === 7 ? 'active' : 'online'));
  const merged = reconcile([], samples, accountId, now);
  const first=merged.events[0], stops=['wrld_democafe000000:27182~region(jp)','private','wrld_demoatelier000:21042~region(jp)'];
  const history=stops.map((place,i)=>({...first, observedAt:now-(3-i)*3600000, previousObservedAt:i?now-(4-i)*3600000:null,
    kind:i?'changed':'first', previous:i?{...first.current,location:location(stops[i-1])}:null, current:{...first.current,location:location(place)}}));
  first.previous=history.at(-1).current;first.previousObservedAt=history.at(-1).observedAt;first.kind='changed';
  merged.records[0].firstObservedAt=history[0].observedAt;
  merged.events.push(...history);
  for(const [index,places] of [[3,['wrld_democafe000000:27182~region(jp)','wrld_demoatelier000:21042~region(jp)']],[5,['wrld_demoobservatory:31415~region(jp)']]]) {
    const latest=merged.events.find(e=>e.userId===merged.records[index].id);
    const earlier=places.map((value,i)=>({...latest,kind:i?'changed':'first',observedAt:now-(places.length-i)*2400000,previousObservedAt:i?now-(places.length-i+1)*2400000:null,
      previous:i?{...latest.current,location:location(places[i-1])}:null,current:{...latest.current,location:location(value)}}));
    latest.previous=earlier.at(-1).current;latest.previousObservedAt=earlier.at(-1).observedAt;latest.kind='changed';merged.events.push(...earlier);
    merged.records[index].firstObservedAt=earlier[0].observedAt;
  }
  const visit=(start,end,where)=>({accountId,displayName:'デモアカウント',presence:'online',startedAt:now-start,lastSeenAt:now-end,observedAt:now-end,endedAt:now-end,location:location(where)});
  const visits=[visit(3600000,1800000,rows[0][2]),visit(7200000,5400000,rows[5][2]),visit(180000,45000,rows[0][2])];visits[2].endedAt=null;
  const encounter=(index,v,relation='instance')=>({accountId,userId:samples[index].id,displayName:samples[index].displayName,startedAt:v.startedAt+10000,lastSeenAt:v.lastSeenAt,observedAt:v.lastSeenAt,endedAt:v.endedAt,visitStartedAt:v.startedAt,relation,location:v.location,otherInstanceId:relation==='instance'?v.location.instanceId:'99999~region(jp)'});
  const encounters=[encounter(0,visits[0]),encounter(3,visits[0]),encounter(5,visits[1]),encounter(0,visits[2]),encounter(8,visits[0],'world')];
  return { accountId, visits, encounters, friends: merged.records, events: merged.events.sort((a,b)=>b.observedAt-a.observedAt), worlds: [
    { id: 'wrld_demoobservatory', name: '星灯りの展望台', authorName: '架空の制作者', capacity: 24, observedAt: now },
    { id: 'wrld_demoatelier000', name: '水辺のアトリエ', authorName: '架空の制作者', capacity: 16, observedAt: now },
    { id: 'wrld_democafe000000', name: '夜更けの喫茶室', authorName: '架空の制作者', capacity: 32, observedAt: now }
  ], state: { phase: 'ready', accountId, accountName: 'デモアカウント', lastSuccessAt: now - 45000, nextRunAt: now + 110000, message: '架空のサンプルです。API接続・収集・保存は行いません。' } };
}
