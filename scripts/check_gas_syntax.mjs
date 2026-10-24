import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {parse} from 'acorn';

export function checkGasSource(source, filename = 'GAS source') {
  // Apps Script's editor parser can reject newer syntax even with the V8 runtime enabled.
  const ast = parse(source, {ecmaVersion:2020, sourceType:'script', locations:true});
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    // Parsing alone cannot catch newer standard-library methods such as Array.prototype.at.
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const member = node.callee, name = member.computed ? member.property.value : member.property.name;
      if (['at','replaceAll','findLast','findLastIndex','toSorted','toReversed','toSpliced'].includes(name)) {
        throw Error(`${filename}:${node.loc.start.line}: .${name}() is newer than the GAS compatibility baseline`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
}
export function checkGasFiles() {
  const directory = new URL('../gas/', import.meta.url);
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.gs')).sort();
  if (!files.length) throw Error('No GAS source files found');
  for (const filename of files) {
    try { checkGasSource(fs.readFileSync(new URL(filename,directory),'utf8'),filename); }
    catch (error) { throw Error(`${filename}: ${error.message}`); }
  }
  return files;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('GAS ES2020 syntax/API checks passed: '+checkGasFiles().join(', '));
}
