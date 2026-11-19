// ─────────────────────────────────────────────────────────────────────────────
// Рабочие пространства (v1.27.0): у каждого пользователя — свой набор источников
// и персональная сборка правил. Манипуляции одного пользователя не затрагивают
// других. Модель разделения:
//
//   • Системные источники (ownerId = null) — общий каталог, обновляется системой
//     (cron/администратор). Пользователь может только включить/выключить источник
//     в СВОЁМ рабочем пространстве (таблица SourceState).
//   • Собственные источники (ownerId = userId) — управляет владелец: загрузка,
//     правка, удаление. Приватность: visibility 'private' — только у владельца;
//     'published' — опубликован, виден другим пользователям (вкл/выкл у себя).
//   • Источники только для администратора (adminOnly) — ET Pro, MISP: нужны
//     секреты уровня системы (oinkcode Proofpoint, ключ REST API MISP) — в
//     пользовательских пространствах не показываются и в персональные сборки
//     не попадают.
//
//   • Состояние админа/системного набора хранится в Source.enabled (как раньше).
//     Состояние пользователя — SourceState(userId, sourceId, enabled); строка
//     отсутствует → наследуется Source.enabled («системные источники по дефолту
//     предоставляются каждому»).
//
//   • Build.userId: null — системная сборка (админ, PULL-набор Clear NDR);
//     cuid пользователя — его персональная сборка.
//   • LogEntry.userId: null — системное событие (только админ); иначе — событие
//     рабочего пространства: пользователь видит ТОЛЬКО свои события.
// ─────────────────────────────────────────────────────────────────────────────

/** Минимальный набор полей источника, нужный для выбора видимости/состояния */
export interface WorkspaceSource {
  id: string
  ownerId: string | null
  visibility: string // private | published
  adminOnly: boolean
  enabled: boolean
  deletedAt: Date | string | null
}

/** Строка SourceState (или её проекция) */
export interface WorkspaceState {
  sourceId: string
  enabled: boolean
}

export type WorkspaceRole = 'admin' | 'user'

/**
 * Виден ли источник в рабочем пространстве.
 * Администратор видит всё не удалённое (управляет системным набором).
 * Пользователь видит: системные (кроме adminOnly), свои, опубликованные другими.
 */
export function isSourceVisible(
  s: Pick<WorkspaceSource, 'ownerId' | 'adminOnly' | 'visibility' | 'deletedAt'>,
  role: WorkspaceRole,
  userId?: string | null,
): boolean {
  if (s.deletedAt) return false
  if (role === 'admin') return true
  if (s.adminOnly) return false
  if (s.ownerId === userId) return true
  if (s.ownerId === null) return true // системный каталог
  return s.visibility === 'published' // чужой — только опубликованный
}

/**
 * Эффективное включение источника в рабочем пространстве:
 * у админа — Source.enabled (его состояние и есть системное),
 * у пользователя — SourceState, а без строки — наследуется Source.enabled.
 */
export function effectiveEnabled(source: { enabled: boolean }, state?: Pick<WorkspaceState, 'enabled'> | null): boolean {
  return state ? state.enabled : source.enabled
}

/**
 * Выборка рабочего пространства: отфильтрованные по видимости источники
 * с эффективным включением. Чистая функция — покрыта тестами.
 */
export function selectWorkspaceSources(
  sources: WorkspaceSource[],
  states: WorkspaceState[],
  role: WorkspaceRole,
  userId?: string | null,
): Array<WorkspaceSource & { effectiveEnabled: boolean }> {
  const bySource = new Map(states.map((st) => [st.sourceId, st]))
  return sources
    .filter((s) => isSourceVisible(s, role, userId))
    .map((s) => ({ ...s, effectiveEnabled: role === 'admin' ? s.enabled : effectiveEnabled(s, bySource.get(s.id)) }))
}

/**
 * Имя файла персональной сборки: personal-<slug email>-<хвост id>.rules.
 * Slug из email-префикса: [a-z0-9-], прочие символы → '-', обрезка до 24.
 */
export function personalFileName(userId: string, email?: string | null): string {
  const base = (email ?? '').split('@')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  const tail = userId.slice(-4)
  return `personal-${base || 'user'}-${tail}.rules`
}

/**
 * Подпись рабочего пространства — детерминированный снимок выбора источников:
 * id, эффективное состояние, приоритет, updatedAt, ruleCount. Если подпись
 * персональной сборки совпадает с текущей — пересобирать нечего (cron
 * пропускает), состав правил у источников не менялся.
 */
export function workspaceSignature(
  sources: Array<Pick<WorkspaceSource, 'id' | 'enabled'> & { updatedAt?: Date | string | null; ruleCount?: number; priority?: number; eff?: boolean }>,
): string {
  const parts = sources
    .map((s) => `${s.id}:${s.eff ?? s.enabled ? 1 : 0}:${s.priority ?? 100}:${s.ruleCount ?? 0}:${s.updatedAt ? new Date(s.updatedAt).getTime() : 0}`)
    .sort()
  return `${parts.length}|${parts.join('|')}`
}
