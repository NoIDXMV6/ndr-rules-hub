// Однократная инициализация при старте Node.js-процесса сервера (next start /
// next dev). Выполняется ДО первого запроса: контейнерный entrypoint к этому
// моменту уже докатил схему БД, поэтому доступ к Setting/VpnProfile безопасен.
// Здесь стартует автоподнятие WireGuard-туннеля (переключатель
// «Автоматическое поднятие тунеля», настройка wgAutoUp): проверка доступности
// конфигурации и wg-quick up с паузой — сервер успевает начать слушать порт.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { maybeAutoUpVpn } = await import('@/lib/engine/vpn-autoup')
  maybeAutoUpVpn()
}
