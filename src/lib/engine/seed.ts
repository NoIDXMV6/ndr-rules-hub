// ─────────────────────────────────────────────────────────────────────────────
// Каталог источников правил + настройки по умолчанию (первичная инициализация)
// ─────────────────────────────────────────────────────────────────────────────

export interface SeedSource {
  name: string
  category: 'ruleset' | 'ip-list' | 'domain-list' | 'url-list'
  kind: 'url' | 'tarball' | 'local'
  url?: string
  authType?: 'none' | 'oinkcode' | 'authkey' | 'basic'
  extraJson?: string
  enabled?: boolean
  priority?: number
  badge?: 'recommended' | 'duplicate' | 'legacy' | 'paid' | 'converter' | 'new' | 'unavailable'
  notes?: string
  notesEn?: string // примечание на английском (для EN-интерфейса)
}

export const LOCAL_ARCHIVES_DIR = process.env.RULES_LOCAL_ARCHIVES_DIR || 'data/archives'

export const SEED_SOURCES: SeedSource[] = [
  // ── Snort.org (официальные, через oinkcode) ────────────────────────────────
  {
    name: 'Snort Registered Ruleset (Snort 3, snapshot-3200)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://www.snort.org/reg-rules/snortrules-snapshot-3200.tar.gz',
    authType: 'oinkcode',
    extraJson: JSON.stringify({ subPath: 'rules' }),
    enabled: true,
    priority: 10,
    badge: 'recommended',
    notes: 'Официальный зарегистрированный набор Snort 3 (~53 000 правил). Загрузка по oinkcode. Основной источник. Обновляется Talos ежедневно.',
    notesEn: 'Official registered Snort 3 ruleset (~53,000 rules). Downloaded with an oinkcode. The primary source, updated daily by Talos.',
  },
  {
    name: 'Snort Registered Ruleset (Snort 2.9, snapshot-29200)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://www.snort.org/reg-rules/snortrules-snapshot-29200.tar.gz',
    authType: 'oinkcode',
    extraJson: JSON.stringify({ subPath: 'rules' }),
    enabled: false,
    priority: 15,
    badge: 'legacy',
    notes: 'Устаревший формат Snort 2.9: 15 216 из 15 783 SID уже входят в Snort3-набор; preproc/so_rules не совместимы с Suricata. Включать только при необходимости.',
    notesEn: 'Legacy Snort 2.9 format: 15,216 of 15,783 SIDs are already covered by the Snort 3 set; preproc/so_rules are not Suricata-compatible. Enable only when needed.',
  },
  {
    name: 'Snort Community Ruleset (Snort 2)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://www.snort.org/downloads/community/community-rules.tar.gz',
    authType: 'none',
    enabled: false,
    priority: 40,
    badge: 'duplicate',
    notes: 'Бесплатное подмножество (568 правил) — 100% перекрывается зарегистрированным набором. Нужен только без oinkcode.',
    notesEn: 'Free subset (568 rules) — 100% covered by the registered set. Only useful without an oinkcode.',
  },
  {
    name: 'Snort 3 Community Ruleset',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://www.snort.org/downloads/community/snort3-community-rules.tar.gz',
    authType: 'none',
    enabled: false,
    priority: 40,
    badge: 'duplicate',
    notes: 'Бесплатное подмножество (4 026 правил) — 4 017 SID входят в зарегистрированный Snort 3 набор.',
    notesEn: 'Free subset (4,026 rules) — 4,017 SIDs are included in the registered Snort 3 set.',
  },
  {
    name: 'Talos LightSPD (Snort 3)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://www.snort.org/reg-rules/Talos_LightSPD.tar.gz',
    authType: 'oinkcode',
    enabled: false,
    priority: 12,
    badge: 'duplicate',
    notes: 'Полный дубликат snortrules-snapshot-3200 (52 680 из 52 680 SID совпадают). Светлая альтернатива зарегистрированному архиву.',
    notesEn: 'A full duplicate of snortrules-snapshot-3200 (52,680 of 52,680 SIDs match). A lightweight alternative to the registered archive.',
  },

  // ── Основные публичные ruleset-ы ───────────────────────────────────────────
  {
    name: 'ET Open Ruleset (Emerging Threats)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://rules.emergingthreats.net/open/suricata-7.0/emerging-all.rules',
    enabled: true,
    priority: 20,
    badge: 'recommended',
    notes: 'Крупнейший открытый набор (~30 000 правил) в нативном формате Suricata. Обновляется ежедневно.',
    notesEn: 'The largest open ruleset (~30,000 rules) in native Suricata format. Updated daily.',
  },
  {
    name: 'Positive Technologies Attack Detection Team',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://raw.githubusercontent.com/ptresearch/AttackDetection/master/pt.rules.tar.gz',
    enabled: true,
    priority: 30,
    badge: 'legacy',
    notes: 'Талантливый набор PT Expert (~9 000 правил). Публичный репозиторий заморожен с 2022 г. — правила не обновляются. Живой набор PT переехал на ptrules.com — источник «PT Open Ruleset (ptrules.com)» ниже.',
    notesEn: 'PT Expert ruleset (~9,000 rules). The public repository has been frozen since 2022 — rules are no longer updated. The live PT set moved to ptrules.com — see the "PT Open Ruleset (ptrules.com)" source below.',
  },
  {
    name: 'PT Open Ruleset (ptrules.com)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://ptrules.com/files/ptopen.rules.tar.gz',
    enabled: true,
    priority: 31,
    badge: 'new',
    notes: 'Новый источник: свежие открытые правила Positive Technologies (обновления продолжаются, ~430+ правил: attacks/malware/info/windows/tools). Сервер блокирует не-браузерный User-Agent — в extra задан userAgent, при ручном добавлении скопируйте его. Найдено через индекс EveBox Rules.',
    notesEn: 'New source: fresh open Positive Technologies rules (still updated, ~430+ rules: attacks/malware/info/windows/tools). The server blocks non-browser User-Agents — a userAgent is preset in extra; copy it when adding manually. Found via the EveBox Rules index.',
    extraJson: JSON.stringify({ subPath: 'rules', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }),
  },
  {
    name: 'Quadrant Suricata Ruleset',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/quadrantsec/suricata-rules/main/quadrant-suricata.rules',
    enabled: true,
    priority: 35,
    badge: 'new',
    notes: 'Новый источник: открытый набор Quadrant Information Security (~2 000 правил, много прикладных детектов SCADA/ICS).',
    notesEn: 'New source: open ruleset by Quadrant Information Security (~2,000 rules, many applied SCADA/ICS detections).',
  },
  {
    name: 'Suricata Traffic ID Ruleset (OISF)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/OISF/suricata-trafficid/master/rules/traffic-id.rules',
    enabled: true,
    priority: 50,
    badge: 'new',
    notes: 'Новый источник: официальные правила идентификации приложений/сервисов от OISF. Классифицирует трафик (не алерты об атаках).',
    notesEn: 'New source: official application/service identification rules from OISF. Classifies traffic (not attack alerts).',
  },

  // ── Свежие CVE (daffainfo/suricata-rules, на базе nuclei-templates) ──────
  {
    name: 'Daffainfo CVE Rules (2026)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/daffainfo/suricata-rules/main/http/cves/2026/CVE-2026.rules',
    enabled: true,
    priority: 70,
    badge: 'new',
    notes: 'Новый источник: свежие CVE-правила по nuclei-шаблонам ProjectDiscovery (46 правил 2026 г., SID 22026xxx — конфликтов нет). Репозиторий обновляется; годы 2000–2024 доступны по аналогичному URL .../cves/<год>/CVE-<год>.rules. Лицензия Apache-2.0.',
    notesEn: 'New source: fresh CVE rules from ProjectDiscovery nuclei templates (46 rules for 2026, SID 22026xxx — no conflicts). The repository is updated regularly; years 2000–2024 are available via a similar URL .../cves/<year>/CVE-<year>.rules. Apache-2.0 license.',
  },
  {
    name: 'Daffainfo CVE Rules (2025)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/daffainfo/suricata-rules/main/http/cves/2025/CVE-2025.rules',
    enabled: true,
    priority: 71,
    badge: 'new',
    notes: 'Новый источник: CVE-правила за 2025 год (47 правил, SID 22025xxx) из того же репозитория. Дополняет ET/Snort по свежим web-уязвимостям.',
    notesEn: 'New source: CVE rules for 2025 (47 rules, SID 22025xxx) from the same repository. Complements ET/Snort on recent web vulnerabilities.',
  },
  {
    name: 'Stamus Threat Hunting Rules',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/StamusNetworks/Threat-Hunting-Rules/main/threat-hunting.rules',
    enabled: false,
    priority: 45,
    badge: 'unavailable',
    notes: 'В Clear NDR присутствует как внутренний источник; публичный URL не раскрывается (репозиторий недоступен). Оставьте включённым в самом Clear NDR.',
    notesEn: 'Present in Clear NDR as an internal source; the public URL is not exposed (the repository is unavailable). Keep it enabled inside Clear NDR itself.',
  },
  {
    name: 'Stamus Lateral Movement Ruleset',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://ti.stamus-networks.io/open/stamus-lateral-rules.tar.gz',
    enabled: true,
    priority: 46,
    badge: 'recommended',
    notes: 'Правила бокового движения в Windows-сетях от Stamus Networks (560 правил). Рабочий URL на ti.stamus-networks.io/open/ найден через индекс EveBox Rules (прежний GitHub-ссылка была 404).',
    notesEn: 'Windows lateral-movement rules by Stamus Networks (560 rules). A working URL at ti.stamus-networks.io/open/ was found via the EveBox Rules index (the old GitHub link returned 404).',
  },

  // ── Abuse.ch ───────────────────────────────────────────────────────────────
  {
    name: 'Abuse.ch SSL Blacklist (SSL certificates)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://sslbl.abuse.ch/blacklist/sslblacklist.rules',
    enabled: true,
    priority: 60,
    badge: 'recommended',
    notes: 'Aлерты по JA3-отпечаткам вредоносных TLS-сертификатов C&C. Работает.',
    notesEn: 'Alerts on JA3 fingerprints of malicious C&C TLS certificates. Works.',
  },
  {
    name: 'Abuse.ch Suricata JA3 Fingerprint Ruleset',
    category: 'ruleset',
    kind: 'url',
    url: 'https://sslbl.abuse.ch/blacklist/ja3_fingerprints.rules',
    enabled: true,
    priority: 61,
    badge: 'recommended',
    notes: 'Алерты по JA3-отпечаткам вредоносных TLS-клиентов (C&C, adware). Новый URL после реорганизации sslbl.abuse.ch (старый /ja3_fingerprints/JA3suricata.rules отдал 404). Не пересекается с SSL Blacklist выше: там — сертификаты, здесь — JA3-отпечатки клиентов.',
    notesEn: 'Alerts on JA3 fingerprints of malicious TLS clients (C&C, adware). New URL after the sslbl.abuse.ch reorganization (the old /ja3_fingerprints/JA3suricata.rules returned 404). Does not overlap with SSL Blacklist above: that one covers certificates, this one covers client JA3 fingerprints.',
  },
  {
    name: 'Threatfox Indicators of Compromise',
    category: 'ruleset',
    kind: 'url',
    url: 'https://threatfox-api.abuse.ch/v2/files/exports/%%AUTHKEY%%/threatfox_suricata.rules',
    authType: 'authkey',
    enabled: false,
    priority: 62,
    badge: 'unavailable',
    notes: 'Прямая выгрузка закрыта (HTTP 410): с 10.2026 abuse.ch требует бесплатный Auth-Key (сегмент пути выгрузки, подставляется вместо %%AUTHKEY%%). Ключ задаётся один раз в «Настройки → abuse.ch Auth-Key»: зарегистрируйтесь на auth.abuse.ch → создайте ключ → включите источник.',
    notesEn: 'Direct download is closed (HTTP 410): since 10/2026 abuse.ch requires a free Auth-Key (a path segment substituted for %%AUTHKEY%%). Set the key once in "Settings → abuse.ch Auth-Key": register at auth.abuse.ch → create a key → enable the source.',
  },
  {
    name: 'Abuse.ch URLhaus IDS Ruleset (malicious URLs)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://urlhaus-api.abuse.ch/v2/files/exports/%%AUTHKEY%%/urlhaus_ids.rules',
    authType: 'authkey',
    enabled: false,
    priority: 66,
    badge: 'new',
    notes: 'Suricata-правила по URL распространения малвари из URLhaus (срабатывание на точный URL в HTTP-запросе). Требует тот же бесплатный Auth-Key abuse.ch, что и ThreatFox (настройки → abuse.ch Auth-Key).',
    notesEn: 'Suricata rules for malware distribution URLs from URLhaus (trigger on the exact URL in an HTTP request). Requires the same free abuse.ch Auth-Key as ThreatFox (Settings → abuse.ch Auth-Key).',
  },
  {
    name: 'Feodo Tracker Botnet C2 (rules)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://feodotracker.abuse.ch/downloads/feodotracker.rules',
    enabled: true,
    priority: 63,
    badge: 'recommended',
    notes: 'Правила по C&C-серверам ботнетов семейства Dridex/Emotet/TrickBot и др.',
    notesEn: 'Rules for C&C servers of Dridex/Emotet/TrickBot and other botnet families.',
  },
  {
    name: 'Feodo Tracker Botnet C2 (IP list → правила)',
    category: 'ip-list',
    kind: 'url',
    url: 'https://feodotracker.abuse.ch/downloads/ipblocklist.txt',
    enabled: true,
    priority: 64,
    badge: 'converter',
    notes: 'Новый источник (конвертер): свежие IP C&C из Feodo Tracker конвертируются в правила (по 500 IP на правило, SID из приватного диапазона).',
    notesEn: 'New source (converter): fresh Feodo Tracker C&C IPs converted into rules (500 IPs per rule, SIDs from a private range).',
    extraJson: JSON.stringify({ sidStart: 1100100, msgPrefix: 'FEODO-C2 known botnet C2 IP' }),
  },

  // ── Через индекс EveBox Rules (rules.evebox.org/app/rulesets): уникальные ─
  // наборы, которых нет выше; et/open, sslbl, feodotracker, trafficid там же —
  // уже подключены отдельными источниками (дубликаты не добавляем)
  {
    name: 'AntiPhishing Ruleset (julioliraup)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://raw.githubusercontent.com/julioliraup/Antiphishing/refs/heads/main/antiphishing.tar.gz',
    enabled: false,
    priority: 120,
    badge: 'new',
    notes: 'Готовые Suricata-правила по фишинговым URL/доменам (Phishstats, Openphish), обновление ежечасно, ~39 000 правил — заметная нагрузка на движок, включайте осознанно. GPL-3.0. Найдено через индекс EveBox Rules.',
    notesEn: 'Ready-made Suricata rules for phishing URLs/domains (Phishstats, Openphish), updated hourly, ~39,000 rules — a noticeable load on the engine, enable deliberately. GPL-3.0. Found via the EveBox Rules index.',
  },
  {
    name: 'PAW Patrules (IDPS/NSM)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://github.com/woundride/pawpatrules/archive/refs/heads/main.tar.gz',
    extraJson: JSON.stringify({ mirrorUrls: ['https://rules.pawpatrules.fr/suricata/paw-patrules.tar.gz'] }),
    enabled: false,
    priority: 121,
    badge: 'new',
    notes: 'Французский набор IDPS/NSM (~21 300 правил в 89 файлах: подозрительные потоки, угрозы, IOC групп, боковое движение, shadow IT), обновляется часто. CC-BY-SA-4.0. Найдено через индекс EveBox Rules. Основной URL — архив официального GitHub-репозитория (woundride/pawpatrules); официальный сервер rules.pawpatrules.fr периодически не отвечает — подключён зеркалом (автоматический фолбэк при недоступности основного URL).',
    notesEn: 'French IDPS/NSM set (~21,300 rules in 89 files: suspicious flows, threats, group IOCs, lateral movement, shadow IT), updated frequently. CC-BY-SA-4.0. Found via the EveBox Rules index. The primary URL is an archive of the official GitHub repository (woundride/pawpatrules); the official server rules.pawpatrules.fr is intermittently unresponsive — connected as a mirror (automatic fallback when the primary URL is down).',
  },
  {
    name: 'The Hunters Ledger (MITRE-детекты)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://the-hunters-ledger.com/feeds/suricata/hunters-ledger.rules',
    enabled: true,
    priority: 72,
    badge: 'new',
    notes: 'Детекти из оригинальных расследований, размечены по MITRE ATT&CK (~135 правил). Лицензия CC BY-NC — для коммерческого использования нужно согласование. Найдено через индекс EveBox Rules.',
    notesEn: 'Detections from original investigations, tagged with MITRE ATT&CK (~135 rules). CC BY-NC license — commercial use requires approval. Found via the EveBox Rules index.',
  },
  {
    name: 'Stalkerware IOC Ruleset (Echap)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://github.com/AssoEchap/stalkerware-indicators/raw/refs/heads/master/generated/suricata.rules',
    enabled: true,
    priority: 73,
    badge: 'new',
    notes: 'IOC сталкерских/шпионских приложений Android/iOS (~1 000 правил) от ассоциации Echap. Найдено через индекс EveBox Rules.',
    notesEn: 'IOCs of Android/iOS stalkerware/spyware apps (~1,000 rules) by the Echap association. Found via the EveBox Rules index.',
  },
  {
    name: 'Threat Hunting Rules (travisbgreen)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://github.com/travisbgreen/hunting-rules/raw/master/hunting.rules.tar.gz',
    enabled: true,
    priority: 74,
    badge: 'new',
    notes: 'Эвристический набор правил для threat hunting (~290 правил, упор на аномалии и нововведения движка; производительность не гарантирована). GPLv3. Найдено через индекс EveBox Rules.',
    notesEn: 'Heuristic ruleset for threat hunting (~290 rules, focused on anomalies and engine novelties; performance not guaranteed). GPLv3. Found via the EveBox Rules index.',
  },
  {
    name: 'NMAP Scan Detection (aleksibovellan)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/aleksibovellan/opnsense-suricata-nmaps/main/local.rules',
    enabled: true,
    priority: 75,
    badge: 'new',
    notes: 'Детект Nmap-сканов по TCP-окнам/флагам/таймингам (10 правил). MIT. Найдено через индекс EveBox Rules.',
    notesEn: 'Nmap scan detection by TCP windows/flags/timings (10 rules). MIT. Found via the EveBox Rules index.',
  },
  {
    name: 'IPFire DBL (правила по доменам)',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://dbl.ipfire.org/lists/suricata.tar.gz',
    enabled: true,
    priority: 76,
    badge: 'new',
    notes: 'Доменный блэклист IPFire DBL (malware/phishing/unwanted) в виде готовых Suricata-правил (~60 правил; полный список доменов можно конвертировать отдельно). CC-BY-SA-4.0. Найдено через индекс EveBox Rules.',
    notesEn: 'IPFire DBL domain blacklist (malware/phishing/unwanted) as ready-made Suricata rules (~60 rules; the full domain list can be converted separately). CC-BY-SA-4.0. Found via the EveBox Rules index.',
  },
  {
    name: 'Etnetera Aggressive IP Feed',
    category: 'ruleset',
    kind: 'url',
    url: 'https://security.etnetera.cz/feeds/etn_aggressive.rules',
    enabled: true,
    priority: 77,
    badge: 'new',
    notes: 'Готовые правила по агрессивным IP (сканеры/брутфорс, чешский CSIRT Etnetera, ~60 правил). MIT. Найдено через индекс EveBox Rules.',
    notesEn: 'Ready-made rules for aggressive IPs (scanners/bruteforce, by the Czech CSIRT Etnetera, ~60 rules). MIT. Found via the EveBox Rules index.',
  },

  // ── Конвертеры: списки индикаторов → правила Suricata ──────────────────────
  {
    name: 'CINS Army List (плохие IP)',
    category: 'ip-list',
    kind: 'url',
    url: 'http://cinsscore.com/list/ci-badguys.txt',
    enabled: true,
    priority: 110,
    badge: 'converter',
    notes: 'Новый источник: CINS Score — активные сканеры/брутфорсеры. Конвертируется в правила.',
    notesEn: 'New source: CINS Score — active scanners/bruteforcers. Converted into rules.',
    extraJson: JSON.stringify({ sidStart: 1100200, msgPrefix: 'CINS-ARMY known bad IP' }),
  },
  {
    name: 'Blocklist.de (атакующие IP)',
    category: 'ip-list',
    kind: 'url',
    url: 'https://lists.blocklist.de/lists/all.txt',
    enabled: true,
    priority: 111,
    badge: 'converter',
    notes: 'Новый источник: IP, замеченные в атаках (bruteforce, ssh, mail). ~40 000 записей, чанками по 500.',
    notesEn: 'New source: IPs seen in attacks (bruteforce, ssh, mail). ~40,000 entries, in chunks of 500.',
    extraJson: JSON.stringify({ sidStart: 1100400, msgPrefix: 'BLOCKLIST-DE attacker IP', maxRules: 200 }),
  },
  {
    name: 'Spamhaus DROP (угнанные сети)',
    category: 'ip-list',
    kind: 'url',
    url: 'https://www.spamhaus.org/drop/drop.txt',
    enabled: true,
    priority: 112,
    badge: 'converter',
    notes: 'Новый источник: CIDR-диапазоны «угнанных» сетей для блокировки. Поддерживаются маски /24 и короче.',
    notesEn: 'New source: CIDR ranges of "hijacked" networks for blocking. Masks of /24 or shorter are supported.',
    extraJson: JSON.stringify({ sidStart: 1100600, msgPrefix: 'SPAMHAUS-DROP hijacked netblock' }),
  },
  {
    name: 'Phishing Army (антифишинг)',
    category: 'domain-list',
    kind: 'url',
    url: 'https://phishing.army/download/phishing_army_blocklist_extended.txt',
    enabled: true,
    priority: 113,
    badge: 'converter',
    notes: 'Новый источник (антифишинг): домены фишинга → DNS-правила. Расширенный список (~200 000 доменов, ограничение maxRules в настройках источника).',
    notesEn: 'New source (anti-phishing): phishing domains → DNS rules. Extended list (~200,000 domains, limited by maxRules in the source settings).',
    extraJson: JSON.stringify({ sidStart: 1100800, msgPrefix: 'PHISHING-ARMY known phishing domain', maxRules: 5000 }),
  },

  // ── Локальные архивы (предзагруженные с Яндекс.Диска / snort.org) ──────────
  {
    name: '[локальный архив] snortrules-snapshot-3200.tar.gz',
    category: 'ruleset',
    kind: 'local',
    url: `${LOCAL_ARCHIVES_DIR}/snortrules-snapshot-3200.tar.gz`,
    enabled: false,
    priority: 11,
    badge: 'recommended',
    notes: 'Локальная копия зарегистрированного набора Snort 3 (53 237 правил). Используйте, если snort.org недоступен или лимит загрузок исчерпан.',
    notesEn: 'Local copy of the registered Snort 3 set (53,237 rules). Use when snort.org is unreachable or the download limit is exhausted.',
  },
  {
    name: '[локальный архив] Talos_LightSPD.tar.gz',
    category: 'ruleset',
    kind: 'local',
    url: `${LOCAL_ARCHIVES_DIR}/Talos_LightSPD.tar.gz`,
    enabled: false,
    priority: 13,
    badge: 'duplicate',
    notes: 'Локальная копия LightSPD — полный дубликат snapshot-3200 (100% SID).',
    notesEn: 'Local copy of LightSPD — a full duplicate of snapshot-3200 (100% of SIDs).',
  },
  {
    name: '[локальный архив] snortrules-snapshot-29200.tar.gz',
    category: 'ruleset',
    kind: 'local',
    url: `${LOCAL_ARCHIVES_DIR}/snortrules-snapshot-29200.tar.gz`,
    enabled: false,
    priority: 16,
    badge: 'legacy',
    notes: 'Локальная копия Snort 2.9 набора (16 035 правил; так же дублирует Snort 3 по 15 216 SID).',
    notesEn: 'Local copy of the Snort 2.9 set (16,035 rules; likewise duplicates the Snort 3 set on 15,216 SIDs).',
  },
  {
    name: '[локальный архив] community-rules.tar.gz',
    category: 'ruleset',
    kind: 'local',
    url: `${LOCAL_ARCHIVES_DIR}/community-rules.tar.gz`,
    enabled: false,
    priority: 41,
    badge: 'duplicate',
    notes: 'Локальная копия community-правил Snort 2 (568 правил, дубликат).',
    notesEn: 'Local copy of Snort 2 community rules (568 rules, duplicate).',
  },
  {
    name: '[локальный архив] snort3-community-rules.tar.gz',
    category: 'ruleset',
    kind: 'local',
    url: `${LOCAL_ARCHIVES_DIR}/snort3-community-rules.tar.gz`,
    enabled: false,
    priority: 42,
    badge: 'duplicate',
    notes: 'Локальная копия community-правил Snort 3 (4 026 правил, дубликат).',
    notesEn: 'Local copy of Snort 3 community rules (4,026 rules, duplicate).',
  },
]

export const DEFAULT_SETTINGS: Record<string, string> = {
  oinkcode: process.env.OINKCODE || '',
  abusechAuthKey: process.env.ABUSECH_AUTH_KEY || '', // Auth-Key abuse.ch (ThreatFox/URLhaus, сегмент пути выгрузки)
  dedupSidStrategy: 'highest-rev', // highest-rev | source-priority | renumber-private
  dedupContent: 'true',
  dropIncompatible: 'true',
  dropDisabledMsg: 'true',
  privateSidStart: '1000000',
  buildFileName: 'clearndr-import.rules',
  buildFormat: 'file', // file | file+tgz (файл + архив с правилами по источникам)
  serveToken: '', // ключ отдачи итогового набора по URL (PULL-схема): ?token= / authkey источника Clear NDR; пусто = без защиты
  downloadBandwidthKbps: '0', // суммарная скорость отдачи /api/export (КБ/с); 0 — без ограничения (балансировка канала)
  // ── Многопользовательский режим (Enterprise) ────────────────────────────────
  registrationOpen: 'true', // открыта ли регистрация новых пользователей (вкладка «Пользователи»)
  sessionTtlHours: '24', // срок жизни сессии веб-интерфейса (часы; продлевается при активности)
  clearndrExportMode: 'file', // file | clearndr | http | local-path | disabled
  clearndrExportUrl: '', // clearndr: базовый URL (например https://clearndr.local); http: полный адрес POST-эндпоинта
  clearndrExportToken: '', // API-токен Scirius (Clear NDR → меню пользователя → Edit Token)
  clearndrExportAuth: 'token', // token | bearer | none — формат заголовка Authorization
  clearndrExportSource: 'NDR Rules Hub', // имя локального источника в Clear NDR (режим clearndr)
  clearndrExportApply: 'true', // вызывать update_push_all после загрузки (режим clearndr)
  clearndrExportLocalPath: '',
  cronEnabled: 'false',
  cronSchedule: '0 4 * * *', // ежедневно в 04:00
  cronExport: 'true',
  vpnEnabled: 'false', // гнать загрузки через WireGuard
  vpnInterface: 'wg0',
  homeNet: '192.168.0.0/16,10.0.0.0/8',
  // ── Мониторинг диска и автоочистка (вкладка «Настройки» → «Диск и очистка») ──
  diskWarnPct: '85', // порог предупреждения на «Обзоре»
  diskCriticalPct: '92', // порог критического состояния (уведомление)
  cleanupAutoEnabled: 'false', // автоматическая очистка по расписанию/порогу
  cleanupSchedule: '17 * * * *', // частота проверки (cron): ежечасно на 17-й минуте
  cleanupTriggerPct: '90', // занятость диска, при которой запускается очистка
  cleanupFreeTargetPct: '80', // прекращать очистку, когда занятость опустилась до
  cleanupOsEnabled: 'true', // удалять старые индексы OpenSearch
  cleanupOsKeepDays: '14', // индексы старше N дней — кандидаты на удаление
  cleanupOsPrefixes: 'logstash-,ndr-,eve-,suricata-,selks-', // только эти префиксы (системные .kibana и др. не трогаются)
  cleanupOsMaxDelete: '50', // максимум индексов за один запуск (страховка)
  cleanupOsUrl: '', // URL OpenSearch; пусто — автопоиск (127.0.0.1/172.17.0.1/host.docker.internal:9200, docker exec)
  cleanupCacheEnabled: 'true', // чистить кэш архивов источников хаба
  cleanupCacheKeepDays: '14',
  cleanupLogsEnabled: 'true', // удалять старые логи в указанных каталогах
  cleanupLogDirs: '', // доп. каталоги логов через запятую (напр. /mnt/clearndr/logs)
  cleanupLogKeepDays: '7',
  cleanupFilesEnabled: 'false', // искать большие файлы
  cleanupFileDirs: '', // где искать (через запятую); поиск идёт ТОЛЬКО здесь
  cleanupLargeFileMb: '500',
  cleanupFileKeepDays: '7',
  cleanupFilesDelete: 'false', // false — только отчёт; true — удалять найденное
  // ── Уведомления (вкладка «Интеграции» → «Уведомления и сервисы») ────────
  notifyTgEnabled: 'false',
  tgBotToken: '',
  tgChatId: '',
  tgProxy: '', // http(s)://user:pass@host:port или socks5://user:pass@host:port
  tgApiBase: 'https://api.telegram.org',
  notifyGotifyEnabled: 'false',
  gotifyUrl: '',
  gotifyToken: '', // app-токен Gotify (не клиентский)
  gotifyPriority: '5',
  notifyOnPipeline: 'true', // события конвейера: загрузка/сборка/экспорт
  notifyOnVpn: 'true', // события WireGuard: поднятие/остановка туннеля
  notifyOnDisk: 'true', // события диска: очистка, пороги занятости
  // ── 2FA / Telegram-бот / рассылка о версиях ─────────────────────────────────
  releaseBroadcastEnabled: 'true', // уведомлять всех с привязанным Telegram о новой версии
  releaseNotes: '', // текст «что нового», добавляемый к рассылке о версии
}
