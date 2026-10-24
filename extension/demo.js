import { friend, reconcile } from './core.js';
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
  return { accountId, friends: merged.records, events: merged.events.reverse(), worlds: [
    { id: 'wrld_demoobservatory', name: '星灯りの展望台', authorName: '架空の制作者', capacity: 24, observedAt: now },
    { id: 'wrld_demoatelier000', name: '水辺のアトリエ', authorName: '架空の制作者', capacity: 16, observedAt: now },
    { id: 'wrld_democafe000000', name: '夜更けの喫茶室', authorName: '架空の制作者', capacity: 32, observedAt: now }
  ], state: { phase: 'ready', accountId, accountName: 'デモアカウント', lastSuccessAt: now - 45000, nextRunAt: now + 110000, message: '架空のサンプルです。API接続・収集・保存は行いません。' } };
}
