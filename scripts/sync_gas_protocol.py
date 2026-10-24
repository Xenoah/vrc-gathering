#!/usr/bin/env python3
"""Regenerate the Apps Script copy of the shared record protocol."""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
source = (root / 'extension/sync-format.js').read_text(encoding='utf-8')
(root / 'gas/Protocol.gs').write_text(
    '// Generated from extension/sync-format.js; keep identical except export keywords.\n' + source.replace('export ', ''), encoding='utf-8')
