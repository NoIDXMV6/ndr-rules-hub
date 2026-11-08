<p align="center">
  <img src="public/logo.svg" width="80" alt="NDR Rules Hub logo">
</p>

# NDR Rules Hub Architecture

**Русская версия → [architecture.md](architecture.md)** · README: [README.md](README.md) · [README.en.md](README.en.md)

This document describes how the system is built: components, the data model, the rule
processing and quality pipelines, fetching mechanics, deduplication and export, the Clear NDR
integration, the VPN layer, the UI and localization.

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

Delivery of the final set to Clear NDR is automated too: **PULL** (Clear NDR fetches the file
from the Hub on a schedule) or **PUSH** (the Hub sends it itself via the Scirius REST API with
a token). Step-by-step guide — [docs/clearndr-integration.en.md](docs/clearndr-integration.en.md),
integration architecture — section 12.

## 2. Component diagram

```mermaid
flowchart TB
    Browser["Browser<br/>Web UI · 9 tabs · RU/EN"]

    subgraph DOCKER["Docker container (standalone)"]
        subgraph NEXTJS["Next.js 16 — single server: UI + REST API · port 3080 → 3000"]
            UI["Web UI<br/>app/page.tsx · components/hub"]
            API["REST API<br/>app/api — route handlers"]
            I18N["i18n<br/>lib/i18n — RU/EN dictionaries,<br/>language detection, header switcher"]
            subgraph ENGINE["Domain engine — lib/engine"]
                direction LR
                FETCHER["fetcher.ts<br/>source fetching<br/>http · tarball · local"]
                PARSER["parser.ts<br/>rule parsing<br/>Snort 2/3 · Suricata"]
                CONVERT["convert.ts · sidmap.ts<br/>lists → rules,<br/>private SID ranges"]
                BUILDER["build.ts<br/>merge · dedup · SID remap"]
                EXPORTER["exporter.ts<br/>file · Clear NDR REST ·<br/>HTTP POST · directory"]
                VPN["vpn.ts<br/>wg-quick up/down/status"]
                SERVICE["service.ts<br/>orchestration · cron · seed"]
                SEED["seed.ts<br/>25 preconfigured sources"]
            end
        end
        PRISMA[("Prisma ORM")]
        SYSLAYER["System layer<br/>wireguard-tools · iptables ·<br/>iproute2 · procps (sysctl)"]
    end

    subgraph EXT["External systems"]
        SOURCES["Rule sources<br/>snort.org · ET Open ·<br/>PT Attack Detection · abuse.ch …"]
        CLEARNDR["Clear NDR<br/>Suricata-based NDR platform"]
    end

    DB[("SQLite (WAL)<br/>data/hub.db")]
    VOLUME[("Volume ./data → /app/data<br/>DB · archive cache · data/exports ·<br/>sidmap.json · wg configs")]

    Browser -- "HTTP :3080" --> UI
    UI -- "fetch JSON" --> API
    UI -.- I18N
    API --> SERVICE
    FETCHER -- "applyAuth + gzip magic bytes" --> SOURCES
    EXPORTER -- "final .rules<br/>REST API / file / directory" --> CLEARNDR
    VPN --> SYSLAYER
    SERVICE --> PRISMA
    PRISMA --> DB
    DB -.- VOLUME

    classDef ui fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a
    classDef engine fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef ext fill:#fef9c3,stroke:#ca8a04,color:#713f12
    classDef store fill:#f3e8ff,stroke:#9333ea,color:#581c87
    classDef sys fill:#f1f5f9,stroke:#64748b,color:#0f172a
    class UI,API,I18N ui
    class FETCHER,PARSER,CONVERT,BUILDER,EXPORTER,VPN,SERVICE,SEED engine
    class SOURCES,CLEARNDR ext
    class DB,VOLUME,PRISMA store
    class SYSLAYER sys
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

```mermaid
flowchart LR
    subgraph SRC["Sources — 25 preconfigured + your own"]
        direction TB
        SRC1["ruleset / tarball<br/>snort.org · ET Open ·<br/>PT AD · abuse.ch"]
        SRC2["local files<br/>and directories"]
        SRC3["indicator lists<br/>ip · domain · url"]
    end

    subgraph FETCH["Fetching — fetcher.ts"]
        direction TB
        AUTH["applyAuth():<br/>oinkcode → reg-rules/file/code,<br/>authkey · basic"]
        CHECK{"HTTP 200<br/>and gzip 1f 8b?"}
        CACHE[("archive cache<br/>data/cache<br/>cacheTtlMinutes")]
    end

    PARSE["Parsing — parser.ts<br/>header + options, multiline,<br/>pcre with braces"]
    CONV["Conversion — convert.ts · sidmap.ts<br/>IP chunks · domains · URLs,<br/>private SID range, guards"]

    RULES[("Prisma · Rule — per source<br/>sid · rev · raw · contentHash<br/>suricataOk · compatNotes")]

    subgraph BUILD["Build — build.ts · service.ts"]
        direction TB
        MERGE["mergeSources(): SID conflict →<br/>highest-rev / source-priority /<br/>renumber-private · dropIncompatible"]
        CONTENT["content dedup: SHA-1<br/>without sid/rev/msg/metadata/reference"]
        REMAP["remapToClearndrBlock():<br/>SID → free block 1e9+,<br/>shared sidmap.json map"]
        GATE{"Clear NDR gate:<br/>conflicting twins?"}
    end

    FINAL["renderFinalFile():<br/>clearndr-import.rules,<br/>sha256 + Build record"]
    VALID["Validation: static compatibility<br/>filter (suricataOk);<br/>offline package — suricata -T loop"]
    EXPORT["Export — exporter.ts<br/>file · Clear NDR REST (Token) ·<br/>HTTP POST · volume directory"]
    CRON["cron — node-cron<br/>fetch → build → export"]
    LOG["LogEntry: error —<br/>build aborted"]

    SRC1 --> AUTH
    SRC2 --> AUTH
    SRC3 --> AUTH
    AUTH --> CHECK
    CHECK -- "yes: rule text" --> PARSE
    CHECK -- "yes: ip/domain/url list" --> CONV
    CHECK -- "no: HTML, rate limit, error" --> CACHE
    CACHE -- "fallback: previously downloaded archive" --> PARSE
    PARSE --> RULES
    CONV --> RULES
    RULES --> MERGE
    MERGE --> CONTENT
    CONTENT --> REMAP
    REMAP --> GATE
    GATE -- "no: 0 twins" --> FINAL
    GATE -- "yes" --> LOG
    FINAL --> VALID
    VALID --> EXPORT
    CRON -.-> FETCH
    CRON -.-> BUILD
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
6. **Export (`exporter.ts`)** — five modes: file for manual import; **Clear NDR REST** — native
   integration (find/create the source → multipart upload → `update_push_all`,
   `Authorization: Token`); HTTP POST to any endpoint (Token/Bearer); copy to a directory
   (shared volume); disabled. Details — section 12.

## 5. Rules quality pipeline

The system principle: **an unvalidated ruleset cannot reach Clear NDR**. Quality is enforced
by five gates — each one blocks defective material at its own stage.

```mermaid
flowchart TD
    subgraph G1["Gate 1 — Fetching · fetcher.ts"]
        direction TB
        A1{"HTTP 200?"}
        A2{"body = gzip 1f 8b?"}
        A3[("archive cache<br/>+ cacheNote to the log")]
        A1 -- "no" --> A3
        A2 -- "no: HTML page of a rate limit<br/>or personal cabinet" --> A3
        A1 -- "yes" --> A2
    end

    subgraph G2["Gate 2 — Parsing and compatibility · parser.ts"]
        direction TB
        B1{"line = a rule<br/>(header + options)?"}
        B2{"checkSuricataCompat():<br/>preproc · react · resp · rawbytes ·<br/>asn1 · dce_* · activate/dynamic ·<br/>Snort 3 sticky buffers?"}
        BN["suricataOk = false<br/>compatNotes"]
        B1 -- "yes" --> B2
        B2 -- "incompatible" --> BN
    end

    subgraph G3["Gate 3 — Storage · service.ts"]
        direction TB
        C1["in-source SID dedup —<br/>the highest rev is kept"]
        C2["contentHash: canonical SHA-1<br/>without sid/rev/msg/metadata/reference"]
        C1 --> C2
    end

    subgraph G4["Gate 4 — Build · build.ts"]
        direction TB
        D1["policies: dropDisabledMsg ·<br/>dropIncompatible · content dedup"]
        D2["SID conflict → strategy:<br/>highest-rev / source-priority /<br/>renumber-private"]
        D3["remap to the free clearndr block<br/>1,000,000,000+ — sidmap.json map,<br/>md5 formula shared with the python pipeline"]
        D4{"conflicting twins — rules matching<br/>after removing sid and reference:*?"}
        D1 --> D2
        D2 --> D3
        D3 --> D4
    end

    G5{"Gate 5 — Engine validation<br/>suricata -T · offline dist/ package<br/>loop: log parsing →<br/>exclude/fix → repeat"}
    FAIL["BUILD ABORTED — the file is not written,<br/>LogEntry: error"]
    OK["final file: 0 duplicates,<br/>0 SID conflicts, 0 Suricata errors<br/>+ sha256 and stats in Build"]
    EXPORT["export to Clear NDR allowed"]

    G1 --> G2
    G2 --> G3
    G3 --> G4
    D4 -- "yes" --> FAIL
    D4 -- "no" --> G5
    G5 -- "0 errors" --> OK
    OK --> EXPORT
```

What each gate does:

1. **Fetching** — a bad response is never stored as an archive: gzip magic bytes are checked
   before writing to disk (a rate-limit HTML page no longer breaks tar “not in gzip format”);
   on failure the run continues from a previously downloaded cache, explicitly noted in the log.
2. **Parsing and compatibility** — a rule is parsed only if the line matches the header pattern;
   Suricata-incompatible constructs are marked `suricataOk = false` with reasons listed in
   `compatNotes` (never silently dropped).
3. **Storage** — only the highest `rev` of each SID survives within a source; content is
   canonicalized (SHA-1 without sid/rev/msg/metadata/reference) for later content dedup.
4. **Build** — policies from settings, SID conflict resolution by strategy, SID move to the free
   clearndr block; the **conflicting-twins gate**: pairs matching after removing `sid` and
   `reference:*` break the Clear NDR import (“conflicting SID in same source”), so if any remain
   the whole build fails — a bad file is never written.
5. **Engine validation** — the offline `dist/` package runs the `suricata -T` loop → log parsing
   → exclude/fix broken rules → repeat **until zero errors**; the online build applies the static
   compatibility filter. Export is only possible from a set that passed the gates.

## 6. Fetching: snort.org authentication and limits

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

## 7. Deduplication and SID strategies

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

## 8. WireGuard VPN layer

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

### Up and down sequences

Tunnel up — `POST /api/vpn {"action": "up", "id" | "config"}`:

```mermaid
sequenceDiagram
    autonumber
    participant U as Web UI — VPN tab
    participant R as Route — POST /api/vpn
    participant V as vpn.ts
    participant X as Container — wg-quick, ip
    participant D as Prisma — VpnProfile

    U->>R: action up — profile id or config
    R->>D: findUnique id — 404 if missing
    R->>R: parseWgConfig — [Interface] and [Peer] sections, PrivateKey
    R->>V: wgUp iface, config
    opt full-tunnel — AllowedIPs contains 0.0.0.0/0
        V->>X: ip route/addr show — container addresses before the tunnel is up
    end
    V->>X: write /etc/wireguard/iface.conf — chmod 0600
    V->>X: wg-quick down iface — clean up a half-raised interface
    V->>X: wg-quick up iface.conf
    alt resolvconf unavailable and the config has DNS=
        V->>V: stripDnsLines — remove DNS lines
        V->>X: wg-quick up iface.conf — retry
    end
    opt interface is up and this is full-tunnel
        V->>X: ip rule del + add — from container address lookup main prio 100
        Note over U,X: web UI responses go via eth0 — the interface does not kill the UI on full-tunnel
    end
    V->>X: wg show interfaces — is iface listed?
    V-->>R: ok, notes, output
    R->>D: persistProfileStatus — active, lastStatusJson
    R-->>U: 200 — ok true, detail, notes
```

Tunnel down — `POST /api/vpn {"action": "down"}`:

```mermaid
sequenceDiagram
    autonumber
    participant U as Web UI — VPN tab
    participant R as Route — POST /api/vpn
    participant V as vpn.ts
    participant X as Container — wg-quick, ip
    participant D as Prisma — VpnProfile

    U->>R: action down — name or id
    R->>V: wgDown name
    V->>X: wg-quick down iface.conf
    V->>X: ip -4 and -6 rule show
    V->>X: ip rule del — from address lookup main prio 100 — our exclusions
    alt wg-quick failed and the interface is already gone
        V-->>R: ok true — "the interface was already down"
    else wg-quick failed but the interface is alive
        V->>X: ip link del iface
        V-->>R: ok true with a note
    end
    R->>D: persistProfileStatus — active false, lastStatusJson
    R-->>U: 200 — ok true, notes
```

## 9. Web UI

A single-page application (Next.js App Router, client components) with 9 tabs:

| Tab | Contents |
|---|---|
| Overview | stat cards (sources, rules, latest build, VPN), recent events |
| Sources | catalog of 25 sources + custom ones, enable toggles, fetch one/all, add/edit dialogs, snort.org archive analysis |
| Rules | rule database with search by SID/msg/source and pagination |
| Build & Export | build, per-source statistics, files in the export directory |
| WireGuard VPN | environment check, config editor, profiles, active interfaces |
| Settings | oinkcode, dedup policies, export (mode, URL, token, source), cron |
| Logs | all engine events |
| Help | goals/objectives, pipeline, limits, troubleshooting — accordions |
| About | developer, project, acknowledgements, technologies with logos, logo — accordions |

Components — shadcn/ui (Radix primitives) + Tailwind CSS; icons — Lucide; technology logos —
inline SVG from simple-icons (`tech-logos.tsx`, CC0).

## 10. Localization (RU/EN)

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

## 11. REST API

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

### Request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser — hub/api.ts
    participant H as Route handler — app/api
    participant E as Engine — lib/engine
    participant D as Prisma ORM
    participant S as SQLite WAL

    B->>H: fetch — method and JSON body
    H->>H: body and parameter parsing — route handler, no middleware
    alt invalid request — no id, config or action
        H-->>B: 400 — JSON with the cause
    else valid request
        H->>E: domain operation — fetchSourceById, buildFinal, wgUp, setSetting
        E->>D: model reads and writes
        D->>S: SQL — WAL mode against Socket timeout
        S-->>D: rows
        D-->>E: typed records
        E->>D: LogEntry — log level, scope, message
        E-->>H: result or domain error
    end
    alt success
        H-->>B: 200 — NextResponse.json
    else unhandled exception
        H->>H: apiError — the cause on one line
        H-->>B: 500 — {"error": real cause} + a line in docker logs
    end
    B->>B: card refresh or error banner
```

## 12. Clear NDR integration: rule delivery

The final ruleset reaches Clear NDR in one of four ways: download the file and import it
manually; **PULL** — Clear NDR fetches the file from the Hub itself; **PUSH** — the Hub sends
it itself through the Scirius REST API; HTTP POST to an arbitrary endpoint or copying to a
shared directory. The step-by-step guide with commands, the token and a deployment checklist —
[docs/clearndr-integration.en.md](docs/clearndr-integration.en.md) (RU:
[docs/clearndr-integration.md](docs/clearndr-integration.md)).

### 12.1 Two delivery schemes

```mermaid
flowchart TB
    subgraph HUB["NDR Rules Hub — Next.js :3080"]
        direction TB
        BLD["Build<br/>clearndr-import.rules + sha256"]
        CRON["Hub cron — Settings → Schedule<br/>fetch → build → export"]
        REST["exporter.ts — “Clear NDR REST” mode<br/>the “Export to Clear NDR” button<br/>or the cron step (cronExport)"]
        PULLAPI["GET /api/export<br/>latest build over HTTP"]
        BLD --> REST
        BLD --> PULLAPI
        CRON -.-> BLD
    end

    subgraph CNDR["Clear NDR (Scirius)"]
        direction TB
        SRC["Source “NDR Rules Hub”<br/>PUSH: method local · PULL: method http"]
        RS["Ruleset + enabled category"]
        UPALL["update_push_all<br/>update → generate → push"]
        SUR["Suricata 7 — ruleset in production"]
        SRC --> RS
        RS --> UPALL
        UPALL --> SUR
    end

    REST -- "Scheme B: PUSH — the Hub sends it<br/>find-or-create → upload → update_push_all<br/>Authorization: Token" --> SRC
    PULLAPI -- "Scheme A: PULL — Clear NDR fetches the file<br/>URL source + Recurrence / cron" --> SRC

    classDef engine fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef ext fill:#fef9c3,stroke:#ca8a04,color:#713f12
    class BLD,CRON,REST,PULLAPI engine
    class SRC,RS,UPALL,SUR ext
```

| | Scheme A: PULL | Scheme B: PUSH |
|---|---|---|
| Who initiates | Clear NDR fetches the file from the Hub | The Hub pushes the file to Clear NDR |
| Network access | Clear NDR → Hub (:3080, `GET /api/export`) | Hub → Clear NDR (443, `/rest/…`) |
| Configured in Clear NDR | a URL source + ruleset + schedule | nothing — the source is created automatically |
| Configured in the Hub | nothing | “Clear NDR REST” mode, URL, token |
| Auto-update | Clear NDR Recurrence / cron `update_push_all` | Hub cron (`cronExport`) / cron `update_push_all` |

### 12.2 PUSH: the Scirius REST API call chain

The “Clear NDR REST” mode (`exporter.ts → pushToClearndrRest`) performs three steps: find or
create a local source, upload the file (multipart; the rules are imported immediately), apply
the ruleset. Authorization — `Authorization: Token <token>`: the token is obtained in the
Clear NDR web UI (user menu → **Edit Token → Regenerate**); it is 40 hex characters bound to
the account and its permissions (`rules.source_edit`, `rules.ruleset_update_push`). Clear NDR
rejects the `Bearer` format (HTTP 401) — the authorization type is selected in the Hub export
settings.

```mermaid
sequenceDiagram
    autonumber
    participant H as Hub — exporter.ts<br/>“Clear NDR REST” mode
    participant A as Clear NDR — Scirius REST API<br/>/rest/… · Authorization: Token
    participant X as Suricata

    H->>A: GET /rest/rules/source/?name=NDR Rules Hub
    alt source found
        A-->>H: results → source pk
    else source missing
        H->>A: POST /rest/rules/source/ — method local, datatype sig
        A-->>H: 201 → new source pk
    end
    H->>A: POST /rest/rules/source/{pk}/upload/ — multipart clearndr-import.rules
    A->>A: import the rules into the source database
    alt SID conflict in the file
        A-->>H: 400 conflicting SID — Hub: “enable deduplication in the build settings”
    end
    A-->>H: {"upload":"ok"}
    opt “Apply ruleset” flag is on (default)
        H->>A: POST /rest/suricata/update_push_all/
        A->>X: update sources → generate ruleset → push → restart
        A-->>H: {"update_push_all":"ok"}
    end
    H-->>H: log (scope export) — chain steps
```

Settings — the “Settings → Export to Clear NDR” tab: base URL (root only, no `/rest` — it is
appended automatically), authorization type, token (a password field), source name
(“NDR Rules Hub” by default), the “Apply ruleset after upload” flag. Errors come with hints:
401/403 — “token rejected… Edit Token → Regenerate”; “conflicting SID” — “enable deduplication
in the build settings”. Every chain step is visible in the Logs (scope `export`).

### 12.3 PULL: Clear NDR fetches the file itself

In Clear NDR, create a “HTTP URL” source pointing at `GET http://<hub>:3080/api/export` (the
latest build is always served there), attach it to a ruleset, enable the category; the update
is performed by the built-in scheduler (Suricata → Update → Recurrence) or a cron with
`update_push_all`. Automatic setup — the idempotent `scripts/clearndr-setup-pull.sh`:
create the source → ruleset → enable the category → `update_push_all`.

```mermaid
sequenceDiagram
    autonumber
    participant C as Clear NDR — celery scheduler<br/>Suricata → Update → Recurrence
    participant S as Source “NDR Rules Hub”<br/>method http · uri /api/export
    participant H as Hub — GET /api/export
    participant X as Suricata

    C->>S: schedule trigger (e.g. Daily)
    S->>H: GET http://hub-host:3080/api/export
    H-->>S: 200 — clearndr-import.rules
    S->>S: import the rules into the source database
    C->>C: generate ruleset — enabled category
    C->>X: push the file → engine restart
    Note over C,X: the Suricata → Update button does the same immediately, a cron with update_push_all does the same without the UI
```

### 12.4 Auto-update — three independent options

| Option | Where it is configured | What happens on schedule |
|---|---|---|
| a) Clear NDR Recurrence | Clear NDR UI → Suricata → Update → Recurrence (a celery task) | Clear NDR downloads the fresh file from the Hub, imports it, rebuilds the ruleset, restarts Suricata |
| b) cron `update_push_all` | a cron on any server that can reach Clear NDR | `POST /rest/suricata/update_push_all/` — update → generate → push |
| c) Hub cron | Settings → Schedule (`cronEnabled` + `cronExport = true`) | Hub: fetch sources → build → push to Clear NDR (`clearndr` mode) |

Option (c) also works with the PULL scheme: after the cron build the fresh file is already at
`/api/export`, where (a) or (b) picks it up.

### 12.5 Testing without a production server

`scripts/clearndr-mock-server.py` reproduces the Scirius REST API (Token auth, DRF pagination,
multipart upload, the “conflicting SID” gate). End-to-end test: start the mock, set
`http://127.0.0.1:8080` and the token `mock-clearndr-token` in the Hub settings, press
“Export to Clear NDR”, then compare `/_stats` — the file sha256 must match byte for byte.
Helper scripts: `clearndr-check.sh` (token, sources, rulesets check), `clearndr-push.sh`
(push a ready file from cron), `clearndr-setup-pull.sh` (PULL setup). Commands — section 5
of the guide.

## 13. Delivery and operations

- **Dockerfile** — multi-stage build: builder (`oven/bun`) → standalone runtime
  (`node:22-bookworm-slim`) + `wireguard-tools`, `iptables`, `iproute2`, `openresolv`, `procps`.
  `outputFileTracingIncludes` guarantees Prisma engines land in the standalone bundle.
- **docker-compose.yml** — `cap_add: NET_ADMIN`, the `/dev/net/tun` device, sysctls
  (`ip_forward`, `src_valid_mark`), volume `./data:/app/data`, port 3080→3000.
- **Orchestration** — `service.ts`: cron (node-cron, `TZ`) runs “update sources → build →
  export”; the same cycle is available via the “Full cycle” button.
- **Clear NDR integration scripts** — `scripts/clearndr-check.sh` (token, sources, rulesets
  check), `clearndr-setup-pull.sh` (idempotent PULL setup), `clearndr-push.sh` (push a ready
  file, cron-friendly), `clearndr-mock-server.py` (Scirius REST API mock).
- **Clear NDR upgrade** — `scripts/clearndr-update.sh`: upgrades the Clear NDR Community docker
  stack (stamusctl) to a new version while preserving every setting — PostgreSQL dump before
  stopping (`pg_dumpall`), archive of `config/` and the `<project>_db-data` volume, then the
  standard `stamusctl compose update` → `pull` → `up -d`, health checks (containers, web UI,
  REST API with a token) and automatic `config/` rollback on failure. Guide —
  `docs/clearndr-update.en.md`.
- **Tests** — vitest, 84 tests: parser, converters, deduplication, fetcher (including
  magic bytes and cache), wg-quick, i18n.
