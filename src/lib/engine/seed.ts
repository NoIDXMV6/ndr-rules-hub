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
  },
  {
    name: 'Positive Technologies Attack Detection Team',
    category: 'ruleset',
    kind: 'tarball',
    url: 'https://raw.githubusercontent.com/ptresearch/AttackDetection/master/pt.rules.tar.gz',
    enabled: true,
    priority: 30,
    badge: 'legacy',
    notes: 'Талантливый набор PT Expert (~9 000 правил). Публичный репозиторий заморожен с 2022 г. — правила не обновляются. Платный канал — через подписку PT.',
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
  },
  {
    name: 'Stamus Lateral Movement Ruleset',
    category: 'ruleset',
    kind: 'url',
    url: 'https://raw.githubusercontent.com/StamusNetworks/lateral-movement-rules/main/lateral-movement.rules',
    enabled: false,
    priority: 46,
    badge: 'unavailable',
    notes: 'Публичного URL нет (404). Используйте встроенный источник Clear NDR.',
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
  },
  {
    name: 'Abuse.ch Suricata JA3 Fingerprint Ruleset',
    category: 'ruleset',
    kind: 'url',
    url: 'https://sslbl.abuse.ch/ja3_fingerprints/JA3suricata.rules',
    enabled: false,
    priority: 61,
    badge: 'unavailable',
    notes: 'abuse.ch закрыл отдельную JA3-выгрузку (404). Содержимое перенесено в SSL Blacklist (см. выше).',
  },
  {
    name: 'Threatfox Indicators of Compromise',
    category: 'ruleset',
    kind: 'url',
    url: 'https://threatfox.abuse.ch/downloads/threatfox_suricata.rules',
    authType: 'authkey',
    enabled: false,
    priority: 62,
    badge: 'unavailable',
    notes: 'Прямая выгрузка закрыта (HTTP 410). С 10.2026 ThreatFox требует бесплатный Auth-Key для API (threatfox.abuse.ch/api/) — ключ задаётся в настройках источника.',
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
    extraJson: JSON.stringify({ sidStart: 1100100, msgPrefix: 'FEODO-C2 known botnet C2 IP' }),
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
  },
]

export const DEFAULT_SETTINGS: Record<string, string> = {
  oinkcode: process.env.OINKCODE || '',
  dedupSidStrategy: 'highest-rev', // highest-rev | source-priority | renumber-private
  dedupContent: 'true',
  dropIncompatible: 'true',
  dropDisabledMsg: 'true',
  privateSidStart: '1000000',
  buildFileName: 'clearndr-import.rules',
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
}
