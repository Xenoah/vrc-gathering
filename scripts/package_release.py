#!/usr/bin/env python3
"""Build a deterministic distribution from explicitly selected project files."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag', default='')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    version = manifest['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or package['version'] != version:
        raise SystemExit('Package and extension versions must agree.')
    if args.tag and args.tag != 'v' + version:
        raise SystemExit('Release tag does not match the extension version.')
    core = (ROOT / 'extension/core.js').read_text(encoding='utf-8')
    if "export const VERSION = '" + version + "';" not in core:
        raise SystemExit('Core version does not match the extension version.')
    paths = [ROOT / name for name in ['README.md', 'README_ja.md', 'VALIDATION.md', 'RELEASE_NOTES.md', 'package.json']]
    for directory in ['extension', 'windows', 'tests', 'scripts', 'gas']:
        paths.extend(p for p in (ROOT / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    payloads = {}
    for path in sorted(paths):
        name = path.relative_to(ROOT).as_posix()
        # Windows checkout line endings must not change release checksums.
        content = path.read_bytes().replace(b'\r\n', b'\n')
        payloads[name] = content
    hashes = ''.join(hashlib.sha256(content).hexdigest() + '  ' + name + '\n' for name, content in sorted(payloads.items()))
    payloads['SHA256SUMS.txt'] = hashes.encode('utf-8')
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    archive = output / ('vrc-gathering-v' + version + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, content in sorted(payloads.items()):
            info = zipfile.ZipInfo('vrc-gathering/' + name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            z.writestr(info, content)
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:
            raise SystemExit('Corrupt release ZIP.')
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / (archive.name + '.sha256')).write_text(checksum + '  ' + archive.name + '\n', encoding='utf-8')
    print(f'{archive.name}: {archive.stat().st_size} bytes, SHA-256 {checksum}')

if __name__ == '__main__':
    main()
