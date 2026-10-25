import test from 'node:test';
import assert from 'node:assert/strict';
import {rankWorlds,worldJourney} from '../extension/insights.js';
import {demoData} from '../extension/demo.js';
import {location} from '../extension/core.js';

test('ranking counts unique fresh online friends, aggregates instances, and excludes hidden or stale observations',()=>{
  const d=demoData(), now=Date.now();
  const rank=rankWorlds(d.friends,d.worlds,{now});
  assert.deepEqual(rank.map(w=>[w.name,w.count,w.rank]),[['星灯りの展望台',2,1],['水辺のアトリエ',1,2],['夜更けの喫茶室',1,2]]);
  const duplicate={...d.friends[0],observedAt:now,location:location('private')};
  assert.equal(rankWorlds([...d.friends,duplicate],d.worlds,{now}).find(w=>w.name==='星灯りの展望台').count,1);
  assert.equal(rankWorlds(d.friends,d.worlds,{now:now+900000}).length,0);
  assert.equal(rankWorlds([{...d.friends[0],isFriend:false}],d.worlds,{now}).length,0);
  assert.equal(rankWorlds([{...d.friends[0],observedAt:now+1}],d.worlds,{now}).length,0);
});
test('journey preserves world, privacy gaps and instance changes while collapsing status-only observations',()=>{
  const d=demoData(), userId=d.friends[0].id;
  const flow=worldJourney(d.events,userId);
  assert.deepEqual(flow.nodes.map(n=>n.kind),['world','private','world','world']);
  assert.equal(flow.nodes[0].worldId,'wrld_democafe000000');
  assert.equal(flow.nodes[1].worldId,'');
  const last=d.events.find(e=>e.userId===userId);
  const status={...last,observedAt:last.observedAt+1,previousObservedAt:last.observedAt,previous:last.current,current:{...last.current,status:'busy'}};
  assert.equal(worldJourney([...d.events,status],userId).nodes.length,4);
  const moved={...status,observedAt:status.observedAt+1,previousObservedAt:status.observedAt,current:{...status.current,location:{...status.current.location,instanceId:'different'}}};
  assert.equal(worldJourney([...d.events,status,moved],userId).nodes.length,5);
  assert.equal(worldJourney(d.events,'usr_missing0001').nodes.length,0);
  assert.equal(worldJourney(d.events,userId,{limit:2}).truncated,true);
});

test('network includes all users, keeps privacy states and same-world instance edges, and filters periods/users',async()=>{
  const {worldNetwork}=await import('../extension/insights.js'),d=demoData();
  const graph=worldNetwork(d.events,d.friends,d.worlds);assert.equal(graph.userCount,9);assert.equal(graph.transitionCount,6);
  assert.equal(graph.nodes.filter(n=>n.kind==='world').length,3);assert.ok(graph.nodes.some(n=>n.id==='state:private'));
  assert.equal(graph.edges.filter(e=>e.from==='wrld_democafe000000'&&e.to==='wrld_demoatelier000').flatMap(e=>e.transitions).filter(t=>t.userId===d.friends[0].id).length,0);
  const single=worldNetwork(d.events,d.friends,d.worlds,{userId:d.friends[0].id});assert.equal(single.userCount,1);assert.equal(single.nodes.length,4);
  const last=d.events.find(e=>e.userId===d.friends[0].id),changed={...last,observedAt:last.observedAt+1,previousObservedAt:last.observedAt,previous:last.current,current:{...last.current,location:{...last.current.location,instanceId:'different'}}};
  const withLoop=worldNetwork([...d.events,changed],d.friends,d.worlds);assert.ok(withLoop.edges.some(e=>e.from===e.to&&e.transitions[0].toInstance==='different'));
  assert.equal(worldNetwork(d.events,d.friends,d.worlds,{since:Date.now()+1}).nodes.length,0);
  assert.equal(worldNetwork(d.events,[],d.worlds).userCount,9); // History-only users remain visible.
  const filtered=worldNetwork(d.events,d.friends,d.worlds,{query:'展望台'});assert.equal(filtered.nodes.length,1);assert.equal(filtered.nodes[0].id,'wrld_demoobservatory');
});
test('network handles thousands of users without truncation and layout/sorting are deterministic',async()=>{
  const {worldNetwork,sortFriends,sortWorlds}=await import('../extension/insights.js'),d=demoData(),sample=d.friends[0];
  const friends=Array.from({length:3000},(_,i)=>({...sample,id:'usr_bulkuser'+i,location:{...sample.location,worldId:'wrld_bulkworld'+String(i).padStart(5,'0')}}));
  const graph=worldNetwork([],friends,[]);assert.equal(graph.userCount,3000);assert.equal(graph.nodes.length,3000);assert.ok(graph.nodes.every(n=>n.x>=0&&n.y>=0&&n.x<=graph.width&&n.y<=graph.height));
  assert.deepEqual(worldNetwork([],friends.toReversed(),[]).nodes.map(n=>[n.id,n.x,n.y]),graph.nodes.map(n=>[n.id,n.x,n.y]));
  const ranked=rankWorlds(d.friends,d.worlds);assert.equal(sortWorlds(ranked,'name')[0].name,[...ranked].sort((a,b)=>a.name.localeCompare(b.name,'ja'))[0].name);
  assert.equal(sortFriends(d.friends,'oldest')[0].displayName,'Haru');assert.equal(sortFriends(d.friends,'duration')[0].stateFirstObservedAt,Math.min(...d.friends.map(f=>f.stateFirstObservedAt)));
  assert.deepEqual(sortFriends(d.friends,'name-desc').map(f=>f.id),sortFriends(d.friends,'name').toReversed().map(f=>f.id));
});

test('older previous snapshots from another device cannot reverse a user timeline',()=>{
  const d=demoData(),first=d.events.find(e=>e.userId===d.friends[0].id),later={...first,observedAt:first.observedAt+1,previousObservedAt:first.observedAt-3600000,previous:{...first.current,location:location('wrld_democafe000000:old')},current:{...first.current,location:location('wrld_demoatelier000:new')}};
  const journey=worldJourney([...d.events,later],first.userId);
  assert.ok(journey.nodes.every((n,i)=>!i||n.observedAt>=journey.nodes[i-1].lastObservedAt));
  assert.equal(journey.nodes.at(-1).worldId,'wrld_demoatelier000');
});

test('network omits travel, joins its known endpoints and preserves private boundaries',async()=>{
  const {worldNetwork}=await import('../extension/insights.js'),d=demoData(),sample=d.events[0],t=Date.now()-100000;
  const state=where=>({...sample.current,location:location(where)});
  const route=places=>places.map((p,i)=>({...sample,observedAt:t+i*1000,previousObservedAt:i?t+(i-1)*1000:null,previous:i?state(places[i-1]):null,current:state(p)}));
  const a='wrld_democafe000000:1',b='wrld_demoatelier000:2';
  const graph=worldNetwork(route([a,'traveling',b]),[],d.worlds);
  assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,1);
  assert.equal(graph.edges[0].from,'wrld_democafe000000');assert.equal(graph.edges[0].to,'wrld_demoatelier000');
  assert.equal(worldNetwork(route([a,'traveling',a]),[],d.worlds).edges.length,0);
  const hidden=worldNetwork(route([a,'traveling','private','traveling',b,'offline']),[],d.worlds);
  assert.ok(hidden.nodes.some(n=>n.name==='プライベート'));assert.ok(hidden.nodes.some(n=>n.name==='現実世界'));
  assert.ok(!hidden.edges.some(e=>e.from==='wrld_democafe000000'&&e.to==='wrld_demoatelier000'));
  assert.equal(worldNetwork([], [{...d.friends[0],location:location('traveling')}],d.worlds).nodes.length,0);
});
test('network visual encodings scale current popularity and route frequency independently',async()=>{
  const {worldRadius,routeColor,routePoint}=await import('../extension/network-style.js');
  const node=count=>({kind:'world',currentUsers:new Set(Array.from({length:count},(_,i)=>i))});
  assert.ok(worldRadius(node(0),100)<worldRadius(node(10),100));assert.ok(worldRadius(node(10),100)<worldRadius(node(100),100));
  assert.equal(worldRadius({kind:'private'},100),35);
  assert.equal(routeColor(1,100),'#518b9b');assert.equal(routeColor(10,100),'#f7cf57');assert.equal(routeColor(100,100),'#ff5d48');
  const path={a:{x:1,y:2},b:{x:10,y:20},c:{x:4,y:9}};
  assert.deepEqual(routePoint(path,0),path.a);assert.deepEqual(routePoint(path,1),path.b);
  assert.ok(routePoint(path,.7).x>routePoint(path,.3).x);
});
