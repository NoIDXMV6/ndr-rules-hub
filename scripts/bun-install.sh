#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# bun-install.sh — устойчивая установка зависимостей на этапе deps (docker build).
#
# История инцидентов (см. README «Если сборка образа висит на bun install»):
#   v1.27.0 — bun install на registry.npmjs.org висел 23196с БЕЗ вывода (сеть
#             хоста сборки: DNS/MTU/троттлинг); сборку прерывал пользователь.
#             Добавлены предохранитель timeout и ручка NPM_REGISTRY.
#   v1.36.1 — зеркало npm-mirror.gitverse.ru ДЕГРАДИРОВАЛО: манифест /next
#             (~31 МБ) отдаётся ~16с (у npmjs — 0.4с), cold install не
#             укладывался в 2700с и молча убивался timeout'ом; bun в non-TTY
#             не печатает прогресс, поэтому «зависание» выглядело как тишина.
#             Один реестр, заданный NPM_REGISTRY, больше не судьба сборки.
#
# Поведение:
#   1) Кандидаты: NPM_REGISTRY (если задан — .env/compose/build-arg, проверяется
#      первым) + дефолтные зеркала registry.npmjs.org → registry.npmmirror.com
#      → npm-mirror.gitverse.ru; дубликаты убираются. Полный список можно
#      заменить: BUN_REGISTRIES="url1 url2 …" (своё зеркало).
#   2) Предпроверка каждого кандидата: полный GET /ms (лёгкий манифест ~90 КБ)
#      с таймаутом 15с, замеряется время ответа. Нет ответа / HTTP != 200 →
#      зеркало исключается (экономия до TIMEOUT секунд на попытку).
#   3) Порядок попыток — по возрастанию времени ответа; зеркала медленнее
#      BUN_SLOW_MS (3000мс) — в конец очереди: быстрый ответ на маленький
#      манифест не спасёт установку из ~900 пакетов на задохнувшемся зеркале.
#   4) Каждая попытка: bun install --frozen-lockfile --registry <зеркало>
#      --verbose (видно, на каком пакете остановились) под предохранителем
#      timeout --kill-after=30 (BUN_INSTALL_TIMEOUT секунд НА ПОПЫТКУ,
#      дефолт 900). Первая удачная попытка завершает шаг; FAIL — только если
#      не сработало ни одно зеркало (с полной диагностикой).
#   5) DRY_RUN=1 — только предпроверка и вывод порядка (без установки);
#      используется тестами tests/bun-install.test.ts.
#
# bun.lock не содержит URL реестра (только имена/версии/integrity-хэши),
# поэтому установка с любого зеркала детерминирована: целостность каждого
# пакета проверяется по хэшам lockfile.
# ─────────────────────────────────────────────────────────────────────────────
set -u

TIMEOUT="${BUN_INSTALL_TIMEOUT:-900}"
SLOW_MS="${BUN_SLOW_MS:-3000}"
PROBE_TIMEOUT_MS=15000
DRY_RUN="${DRY_RUN:-0}"

DEFAULT_REGISTRIES="https://registry.npmjs.org https://registry.npmmirror.com https://npm-mirror.gitverse.ru"

if [ -n "${BUN_REGISTRIES:-}" ]; then
  CANDIDATES="$BUN_REGISTRIES"
else
  CANDIDATES="$DEFAULT_REGISTRIES"
fi

# заданное пользователем зеркало — первым в списке предпроверки; итоговый
# порядок попыток всё равно определяет замер скорости (п. 3)
if [ -n "${NPM_REGISTRY:-}" ]; then
  first="${NPM_REGISTRY%/}"
  rest=""
  for r in $CANDIDATES; do
    r="${r%/}"
    [ "$r" = "$first" ] || rest="$rest $r"
  done
  CANDIDATES="$first $rest"
fi

# предпроверка зеркала: полное время ответа GET /ms в stdout (мс);
# код 1 — зеркало неисправно. bun в образе deps есть гарантированно,
# поэтому проба выполняется самим bun (curl в образ может не входить).
probe() {
  PROBE_URL="$1/ms" PROBE_TIMEOUT_MS="$PROBE_TIMEOUT_MS" bun -e '
const t = Date.now();
fetch(process.env.PROBE_URL, { signal: AbortSignal.timeout(Number(process.env.PROBE_TIMEOUT_MS)) })
  .then(async r => {
    await r.arrayBuffer();
    process.stdout.write(String(Date.now() - t));
    process.exit(r.ok ? 0 : 1);
  })
  .catch(() => process.exit(1));
'
}

echo "[deps] bun install: предохранитель ${TIMEOUT}с/попытку, порог деградации ${SLOW_MS}мс, предпроверка ${PROBE_TIMEOUT_MS}мс"
MEASURED=""
for r in $CANDIDATES; do
  r="${r%/}"
  if ms=$(probe "$r"); then
    MEASURED="$MEASURED
$ms $r"
    echo "[deps]   $r — исправно, ${ms}мс"
  else
    echo "[deps]   $r — нет ответа (HTTP != 200 или таймаут ${PROBE_TIMEOUT_MS}мс) — исключено"
  fi
done

if [ -z "$MEASURED" ]; then
  echo "[deps] FAIL: ни одно из зеркал не отвечает. Проверьте сеть хоста сборки:" >&2
  echo "[deps]   curl -o /dev/null -sS -w 'total %{time_total}s\n' https://registry.npmjs.org/ms" >&2
  echo "[deps]   docker build --network=host .   # на хосте быстро, в сборке висит → DNS/MTU bridge" >&2
  exit 1
fi

# порядок попыток: сначала исправные и быстрые (по возрастанию времени),
# затем деградировавшие (медленнее порога). NF == 2 — строки «мс url»;
# пустые строки (ведущий \n первого замера) отбрасываются.
ORDER=$(printf '%s\n' "$MEASURED" \
  | awk -v slow="$SLOW_MS" 'NF == 2 { g = ($1 <= slow) ? 0 : 1; print g, $1, $2 }' \
  | sort -k1,1n -k2,2n \
  | awk 'NF == 3 { print $3 }')

n=$(printf '%s\n' "$ORDER" | wc -l)
echo "[deps] порядок попыток ($n):"
i=0
for r in $ORDER; do
  i=$((i + 1))
  echo "[deps]   $i. $r"
done

if [ "$DRY_RUN" = "1" ]; then
  echo "[deps] DRY_RUN: установка не выполнялась"
  exit 0
fi

for r in $ORDER; do
  echo "[deps] попытка: bun install --frozen-lockfile --registry $r (таймаут ${TIMEOUT}с)…"
  start=$(date +%s)
  timeout --kill-after=30 "${TIMEOUT}s" \
    bun install --frozen-lockfile --registry "$r" --network-concurrency 16 --verbose
  rc=$?
  end=$(date +%s)
  if [ "$rc" -eq 0 ]; then
    echo "[deps] OK: зависимости установлены с $r за $((end - start))с"
    exit 0
  fi
  case $rc in
    124) echo "[deps] FAIL($r): не уложился в ${TIMEOUT}с — зеркало зависло/крайне медленное; пробую следующее" >&2 ;;
    137) echo "[deps] FAIL($r): убит kill-after — SIGTERM не завершил процесс; пробую следующее" >&2 ;;
    *)   echo "[deps] FAIL($r): код $rc за $((end - start))с; пробую следующее" >&2 ;;
  esac
done

echo "[deps] FAIL: ни одно зеркало не завершило установку. Попытки были:" >&2
for r in $ORDER; do echo "[deps]   - $r" >&2; done
echo "[deps] Диагностика на хосте сборки:" >&2
echo "[deps]   curl -o /dev/null -sS -w 'total %{time_total}s\n' https://registry.npmjs.org/ms" >&2
echo "[deps]   docker build --network=host .   # на хосте быстро, в сборке висит → DNS/MTU bridge" >&2
echo "[deps]   своё зеркало: --build-arg NPM_REGISTRY=… или BUN_REGISTRIES=\"url1 url2 …\"" >&2
exit 1
