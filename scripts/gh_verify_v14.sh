#!/usr/bin/env bash
# Сквозная проверка ассетов релиза v1.4.0 (токен не выводится).
set -euo pipefail
cd /home/z/my-project
REPO=NoIDXMV6/ndr-rules-hub
TAG=v1.4.0

u=$(git config --get remote.origin.url)
creds=${u#*://}; creds=${creds%%@*}
case $creds in *:*) TOKEN=${creds##*:};; *) TOKEN=$creds;; esac
[ -n "$TOKEN" ] || { echo NO_TOKEN_IN_REMOTE; exit 1; }

for NAME in clearndr-rules-20261107-sidfirst.zip clearndr-snort2-import-kit-20261108-v3.zip; do
  curl -sSL -H "Authorization: Bearer $TOKEN" -o "/tmp/$NAME" \
    "https://github.com/$REPO/releases/download/$TAG/$NAME"
  echo "== $NAME"
  sha256sum "/tmp/$NAME" "dist/$NAME" | awk '{print "  " $1 "  " $2}'
done
rm -f /tmp/clearndr-rules-20261107-sidfirst.zip /tmp/clearndr-snort2-import-kit-20261108-v3.zip
