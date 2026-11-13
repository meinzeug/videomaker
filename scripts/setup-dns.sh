#!/usr/bin/env bash
set -euo pipefail
# Idempotent Hetzner Cloud DNS setup. Secrets are read from a file, never echoed.
export HETZNER_KEY_FILE="${HETZNER_KEY_FILE:-$HOME/hetznerkey.txt}"
python3 - <<'PY'
import json, os, sys, time, urllib.error, urllib.request
from pathlib import Path
key = Path(os.environ['HETZNER_KEY_FILE']).read_text().strip()
if not key: sys.exit('Hetzner API key is empty')
base = 'https://api.hetzner.cloud/v1'
headers = {'Authorization': 'Bearer '+key, 'Content-Type': 'application/json'}
def call(method, path, data=None):
    req = urllib.request.Request(base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as res: return json.load(res)
    except urllib.error.HTTPError as e:
        if e.code == 404 and method == 'GET': return None
        raise RuntimeError(f'Hetzner API HTTP {e.code}: {e.read().decode()}') from None
path = '/zones/dorfspy.de/rrsets/videomaker/A'
existing = call('GET', path)
if existing:
    values = sorted(r['value'] for r in existing['rrset']['records'])
    if values == ['91.99.217.84']:
        print('DNS record already points to 91.99.217.84'); sys.exit(0)
    # Preserve existing values; a different A record requires explicit operator review.
    sys.exit('An A record already exists with different values. Review it before changing DNS: '+', '.join(values))
result = call('POST', '/zones/dorfspy.de/rrsets', {'name':'videomaker','type':'A','ttl':300,'records':[{'value':'91.99.217.84'}]})
action = result.get('action', {})
for _ in range(30):
    if action.get('status') == 'success': break
    if action.get('status') == 'error': sys.exit('Hetzner DNS action failed: '+str(action.get('error')))
    time.sleep(2)
    action = call('GET', '/actions/'+str(action['id']))['action']
else: sys.exit('DNS action did not complete in time')
print('Created videomaker.dorfspy.de A 91.99.217.84')
PY
