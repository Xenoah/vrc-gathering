export const DEFAULT_X_CONCURRENCY=3;
export const MAX_X_CONCURRENCY=10;
export const xScope=value=>value==='all'?'all':'linked';
export const xAccountId=value=>typeof value==='string'&&/^(usr_[a-zA-Z0-9-]{8,64}|[a-zA-Z0-9]{8,32})$/.test(value)?value:'';
export function validateXScope(value){
  if(!['linked','all'].includes(value))throw Error('Xの取得対象を選択してください。');
  return value;
}
export const xConcurrency=value=>Number.isInteger(value)&&value>=1&&value<=MAX_X_CONCURRENCY?value:DEFAULT_X_CONCURRENCY;
export function validateXConcurrency(value){
  if(!Number.isInteger(value)||value<1||value>MAX_X_CONCURRENCY)throw Error('Xの同時取得数は1〜10の整数で指定してください。');
  return value;
}
