#!/usr/bin/env bash
# Релиз v1.4.0 — sid-first пакеты (фикс «conflicting SID (33)» из clsid-контента).
# Токен берётся ТОЛЬКО из remote URL и не выводится.
set -euo pipefail
cd /home/z/my-project

REPO=NoIDXMV6/ndr-rules-hub
TAG=v1.4.0
ZIP=dist/clearndr-rules-20261107-sidfirst.zip
KIT=dist/clearndr-snort2-import-kit-20261108-v3.zip

u=$(git config --get remote.origin.url)
creds=${u#*://}; creds=${creds%%@*}
case $creds in *:*) TOKEN=${creds##*:};; *) TOKEN=$creds;; esac
[ -n "$TOKEN" ] || { echo NO_TOKEN_IN_REMOTE; exit 1; }
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

code=$(api -o /tmp/rel14_check.json -w '%{http_code}' "https://api.github.com/repos/$REPO/releases/tags/$TAG" || true)
if [ "${code:-}" = "200" ]; then
  RELID=$(python3 -c "import json;print(json.load(open('/tmp/rel14_check.json'))['id'])")
  echo "release $TAG уже существует (id=$RELID) — ассеты будут перезалиты"
else
  SHA=$(sha256sum "$ZIP" | cut -d' ' -f1)
  KITSHA=$(sha256sum "$KIT" | cut -d' ' -f1)

  python3 - "$TAG" "$SHA" "$KITSHA" > /tmp/rel14_payload.json <<'PYEOF'
import json, sys
tag, sha, kitsha = sys.argv[1], sys.argv[2], sys.argv[3]
body = f"""**Финальный пакет правил для Clear NDR: 113 832 правила, Suricata 7, sid-first.**

Исправлен последний корень ошибки Clear NDR `The source contains conflicting SID (33) in same source`:

**Диагноз (воспроизведён на живом Scirius — движке правил Clear NDR):**
Scirius извлекает SID регэкспом `sid *: *(\\d+)` — **первое** совпадение в строке.
В правилах Talos BROWSER-IE / BROWSER-PLUGINS внутри `content:"clsid:33FD63B1-…"`
есть подстрока `sid:33…` (cl**sid:**33FD…) — GUID из контента принимается за SID
правила. У HTTP- и SMTP-вариантов таких правил ложный SID совпадает, и любой файл,
содержащий оба правила пары, падает на импорте. Число (33) из ошибки пользователя
воспроизведено байт-в-байт на файлах пакета.

**Исправление:** во всех правилах опция `sid:…;` перенесена в начало списка опций
(порядок опций в Snort/Suricata свободный, семантика не меняется). Первое совпадение
регэкспа — теперь настоящий SID из блока 1 000 000 000+. Контент, msg, rev,
classtype не менялись; SID-MAP.csv валиден.

**Проверка на живом Scirius (копия движка правил Clear NDR, развёрнута в песочнице):**
- до исправления: full (113 832), talos2 (45 985), kit-01of10 (4 600),
  cat-exploits-web (37 740) — все падают с `conflicting SID (33)`;
- после исправления: **31/31 файл** (21 файл пакета + 10 кусков кита) импортируются
  без ошибок;
- `suricata -T` (7.0.10): полный файл загружается успешно, 0 ошибок.

**Артефакты:**
- `clearndr-rules-20261107-sidfirst.zip` ({sha[:16]}…) — полный пакет: full/starter/smoke + by-source (13) + by-category (5) + SID-MAP.csv + SHA256SUMS.txt + README-IMPORT.md
- `clearndr-snort2-import-kit-20261108-v3.zip` ({kitsha[:16]}…) — импорт-набор Talos Snort 2.9 (45 985 правил, 10 кусков ≤4 600 правил): **один кусок = один новый источник Clear NDR**

SHA-256:
`{sha}` — clearndr-rules-20261107-sidfirst.zip
`{kitsha}` — clearndr-snort2-import-kit-20261108-v3.zip

**Импорт:** один файл = один новый источник; не импортировать повторно в непустой источник;
не смешивать файлы, содержащие одни и те же правила (full ∩ by-source ∩ by-category = 100%)."""
print(json.dumps({
    "tag_name": tag,
    "target_commitish": "main",
    "name": "v1.4.0 — sid-first: фикс «conflicting SID (33)» (clsid в контенте)",
    "body": body,
    "draft": False,
    "prerelease": False,
}))
PYEOF

  echo "== создание release $TAG:"
  api -X POST -d @/tmp/rel14_payload.json "https://api.github.com/repos/$REPO/releases" > /tmp/rel14_create.json
  RELID=$(python3 -c "import json;d=json.load(open('/tmp/rel14_create.json'));print(d.get('id') or '');import sys;print(d.get('message',''),file=sys.stderr)" 2>/tmp/rel14_err.txt)
  [ -n "$RELID" ] || { echo "CREATE_FAILED: $(cat /tmp/rel14_err.txt)"; exit 1; }
  echo "release id=$RELID"
fi

up=$(api "https://api.github.com/repos/$REPO/releases/$RELID" | python3 -c "import json,sys;print(json.load(sys.stdin)['upload_url'].split('{')[0])")

upload() { # $1=file $2=name
  api "https://api.github.com/repos/$REPO/releases/$RELID/assets" | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a['name']=='$2': print(a['id'])
" | while read -r aid; do
    [ -n "$aid" ] && api -X DELETE "https://api.github.com/repos/$REPO/releases/assets/$aid" >/dev/null || true
  done
  api -X POST -H "Content-Type: application/zip" --data-binary @"$1" "$up?name=$2" > /tmp/rel14_asset.json
  python3 -c "import json;d=json.load(open('/tmp/rel14_asset.json'));print('asset:',d.get('name'),d.get('size'),d.get('state'),(d.get('message') or ''))"
}

upload "$ZIP" "$(basename "$ZIP")"
upload "$KIT" "$(basename "$KIT")"

echo "== итог:"
api "https://api.github.com/repos/$REPO/releases/$RELID" | python3 -c "import json,sys;d=json.load(sys.stdin);print('URL:',d['html_url']);print('assets:',[(a['name'],a['size'],a['state']) for a in d['assets']])"
