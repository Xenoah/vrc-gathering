export const USER_STATUSES = {
  'join me':{key:'join',label:'Join Me',color:'#00b0f4'},
  active:{key:'online',label:'Online',color:'#2bce0a'},
  'ask me':{key:'ask',label:'Ask Me',color:'#f18a00'},
  busy:{key:'busy',label:'Do Not Disturb',color:'#e00032'},
  offline:{key:'offline',label:'現実世界（Offline）',color:'#909090'},
  unknown:{key:'unknown',label:'不明',color:'#909090'}
};

export function userStatus(friend) {
  // The selected status can remain cached after someone closes the game.
  if(friend?.presence==='offline')return USER_STATUSES.offline;
  return USER_STATUSES[friend?.status]||USER_STATUSES.unknown;
}
