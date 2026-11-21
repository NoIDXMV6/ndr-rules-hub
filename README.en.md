<p align="center">
  <img src="public/logo.svg" width="96" alt="NDR Rules Hub logo">
</p>

# NDR Rules Hub

**[Русская документация → README.md](README.md)** · architecture: [architecture.md (rus)](architecture.md) · [architecture.en.md (eng)](architecture.en.md) · Clear NDR integration: [docs/clearndr-integration.md (rus)](docs/clearndr-integration.md) · [docs/clearndr-integration.en.md (eng)](docs/clearndr-integration.en.md)

A management service for **Snort / Suricata** rule sources with a full-featured Web UI, scheduled
automatic downloads, Snort 2/3 → Suricata conversion, deduplication, SID conflict resolution,
**validation of the final ruleset with the real Suricata engine**, and export into **Clear NDR**
(https://docs.clearndr.io). Delivered as a **Docker container**.

> Author and developer — **Pavel Kozhevatov** ([kozhevatov.ru](https://kozhevatov.ru)) ·
> repository: [github.com/NoIDXMV6/ndr-rules-hub](https://github.com/NoIDXMV6/ndr-rules-hub) ·
> acknowledgements to Clear NDR (Stamus Networks) and [mikrocata2selks](https://github.com/angolo40/mikrocata2selks) —
> see the “About” tab in the UI.

![stack](https://img.shields.io/badge/Next.js%2016-TypeScript-blue) ![db](https://img.shields.io/badge/SQLite-Prisma-orange) ![validate](https://img.shields.io/badge/Suricata%207.0.10-validated-brightgreen) ![vpn](https://img.shields.io/badge/WireGuard-integrated-green)

## Features

| Block | What it does |
|---|---|
| **Sources** | Catalog of 36 preconfigured sources (13 original from Clear NDR + 23 new). Add your own by URL/archive/local file. Types: ruleset, tar.gz archive, IP/domain/URL lists (converters). **Trash bin**: delete with rules kept, restore, permanent delete (names of purged built-ins are not re-created by catalog seeding) |
| **Fetching** | HTTP(S) with **oinkcode** support (snort.org, no login/password), auth-key, Basic, **X-Api-Key (RST Cloud)**. snort.org rate-limit handling (403 → a clear message). Local archives and directories |
| **Converters** | IP/CIDR lists → rules (chunks of N addresses per SID), domains → DNS rules, URLs → HTTP rules, SHA-256 → `filesha256` rules (HTTP-response file inspection). SIDs from the 1,100,000+ block |
| **Snort→Suricata converter** | `scripts/s2x_convert.py`: Snort 3 sticky buffers (http_uri…) → dot forms (http.uri…), inline content modifiers → separate keywords, bufferlen → bsize, soid/service removal, variable mapping, file→tcp, ssl→tls. Empirically calibrated on Suricata 7.0.10 |
| **Validator** | Every final ruleset is run through **real Suricata** (`suricata -T`); the “validate → parse log → fix/exclude → repeat” loop continues until 0 errors. **An unvalidated ruleset cannot reach Clear NDR** — export is blocked |
| **Deduplication** | By SID (the strategy picks the winner: highest rev / source priority) and by content (canonical SHA-1 without sid/rev/msg/metadata). SID conflict with **different** detections: the loser's fate is a separate "SID conflict loser" setting — it can be kept under a new deterministic SID (2,000,000,000+ block → remap into the clearndr block) |
| **Compatibility** | Automatic detection of Snort 2 (preproc, react, rawbytes…) and Snort 3 (keystore, pkt_trace…) keywords missing in Suricata, filtered out at build time |
| **Categories** | A section grouping rules of enabled sources by `classtype`; manage categories (on/off in build, rename, hide) and **individual rules** (SID switch survives source re-fetching). Final ruleset = enabled sources ∩ category/rule filter |
| **Build** | A final `suricata.rules` file with a header, per-source statistics and SHA-256. Output option: **tgz archive with one file per source** (import into Clear NDR as a datatype `sigs` source — each file becomes a category) |
| **Clear NDR export** | 1) file for manual import; 2) **native integration via the Clear NDR (Scirius) REST API** — upload + `update_push_all` with a token; 3) pull scheme: Clear NDR fetches the file from the Hub itself (`/api/export`, datatype `sig`; `?archive=1` — per-source tgz for datatype `sigs`; the token goes into the source authkey field or `?token=`) and updates on its own schedule; 4) HTTP POST to any endpoint; 5) copying to a shared directory (volume). Ready-made Uri and token — the “Account” section → “Tokens & access”; step-by-step guide incl. Recurrence — [docs/clearndr-integration.en.md](docs/clearndr-integration.en.md) |
| **DNS filtering (v1.29.0)** | A separate module built “by analogy” with the rules, the **“DNS lists”** menu with a second-level submenu (Sources / Categories / Records / Build & Export): a **catalog of 46 domain lists** (AdGuard HostlistsRegistry, hosts feeds) plus **import of a filtering-database SQL dump** (export.sql/.rar, streaming parse: ~2.2M domains and 151 categories from a 502-MB dump). Records are domains; categories and individual records are managed manually (allowlists, forced block). Duplicates are resolved by source priority. The blocked-domain list is built in 4 formats: plain / hosts / dnsmasq / AdGuard. Download — the `GET /api/dns/export` endpoint: **serving is forbidden without a token** (v1.34.0 — the global dnsServeToken key was removed, tokens are managed in the “Account” section only), **token scope — rules, domains, or both**. Since v1.33.0 the domain list is served as a **full Uri with the token in the address** (`/api/dns/export?token=ndrt_…`) — paste it whole into the URL field of any DNS server that updates blocklists by link (AdGuard Home, Pi-hole, Blocky, dnsmasq — they have no separate token field); for the rules the procedure is unchanged — a token-free Uri + the Clear NDR authkey field. The remaining dump types are converted into NDR rules: **IP/CIDR → IP rules** (chunks of 500, SID 1,200,000+), **URL → host into DNS + HTTP rule** (SID 1,300,000+), **Regex → pcre on http.uri.raw** (SID 1,400,000+), **Phrase → http.response_body** (SID 1,500,000+); disabled “Filtering dump: …” sources are generated — enable them under “Rules → Sources”. Since v1.31.0: DNS stat cards on “Overview” (sources/domains/categories/build + a latest-build card with download) and header status badges — mirroring the rules. Since v1.32.0 the **“Build & Export”** tab mirrors the rules “Final rule set build” tab: progress with stages and a terminal log, latest-build badges, a metric grid (input/duplicates/allowlist/categories/manual/TLD/final), the per-source table, the `data/exports/domains` export-directory files; the DNS cycle is a separate notification event and has its own schedule for peak-load staggering. Since v1.34.0 the catalog includes the **RST Cloud Threat Feed: domains** feed (rst-csv format, X-Api-Key auth, `skipFpAlarm`/`minScore` filters in the source extra) and the **“Check in RST Cloud”** button in Records |
| **RST Cloud (v1.34.0)** | Integration with the commercial aggregated threat database (api.rstcloud.net, 260+ sources with a trust score). **API key** — “Settings → Source tokens → RST Cloud” (the X-Api-Key header, the `RST_API_KEY` env var); the **“Check key”** button shows validity, entitlements and quota (usually 1,000 requests/day). **Threat Feed feeds** (gzip CSV, the converter extracts the indicator column): IPs (~110K → chunks of 500, SID 1,600,000+), URLs (~7K HTTP rules, SID 1,700,000+), SHA-256 (~44K `filesha256` rules, SID 1,800,000+) — sources under “Rules” (disabled, adminOnly); the **domain feed** (~135K) is under “DNS lists” (disabled). **Indicator check** — a button under “DNS lists → Records”: IoC Lookup (score/tags/description), Noise Control (benignness/false positives), Whois (registration data) — the `POST /api/rst/check` and `POST /api/rst/lookup` endpoints; each check consumes 1 key-quota request |
| **Production resilience (v1.35.0)** | Removing DB blocking and “hung” builds: **two DB clients** — interactive (web API) and heavy (rules/DNS builds, dump import, bulk inserts) — under WAL readers do not block each other, the UI stays responsive during builds; rules are read from the DB **in batches** (cursor batches of 20k with event-loop breathing); the DNS build file is written **streaming** (20k-line chunks + incremental sha256, no ~100MB single string); sorting 6M domains is **chunked with event-loop pauses** (k-way merge, same order as Array.sort); a **watchdog** force-finishes a build with no signs of life for 10 minutes (no forever-running builds, the queue is unblocked); dashboard counters (478k rules / 6M domains) use a **TTL cache** with background refresh; the records search counter is capped (“20000+”); every build event is mirrored to the **container stdout** (docker logs — diagnostics available even with the DB busy); per-phase timings are in the build journal |
| **WireGuard VPN** | Full setup: wg-quick config editor, syntax check, up/down, status (`wg show`), environment check (wg, wg-quick, /dev/net/tun, NET_ADMIN). Rule downloads through the tunnel. **Re-raise protection**: an up tunnel cannot be raised again (HTTP 409 + the “Up” button disabled by actual `wg show interfaces` state — a second click no longer tears the tunnel down and hangs the container); profile state comes from wg, not a DB flag. Since v1.33.0 — **“Automatic tunnel raising”**: at container start the system checks that a saved configuration is available (the active profile, otherwise the first saved one) and raises the tunnel itself; an already-up tunnel is left untouched, environment errors go to the log and notifications |
| **Server monitoring** | Dashboards on “Overview”: CPU/memory/uptime (host /proc), disks with usage-threshold highlighting, network interface speed and traffic, WireGuard tunnel speed and peers, running containers (docker ps via a mounted docker.sock). 5 s polling, deltas computed client-side |
| **Disk auto-cleanup** | Free-space control for the hub data volume: when a threshold is crossed — automatic reclaim: hub archive cache, old OpenSearch indices (allowed prefixes only, system indices untouched), old files in listed log directories (suricata logs), large-file search (report-only by default). Each step enabled separately, a “What will be deleted” dry-run, per-run index limit, free-space target. Managed in “Settings → Disk & auto-cleanup”, buttons on “Overview” |
| **Notifications** | **Telegram** (bot + chat id, http/https/socks4/socks5 proxy, custom Bot API Server) and **Gotify** (self-hosted: URL + app token). Events: rule pipeline (fetch/build/export — with a DNS line when both run together), a **separate DNS cycle** (domain-source updates and list build — the “Domain lists” line with its own switch), WireGuard (tunnel up/down/errors), disk (usage thresholds, cleanup results) — individually switchable. “Test” buttons in settings |
| **Own Gotify server** | Automatic deployment of a gotify/server container right from the hub (docker.sock): /health wait, environment templates in data/gotify/ — docker-compose, Caddy and nginx with TLS, a domain/DNS/reverse-proxy guide. Without docker.sock — the `scripts/gotify-deploy.sh` host script. Details — [docs/gotify.md](docs/gotify.md) |
| **Clear NDR update** | A tab that detects the installed version → finds the latest stamusctl-templates release → when a newer one exists, lets you pick options (OpenSearch/PostgreSQL data, backups, stamusctl CLI) and start the update in one click. The `clearndr-update.sh` script runs on the host (SSH, or local when the hub is deployed in a container on the Clear NDR host), the log streams in real time, failures trigger automatic rollback, and the result is verified (containers, web UI, REST API). v4: self-restore of a missing `config/docker-compose.yaml`, `docker compose config` validation, auto-patch of the `networks` section (a gap in the 3.3.x templates), backup gate and rollback guard. A separate `clearndr-repair-stack.sh` repairs a broken instance `config/`. Guide — [docs/clearndr-update.en.md](docs/clearndr-update.en.md) |
| **Schedule** | cron (node-cron): source update → build → export. The **DNS cycle** (domain-source updates + domain-list rebuild) runs right after the main cycle or on its own schedule (`dnsCronSchedule`, the “DNS cycle” field in “Schedule (cron)”) — peak-load staggering: rules first, domains later; an invalid expression logs a warning and falls back to running together. Controlled from the UI |
| **Logs** | All fetch/build/export/VPN events with levels and filters |
| **Bilingual UI** | Russian and English via localization files (`src/lib/i18n/`). Language detected from browser strings (`navigator.languages`), RU/EN switch in the header, choice persisted in `localStorage`. Favicon (`public/favicon.ico`, 16–256 px) and logo included |
| **Help & “About”** | Tabs with goals/principles, developer info, acknowledgements and the technology list — collapsible accordions, also in both languages. The “Help” tab includes a detailed Clear NDR integration guide (token, PUSH/PULL schemes, auto-update) illustrated with process diagrams |
| **Multi-user mode (Enterprise)** | Registration with **2FA choice** (Telegram or TOTP), the account is activated by code confirmation, an **“Account” section** (second-level menu: “Profile & 2FA” + “Tokens & access”), personal **download tokens** (`ndrt_…`, SHA-256 in DB, revocation/expiry/stats, rules/domains/both scope), “own sources” (ownerId), security event journal. See [docs/developer.md](docs/developer.md) |
| **Captcha & 2FA** | Sign-in and registration are protected by a **single-use SVG captcha** (the answer never leaves the server, the image is burned after every attempt, per-IP issue limit, 2-min TTL — economic protection against captcha-solving services) and **two-factor authentication**: a code via Telegram (chat bound by /start to the bot) or **TOTP** (RFC 6238, QR + manual key, ±1 step window). The method is chosen at registration and changed in the “Account” cabinet (switching requires a code of the new method, disabling requires the password); on loss of access an administrator resets 2FA |
| **Release broadcasts** | When the hub is updated, every account with a bound Telegram automatically gets a message about the new version and features (one broadcast per version; the “what’s new” text is in settings; a “Broadcast now” button and a switch) |
| **Protection** | Per-IP rate limits on every endpoint (429 + Retry-After); brute-force protection: sign-in (IP + email + account lock), serving keys and tokens (10 failures/5 min → 15 min block); request queues for heavy operations (build/fetch/download — 429 on overflow); download bandwidth throttling (`downloadBandwidthKbps`); CSRF (Sec-Fetch-Site/Origin); scrypt passwords, SHA-256 token storage, constant-time comparisons; security headers; secrets redacted for non-admins |

## Editions

| | **Community** (default) | **Enterprise** (`NDR_EDITION=enterprise`) |
|---|---|---|
| Authentication | none — everything works as before | session sign-in, scrypt passwords |
| Registration & verification | — | yes; the personal cabinet opens only after administrator verification |
| User cabinet | — | Overview, Sources, Categories, Rules, Build & Export, Account (Profile & 2FA · Tokens & access), Clear NDR Update, OpenSearch Dashboards, Help, About |
| Administrator extras | full interface | + Users (verification), VPN, Settings, Logs |
| Download tokens | global serveToken key | global key + per-user personal tokens (“Account” → “Tokens & access”) |

The same Docker image serves both editions — switch via the `NDR_EDITION` environment variable (see [.env.example](.env.example)). User tables are added to the volume DB automatically (db-heal at startup). Architecture and protection details — [docs/developer.md](docs/developer.md), REST spec — [openapi.json](openapi.json), C4 diagrams (PlantUML) — [docs/diagrams/](docs/diagrams/).

## Validated ruleset package for Clear NDR

The ready-made package is in the [`dist/`](dist/) directory and in the release attachments:

- **113,843 rules** from 13 sources (ET Open, Talos Snort 2.9 + Snort 3, Abuse.ch SSLBL,
  Phishing Army, PT Attack Detection, Quadrant, OISF Traffic-ID, Blocklist.de, CINS Army,
  Spamhaus DROP, Feodo Tracker);
- every file was checked with `suricata -T` on Suricata 7.0.10 — **0 load errors**;
- variants: `full` (the whole set), `starter` (53,674 rules, high signal), `smoke` (123),
  breakdowns by category (`by-category/`) and by source (`by-source/`);
- integrity control: `sha256sum -c SHA256SUMS.txt`.

Testing and import procedure — in [`dist/README-IMPORT.md`](dist/README-IMPORT.md).

### Compatibility results (Suricata 7.0.10, 120k-rule corpus)

| Ruleset | Loads as is | After the s2x converter |
|---|---|---|
| ET Open (suricata-7.0) | **100%** | — |
| Talos Snort 2.9 (snapshot-29200) | 99.93% | **100%** (minus 0.2% excluded by the validator) |
| Talos Snort 3 (snapshot-3200) | **1.5%** | **99.7%** |

Typical Snort 3 → Suricata 7 incompatibilities: sticky buffers before content (9,829 rules), `soid`
(4,584), the `file` protocol (1,387), `service` (782), inline content modifiers (~30k options),
`bufferlen` (1,061), `byte_math`, SIP buffers, the 8192-byte rule length limit.

## Quick start (Docker)

```bash
git clone <repo> ndr-rules-hub && cd ndr-rules-hub
cp .env.example .env
# put your Oinkcode in (snort.org profile → Oinkcode) — can also be done later via the UI
echo 'OINKCODE=your_code' >> .env

docker compose up -d --build
# UI: http://localhost:3080
```

First run: the **“Sources”** tab → enable the sources you need → “Refresh all” →
the **“Build & Export”** tab → “Build” → “Download final file” (import into Clear NDR
using Clear NDR itself), or configure automatic export in **“Settings”**
(the “Clear NDR REST” mode — see [docs/clearndr-integration.en.md](docs/clearndr-integration.en.md): token, commands, auto-update, mock test).

> **Oinkcode is enough**: the official way to automate snort.org registered-rule downloads is
> `/reg-rules/<file>/<oinkcode>` (a redirect to `/rules/<file>?oinkcode=…`). No login/password needed.
> Personal-cabinet links (`https://snort.org/downloads/registered/<file>.tar.gz`) do **not** accept an
> oinkcode query parameter — the Hub automatically rewrites them to the canonical reg-rules form.
> Mind the snort.org download limit — do not enable several mirrors of the same ruleset at once.

## Server monitoring, disk auto-cleanup and notifications

### Dashboards on “Overview” (administrator only)

The system-dashboard block polls `GET /api/system` every 5 seconds:

- **Server** — CPU usage (`/proc/stat` delta), load average, memory (`/proc/meminfo`), uptime.
  `/proc` inside the container reflects the host kernel — this is server state, not container state.
- **Disks** — real volumes (`df -kPT`, tmpfs/squashfs excluded): used/free/percent. The hub data
  volume (`/app/data`) is marked; above the thresholds (85 % / 92 % by default) the row is
  highlighted and a banner with “What will be deleted” / “Configure” buttons appears.
- **WireGuard tunnel** — peers, handshake freshness, total traffic and speed (delta of
  `wg show all dump` between polls).
- **Network interfaces** — rx/tx counters and per-interface speed (`/proc/net/dev`).
- **Containers** — `docker ps` via the read-only mounted `/var/run/docker.sock` (the line is
  already in docker-compose.yml); without the socket a mounting hint is shown.
- **Disk cleanup** — “What will be deleted” (dry-run) and “Clean up now” buttons, last report.

### Disk auto-cleanup

Periodic usage check of the data volume (cron, hourly by default); warn/critical thresholds →
notification (throttled to once per 6 hours per level); with auto-cleanup enabled and the trigger
threshold crossed, cleanup steps run until the free-space target is reached. Manual runs and
dry-runs execute all enabled steps fully.

Steps (each enabled separately in “Settings → Disk & auto-cleanup”):

1. **Hub cache** — source archives in `data/cache` and `.pack-*` build leftovers older than N days
   (default 14) — safely recreated.
2. **Log directories** — files older than N days (default 7) in the listed directories. For
   suricata logs mount the host directory into the container (e.g. `- /var/log/suricata:/mnt/suricata-logs:ro`)
   and list it. Active files (`eve.json`, `fast.log`, `stats.log`…) are never touched.
3. **OpenSearch indices** — only indices with allowed prefixes (`logstash-,ndr-,eve-,suricata-,selks-`)
   older than N days (default 14), max N per run (default 50, oldest first). System indices
   (`.kibana`, `.opendistro-*`, security*) are untouched. Channel: explicit URL → OSD setting →
   auto-discovery (127.0.0.1/172.17.0.1/host.docker.internal:9200) → docker exec into the opensearch
   container. Self-signed certificates are accepted.
4. **Large files** — files > N MB and older than N days searched ONLY in explicitly listed
   directories; report-only by default, deletion behind a separate switch.

Anything outside the explicitly allowed lists is never deleted. Run history — “Logs” tab
(scope `cleanup`), the last report — on “Overview”.

### Notifications: Telegram and Gotify

- **Telegram**: bot token (@BotFather) + chat id. Proxy: `http(s)://user:pass@host:port` or
  `socks5://user:pass@host:1080`. A custom Bot API Server can be set. “Test” button.
- **Gotify**: server URL + app token (Apps → Create Application), priority 0–10.
- **Events** (individually switchable): rule pipeline, WireGuard, disk.

### Own Gotify server

Option 1 — from the UI: “Settings → Notifications → Gotify → Own server → Deploy Gotify”. The hub
(with docker.sock) runs `gotify/server` (port 8085, volume `ndr-gotify-data`), waits for `/health`
and saves environment templates (docker-compose, Caddy/nginx with TLS, a domain/DNS guide) to
`data/gotify/`. Default credentials admin/admin — change the password right after the first login.

Option 2 — on the host: `sudo bash scripts/gotify-deploy.sh --port 8085 --domain gotify.example.com`.

Full guide — [docs/gotify.md](docs/gotify.md).

## Captcha and two-factor authentication (Enterprise)

Sign-in and registration start with a captcha: the server renders a distorted SVG text
(random fonts, per-character rotation/shift, wavy lines, noise) and returns `{captchaId, svg}`.
The answer never leaves the server; the comparison is constant-time. Resistance to captcha-solving
services is economic: the captcha is **single-use** (burned after every attempt), TTL 2 minutes,
issue limit 30 per 10 minutes per IP, plus the existing brute-force protection (IP/account blocks).
The captcha is mandatory at step 1 of both sign-in and registration.

**2FA** — the method is chosen at registration and changed in the “Account” cabinet:

- **Telegram** — registration asks for a username; the hub sends the code via the bot. Telegram
  forbids bots from messaging first, so the user sends `/start` to the bot once (the deep link is
  shown on the screen) — the hub poller binds the chat_id and immediately delivers the pending code.
  Sign-in: password → Telegram code → session.
- **TOTP** (for those without Telegram) — the server generates a secret (RFC 4648 base32), a QR
  (`otpauth://…`) and a manual key; codes are verified with a ±1 step (30 s) window, compatible with
  Google Authenticator/Authy/FreeOTP.

Second-step mechanics: after a correct password a short-lived (5 min) HMAC ticket is issued in the
HttpOnly `ndrh_mfa` cookie; the session is created only after the code is confirmed. Code: 5-min TTL,
max 5 wrong attempts, 10/5-min per-IP limit on verify endpoints. All events land in the security
journal (sign-ins, codes, 2FA changes/resets).

Changing the method in the cabinet requires confirming with the NEW method (you cannot lock yourself
out); disabling 2FA requires the password. If both factors are lost, an administrator resets 2FA on
the “Users” tab (“Reset 2FA”). The bootstrap administrator (first user) may postpone 2FA setup and
enable it later in “Account”.

For Telegram 2FA and broadcasts configure the bot: “Settings → Notifications” → bot token
(@BotFather) — the same token serves chat binding, codes and release broadcasts. Proxy supported.

**Release broadcasts**: on the first dashboard request after an update the app version is compared
with the `releaseNotifyVersion` setting; on mismatch every account with a bound Telegram gets
“updated to vX.Y.Z” + the “what’s new” text (`releaseNotes`) + the releases link. One broadcast per
version; “Broadcast now” repeats it.

**Sticky menu**: the menu bar stays pinned under the header while scrolling (header height is
measured automatically; message banners moved out of the sticky header).

## Bilingual interface (RU/EN)

The UI is localized into two languages via localization files:

- **Language detection** — from the browser strings: `navigator.languages` (the first language a
  translation exists for; `ru-RU` → Russian, `en-US` → English). No server cookies needed: the
  page is fully client-side.
- **RU/EN switch** — in the header, on the right. The choice is stored in `localStorage`
  (key `ndrh.lang`) and takes priority over the browser on subsequent visits.
- **Dictionaries** — `src/lib/i18n/ru.ts` (canonical) and `src/lib/i18n/en.ts` (typed as
  `typeof ru`, so a missing key breaks `tsc`). Templates with variables: `'Built {n} rules'` +
  the `tr()` function. Rich text (bold/code) — lightweight `**…**` and `` `…` `` markup in the
  `Rich` component.
- **Provider** — `useSyncExternalStore` on top of localStorage: SSR always renders Russian,
  after hydration React switches to the browser language without hydration mismatches.
- All 9 tabs, the header, the footer, action messages, size units (B/KB) and date formats
  (`ru-RU`/`en-US`) are localized. Engine messages in the log and API errors are in Russian —
  those are operational data, not interface elements.

See also [architecture.md](architecture.md) (Russian) and [architecture.en.md](architecture.en.md)
(English) for the system architecture.

## If the image build hangs on `bun install`

`bun install` has no built-in timeout: on a flaky network the step hangs for hours silently
(bun prints no progress in non-TTY mode). Two incidents: v1.27.0 — 23196 s on
`registry.npmjs.org` (host network: DNS/MTU/throttling); v1.36.1 — the `npm-mirror.gitverse.ru`
mirror degraded (the ~31 MB `/next` manifest takes ~16 s vs 0.4 s on npmjs), an install of
~1000 packages did not fit into 45 minutes and was killed silently by the fuse. A single
registry no longer decides the build's fate: since v1.36.1 the deps stage behaves as follows
(scripts/bun-install.sh):

1. every candidate mirror is probed with a light `GET /ms` (~90 KB, 15 s timeout);
   non-responding mirrors are excluded immediately — the per-attempt fuse time is not wasted;
2. attempts are ordered by measured latency; degraded mirrors (slower than 3 s per request)
   go last — a fast answer on a tiny manifest will not save an install of a thousand packages
   on a choked mirror;
3. each attempt runs `bun install --frozen-lockfile --registry <mirror> --verbose` under the
   per-attempt fuse `BUN_INSTALL_TIMEOUT` (seconds **PER ATTEMPT**, default 900, kill-after
   30 s): the build log shows the package it stalled on;
4. the first successful mirror completes the step; FAIL with diagnostics (stderr) only if
   none worked.

Default candidates: `registry.npmjs.org` → `registry.npmmirror.com` → `npm-mirror.gitverse.ru`.
`NPM_REGISTRY` (if set in .env) is probed first but queued by measured speed; a custom list —
`BUN_REGISTRIES="url1 url2 …"`. `bun.lock` embeds no registry URLs — installs from any mirror
are verified against the lockfile integrity hashes; the bun package cache survives between
builds (a version bump no longer re-downloads packages).

```bash
# mirror latency from the build host (light ms manifest, ~90 KB):
curl -o /dev/null -sS -w 'npmjs:     total %{time_total}s\n' https://registry.npmjs.org/ms
curl -o /dev/null -sS -w 'npmmirror: total %{time_total}s\n' https://registry.npmmirror.com/ms
curl -o /dev/null -sS -w 'gitverse:  total %{time_total}s\n' https://npm-mirror.gitverse.ru/ms
# fast on the host but hanging inside the build → DNS/MTU of the bridge network:
docker build --network=host -t ndr-rules-hub:local .
# regression tests for the automation + a real fallback check:
RUN_NET_TESTS=1 bunx vitest run tests/bun-install.test.ts
```

## Diagnostics (if the UI shows an API error)

The UI and the API are served by the same Next.js server: if the page opened, the backend is
reachable — there is no separate “backend” to expose. An `HTTP 500` error means the request
reached the API and the route crashed; the real cause is returned in the response, shown in the
red bar in the UI and duplicated into the container logs.

```bash
docker logs ndr-rules-hub --tail 100        # [entrypoint] …, [api] 500: <cause>
curl -s http://localhost:3080/api/health    # self-diagnostics: DB, schema, files
```

`/api/health` answers 200 even with a broken DB and shows the exact error (for example,
`PrismaClientKnownRequestError P2022` with an outdated schema); since v1.36.2 it also shows
counts of the tables most likely to bloat (domainRecords/logEntries/authEvents…) and the DB/WAL
file sizes. The DB schema is healed automatically (db-heal at container startup): missing
tables/columns/indexes are added WITHOUT data loss. Every heavy step is time-bounded
(DB_HEAL_TIMEOUT_MS, 90 s per step by default — integrity scan, snapshot restore, VACUUM
backup, CREATE INDEX; the entrypoint global guard is DB_HEAL_TIMEOUT, 300 s), so initialization
can no longer hang silently on a huge DB.

Since v1.36.2 the integrity scan is SKIPPED on a large DB (threshold DB_HEAL_CHECK_SKIP_MB,
default 400 MB): in the incident a 1.3 GB DB did not finish quick_check within 90 s, the code-2
exit cut db-heal BEFORE the schema heal, and the server started on an outdated schema (P2022 on
every API, the UI stuck on “Checking session…”). The schema heal now always runs — it reads only
metadata (sqlite_master, PRAGMA table_info) and does not depend on data pages. A full scan of a
large DB is manual: `NDR_DB_FULL_CHECK=1` with a raised `DB_HEAL_TIMEOUT_MS` (e.g. 600000).
db-heal exit codes: 0 — ok/healed; 1 — proven corruption without healthy snapshots (the entrypoint
backs up to `./data/hub.db.bak-<date>` and creates a DB from the template); 2 — the check did
NOT FINISH (timeout of the structural check/connection) — the DB is NOT considered corrupted,
the server starts with the existing DB and the check repeats on the next restart.

The first container log lines always show hub.db/-wal/-shm sizes and the free volume space (a
gigabyte `-wal` is a footprint of stuck builds; after a successful check db-heal trims it via
`wal_checkpoint(TRUNCATE)`), and the first application log line is
`[db …] SQLite: journal=wal, DB … MB, wal-file … MB`. "Empty logs" with an unhealthy container
are no longer possible: even a stuck db-heal step prints which step exceeded its timeout.

The error `Prisma Client could not locate the Query Engine for runtime …` means the Prisma
platform mismatched between build stages (builder ≠ runtime). The repo already accounts for
this: `binaryTargets = ["native", "debian-openssl-3.0.x"]` in `prisma/schema.prisma` covers the
`node:22-bookworm-slim` runtime image. The schema version stamp is computed from models only,
so generator edits do not trigger a rebuild.

## Running without Docker

```bash
bun install
cp .env.example .env   # DATABASE_URL=file:./db/hub.db
bun run db:push
bun run dev            # http://localhost:3000
bunx vitest run        # engine tests
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `OINKCODE` | oinkcode for snort.org (can be set in the UI) | — |
| `RST_API_KEY` | RST Cloud API key (Threat Feed feeds, IoC Lookup, Whois — can be set in the UI) | — |
| `DATABASE_URL` | SQLite DB | `file:/app/data/hub.db` |
| `RULES_DATA_DIR` | data directory (cache, exports, archives) | `/app/data` |
| `WG_CONFIG_DIR` | where to store WireGuard configs | `/app/data/wireguard` |
| `TZ` | cron timezone | `Europe/Moscow` |
| `DB_HEAL_TIMEOUT` | global timeout of the DB schema check/heal at container startup (seconds) | `300` |
| `DB_HEAL_TIMEOUT_MS` | timeout of a single heavy db-heal step (milliseconds) | `90000` |
| `DB_HEAL_CHECK_SKIP_MB` | integrity scan is skipped for DBs above this size (MB; `0` — always scan; full scan — `NDR_DB_FULL_CHECK=1`) | `400` |
| `NDR_EDITION` | edition: `community` (no authentication) / `enterprise` (multi-user mode) | `community` |

## WireGuard in the container

`docker-compose.yml` already contains `cap_add: NET_ADMIN`, the `/dev/net/tun` device and
`ip_forward`. The image ships `wireguard-tools` (wg + wg-quick), `iptables`, `iproute2`,
`openresolv` (the “DNS =” lines) and `procps`/`sysctl` (required for `AllowedIPs = 0.0.0.0/0`).
In the UI (the **WireGuard VPN** tab):

1. paste a `.conf` file (wg-quick format), optionally set the interface name with a
   `# InterfaceName: wg-office` comment;
2. “Check config syntax” → “Save” → “Bring tunnel up”;
3. enable **“Automatic tunnel raising”** (v1.33.0): at every container start the system will
   check that the saved configuration is available (the active profile, otherwise the first
   saved one) and raise the tunnel itself; turning the toggle on performs an attempt
   immediately (result in the message, log and notification); a tunnel that is already up
   (process restart without container recreation) is left untouched;
4. handshake/traffic status is visible in the “Active interfaces” block.

If the tunnel should only serve snort.org downloads — restrict `AllowedIPs` to the snort.org
subnets instead of `0.0.0.0/0`.

### If the UI shows “No /dev/net/tun”

This warning does not affect rule downloads or builds — only tunneling. If you do not need the
VPN, it can be ignored. If you do:

1. **Check the host** (the machine running Docker):
   ```bash
   ls -l /dev/net/tun                     # must exist (character device 10,200)
   sudo modprobe tun                      # if missing — load the module
   sudo modprobe wireguard                # kernel module for the tunnels themselves
   echo tun | sudo tee /etc/modules-load.d/tun.conf   # and load at boot
   echo wireguard | sudo tee /etc/modules-load.d/wireguard.conf
   ```
   If the file is still missing after `modprobe tun`: `sudo mkdir -p /dev/net && sudo mknod /dev/net/tun c 10 200 && sudo chmod 666 /dev/net/tun`.
2. **Make sure the container runs the repository compose** (it has `cap_add` and `devices`):
   ```bash
   cd ndr-rules-hub && git pull && docker compose up -d --force-recreate
   docker inspect ndr-rules-hub --format '{{json .HostConfig.CapAdd}} {{json .HostConfig.Devices}}'
   # expected: ["NET_ADMIN"] [{"PathOnHost":"/dev/net/tun",...}]
   ```
   If it shows `[]` — the container was started via `docker run` or an old compose without these
   flags: recreate it with the repository `docker-compose.yml` (for `docker run` add
   `--cap-add NET_ADMIN --device /dev/net/tun`).
3. **Check inside the container**: `docker compose exec rules-hub test -e /dev/net/tun && echo OK`.
4. **The host is an LXC container (Proxmox etc.)**: tun must be allowed on the hypervisor —
   add to `/etc/pve/lxc/<id>.conf` and restart the LXC:
   ```
   lxc.cgroup2.devices.allow: c 10:200 rwm
   lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
   ```

### If wg-quick fails with “sysctl: permission denied on key”

For full-tunnel configs (`AllowedIPs = 0.0.0.0/0`) wg-quick sets
`net.ipv4.conf.all.src_valid_mark=1`, but `/proc/sys` is read-only inside the container
(especially on 6.8+ kernels), so the write is denied even with NET_ADMIN. Two steps are needed:

1. **The value must be set by docker at container creation** — the repository
   `docker-compose.yml` already contains:
   ```yaml
   sysctls:
     - net.ipv4.ip_forward=1
     - net.ipv4.conf.all.src_valid_mark=1
   ```
   Recreate the container: `git pull && docker compose up -d --build --force-recreate`.
2. **wg-quick in the image is patched** as in upstream wireguard-tools (commit `ac74ed6`):
   the write happens only if the value is not already 1. The stock bookworm version
   (1.0.20210914) wrote unconditionally and failed on read-only `/proc/sys` even when the
   value was already set — the patch fixes that.

Check: `docker compose exec rules-hub sysctl -n net.ipv4.conf.all.src_valid_mark`
should print `1`; the “src_valid_mark (write)” card in the UI turns green.

If `docker compose up` itself fails to set this sysctl (happens inside an unprivileged LXC) —
set the key on the host/LXC (`sysctl -w net.ipv4.conf.all.src_valid_mark=1`) and add it to
`/etc/sysctl.conf`; or run the LXC in privileged mode. An alternative without sysctl: restrict
`AllowedIPs` to the snort.org subnets — wg-quick then does not touch that key.

### If the web UI is unreachable while a full-tunnel is up

Symptoms: the tunnel is up, handshake present (`docker compose exec rules-hub wg show`),
but the Hub page does not open, and in an open tab all environment-check cards show “no data”.
The cause is the very nature of full-tunnel: wg-quick adds policy routing
(`ip rule not fwmark → table 51820`) which wraps EVERYTHING into the tunnel, including reply
packets of incoming connections to the web UI (port mapping 3080→3000): replies go out via wg0
and get lost.

The Hub solves this automatically: when a full-tunnel config comes up it adds the rule

```bash
ip rule add from <container-address-on-eth0> lookup main priority 100
```

(and the same for global IPv6 if present) — web UI replies go out via eth0 while all other
outbound container traffic goes through the tunnel. The rule is removed on “Bring tunnel down”.
Verify with:

```bash
docker compose exec rules-hub ip rule show          # a “100: from <IP> lookup main” line
```

Emergency access recovery (when the UI is already “dead” and buttons cannot be pressed) —
from the host:

```bash
# option 1: bring the tunnel down properly
docker compose exec rules-hub wg-quick down /app/data/wireguard/wg0.conf
# option 2: if that did not help — delete the interface directly
docker compose exec rules-hub ip link del wg0
# option 3: the simplest one — restart the container (the tunnel goes down too)
docker compose restart rules-hub
```

### If rule downloads fail with “HTTP 422” (snort.org)

Verified in practice: snort.org answers `HTTP 422` with the body `["Invalid oinkcode"]` when the
**oinkcode is not accepted** — the code is missing, has a typo, or was revoked. Since this
version the Hub shows the response body and a fingerprint of the submitted code
(`sent oinkcode abcd…ef01 (40 chars)` or `oinkcode NOT set`) in the error, so the cause is
immediately visible. What to check:

1. the code is saved in **Settings** (the oinkcode field) or in the source extra;
2. the code is copied in full from snort.org → **Preferences → Oinkcode** (40 hex characters,
   no spaces or line breaks);
3. the snort.org account is active and the code is not revoked (re-issue it if in doubt);
4. if the code is definitely correct but 422 keeps repeating — note that with a full-tunnel up,
   requests to snort.org come from the VPN server IP: temporarily bring the tunnel down
   (“Bring down” in the WireGuard tab) and retry “Refresh” — this rules out snort.org reacting
   to the egress IP.

For reference: `403` — wrong oinkcode or the download limit (registered — no more than once
every 15 minutes), `429` — too frequent requests. The Hub does not re-download the archive if
`cacheTtlMinutes` is set in the source extra (an archive younger than N minutes is taken from
the cache), and when a source is unreachable it automatically works from the previously
downloaded archive, noted in the logs.

### If unpacking fails: “tar: … not in gzip format”

Previously the Hub stored an HTTP 200 body as is: if snort.org returned an HTML page instead of
an archive (download limit, a personal-cabinet link with the oinkcode in the query — verified:
`downloads/registered/…?oinkcode=` returns a web page, not an archive), the file was written as
`.tar.gz` and tar failed with an opaque error. Starting with this version:

1. **Magic-byte check** — the archive is only stored and unpacked if the body starts with
   `1f 8b` (real gzip); otherwise the error shows the HTML page title and a hint
   (limit / link form / oinkcode).
2. **Link normalization** — personal-cabinet links
   (`snort.org/downloads/registered|subscribed/<file>.tar.gz`) are automatically rewritten to the
   canonical `www.snort.org/reg-rules/<file>.tar.gz/<oinkcode>` form — both work, no need to
   change the URL in the source.
3. **The cache stays clean** — HTML is no longer saved over a previously downloaded archive;
   on a bad response the Hub works from the cache with a warning.
4. tar errors are now short (“archive downloaded (N bytes), but tar could not unpack it: …”)
   instead of `Command failed: tar -xzf /app/data/cache/…`.

## Service API

| Method/path | Description |
|---|---|
| `GET /api/health` | self-diagnostics: DB, schema version, files (always 200) |
| `GET /api/dashboard` | summary: sources, rules, latest build, VPN, logs |
| `GET/POST /api/sources` | list / add a source |
| `PATCH/DELETE /api/sources/:id` | edit / delete |
| `POST /api/sources/:id/fetch` | fetch the source’s rules |
| `POST /api/fetch-all` | update all enabled |
| `POST /api/build` | start the build in the background: immediately returns `{ok, jobId}`; status via `GET /api/build/progress` (phase/percent/log, result when finished); `{ "export": true }` — with export after the build |
| `GET /api/build/progress` | progress of the current/last build: phase, percent, log tail, result |
| `GET /api/export` | the final set for a Clear NDR URL source (PULL): the file (datatype `sig`) or `?archive=1` — per-source tgz (datatype `sigs`); authentication — a personal `ndrt_…` token / serveToken (`?token=` or the Authorization header) or a session; download queue + bandwidth throttling |
| `POST /api/export` | push to Clear NDR using the configured method |
| `POST /api/auth/captcha` · `GET` | issue a single-use SVG captcha ({captchaId, svg}, 2-min TTL, 30/10 min per IP limit) — Enterprise |
| `POST /api/auth/login` | sign-in step 1: captcha + password; with 2FA — a second-step ticket (cookie `ndrh_mfa`) and `{mfa: telegram\|totp}`; Telegram-2FA sends the code via the bot, without a bound chat it refuses with a /start hint |
| `POST /api/auth/login/verify` | sign-in step 2: Telegram or TOTP code (±1 step) → session; 10/5 min limit, the code has 5 wrong attempts and a 5-min TTL |
| `POST /api/auth/register` | registration step 1: captcha + data + 2FA choice (telegram — username; totp — secret+QR right away); the account is pending until the code is confirmed |
| `POST /api/auth/register/verify` | registration step 2: code → account activated (verifiedBy: telegram-code / totp-code) |
| `GET/POST /api/auth/account` | cabinet: current 2FA and actions — save-telegram, send-telegram-code, switch-telegram, setup-totp, switch-totp, disable-2fa (password), send-test |
| `POST /api/auth/register` · `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | registration (the first user becomes admin; bootstrap may skip 2FA), sign-in/out (cookie session), UI state (including twoFactor) — Enterprise only |
| `GET/PATCH /api/auth/users` · `PATCH/DELETE /api/auth/users/:id` · `GET /api/auth/events` | users: list, verification/disable/roles/delete, security journal — administrator only, Enterprise only |
| `GET/POST /api/tokens` · `DELETE /api/tokens/:id` | personal download tokens (admin sees all): creation (the token is shown once), revocation — Enterprise only |
| `GET /api/rules?sid=&q=&sourceId=&page=` | browse the rule database |
| `GET/PUT /api/settings` | settings (oinkcode, rstApiKey, policies, cron, export, notifications, auto-cleanup) |
| `POST /api/rst/check` | RST Cloud API key check: validity, entitlements, quota (admin only) |
| `POST /api/rst/lookup` | indicator check via RST Cloud: IoC Lookup / Noise Control / Whois (admin only) |
| `GET/POST/PUT/DELETE /api/vpn` | WireGuard status/actions/profiles; a second `up` of a raised tunnel → 409 + `alreadyUp`; POST `action: 'auto-up'` runs the “Automatic tunnel raising” check; GET includes `autoUp` (the state of the `wgAutoUp` toggle) |
| `GET /api/system` | system monitoring (administrator only): CPU/memory/disks/network/containers/WireGuard + auto-cleanup status |
| `POST /api/system` | cleanup actions: `cleanup-preview` (dry-run), `cleanup-run`, `disk-check`, `reschedule` |
| `GET /api/notify` · `POST /api/notify` | Gotify state; actions: `test` (telegram/gotify), `gotify-deploy` (deploy your own server), `gotify-remove`, `release-broadcast` (forced version broadcast) |
| `GET /api/clearndr-update` | update section status: versions, host preflight, stack state, run history (`?log=<runId>` — run log) |
| `POST /api/clearndr-update` | actions: `probe` (host check), `start` (begin update), `cancel`, `sync-script` |
| `PUT /api/clearndr-update` | connection settings (SSH/local, instance dir, URL, token) |
| `GET /api/logs` | log |

## Structure

```
prisma/schema.prisma        # Source(+ownerId), Rule, Build, Setting, LogEntry, VpnProfile,
                            # User, Session, DownloadToken, AuthEvent (Enterprise)
src/lib/engine/
  parser.ts                 # Snort2/Snort3/Suricata rule parser (+multiline)
  convert.ts                # IP/domain/URL → rule converters
  fetcher.ts                # fetching (url/tarball/local, oinkcode/auth-key/basic)
  build.ts                  # mergeSources: SID/content dedup, conflict winner/loser policies
  exporter.ts               # file · Clear NDR REST (upload → apply) · HTTP POST · directory
  vpn.ts                    # wg-quick: config, up/down, status, environment check
  service.ts                # orchestration: fetch → build → export, cron, catalog seed
  seed.ts                   # catalog of 25 sources + default settings
src/lib/i18n/
  detect.ts                 # Lang type, detectLang (browser strings), tr(), localeOf
  ru.ts / en.ts             # UI dictionaries (en is typed as Dictionary = typeof ru)
  index.tsx                 # I18nProvider (useSyncExternalStore) + useI18n()
scripts/
  s2x_convert.py            # Snort 2/3 → Suricata 7 converter (probe-calibrated)
  talos_convert_batch.py    # batch Talos 29200/3200 conversion + validation
  final_assembly.py         # package assembly: merge + suricata -T loop until 0 errors
  keyword_analysis.py       # analysis of 153 corpus keywords
  make_final_files.py       # delivery files (full/starter/smoke/by-*)
  clearndr-check.sh         # Clear NDR REST API check (token, sources, rulesets)
  clearndr-setup-pull.sh    # pull scheme setup: Hub-URL source + ruleset + schedule
  clearndr-push.sh          # push delivery of a .rules file to Clear NDR (cron-friendly)
  clearndr-update.sh        # in-place Clear NDR stack upgrade (backups + rollback + config/ v4 safeguards)
  clearndr-repair-stack.sh  # repair a broken instance config/ (missing compose file, networks section)
  clearndr-mock-server.py   # Clear NDR mock (Scirius REST) for integration testing
  make-favicon.mjs + make-favicon-ico.py  # favicon.ico from public/logo.svg (sharp + ICO)
docs/
  clearndr-integration.md / .en.md  # exact guide to delivering and auto-updating rules to Clear NDR
  clearndr-update.md / .en.md       # guide to upgrading the Clear NDR stack with all settings preserved
dist/                       # VALIDATED package for Clear NDR (zip + README + SHA256)
src/app/api/…               # REST API (Next.js route handlers)
src/components/hub/…        # Web UI (9 tabs, bilingual)
public/logo.svg, public/favicon.ico  # logo and favicon
architecture.md / .en.md     # system architecture (rus/eng)
tests/                      # vitest: parser, converters, build, VPN, fetcher, i18n
Dockerfile                  # multi-stage build (standalone + wireguard-tools)
docker-compose.yml          # NET_ADMIN, /dev/net/tun, volume ./data
```

### Ruleset quality pipeline

```mermaid
flowchart LR
    A["sources"] --> B["fetch"]
    B --> C["merge<br/>SID / content dedup"]
    C --> D["s2x_convert.py<br/>Snort 2/3 → Suricata 7"]
    D --> E{"suricata -T"}
    E -- "0 errors" --> F["dist/ package<br/>+ SHA256SUMS"]
    E -- "load errors" --> G["log parsing:<br/>exclude / fix broken"]
    G --> C
    F --> H["export to Clear NDR"]
```

The full description of the quality gates is in [architecture.en.md, section 5](architecture.en.md#5-rules-quality-pipeline).

Running the pipeline manually (in a sandbox without Docker):
```bash
python3 scripts/talos_convert_batch.py   # Talos 29200+3200 → Suricata
python3 scripts/final_assembly.py        # the whole corpus + the validation loop
python3 scripts/make_final_files.py      # delivery files into download/rules/
```

## Tests

```bash
bunx vitest run
```

444 tests (38 files): parsing real Snort 3 rules (multiline, pcre with braces), converters
(IP chunks, domains, URLs, maxRules guards), SID dedup policies (winner and loser), the DNS
module (adguard/hosts/plain hostlists, domain list merge, 4-format render, streaming SQL-dump
parser, token scope),
DELETED stubs, content hash, wg-quick configs (valid/broken), local directory and tar.gz
fetching, an online list-converter integration test (Spamhaus DROP), plus the i18n suite:
browser-string language detection, template interpolation, full ru/en key parity, `{n}`
placeholder parity across languages, localized size units.

## Source catalog — analysis

See [docs/ANALYSIS.md](docs/ANALYSIS.md): a full breakdown of the 5 snort.org archives from
Yandex.Disk (real SID overlaps), verdicts on duplicates, Suricata compatibility and a review of
all available rule sources with working URLs.
