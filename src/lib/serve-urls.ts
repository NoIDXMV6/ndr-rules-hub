// ─────────────────────────────────────────────────────────────────────────────
// Готовые Uri отдачи для плашки после создания токена скачивания (v1.33.0).
// Без серверных импортов: используется клиентской карточкой «Токены и доступ»
// и тестами. Процедуры подключения у двух списков РАЗНЫЕ:
//  • правила Suricata — Clear NDR передаёт токен в заголовке Authorization
//    (поле «Optional authorization key» источника): Uri выдаётся БЕЗ токена,
//    чтобы каждое поле формы Clear NDR получило своё значение;
//  • список заблокированных доменов забирают ЛЮБЫЕ DNS-серверы с поддержкой
//    обновления списков по ссылке (AdGuard Home, Pi-hole, Blocky, dnsmasq…):
//    отдельного поля для токена у них нет — поэтому выдаётся ПОЛНЫЙ Uri,
//    в котором токен уже в адресе (?token=…); заголовок Authorization также
//    принимается, но не требуется.
// ─────────────────────────────────────────────────────────────────────────────

/** Базовый адрес без хвостового слэша */
function baseOf(origin: string): string {
  return origin.trim().replace(/\/+$/, '')
}

/** Uri отдачи итогового набора правил (источник URL в Clear NDR): БЕЗ токена */
export function rulesExportUrls(origin: string): { file: string; archive: string } {
  const base = baseOf(origin)
  return { file: `${base}/api/export`, archive: `${base}/api/export?archive=1` }
}

/** ПОЛНЫЙ Uri отдачи списка заблокированных доменов: токен в адресе (?token=…) */
export function dnsExportUrl(origin: string, token: string): string {
  return `${baseOf(origin)}/api/dns/export?token=${encodeURIComponent(token)}`
}
