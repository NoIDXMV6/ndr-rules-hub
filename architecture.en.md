<p align="center">
  <img src="public/logo.svg" width="80" alt="NDR Rules Hub logo">
</p>

# NDR Rules Hub Architecture

**Русская версия → [architecture.md](architecture.md)** · README: [README.md](README.md) · [README.en.md](README.en.md)

This document describes how the system is built: components, the data model, the rule
processing pipeline, fetching mechanics, deduplication and export, the VPN layer, the UI and
localization.

---

## 1. Overview and purpose

**NDR Rules Hub** is a companion service for the **Clear NDR** NDR platform (Stamus Networks,
Suricata-based). Its mission: automate the full cycle of working with Snort/Suricata rulesets —
from sources to a final file ready for import into Clear NDR.

Key problems it solves:

- **scattered sources** — official Talos rulesets (snort.org), ET Open, PT Attack Detection,
  Quadrant, OISF, abuse.ch feeds and dozens of indicator-list converters live at different URLs,
  with different authentication and rate limits;
- **duplicates and SID conflicts** — the main cause of failed Clear NDR imports
  (“conflicting sid”);
- **Snort → Suricata incompatibility** — Snort 3 syntax (sticky buffers, `soid`, `file`,
  inline modifiers) breaks loading in Suricata;
- **manual labor** — without the service, rule updates mean manual downloads, conversion and
  checking on a schedule.

Reliability principle: **an unvalidated ruleset cannot reach Clear NDR** — the final file is
run through the real Suricata engine (`suricata -T`), and export is blocked until zero errors.

## 2. Component diagram

```
┌────────────────────────────── Docker container (standalone) ─────────────────────────────┐
│                                                                                          │
│  Browser ──HTTP 3080──► Next.js 16 (single server, output: standalone)                   │
│                          │                                                               │
│                          ├─ src/app/page.tsx + src/components/hub/*  — Web UI (RSC+client)│
│                          ├─ src/app/api/*        — REST route handlers                  │
│                          │                                                               │
│                          ├─ src/lib/i18n/*        — RU/EN dictionaries, language detect  │
│                          │                                                               │
│                          └─ src/lib/engine/*      — domain engine                        │
│                              ├─ fetcher.ts      source fetching (http/tarball/local)     │
│                              ├─ parser.ts       Snort2/3/Suricata rule parser            │
│                              ├─ convert.ts      IP/domain/URL lists → rules              │
│                              ├─ sidmap.ts       private SID ranges                       │
│                              ├─ build.ts        merge + dedup + renumbering              │
│                              ├─ exporter.ts     file / HTTP push / directory             │
│                              ├─ vpn.ts          wg-quick: up/down/status/checks          │
│                              ├─ service.ts      orchestration, cron (node-cron), seed    │
│                              └─ seed.ts         catalog of 25 preconfigured sources      │
│                          │                                                               │
│                          └─ Prisma ORM ──► SQLite (WAL) — data/hub.db                    │
│                                                                                          │
│  wireguard-tools, iptables, iproute2, procps (sysctl) — system layer                     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
        │ volume ./data (/app/data)
        ▼
   DB, archive cache, final files (data/exports), WireGuard configs
```

There is a single server: Next.js serves both the UI and the API. No separate “backend”
exists — if the page opened, the API is reachable. Data survives container recreation via the
`./data` volume.

## 3. Data model (Prisma / SQLite)

Schema — `prisma/schema.prisma`. The client is generated with `binaryTargets = ["native",
"debian-openssl-3.0.x"]` (builder `oven/bun` ≠ runtime `node:22-bookworm-slim`).

| Model | Purpose | Key fields |
|---|---|---|
| `Source` | rule source | `category` (ruleset / ip-list / domain-list / url-list), `kind` (url / tarball / local), `authType` (none / oinkcode / authkey / basic), `extraJson` (converter/auth parameters), `priority` (lower = more important), `status`, `badge`, `builtin` |
| `Rule` | a rule of a specific source | `sid`, `rev`, `action`, `proto`, `msg`, `raw`, `contentHash` (canonical SHA-1 without sid/rev/msg/metadata), `suricataOk`, `compatNotes`; unique `[sourceId, sid]` |
| `Build` | build result | `statsJson` (per-source/duplicate statistics), `policyJson` (applied policies), `fileName`, `sha256`, `sizeBytes`, `source` (manual / cron) |
| `Setting` | settings (k-v) | oinkcode, dedup strategies, privateSidStart, cron, export parameters |
| `LogEntry` | event log | `level` (ok/warn/error/success), `scope`, `message` |
| `VpnProfile` | stored wg-quick config | `name`, `config`, `active`, `lastStatusJson` |

DB reliability: **WAL mode** (against “Socket timeout” under parallel requests) and automatic
schema recovery: the entrypoint compares the version stamp (`/app/data/.schema-version`) with
the sample from the image; on mismatch the old database is backed up to `data/hub.db.bak-<date>`
and a new one is created. The stamp is computed from models only, so generator edits do not
recreate the DB.

## 4. Rule processing pipeline

```
Sources ─► fetch ─► parse ─► convert ─► merge/dedup ─► build ─► validate ─► export
   │         │        │         │           │            │          │           │
   │      fetcher  parser   convert.ts   build.ts     build.ts  scripts/   exporter.ts
   │                         ▲                      ▲        (suricata -T)
   │                         └─ indicator lists ───└─ SID conflicts
   ▼
 data/cache (tar.gz), data/archives (local)
```

Steps:

1. **Fetching (`fetcher.ts`)** — by `kind`: HTTP(S) URL, tar.gz archive (download → magic-byte
   check → `tar -xzf` → collect all `.rules`), local path/directory.
2. **Parsing (`parser.ts`)** — rule header and options parsed into a structure (SID, rev, msg,
   classtype, proto, direction), multiline rules and pcre with braces supported.
3. **List conversion (`convert.ts`, `sidmap.ts`)** — IP/CIDR in chunks of N addresses per SID,
   domains → DNS rules, URLs → HTTP rules; SIDs from the private range (`privateSidStart`,
   standard 1,000,000–1,999,999); `perRule`/`maxRules` guards.
4. **Deduplication and build (`build.ts`)** — removal of duplicates by SID and content, SID
   conflict resolution, optional renumbering; compatibility filter.
5. **Validation** — the `scripts/s2x_convert.py` converter + the `suricata -T` loop (for the
   offline `dist/` package; the online build applies the static compatibility filter).
6. **Export (`exporter.ts`)** — three modes: file for manual import, HTTP POST to Clear NDR
   (with a Bearer token), copy to a directory (shared volume).

## 5. Fetching: snort.org authentication and limits

`fetcher.ts` supports `authType`: `none`, `oinkcode`, `authkey` (query parameter), `basic`
(login/password in `extraJson`).

snort.org behavior verified in practice:

- the canonical auth form is a path segment, not a query:
  `https://www.snort.org/reg-rules/<file>.tar.gz/<oinkcode>` → redirect to the real file;
- personal-cabinet links `snort.org/downloads/registered/<file>.tar.gz?oinkcode=…`
  **ignore the query** and return HTTP 200 + an HTML page;
- `applyAuth()` automatically normalizes all known forms to the canonical one
  (`downloads/registered|subscribed/…` → `reg-rules/<file>/<oinkcode>`);
- **gzip magic bytes** (`1f 8b`) are checked before writing to disk: HTML is no longer stored as
  an archive and does not break tar (“not in gzip format”); on a bad response a previously
  downloaded archive (cache) is used, marked with `cacheNote`;
- limits: registered — no more than once every 15 minutes; `cacheTtlMinutes` in `extraJson`
  prevents re-downloading; `422` = Invalid oinkcode, `403`/`429` = rate limit; the oinkcode
  appears in error messages only as a fingerprint (`abcd…ef01`), the full code is never logged.

## 6. Deduplication and SID strategies

| Policy | What it does |
|---|---|
| `dedupSidStrategy = highest-rev` | on an SID conflict the rule with the highest `rev` is kept (default) |
| `dedupSidStrategy = source-priority` | the source with the lower `priority` number wins |
| `dedupSidStrategy = renumber-private` | conflicting SIDs are moved into the private range |
| `dedupContent = true` | removes rules with the same `contentHash` (canonical SHA-1 without sid/rev/msg/metadata) but different SIDs |
| `dropIncompatible = true` | excludes Suricata-incompatible constructs from the build (preproc, keystore, replace, rawbytes…) |
| `dropDisabledMsg = true` | removes DELETED/DISABLED stubs |

Statistics for every step (per source: fetched/in build/dropped by SID/by content/incompatible)
are written to `Build.statsJson` and shown in the “Build & Export” tab.

## 7. WireGuard VPN layer

`vpn.ts` manages the tunnel inside the container:

- editing and storing wg-quick profiles (DB + `WG_CONFIG_DIR`);
- syntax check (`wg-quick strip`), up/down, status via `wg show` (peers, handshake, traffic);
- environment checks: `wg`, `wg-quick`, `/dev/net/tun`, `NET_ADMIN`, `sysctl`, writing
  `src_valid_mark` — cards with three states (“available / unavailable / no data”);
- **full-tunnel does not kill the web UI**: when a config with `AllowedIPs = 0.0.0.0/0` comes up,
  a policy rule is added — `ip rule add from <container IP> lookup main priority 100`
  (web-server replies go via eth0, the rest of the traffic — via the tunnel); the rule is
  removed on tunnel down;
- `wg-quick` in the image is patched as in upstream (`ac74ed6`): `src_valid_mark` is written
  only if the value is not already 1 (read-only `/proc/sys`).

## 8. Web UI

A single-page application (Next.js App Router, client components) with 9 tabs:

| Tab | Contents |
|---|---|
| Overview | stat cards (sources, rules, latest build, VPN), recent events |
| Sources | catalog of 25 sources + custom ones, enable toggles, fetch one/all, add/edit dialogs, snort.org archive analysis |
| Rules | rule database with search by SID/msg/source and pagination |
| Build & Export | build, per-source statistics, files in the export directory |
| WireGuard VPN | environment check, config editor, profiles, active interfaces |
| Settings | oinkcode, dedup policies, export, cron |
| Logs | all engine events |
| Help | goals/objectives, pipeline, limits, troubleshooting — accordions |
| About | developer, project, acknowledgements, technologies with logos, logo — accordions |

Components — shadcn/ui (Radix primitives) + Tailwind CSS; icons — Lucide; technology logos —
inline SVG from simple-icons (`tech-logos.tsx`, CC0).

## 9. Localization (RU/EN)

The layer lives in `src/lib/i18n/`:

```
detect.ts    Lang ('ru'|'en'), detectLang(browserStrings, stored), tr(), localeOf()
ru.ts        canonical dictionary (≈180 string values), export type Dictionary = typeof ru
en.ts        English dictionary typed as Dictionary → tsc prevents key drift
index.tsx    I18nProvider (useSyncExternalStore over localStorage) + useI18n()
```

Mechanics:

1. **SSR and hydration** always render Russian (`<html lang="ru">`).
2. After mount, `useSyncExternalStore` reads the snapshot: the stored choice
   (`localStorage['ndrh.lang']`) takes priority over the browser strings `navigator.languages`
   (the first supported language: `ru*` → ru, `en*` → en; otherwise `ru`).
3. The **RU/EN switch** in the header calls `setLang()` → snapshot update, listeners,
   `localStorage`, `<html lang>` and `document.title`.
4. Templates with variables — `{n}` placeholders + `tr()`; rich text (the “Help” and “About”
   accordions) — per-lang content with lightweight `**bold**`/`` `code` `` markup (the `Rich`
   component).
5. Size units (`fmtSize`: Б/КБ/МБ ↔ B/KB/MB) and date formats (`localeOf`: `ru-RU` / `en-US`)
   are localized too. Engine messages in the log stay Russian — they are operational data.
6. Language parity is enforced by tests: equal key sets, no empty values, matching
   placeholders, no Cyrillic in EN.

## 10. REST API

| Method/path | Purpose |
|---|---|
| `GET /api/health` | self-diagnostics (DB, schema, files), always 200 |
| `GET /api/dashboard` | summary for the UI |
| `GET/POST /api/sources`, `PATCH/DELETE /api/sources/:id` | source management |
| `POST /api/sources/:id/fetch`, `POST /api/fetch-all` | rule fetching |
| `POST /api/build` | build (`{"export": true}` — with export) |
| `GET/POST/PUT /api/export` | download / push / list files |
| `GET /api/rules` | rule database (sid, q, sourceId, page) |
| `GET/PUT /api/settings` | settings |
| `GET/POST/PUT/DELETE /api/vpn` | WireGuard: status, actions, profiles |
| `GET /api/logs` | log |

API errors are returned as `{"error": "…"}` with the real cause (not an opaque HTTP 500) and
duplicated into container logs.

## 11. Delivery and operations

- **Dockerfile** — multi-stage build: builder (`oven/bun`) → standalone runtime
  (`node:22-bookworm-slim`) + `wireguard-tools`, `iptables`, `iproute2`, `openresolv`, `procps`.
  `outputFileTracingIncludes` guarantees Prisma engines land in the standalone bundle.
- **docker-compose.yml** — `cap_add: NET_ADMIN`, the `/dev/net/tun` device, sysctls
  (`ip_forward`, `src_valid_mark`), volume `./data:/app/data`, port 3080→3000.
- **Orchestration** — `service.ts`: cron (node-cron, `TZ`) runs “update sources → build →
  export”; the same cycle is available via the “Full cycle” button.
- **Tests** — vitest, 84 tests: parser, converters, deduplication, fetcher (including
  magic bytes and cache), wg-quick, i18n.
