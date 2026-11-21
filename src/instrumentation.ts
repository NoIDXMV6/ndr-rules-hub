// Однократная инициализация при старте Node.js-процесса сервера (next start /
// next dev). Выполняется ДО первого запроса: контейнерный entrypoint к этому
// моменту уже докатил схему БД, поэтому доступ к Setting/VpnProfile безопасен.
// Здесь стартуют фоновые процедуры, которые должны переживать рестарт контейнера:
//   • автоподнятие WireGuard-туннеля (переключатель «Автоматическое поднятие
//     тунеля», настройка wgAutoUp): проверка доступности конфигурации и
//     wg-quick up с паузой — сервер успевает начать слушать порт;
//   • автовозобновление скана живости доменов (dns-alive.ts): чекпоинт
//     dnsAliveScanState помечен «активен», а процесс умер посреди скана →
//     скан продолжается с места остановки (свежие вердикты в БД не
//     перепроверяются — потеря результатов при прерывании исключена).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { maybeAutoUpVpn } = await import('@/lib/engine/vpn-autoup')
  maybeAutoUpVpn()
  const { maybeResumeInterruptedScan } = await import('@/lib/engine/dns-alive')
  void maybeResumeInterruptedScan().catch(() => undefined)
}
