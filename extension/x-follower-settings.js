export const DEFAULT_X_CONCURRENCY=3;
export const MAX_X_CONCURRENCY=10;
export const xConcurrency=value=>Number.isInteger(value)&&value>=1&&value<=MAX_X_CONCURRENCY?value:DEFAULT_X_CONCURRENCY;
export function validateXConcurrency(value){
  if(!Number.isInteger(value)||value<1||value>MAX_X_CONCURRENCY)throw Error('Xの同時取得数は1〜10の整数で指定してください。');
  return value;
}
