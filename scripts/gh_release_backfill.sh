#!/usr/bin/env bash
# Дозаливка GitHub Releases для тегов v1.10.0…v1.13.1 (объекты Releases
# создавались только до v1.9.0, теги при этом запушены).
# Идемпотентно: существующий релиз тега не пересоздаётся.
# Токен берётся ТОЛЬКО из remote URL и не выводится.
set -euo pipefail
cd /home/z/my-project

REPO=NoIDXMV6/ndr-rules-hub

u=$(git config --get remote.origin.url)
creds=${u#*://}; creds=${creds%%@*}
case $creds in *:*) TOKEN=${creds##*:};; *) TOKEN=$creds;; esac
[ -n "$TOKEN" ] || { echo NO_TOKEN_IN_REMOTE; exit 1; }
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

mk_payload() { # $1=tag $2=name $3=body-file $4=out-json
  python3 - "$1" "$2" "$3" "$4" <<'PYEOF'
import json, sys
tag, name, bodyfile, out = sys.argv[1:5]
body = open(bodyfile, encoding="utf-8").read()
json.dump({"tag_name": tag, "name": name, "body": body,
           "draft": False, "prerelease": False}, open(out, "w", encoding="utf-8"),
          ensure_ascii=False)
PYEOF
}

release_exists() { # $1=tag -> печатает id или пусто
  api "https://api.github.com/repos/$REPO/releases/tags/$1" | python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('id',''))
except Exception: print('')
"
}

create_release() { # $1=tag $2=name $3=body-file
  local tag="$1" name="$2" body="$3" id code url
  id="$(release_exists "$tag")"
  if [ -n "$id" ]; then
    echo "  = $tag: релиз уже существует (id=$id), пропущено"
    return 0
  fi
  mk_payload "$tag" "$name" "$body" /tmp/rel_payload.json
  code=$(api -o /tmp/rel_create.json -w '%{http_code}' -X POST -d @/tmp/rel_payload.json \
        "https://api.github.com/repos/$REPO/releases" || true)
  if [ "$code" != "201" ]; then
    echo "  ! $tag: создание не удалось (HTTP $code): $(python3 -c "import json;d=json.load(open('/tmp/rel_create.json'));print(d.get('message',''))" 2>/dev/null || cat /tmp/rel_create.json)" >&2
    return 1
  fi
  id=$(python3 -c "import json;print(json.load(open('/tmp/rel_create.json'))['id'])")
  url=$(python3 -c "import json;print(json.load(open('/tmp/rel_create.json'))['html_url'])")
  echo "  + $tag: релиз создан (id=$id) $url"
}

T=/tmp/rel_notes; mkdir -p "$T"

# ── v1.10.0 ──────────────────────────────────────────────────────────────────
cat > "$T/v1.10.0.md" <<'EOF'
## Обновление Clear NDR из UI

- **`clearndr-update.sh`** — автоматическое обновление стека Clear NDR на новую версию с сохранением всех настроек: preflight-проверки хоста, диагностика сбоя opensearch, поддержка seed-имён контейнеров.
- **v3**: статус шагов, разделение «чистый вывод / полный лог», решение по данным, интеграция `mikrocata2selks`.
- **Новый раздел хаба «Обновление Clear NDR»**: текущие версии, доступные релизы, опции запуска, живой лог, проверки результата.
- Mock-стенд `test-clearndr-update-mock.sh` для безопасных прогонов.
EOF

# ── v1.11.0 ──────────────────────────────────────────────────────────────────
cat > "$T/v1.11.0.md" <<'EOF'
## Защита config/, repair-скрипт, локальный режим

Инцидент 09.11.2026: после сбойного обновления в каталоге инстанса пропал `config/docker-compose.yaml` (`stamusctl compose down/up` падал с «stat … no such file or directory»), а ручное восстановление из шаблона 3.3.x упиралось в «refers to undefined network network» — в шаблонах stamusctl-templates 3.3.x секция `networks` не определена. Скрипт и хаб защищены от обоих сбоев.

- `clearndr-update.sh`: **бэкап-гейт каталога `config/`** — обновление прерывается, если compose-файл исчезает до/после шагов;
- **`clearndr-repair-stack.sh`** (новый): поиск инстансов без compose-файла, восстановление из `config.failed-*`/архивов/ручного `config/config/`, автопатч сетей (`external: true` по факту), валидация `docker compose config`, подъём стека и health-check opensearch;
- **локальный режим обновления** — запуск из контейнера хаба.

> ⚠️ В сборке образа этого релиза есть дефект: `clearndr-repair-stack.sh` не попал в коммит, Dockerfile ссылался на него — пересборка падала. Исправлено в v1.12.0 (gitignore-вайтлист) и v1.13.1 (.dockerignore).
EOF

# ── v1.12.0 ──────────────────────────────────────────────────────────────────
cat > "$T/v1.12.0.md" <<'EOF'
## Восстановление repair-скрипта и события-стека (пустой OpenSearch Dashboards)

В v1.11.0 `scripts/clearndr-repair-stack.sh` не попал в коммит — `.gitignore` игнорировал весь каталог `/scripts`, а `git add` молча пропустил файл; Dockerfile ссылался на него (сборка образа v1.11.0 сломана).

- `.gitignore`: игнор только `/scripts/*` с явными исключениями (`!`) для поставляемых в образе скриптов;
- **`clearndr-repair-stack.sh` восстановлен** (полный функционал v1.11.0);
- **`clearndr-events-restore.sh`** — восстановление пустого OpenSearch Dashboards: диагностика (данные в logstash-* vs паттерны/дашборды в `.kibana`), лестница fix;
- `clearndr-update.sh` v2: лестница fix при HTTP 400 `kibana_reset` — удаление/пересоздание индексов `.kibana_1`/`.kibana_2` (алиас `.kibana`), прямая REST-загрузка 522 дашборд-объектов из `config-scirius-*:/opt/kibana7-dashboards/dashboards`, создание индекс-паттерна через API, `defaultIndex`.
EOF

# ── v1.13.0 ──────────────────────────────────────────────────────────────────
cat > "$T/v1.13.0.md" <<'EOF'
## Реконструкция compose из контейнеров; фикс пустого OSD 3.x (Workspaces)

### Root cause «пустого» Dashboards (OSD 3.x)
В OpenSearch Dashboards 3.x включённая функция **Workspaces** (`workspace.enabled: true`) скрывает объекты, залитые в `.kibana` напрямую, — подтверждено [opensearch-project/OpenSearch-Dashboards#10890](https://github.com/opensearch-project/OpenSearch-Dashboards/issues/10890). Объекты физически на месте (522), но не видны в UI.

- **`clearndr-osd3-workspaces-fix.sh`** (новый): диагностика (версия OSD, статус workspaces по конфигу — авторитетно, без API-зондов) и фикс: правка bind-файла `opensearch_dashboards.yml` (`workspace.enabled: false` с комментарием про #10890), `docker restart`, ожидание health, **автооткат** при неуспехе; запасной путь — пересоздание контейнера из `docker inspect` (аргументы собираются роботом с guard-ами на пустые значения);
- `clearndr-events-restore.sh` v2: лестница fix при 400 `kibana_reset`;
- **`clearndr-repair-stack.sh`: источник (d) — реконструкция `docker-compose.yaml` из `docker inspect` работающих контейнеров** (образы, env, порты, монтирования, healthcheck, сеть, labels, depends_on), восстановление отсутствующих bind-файлов с хоста через `docker exec cat` (events-stack);
- mock-стенд: сценарии A13/A14 + части B — **93/93 PASS**.
EOF

# ── v1.13.1 ──────────────────────────────────────────────────────────────────
cat > "$T/v1.13.1.md" <<'EOF'
## Фикс сборки образа хаба

- **`.dockerignore`**: `clearndr-events-restore.sh` добавлен в вайтлист — каталог `scripts` исключался целиком, а разблокированы были только два скрипта, поэтому `COPY scripts/clearndr-events-restore.sh` падал с `failed to compute cache key: … not found` (runtime 12/14);
- `package.json`: 1.13.0 → 1.13.1.

> Симптом у пользователей v1.13.0: пересборка образа хаба обрывается на этапе `[runtime 12/14] COPY scripts/clearndr-events-restore.sh`. После `git pull` сборка проходит.
EOF

ok=0; fail=0
for spec in \
  "v1.10.0|v1.10.0 — Обновление Clear NDR из UI (скрипт обновления + вкладка хаба)" \
  "v1.11.0|v1.11.0 — Защита config/, repair-скрипт, локальный режим обновления" \
  "v1.12.0|v1.12.0 — Восстановлен repair-скрипт; лестница восстановления пустого Dashboards" \
  "v1.13.0|v1.13.0 — Реконструкция compose из контейнеров; фикс пустого OSD 3.x (Workspaces)" \
  "v1.13.1|v1.13.1 — Фикс сборки образа хаба (.dockerignore)" \
; do
  tag="${spec%%|*}"; name="${spec#*|}"
  echo "== $tag"
  if create_release "$tag" "$name" "$T/$tag.md"; then ok=$((ok+1)); else fail=$((fail+1)); fi
done

echo "== Проверка: все релизы на GitHub:"
api "https://api.github.com/repos/$REPO/releases?per_page=20" | python3 -c "
import json,sys
for r in sorted(json.load(sys.stdin), key=lambda x: x['tag_name']):
    print(' %-9s %s' % (r['tag_name'], r['html_url']))
"
echo "== итог: ok=$ok fail=$fail"
[ "$fail" -eq 0 ]
