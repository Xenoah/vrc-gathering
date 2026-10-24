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
