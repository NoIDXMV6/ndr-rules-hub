#!/usr/bin/env bash
# Создание одного GitHub Release.
#   scripts/gh_release_create.sh <tag> <name> <notes.md>
# Идемпотентно: существующий релиз тега не пересоздаётся (та же логика, что
# в gh_release_backfill.sh). Тег должен существовать в репозитории.
# Токен берётся ТОЛЬКО из remote URL origin и не выводится.
set -euo pipefail
cd /home/z/my-project

REPO=NoIDXMV6/ndr-rules-hub
tag=${1:?Использование: gh_release_create.sh <tag> <name> <notes.md>}
name=${2:?Нет названия: gh_release_create.sh <tag> <name> <notes.md>}
notes=${3:?Нет файла заметок: gh_release_create.sh <tag> <name> <notes.md>}
[ -f "$notes" ] || { echo "Файл заметок не найден: $notes"; exit 1; }

u=$(git config --get remote.origin.url)
creds=${u#*://}; creds=${creds%%@*}
case $creds in *:*) TOKEN=${creds##*:};; *) TOKEN=$creds;; esac
[ -n "$TOKEN" ] || { echo NO_TOKEN_IN_REMOTE; exit 1; }
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

id=$(api "https://api.github.com/repos/$REPO/releases/tags/$tag" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('id',''))
except Exception: print('')
")
if [ -n "$id" ]; then
  echo "  = $tag: релиз уже существует (id=$id), пропущено"
  exit 0
fi

payload=$(mktemp)
python3 - "$tag" "$name" "$notes" > "$payload" <<'PYEOF'
import json, sys
tag, name, notes = sys.argv[1:4]
json.dump({"tag_name": tag, "name": name,
           "body": open(notes, encoding="utf-8").read(),
           "draft": False, "prerelease": False},
          sys.stdout, ensure_ascii=False)
PYEOF

out=$(mktemp)
code=$(api -o "$out" -w '%{http_code}' -X POST -d @"$payload" \
      "https://api.github.com/repos/$REPO/releases" || true)
if [ "$code" != "201" ]; then
  echo "  ! $tag: создание не удалось (HTTP $code)" >&2
  python3 -c "
import json
try: print(' ', json.load(open('$out')).get('message',''))
except Exception: print(' ', open('$out').read()[:300])
" >&2
  exit 1
fi
python3 -c "
import json
d = json.load(open('$out'))
print('  + %s: релиз создан (id=%s) %s' % ('${tag}', d['id'], d['html_url']))
"
