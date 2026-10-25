import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('distribution preserves PNG bytes and bundles the same GAS source as the in-extension guide',()=>{
  const check=spawnSync('python3',['-c',`
from pathlib import Path
from zipfile import ZipFile
import json, runpy, struct
root=Path.cwd()
runpy.run_path(str(root/'scripts/package_release.py'),run_name='__main__')
manifest=json.loads((root/'extension/manifest.json').read_text())
version=manifest['version']
with ZipFile(root/'dist'/('vrc-gathering-v'+version+'.zip')) as archive:
    for sizes in [manifest['icons'],manifest['action']['default_icon']]:
        for size,path in sizes.items():
            raw=archive.read('vrc-gathering/extension/'+path)
            assert raw==(root/'extension'/path).read_bytes()
            assert raw[:8]==b'\\x89PNG\\r\\n\\x1a\\n'
            assert struct.unpack('>II',raw[16:24])==(int(size),int(size))
    for name in ['Code.gs','Protocol.gs','appsscript.json']:
        assert archive.read('vrc-gathering/extension/setup/'+name)==archive.read('vrc-gathering/gas/'+name)
    assert archive.read('vrc-gathering/extension/setup/Watch-VRChatLogs.ps1')==archive.read('vrc-gathering/windows/Watch-VRChatLogs.ps1')
`],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8'});
  assert.equal(check.status,0,check.stderr || check.stdout);
});
