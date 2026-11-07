#!/usr/bin/env bash
# Только чтение: список релизов и ассетов (токен не выводится).
set -euo pipefail
cd /home/z/my-project
REPO=NoIDXMV6/ndr-rules-hub

u=$(git config --get remote.origin.url)
creds=${u#*://}; creds=${creds%%@*}
case $creds in *:*) TOKEN=${creds##*:};; *) TOKEN=$creds;; esac
[ -n "$TOKEN" ] || { echo NO_TOKEN_IN_REMOTE; exit 1; }

curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases?per_page=20" | python3 -c "
import json, sys
for r in json.load(sys.stdin):
    print(f\"== {r['tag_name']}  id={r['id']}  {r['name']}\")
    print('   url:', r['html_url'])
    if not r['assets']:
        print('   assets: (пусто)')
    for a in r['assets']:
        print(f\"   asset: {a['name']}  {a['size']}B  state={a['state']}  dl={a['download_count']}\")
"
