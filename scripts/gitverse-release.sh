#!/usr/bin/env bash
# Создание релиза на GitVerse (public API api.gitverse.ru).
#   scripts/gitverse-release.sh <tag> <name> <notes.md> [asset-file]
# Идемпотентно: релиз тега не пересоздаётся (существующий — просто сообщается).
# Токен GitVerse берётся ТОЛЬКО из переменной окружения GITVERSE_TOKEN и
# НИГДЕ не выводится и не сохраняется (не печатать его в командах логов!).
#
# Особенности API GitVerse (по docs/developers/public-api):
#   • база: https://api.gitverse.ru (БЕЗ префикса /api/v1);
#   • авторизация: Authorization: Bearer <token>;
#   • ОБЯЗАТЕЛЬНЫЙ заголовок Accept: application/vnd.gitverse.object+json;version=1;
#   • создание релиза: POST /repos/{owner}/{repo}/releases {tag_name,name,body};
#   • ассеты: POST /repos/{owner}/{repo}/releases/{id}/assets?name=<file>
#     — multipart/form-data, поле «attachment» (поле «file» вешает запрос).
set -euo pipefail
cd /home/z/my-project

OWNER_REPO=noid/ndr-hub
ACC='application/vnd.gitverse.object+json;version=1'

tag=${1:?Использование: gitverse-release.sh <tag> <name> <notes.md> [asset-file]}
name=${2:?Нет названия}
notes=${3:?Нет файла заметок}
asset=${4:-}
[ -f "$notes" ] || { echo "Файл заметок не найден: $notes"; exit 1; }
[ -n "${GITVERSE_TOKEN:-}" ] || { echo "GITVERSE_TOKEN не задан (env)"; exit 1; }

api() { curl -sS --max-time 30 -H "Authorization: Bearer $GITVERSE_TOKEN" -H "Accept: $ACC" "$@"; }

# существующий релиз по тегу?
code=$(api -o /tmp/gv_rel.json -w '%{http_code}' "https://api.gitverse.ru/repos/$OWNER_REPO/releases/tags/$tag" || true)
if [ "$code" = "200" ]; then
  id=$(python3 -c "import json;print(json.load(open('/tmp/gv_rel.json')).get('id',''))")
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

code=$(api -o /tmp/gv_created.json -w '%{http_code}' -X POST -H "Content-Type: application/json" \
       --data-binary @"$payload" "https://api.gitverse.ru/repos/$OWNER_REPO/releases" || true)
if [ "$code" != "201" ]; then
  echo "  ! $tag: создание не удалось (HTTP $code)" >&2
  head -c 400 /tmp/gv_created.json >&2; echo >&2
  exit 1
fi
id=$(python3 -c "import json;print(json.load(open('/tmp/gv_created.json')).get('id',''))")
url=$(python3 -c "import json;print(json.load(open('/tmp/gv_created.json')).get('html_url',''))")
echo "  + $tag: релиз создан (id=$id) $url"

# asset (опционально)
if [ -n "$asset" ]; then
  [ -f "$asset" ] || { echo "  ! asset не найден: $asset"; exit 1; }
  aname=$(basename "$asset")
  code=$(curl -sS --max-time 600 -o /tmp/gv_asset.json -w '%{http_code}' \
    -X POST -H "Authorization: Bearer $GITVERSE_TOKEN" -H "Accept: $ACC" \
    -F "attachment=@$asset;type=application/zip" \
    "https://api.gitverse.ru/repos/$OWNER_REPO/releases/$id/assets?name=$aname" || true)
  if [ "$code" != "201" ]; then
    echo "  ! $tag: загрузка asset не удалась (HTTP $code)" >&2
    head -c 300 /tmp/gv_asset.json >&2; echo >&2
    exit 1
  fi
  echo "  + $tag: asset загружен: $aname ($(stat -c%s "$asset") байт)"
fi
