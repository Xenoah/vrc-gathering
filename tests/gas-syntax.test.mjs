import test from 'node:test';
import assert from 'node:assert/strict';
import {checkGasSource,checkGasFiles} from '../scripts/check_gas_syntax.mjs';

test('all shipped GAS sources parse as ES2020 and avoid selected newer runtime methods',()=>{
  assert.deepEqual(checkGasFiles(),['Code.gs','Protocol.gs']);
});
test('GAS compatibility guard rejects the reported regressions and ES2022 syntax',()=>{
  for(const source of ['state.ready ||= false;','state.ready &&= false;','state.ready ??= false;','class Example { field = 1; }', 'selected.at(-1);', "selected['at'](-1);", "value.replaceAll('a','b');"]) {
    assert.throws(()=>checkGasSource(source),undefined,source);
  }
  assert.doesNotThrow(()=>checkGasSource("const state={}; if(!state.ready)state.ready=false; const item=state?.items ?? []; item[item.length-1];"));
});
