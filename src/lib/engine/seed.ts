// ─────────────────────────────────────────────────────────────────────────────
// Каталог источников правил + настройки по умолчанию (первичная инициализация)
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '@/lib/db'
import { getSetting as getSettingRaw } from './service'
import { log } from './service'

export interface SeedSource {
  name: string
  category: 'ruleset' | 'ip-list' | 'domain-list' | 'url-list' | 'zeek-intel' | 'misp'
  kind: 'url' | 'tarball' | 'local'
  url?: string
  authType?: 'none' | 'oinkcode' | 'authkey' | 'basic' | 'misp' | 'opennrd'
  extraJson?: string
  enabled?: boolean
  priority?: number
  badge?: 'recommended' | 'duplicate' | 'legacy' | 'paid' | 'converter' | 'traffic' | 'hunting' | 'unavailable'
  notes?: string
  notesEn?: string // примечание на английском (для EN-интерфейса)
  adminOnly?: boolean // источник только для администратора (ET Pro, MISP): секреты уровня системы
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
    badge: 'recommended',
    notes: 'Свежие открытые правила Positive Technologies (обновления продолжаются, ~430+ правил: attacks/malware/info/windows/tools). Сервер блокирует не-браузерный User-Agent — в extra задан userAgent, при ручном добавлении скопируйте его. Найдено через индекс EveBox Rules.',
    notesEn: 'Fresh open Positive Technologies rules (still updated, ~430+ rules: attacks/malware/info/windows/tools). The server blocks non-browser User-Agents — a userAgent is preset in extra; copy it when adding manually. Found via the EveBox Rules index.',
    extraJson: JSON.stringify({ subPath: 'rules', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }),
  },
  {
    name: 'Quadrant Suricata Ruleset',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/quadrantsec/suricata-rules/main/quadrant-suricata.rules',
    enabled: true,
    priority: 35,
    badge: 'recommended',
    notes: 'Открытый набор Quadrant Information Security (~2 000 правил, много прикладных детектов SCADA/ICS).',
    notesEn: 'Open ruleset by Quadrant Information Security (~2,000 rules, many applied SCADA/ICS detections).',
  },
  {
    name: 'Suricata Traffic ID Ruleset (OISF)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/OISF/suricata-trafficid/master/rules/traffic-id.rules',
    enabled: true,
    priority: 50,
    badge: 'traffic',
    notes: 'Официальные правила идентификации приложений/сервисов от OISF. Классифицирует трафик (НЕ алерты об атаках) — полезно для разметки, не для обнаружения угроз.',
    notesEn: 'Official application/service identification rules from OISF. Classifies traffic (NOT attack alerts) — useful for labeling, not threat detection.',
  },

  // ── Свежие CVE (daffainfo/suricata-rules, на базе nuclei-templates) ──────
  {
    name: 'Daffainfo CVE Rules (2026)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/daffainfo/suricata-rules/main/http/cves/2026/CVE-2026.rules',
    enabled: true,
    priority: 70,
    badge: 'recommended',
    notes: 'Свежие CVE-правила по nuclei-шаблонам ProjectDiscovery (46 правил 2026 г., SID 22026xxx — конфликтов нет). Репозиторий обновляется; годы 2000–2024 доступны по аналогичному URL .../cves/<год>/CVE-<год>.rules. Лицензия Apache-2.0.',
    notesEn: 'Fresh CVE rules from ProjectDiscovery nuclei templates (46 rules for 2026, SID 22026xxx — no conflicts). The repository is updated regularly; years 2000–2024 are available via a similar URL .../cves/<year>/CVE-<year>.rules. Apache-2.0 license.',
  },
  {
    name: 'Daffainfo CVE Rules (2025)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/daffainfo/suricata-rules/main/http/cves/2025/CVE-2025.rules',
    enabled: true,
    priority: 71,
    badge: 'recommended',
    notes: 'CVE-правила за 2025 год (47 правил, SID 22025xxx) из того же репозитория. Дополняет ET/Snort по свежим web-уязвимостям.',
    notesEn: 'CVE rules for 2025 (47 rules, SID 22025xxx) from the same repository. Complements ET/Snort on recent web vulnerabilities.',
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
    badge: 'recommended',
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
    badge: 'recommended',
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
    badge: 'recommended',
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
    badge: 'hunting',
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
    badge: 'recommended',
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
    badge: 'hunting',
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
    badge: 'recommended',
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
    badge: 'recommended',
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
    badge: 'recommended',
    notes: 'Готовые правила по агрессивным IP (сканеры/брутфорс, чешский CSIRT Etnetera, ~60 правил). MIT. Найдено через индекс EveBox Rules.',
    notesEn: 'Ready-made rules for aggressive IPs (scanners/bruteforce, by the Czech CSIRT Etnetera, ~60 rules). MIT. Found via the EveBox Rules index.',
  },

  {
    name: 'Stamus Open NRD (новые домены, 30 дней)',
    category: 'domain-list',
    kind: 'tarball',
    url: 'https://ti.stamus-networks.io/%%OPENNRD%%/sti-domains-nrd-30.tar.gz',
    authType: 'opennrd',
    enabled: false,
    priority: 90,
    badge: 'recommended',
    notes: 'Open NRD от Stamus Networks — все домены, зарегистрированные за последние 30 дней (обновляется ежедневно, архив со списком доменов; конвертируется в DNS-правила). Код лицензии — БЕСПЛАТНО на год (продление бесплатно): заполните форму stamus-networks.com/stamus-labs/subscribe-to-threat-intel-feed, код придёт письмом; введите его в «Настройки → Токены источников → Open NRD (Stamus Networks)» — он подставляется в URL вместо %%OPENNRD%%. Смежные фиды (entropy/phishing, 14/30 дней) добавляются источниками с тем же кодом: sti-domains-entropy-30.tar.gz, sti-domains-phishing-30.tar.gz и т. д.',
    notesEn: 'Open NRD by Stamus Networks — all domains registered in the last 30 days (updated daily, archive with a domain list; converted into DNS rules). The license code is FREE for a year (free renewal): fill the form at stamus-networks.com/stamus-labs/subscribe-to-threat-intel-feed, the code arrives by email; enter it in "Settings → Source tokens → Open NRD (Stamus Networks)" — it is substituted into the URL for %%OPENNRD%%. Related feeds (entropy/phishing, 14/30 days) can be added as sources with the same code: sti-domains-entropy-30.tar.gz, sti-domains-phishing-30.tar.gz, etc.',
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

  // ── Новые фиды по итогам анализа открытых каталогов (11.2026): ET blockrules,
  // Binary Defense, ET Pro, Zeek intel CriticalPathSecurity, MISP ─────────────
  {
    name: 'ET Compromised IPs (blockrules)',
    category: 'ip-list',
    kind: 'url',
    url: 'https://rules.emergingthreats.net/blockrules/compromised-ips.txt',
    enabled: true,
    priority: 114,
    badge: 'converter',
    notes: 'Угнанные/компрометированные хосты от Proofpoint (ET blockrules, обычный текст, обновляется ежедневно). Конвертируется в правила чанками по 500 IP. Дополняет Spamhaus DROP и Feodo.',
    notesEn: 'Compromised hosts from Proofpoint (ET blockrules, plain text, updated daily). Converted into rules in chunks of 500 IPs. Complements Spamhaus DROP and Feodo.',
    extraJson: JSON.stringify({ sidStart: 1101000, msgPrefix: 'ET-COMPROMISED compromised host IP' }),
  },
  {
    name: 'Binary Defense Banlist (атакующие IP)',
    category: 'ip-list',
    kind: 'url',
    url: 'https://binarydefense.com/banlist.txt',
    enabled: true,
    priority: 115,
    badge: 'converter',
    notes: 'Активные сканеры, брутфорсеры и ботнет-узлы от Binary Defense Systems (обычный текст, обновляется регулярно). Конвертируется в правила; пересекается с CINS/Blocklist.de — дедупликация в сборке убирает повторяющиеся IP.',
    notesEn: 'Active scanners, brute-forcers and botnet nodes by Binary Defense Systems (plain text, updated regularly). Converted into rules; overlaps with CINS/Blocklist.de — build deduplication removes repeated IPs.',
    extraJson: JSON.stringify({ sidStart: 1101100, msgPrefix: 'BINARY-DEFENSE known malicious IP' }),
  },
  {
    name: 'ET Pro Ruleset (Emerging Threats Pro)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://rules.emergingthreatspro.com/%%OINKCODE%%/suricata-7.0/etpro.rules.tar.gz',
    authType: 'oinkcode',
    enabled: false,
    priority: 25,
    badge: 'paid',
    adminOnly: true,
    notes: 'Платный набор ET Pro (~40 000 правил, обновляется ежедневно: продвинутая малварь, C2, web-атаки; поверх ET Open). ВАЖНО: у ET Pro СВОЙ oinkcode, он НЕ совпадает с кодом snort.org — выдается Proofpoint после покупки подписки (etadmin.proofpoint.com/etpro, формат $oinkcode/suricata-<версия>/etpro.rules.tar.gz). Код подставляется вместо %%OINKCODE%%: укажите его в «Настройки» → «Oinkcode ET Pro» (или в extra источника {"oinkcode":"…"}). Снортовский код к этому источнику не применяется. Без действующего кода сервер вернёт ошибку. Источник только для администратора: пользователи видят его в своих пространствах только если администратор опубликовал его копию.',
    notesEn: 'Paid ET Pro ruleset (~40,000 rules, updated daily: advanced malware, C2, web attacks; a superset of ET Open). IMPORTANT: ET Pro has its OWN oinkcode, it is NOT the snort.org code — issued by Proofpoint after purchasing the subscription (etadmin.proofpoint.com/etpro, $oinkcode/suricata-<version>/etpro.rules.tar.gz format). The code is substituted for %%OINKCODE%%: set it in “Settings” → “ET Pro Oinkcode” (or in the source extra {"oinkcode":"…"}). The snort.org code is NOT applied to this source. Without a valid code the server returns an error.',
  },
  {
    name: 'Cobalt Strike C2 IPs (CriticalPathSecurity, Zeek intel)',
    category: 'zeek-intel',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/CriticalPathSecurity/Zeek-Intelligence-Feeds/master/cobaltstrike_ips.intel',
    enabled: true,
    priority: 116,
    badge: 'converter',
    notes: 'IP-адреса C2-серверов Cobalt Strike (агрегат Critical Path Security; в репо также OTX, Binary Defense и собственные данные CPS). Формат Zeek intel (TSV, Intel::ADDR) конвертируется в IP-правила чанками по 500.',
    notesEn: 'Cobalt Strike C2 server IPs (aggregated by Critical Path Security; the repo also includes OTX, Binary Defense and CPS own data). Zeek intel format (TSV, Intel::ADDR) converted into IP rules in chunks of 500.',
    extraJson: JSON.stringify({ sidStart: 1101200, msgPrefix: 'CPS-COBALTSTRIKE C2 IP' }),
  },
  {
    name: 'Tor Exit Nodes (CriticalPathSecurity, Zeek intel)',
    category: 'zeek-intel',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/CriticalPathSecurity/Zeek-Intelligence-Feeds/master/tor-exit.intel',
    enabled: false,
    priority: 117,
    badge: 'converter',
    notes: 'Выходные узлы Tor (Zeek intel, обновляется CPS). Не малварь: срабатывания означают анонимизацию трафика — включайте, если политика запрещает Tor (иначе ложно-положительные на легитимные сервисы). Конвертируется в IP-правила.',
    notesEn: 'Tor exit nodes (Zeek intel, updated by CPS). Not malware: hits mean traffic anonymization — enable if your policy forbids Tor (otherwise false positives on legitimate services). Converted into IP rules.',
    extraJson: JSON.stringify({ sidStart: 1101300, msgPrefix: 'CPS-TOR-EXIT exit node IP' }),
  },
  {
    name: 'MISP Suricata Export (events/nids/suricata/download)',
    category: 'ruleset',
    kind: 'url',
    url: 'https://misp.example.local/events/nids/suricata/download',
    authType: 'misp',
    enabled: false,
    priority: 130,
    adminOnly: true,
    notes: 'Интеграция с платформой threat intelligence MISP. Замените misp.example.local на адрес вашего MISP. Готовые Suricata-правила по всем опубликованным событиям; для одного события добавьте его ID в конец URL (.../download/<ID>). Ключ: «Настройки → MISP API Key» (REST-ключ пользователя MISP, заголовок Authorization). Источник только для администратора: ключ MISP — секрет уровня системы.',
    notesEn: 'Integration with the MISP threat intelligence platform. Replace misp.example.local with your MISP address. Ready-made Suricata rules for all published events; for a single event append its ID to the URL (.../download/<ID>). Key: "Settings → MISP API Key" (the MISP user REST key, Authorization header).',
  },
  {
    name: 'MISP Attributes (restSearch JSON → конвертер)',
    category: 'misp',
    kind: 'url',
    url: 'https://misp.example.local/attributes/restSearch.json?returnFormat=json&limit=20000&published=1&enforceWarninglist=1',
    authType: 'misp',
    enabled: false,
    priority: 131,
    adminOnly: true,
    badge: 'converter',
    notes: 'Конвертер атрибутов MISP (REST /attributes/restSearch.json): ip-dst/ip-src → IP-правила (чанками), domain/hostname → DNS-правила, url/uri → HTTP-правила. Хэши и не-сетевые типы пропускаются. GET-фильтры в URL можно править (type=, tag=, category=, published=, enforceWarninglist=). Ключ: «Настройки → MISP API Key». Источник только для администратора.',
    notesEn: 'MISP attribute converter (REST /attributes/restSearch.json): ip-dst/ip-src → IP rules (chunked), domain/hostname → DNS rules, url/uri → HTTP rules. Hashes and non-network types are skipped. GET filters in the URL are editable (type=, tag=, category=, published=, enforceWarninglist=). Key: "Settings → MISP API Key".',
    extraJson: JSON.stringify({ sidStart: 1101400, msgPrefix: 'MISP' }),
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
  // oinkcode ET Pro (Proofpoint) — НЕ совпадает с кодом snort.org, подставляется
  // только в источник «ET Pro Ruleset» (rules.emergingthreatspro.com)
  etProOinkcode: process.env.ETPRO_OINKCODE || '',
  abusechAuthKey: process.env.ABUSECH_AUTH_KEY || '', // Auth-Key abuse.ch (ThreatFox/URLhaus, сегмент пути выгрузки)
  mispAuthKey: process.env.MISP_AUTH_KEY || '', // ключ REST API MISP (заголовок Authorization)
  openNrdLicense: process.env.OPENNRD_LICENSE || '', // код лицензии Open NRD (Stamus Networks) — сегмент пути ti.stamus-networks.io/<КОД>/…
  dedupSidStrategy: 'highest-rev', // highest-rev | source-priority — только выбор победителя конфликта SID
  dedupSidConflict: 'drop', // drop | reassign — судьба проигравшего при конфликте SID с другим детектом
  dedupContent: 'true',
  dropIncompatible: 'true',
  dropDisabledMsg: 'true',
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
  notifyOnDns: 'true', // события DNS-списков: отдельный DNS-цикл (обновление источников + сборка списка)
  // ── 2FA / Telegram-бот / рассылка о версиях ─────────────────────────────────
  releaseBroadcastEnabled: 'true', // уведомлять всех с привязанным Telegram о новой версии
  releaseNotes: '', // текст «что нового», добавляемый к рассылке о версии
  // ── MISP (вкладка «Интеграции» → «MISP») ────────────────────────────────────
  mispUrl: '', // базовый URL MISP (коннекторы и источник-фид; деплой подставляет сам)
  mispDistribution: '1', // распределение событий: 0 org,1 community,2 connected,3 all
  mispThreatLevel: '2', // threat level: 1 High … 4 Undefined
  mispPublished: 'false', // публиковать события сразу (false — на согласование)
  mispTagPrefix: 'ndr-hub', // тег-метка, добавляемый ко всем событиям хаба
  mispDeployPort: '8408', // порт хоста для ndr-misp-nginx
  mispDeployBaseUrl: '', // BASE_URL стека MISP (http://<адрес>:порт); пусто — автоподстановка
  mispIngestToken: '', // токен webhook-приёмника /api/misp/ingest (uuWAF и др.)
  // коннекторы: включение, интервал (мин), состояние последнего запуска
  mispConnClearndrEnabled: 'false',
  mispConnClearndrInterval: '15',
  mispConnClearndrIndex: 'logstash-*', // индекс Suricata-алертов Clear NDR
  mispConnClearndrLastRun: '',
  mispConnClearndrLastStatus: '',
  mispConnClearndrLastCount: '0',
  mispConnWazuhEnabled: 'false',
  mispConnWazuhUrl: '', // Wazuh Indexer (https://<хост>:9200)
  mispConnWazuhUser: 'admin',
  mispConnWazuhPass: '',
  mispConnWazuhIndex: 'wazuh-states-vulnerabilities-*',
  mispConnWazuhInterval: '60',
  mispConnWazuhLastRun: '',
  mispConnWazuhLastStatus: '',
  mispConnWazuhLastCount: '0',
  mispConnZabbixEnabled: 'false',
  mispConnZabbixUrl: '', // http://<хост>/api_jsonrpc.php
  mispConnZabbixUser: 'Admin',
  mispConnZabbixPassword: '',
  mispConnZabbixToken: '', // API-токен Zabbix 5.4+ (альтернатива user/pass)
  mispConnZabbixMinSeverity: '2', // минимальная важность проблем (0..5)
  mispConnZabbixInterval: '15',
  mispConnZabbixLastRun: '',
  mispConnZabbixLastStatus: '',
  mispConnZabbixLastCount: '0',
  mispConnMikrotikEnabled: 'false',
  mispConnMikrotikUrl: '', // https://<роутер>/rest (RouterOS v7, REST включён)
  mispConnMikrotikUser: 'admin',
  mispConnMikrotikPass: '',
  mispConnMikrotikLists: '', // фильтр названий address-list через запятую (пусто — все)
  mispConnMikrotikInterval: '15',
  mispConnMikrotikLastRun: '',
  mispConnMikrotikLastStatus: '',
  mispConnMikrotikLastCount: '0',
  // ── DNS-фильтрация (вкладка «DNS-фильтрация») ─────────────────────────────
  dnsBuildFormat: 'plain', // plain | hosts | dnsmasq | adblock — формат итогового файла
  dnsFileName: 'blocked-domains.txt', // имя итогового файла списка доменов
  dnsCronEnabled: 'true', // полный цикл (cron/«Полный цикл») обновляет DNS-источники и пересобирает список
  dnsCronSchedule: '', // отдельное расписание DNS-цикла (cron): разнести по времени с основным циклом; пусто — сразу за основным
  dnsServeToken: '', // глобальный ключ отдачи /api/dns/export; пусто — открытая отдача (как и у правил)
}

// ─────────────────────────────────────────────────────────────────────────────
// Каталог DNS-источников (фильтрация нежелательных ресурсов по доменам).
// Приоритет задаёт, кто забирает домен себе при дубликате между списками:
// чем меньше число, тем раньше источник обрабатывается (угрозы → трекеры →
// тематические списки → реклама → смешанные; для белых списков порядок не важен).
// ─────────────────────────────────────────────────────────────────────────────

export interface DnsSeedSource {
  name: string
  url?: string
  kind?: 'url' | 'local'
  format?: 'auto' | 'adguard' | 'hosts' | 'plain'
  category: string // ключ DomainCategory: ads | tracking | malware | phishing | gambling | piracy | adult | spam | rkn | mixed | allowlist
  purpose?: 'block' | 'allow'
  enabled?: boolean
  priority?: number
  notes?: string
  notesEn?: string
}

export const DNS_CATALOG: DnsSeedSource[] = [
  // ── Угрозы: threat intelligence, малварь ────────────────────────────────────
  {
    name: "HaGeZi's Threat Intelligence Feeds",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_44.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Крупнейший threat-intel фид HaGeZi (~1,6 млн доменов): C2, малварь, фишинг, скам. Основной источник блока угроз.',
    notesEn: "The largest HaGeZi threat-intel feed (~1.6M domains): C2, malware, phishing, scams. The primary threat-block source.",
  },
  {
    name: 'POL: CERT Polska List of malicious domains',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_41.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Список вредоносных доменов CERT Polska (~107 тыс.): ботнеты, фишинг, распространители малвари. Официальный источник польского CSIRT.',
    notesEn: 'Malicious domain list by CERT Polska (~107K): botnets, phishing, malware distribution. Official Polish CSIRT source.',
  },
  {
    name: "Dandelion Sprout's Anti-Malware List",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_12.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Список доменов-распространителей вредоносного ПО (~12,5 тыс.), собран из нескольких фидов.',
    notesEn: 'Malware distribution domains (~12.5K), aggregated from multiple feeds.',
  },
  {
    name: "ShadowWhisperer's Malware List",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_42.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Домены вредоносного ПО и нежелательного софта (~29,5 тыс.).',
    notesEn: 'Malware and unwanted software domains (~29.5K).',
  },
  {
    name: 'Malicious URL Blocklist (URLHaus)',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_11.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Домены вредоносных URL из фида abuse.ch URLhaus (~2 тыс.), обновляется в реальном времени.',
    notesEn: 'Malicious URL domains from abuse.ch URLhaus feed (~2K), updated in real time.',
  },
  {
    name: 'The Big List of Hacked Malware Web Sites',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_9.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Список взломанных и заражённых сайтов (~13,5 тыс., dns-bh cybercrime-tracker).',
    notesEn: 'Hacked and malware-infected websites (~13.5K, cybercrime-tracker dns-bh).',
  },
  {
    name: 'NoCoin Filter List',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_8.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Домены скрытого криптоджекинга (~300): майнинг-скрипты без согласия пользователя.',
    notesEn: 'Cryptojacking domains (~300): mining scripts without user consent.',
  },
  {
    name: "HaGeZi's Badware Hoster Blocklist",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_55.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Хостинги и CDN, известные раздачей вредоносного ПО (~1,2 тыс.).',
    notesEn: 'Hosting providers and CDNs known for malware distribution (~1.2K).',
  },
  {
    name: 'Stalkerware Indicators List',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_31.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Индикаторы сталкервари (~900 доменов): C2 и панели слежки за устройствами (фиды ESET/STOPStalkerware).',
    notesEn: 'Stalkerware indicators (~900 domains): C2 and device-tracking panels (ESET/STOPStalkerware feeds).',
  },
  {
    name: 'Ukrainian Security Filter',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_62.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Украинский фид безопасности (~1,7 тыс.): фишинг, малварь, пропагандистские ресурсы.',
    notesEn: 'Ukrainian security feed (~1.7K): phishing, malware, propaganda resources.',
  },
  {
    name: 'uBlock₀ filters – Badware risks',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_50.txt',
    category: 'malware', enabled: true, priority: 20,
    notes: 'Домены с риском вредоносного ПО из списков uBlock Origin (~3,5 тыс.).',
    notesEn: 'Badware-risk domains from uBlock Origin lists (~3.5K).',
  },
  // ── Фишинг и мошенничество ──────────────────────────────────────────────────
  {
    name: 'Phishing Army',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_18.txt',
    category: 'phishing', enabled: true, priority: 21,
    notes: 'Фишинговые домены Phishing Army (~145 тыс., из Telegram-каналов и фидов).',
    notesEn: 'Phishing Army domains (~145K, from Telegram channels and feeds).',
  },
  {
    name: 'Phishing URL Blocklist (PhishTank and OpenPhish)',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_30.txt',
    category: 'phishing', enabled: true, priority: 21,
    notes: 'Фишинговые URL из PhishTank и OpenPhish (~17 тыс.), обновляется каждые 15-30 минут.',
    notesEn: 'Phishing URLs from PhishTank and OpenPhish (~17K), refreshed every 15-30 minutes.',
  },
  {
    name: 'Scam Blocklist by DurableNapkin',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_10.txt',
    category: 'phishing', enabled: true, priority: 21,
    notes: 'Скам-домены (~900): мошеннические магазины, «выигрыши», фейковые сервисы.',
    notesEn: 'Scam domains (~900): fraudulent shops, fake giveaways and services.',
  },
  // ── Трекеры и слежка ────────────────────────────────────────────────────────
  {
    name: 'ShadowWhisperer Tracking List',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_69.txt',
    category: 'tracking', enabled: true, priority: 30,
    notes: 'Домены трекеров и аналитики (~132 тыс.): телеметрия, пиксели слежки, data-брокеры.',
    notesEn: 'Tracking and analytics domains (~132K): telemetry, tracking pixels, data brokers.',
  },
  {
    name: 'WindowsSpyBlocker - Hosts spy rules',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_23.txt',
    category: 'tracking', enabled: true, priority: 30,
    notes: 'Телеметрия Windows (~350 доменов): сбор данных, диагностика, реклама Windows.',
    notesEn: 'Windows telemetry (~350 domains): data collection, diagnostics, Windows ads.',
  },
  {
    name: "HaGeZi's Windows/Office Tracker Blocklist",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_63.txt',
    category: 'tracking', enabled: true, priority: 30,
    notes: 'Трекеры Microsoft Windows и Office (~400).',
    notesEn: 'Microsoft Windows and Office trackers (~400).',
  },
  {
    name: "HaGeZi's Xiaomi Tracker Blocklist",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_60.txt',
    category: 'tracking', enabled: true, priority: 30,
    notes: 'Трекеры Xiaomi MIUI и устройств (~400).',
    notesEn: 'Xiaomi MIUI and device trackers (~400).',
  },
  {
    name: "Perflyst and Dandelion Sprout's Smart-TV Blocklist",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_7.txt',
    category: 'tracking', enabled: true, priority: 30,
    notes: 'Телеметрия Smart-TV (~150): Samsung, LG, Roku, Vizio и др.',
    notesEn: 'Smart-TV telemetry (~150): Samsung, LG, Roku, Vizio, etc.',
  },
  // ── Тематические списки ─────────────────────────────────────────────────────
  {
    name: "HaGeZi's Gambling Blocklist",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_47.txt',
    category: 'gambling', enabled: true, priority: 40,
    notes: 'Домены азартных игр и казино (~670 тыс. — крупнейший тематический список HaGeZi).',
    notesEn: "Gambling and casino domains (~670K — HaGeZi's largest thematic list).",
  },
  {
    name: "HaGeZi's Anti-Piracy Blocklist",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_46.txt',
    category: 'piracy', enabled: true, priority: 40,
    notes: 'Пиратские ресурсы и файлообменники (~62 тыс.).',
    notesEn: 'Piracy sites and file-sharing resources (~62K).',
  },
  {
    name: "ShadowWhisperer's Dating List",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_57.txt',
    category: 'adult', enabled: true, priority: 40,
    notes: 'Сайты знакомств (~1,4 тыс.) — для политики «без dating» в корпоративных сетях.',
    notesEn: 'Dating sites (~1.4K) — for a "no dating" policy in corporate networks.',
  },
  {
    name: "HaGeZi's The World's Most Abused TLDs",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_56.txt',
    category: 'spam', enabled: true, priority: 45,
    notes: 'Злоупотребляемые TLD (~20 одно-меточных записей: .top, .zip, .click…). Блокировка целых доменных зон — может задевать легитимные сайты.',
    notesEn: 'Most abused TLDs (~20 single-label entries: .top, .zip, .click…). Blocks whole TLD zones — may affect legitimate sites.',
  },
  // ── Реклама ─────────────────────────────────────────────────────────────────
  {
    name: '1Hosts (Lite)',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_24.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Лёгкий вариант 1Hosts (~102 тыс.): реклама и трекеры без агрессивных правил.',
    notesEn: '1Hosts Lite variant (~102K): ads and trackers without aggressive rules.',
  },
  {
    name: "Steven Black's List",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_33.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Объединённый hosts-список Steven Black (~76 тыс.): реклама, трекеры, малварь.',
    notesEn: "Steven Black's unified hosts list (~76K): ads, trackers, malware.",
  },
  {
    name: 'AdAway Default Blocklist',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_2.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Стандартный список AdAway (~6,5 тыс.): классический hosts от рекламы.',
    notesEn: 'AdAway default blocklist (~6.5K): classic ad-blocking hosts.',
  },
  {
    name: "Dan Pollock's List",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_4.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Список Дэна Поллока (~13 тыс.): реклама, трекеры, малварь; hosts-формат.',
    notesEn: "Dan Pollock's list (~13K): ads, trackers, malware; hosts format.",
  },
  {
    name: 'AD servers by yoyo.org',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Рекламные серверы yoyo.org (~3,5 тыс.), один из старейших hosts-списков.',
    notesEn: 'Ad servers by yoyo.org (~3.5K), one of the oldest hosts lists.',
  },
  {
    name: "Peter Lowe's Blocklist",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_3.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Список Питера Лоу (~3,5 тыс.): рекламные серверы и трекеры.',
    notesEn: "Peter Lowe's list (~3.5K): ad servers and trackers.",
  },
  {
    name: 'winhelp2002.mvps.org',
    url: 'http://winhelp2002.mvps.org/hosts.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Классический MVPS hosts-список (~8,7 тыс.) — обновляется редко, но стабилен.',
    notesEn: 'Classic MVPS hosts list (~8.7K) — rarely updated but stable.',
  },
  {
    name: 'AdGuard DNS Popup Hosts filter',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_59.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Домены попапов и push-уведомлений (~1 тыс.).',
    notesEn: 'Popup and push-notification domains (~1K).',
  },
  {
    name: 'AWAvenue Ads Rule',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_53.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'AWAvenue Ads (~900): реклама китайских и глобальных сетей, аккуратный отбор.',
    notesEn: 'AWAvenue Ads (~900): Chinese and global ad networks, carefully curated.',
  },
  {
    name: "Dandelion Sprout's Anti Push Notifications",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_39.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Домены браузерных push-уведомлений (~500).',
    notesEn: 'Browser push-notification domains (~500).',
  },
  {
    name: "Dandelion Sprout's Game Console Adblock List",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_6.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Реклама на игровых консолях (~20 записей): PlayStation, Xbox, Nintendo.',
    notesEn: 'Game console ads (~20 entries): PlayStation, Xbox, Nintendo.',
  },
  // ── Смешанные и специальные ──────────────────────────────────────────────────
  {
    name: 'AdGuard DNS filter',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
    category: 'mixed', enabled: true, priority: 60,
    notes: 'Официальный фильтр AdGuard DNS (~191 тыс.): реклама, трекеры, фишинг, малварь в одном списке. Рекомендуемая база DNS-фильтрации.',
    notesEn: 'Official AdGuard DNS filter (~191K): ads, trackers, phishing, malware in one list. The recommended DNS-filtering base.',
  },
  {
    name: 'OISD Blocklist Big',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_27.txt',
    category: 'mixed', enabled: true, priority: 60,
    notes: 'OISD Big (~227 тыс.): реклама, трекеры, малварь, фишинг; собран без ложных срабатываний.',
    notesEn: 'OISD Big (~227K): ads, trackers, malware, phishing; compiled to avoid false positives.',
  },
  {
    name: 'hpHosts',
    url: 'https://cdn.jsdelivr.net/gh/evankrob/hosts-filenetrehost@master/ad_servers.txt',
    category: 'mixed', enabled: true, priority: 60,
    notes: 'Редакционный список hpHosts (~46 тыс.): рекламные и вредоносные домены.',
    notesEn: 'hpHosts editorial list (~46K): advertising and malware domains.',
  },
  {
    name: 'someonewhocares.org',
    url: 'https://someonewhocares.org/hosts/hosts',
    category: 'mixed', enabled: true, priority: 60,
    notes: 'Список someonewhocares.org (~13 тыс.): реклама, трекеры, вредоносные и нежелательные сайты.',
    notesEn: 'someonewhocares.org list (~13K): ads, trackers, malware and unwanted sites.',
  },
  {
    name: 'No Google',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_37.txt',
    category: 'mixed', enabled: false, priority: 60,
    notes: 'Строгий список доменов Google (~1,6 тыс. во включённой части) — для полного отказа от экосистемы Google; почти наверняка сломает часть сайтов.',
    notesEn: 'Strict Google domains list (~1.6K in the enabled part) — for fully de-Googling; very likely breaks parts of many sites.',
  },
  {
    name: "HaGeZi's Ultimate Blocklist",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_49.txt',
    category: 'mixed', enabled: false, priority: 60,
    notes: 'Максимальный список HaGeZi (агрегат всех его списков). Включайте ВМЕСТО остальных списков HaGeZi, а не вместе с ними — иначе двойная нагрузка без прироста.',
    notesEn: "HaGeZi's ultimate aggregation of all his lists. Enable INSTEAD of the other HaGeZi lists, not alongside them.",
  },
  // ── Региональные списки ─────────────────────────────────────────────────────
  {
    name: 'POL: Polish filters for Pi-hole',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_14.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Польский список для Pi-hole (~400): реклама и трекеры польских сайтов.',
    notesEn: 'Polish Pi-hole list (~400): ads and trackers of Polish websites.',
  },
  {
    name: "SWE: Frellwit's Swedish Hosts File",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_17.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Шведский hosts-список Frellwit (~1,2 тыс.): реклама, трекеры, малварь шведских сайтов.',
    notesEn: "Frellwit's Swedish hosts file (~1.2K): ads, trackers, malware of Swedish sites.",
  },
  {
    name: 'TUR: turk-adlist',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_26.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Турецкий список рекламы (~1,2 тыс.).',
    notesEn: 'Turkish ad list (~1.2K).',
  },
  {
    name: 'TUR: Turkish Ad Hosts',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_40.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Турецкие рекламные домены (~2 тыс.).',
    notesEn: 'Turkish ad domains (~2K).',
  },
  {
    name: 'VNM: ABPVN List',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_16.txt',
    category: 'ads', enabled: true, priority: 50,
    notes: 'Вьетнамский список ABPVN (~19 тыс.): реклама и трекеры вьетнамских сайтов.',
    notesEn: 'Vietnamese ABPVN list (~19K): ads and trackers of Vietnamese sites.',
  },
  // ── Белые списки (allow) ────────────────────────────────────────────────────
  {
    name: "HaGeZi's Allowlist Referral",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_45.txt',
    category: 'allowlist', purpose: 'allow', enabled: true, priority: 90,
    notes: 'Белый список HaGeZi (~950): партнёрские и реферальные ссылки, которые не нужно блокировать. Домены исключаются из итогового списка.',
    notesEn: "HaGeZi allowlist (~950): affiliate and referral links that should not be blocked. Domains are excluded from the final list.",
  },
]

/** Категории DNS-модуля каталога: ключи с русскими подписями (label) */
export const DNS_CATALOG_CATEGORIES: Array<{ name: string; label: string }> = [
  { name: 'ads', label: 'Реклама' },
  { name: 'tracking', label: 'Трекеры и слежка' },
  { name: 'malware', label: 'Вредоносные домены' },
  { name: 'phishing', label: 'Фишинг и мошенничество' },
  { name: 'gambling', label: 'Азартные игры' },
  { name: 'piracy', label: 'Пиратство и файлообмен' },
  { name: 'adult', label: '18+ и знакомства' },
  { name: 'spam', label: 'Спам и вредоносные TLD' },
  { name: 'rkn', label: 'Запрещённые ресурсы (импорт)' },
  { name: 'mixed', label: 'Смешанные списки' },
  { name: 'allowlist', label: 'Белые списки' },
]

/**
 * Первичная инициализация DNS-модуля: каталог доменных списков + категории.
 * Докатка при каждом старте: недостающие источники каталога и категории
 * добавляются; удалённые пользователем (purgedDnsSources) не восстанавливаются.
 */
export async function ensureDnsSeed(): Promise<{ added: string[] }> {
  const added: string[] = []
  const purged = new Set<string>(JSON.parse((await getSettingRaw('purgedDnsSources')) || '[]') as string[])
  // категории каталога
  for (const c of DNS_CATALOG_CATEGORIES) {
    await db.domainCategory.upsert({ where: { name: c.name }, create: { name: c.name, label: c.label }, update: {} })
  }
  // источники
  const count = await db.domainSource.count()
  if (count === 0) {
    for (const s of DNS_CATALOG) {
      if (purged.has(s.name)) continue
      await db.domainSource.create({
        data: {
          name: s.name,
          url: s.url ?? null,
          kind: s.kind ?? 'url',
          format: s.format ?? 'auto',
          category: s.category,
          purpose: s.purpose ?? 'block',
          enabled: s.enabled ?? true,
          priority: s.priority ?? 100,
          notes: s.notes ?? null,
          notesEn: s.notesEn ?? null,
          builtin: true,
        },
      })
    }
    await log('info', 'system', `Каталог DNS-источников инициализирован: ${DNS_CATALOG.length} списков`, undefined, `DNS catalog initialized: ${DNS_CATALOG.length} lists`)
  } else {
    const rows = await db.domainSource.findMany({ select: { name: true }, where: { deletedAt: null } })
    const byName = new Set(rows.map((r) => r.name))
    for (const s of DNS_CATALOG) {
      if (purged.has(s.name) || byName.has(s.name)) continue
      await db.domainSource.create({
        data: {
          name: s.name,
          url: s.url ?? null,
          kind: s.kind ?? 'url',
          format: s.format ?? 'auto',
          category: s.category,
          purpose: s.purpose ?? 'block',
          enabled: s.enabled ?? true,
          priority: s.priority ?? 100,
          notes: s.notes ?? null,
          notesEn: s.notesEn ?? null,
          builtin: true,
        },
      })
      added.push(s.name)
    }
    if (added.length) await log('info', 'system', `Каталог DNS-источников дополнен: ${added.join(', ')}`, undefined, `DNS catalog updated: ${added.join(', ')}`)
  }
  return { added }
}
