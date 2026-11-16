// ─────────────────────────────────────────────────────────────────────────────
// Категории итогового набора: группировка правил по classtype и фильтрация
//
// Категория = значение classtype правила (проверенные значения из
// classification.config: trojan-activity, attempted-user, …). Правила без
// classtype (конвертеры списков) попадают в категорию UNCATEGORIZED («none»).
// Пользователь управляет категориями (включение/выключение, переименование,
// скрытие) и отдельными правилами (RuleOverride, sid → enabled) — итоговый
// набор собирается из правил включённых источников, прошедших оба фильтра.
// ─────────────────────────────────────────────────────────────────────────────

/** Категория правил без classtype (конвертеры списков и др.) */
export const UNCATEGORIZED = 'none'

export function ruleCategory(clsType?: string | null): string {
  const v = (clsType ?? '').trim().toLowerCase()
  return v || UNCATEGORIZED
}

export interface CategorizedRule {
  sid: number
  clsType?: string | null
  sourceName?: string
}

export interface CategoryStat {
  name: string
  rules: number
  sources: string[]
}

/** Статистика по категориям из списка правил (правила источников после дедупа) */
export function groupRulesByCategory(rules: CategorizedRule[]): Map<string, CategoryStat> {
  const map = new Map<string, CategoryStat>()
  for (const r of rules) {
    const name = ruleCategory(r.clsType)
    let st = map.get(name)
    if (!st) {
      st = { name, rules: 0, sources: [] }
      map.set(name, st)
    }
    st.rules++
    if (r.sourceName && !st.sources.includes(r.sourceName)) st.sources.push(r.sourceName)
  }
  return map
}

/**
 * Фильтр итогового набора по категориям и пользовательским исключениям правил.
 * catEnabled: имя категории → включена; отсутствие категории в карте = включена
 * (когда пользователь ещё не сканировал категории, ничего не отбрасывается).
 * ruleEnabled: sid → включено; отсутствие = включено.
 */
export function applyCategoryAndRuleFilter<T extends CategorizedRule>(
  rules: T[],
  catEnabled: Map<string, boolean>,
  ruleEnabled: Map<number, boolean>
): { kept: T[]; excludedByCategory: number; excludedByRule: number } {
  const kept: T[] = []
  let excludedByCategory = 0
  let excludedByRule = 0
  for (const r of rules) {
    const cat = ruleCategory(r.clsType)
    if (catEnabled.has(cat) && !catEnabled.get(cat)) {
      excludedByCategory++
      continue
    }
    if (ruleEnabled.has(r.sid) && !ruleEnabled.get(r.sid)) {
      excludedByRule++
      continue
    }
    kept.push(r)
  }
  return { kept, excludedByCategory, excludedByRule }
}

/** Человекочитаемое имя категории: label пользователя, иначе classtype */
export function categoryDisplayName(name: string, label?: string | null): string {
  if (label && label.trim()) return label.trim()
  return name === UNCATEGORIZED ? 'без категории (без classtype)' : name
}

// Человекочитаемые описания стандартных classtype (classification.config),
// для подсказок в UI. Неполный список — нестандартные значения отображаются как есть.
export const CLASSTYPE_DESCRIPTIONS: Record<string, string> = {
  'attempted-admin': 'попытка компрометации с правами администратора',
  'attempted-user': 'попытка компрометации пользовательских прав',
  'attempted-recon': 'разведка (recon)',
  'successful-admin': 'успешная компрометация с правами администратора',
  'successful-user': 'успешная компрометация пользовательских прав',
  'web-application-attack': 'атака на веб-приложение',
  'web-application-activity': 'активность на веб-приложение',
  'trojan-activity': 'активность троянского ПО / C&C',
  'shellcode-detect': 'обнаружение шеллкода',
  'policy-violation': 'нарушение политики',
  'bad-unknown': 'подозрительная/неизвестная активность',
  'default-login-attempt': 'попытка входа с учётными данными по умолчанию',
  'denial-of-service': 'отказ в обслуживании (DoS)',
  'misc-attack': 'прочая атака',
  'misc-activity': 'прочая активность',
  'malware-c2': 'командный сервер (C&C) вредоносного ПО',
  'coin-mining': 'майнинг криптовалюты',
  'domain-c2': 'C&C-домен',
  'indicator-compromise': 'признак компрометации',
  'indicator-scan': 'сканирование',
  'indicator-obfuscation': 'обфускация',
  'network-scan': 'сканирование сети',
  'protocol-command-decode': 'разбор команды протокола',
  'non-standard-protocol': 'нестандартный протокол',
  'suspicious-filename-detect': 'подозрительное имя файла',
  'suspicious-login': 'подозрительный вход',
  'system-call-detect': 'системный вызов',
  'unusual-client-port-usage': 'необычный клиентский порт',
  'file-format': 'известный формат файла',
  'unknown': 'неизвестная активность',
  'misc-unsafe': 'небезопасная активность',
  'tcp-connection': 'TCP-соединение',
  'potentially-bad-traffic': 'потенциально вредоносный трафик',
  'known-issue': 'известная проблема',
  'targeted-activity': 'целенаправленная активность',
  ' exploit': 'эксплойт',
  'exploit': 'эксплойт',
  'icq': 'ICQ-трафик',
  'inappropriate-content': 'нежелательный контент',
  'mud-data-loss': 'потеря данных',
  'device-retrieved-internal': 'внутренние данные устройства',
}
