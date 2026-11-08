'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'

const REPO = 'https://github.com/NoIDXMV6/ndr-rules-hub'

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80">
      {children}
    </a>
  )
}

function Li({ children }: { children: React.ReactNode }) {
  return <li className="ml-4 list-disc marker:text-muted-foreground/60">{children}</li>
}

const steps: { title: string; text: React.ReactNode }[] = [
  {
    title: '1. Источники',
    text: <>Каталог источников (вкладка «Источники»): официальные наборы snort.org (registered по oinkcode, community), ET Open, PT Attack Detection, Quadrant, OISF Traffic ID, фиды abuse.ch, конвертеры списков IP/доменов и локальные архивы. У каждого источника — тип авторизации (oinkcode / auth-key / basic / без авторизации), приоритет и флаг включения.</>,
  },
  {
    title: '2. Загрузка',
    text: <>HTTP(S)-загрузка с авторизацией: для snort.org ссылки приводятся к канонической форме <code>/reg-rules/&lt;файл&gt;/&lt;oinkcode&gt;</code>, архив проверяется по magic-байтам gzip, поддерживается кэш (<code>cacheTtlMinutes</code>) и работа от ранее скачанного архива при сбоях. Учитывайте лимиты snort.org: registered — не чаще раза в 15 минут.</>,
  },
  {
    title: '3. Парсинг и конвертация',
    text: <>Правила разбираются на атрибуты (SID, rev, msg, classtype, протокол, направление), проверяется совместимость с Suricata. Списки индикаторов (IP, домены, URL) конвертируются в правила Suricata с SID из приватного диапазона — с настройками sidStart, msgPrefix, perRule, maxRules.</>,
  },
  {
    title: '4. Дедупликация',
    text: <>Внутри источника и между источниками устраняются дубликаты: по SID (стратегии highest-rev / source-priority / renumber-private) и по содержимому правила (content hash). Отдельно гасится конфликт «conflicting SID» — причина отказов импорта в Clear NDR.</>,
  },
  {
    title: '5. Сборка',
    text: <>Итоговый файл собирается из всех правил с фильтром совместимости (dropIncompatible — отбросить несовместимые с Suricata конструкции), опционально скрываются отключённые правила (dropDisabledMsg). Результат: файл с именем из настроек, SHA-256 и статистикой.</>,
  },
  {
    title: '6. Экспорт',
    text: <>Три способа доставки в Clear NDR: скачать файл и импортировать вручную (вкладка «Сборка и экспорт» → «Скачать итоговый файл»); HTTP push на адрес Clear NDR с токеном; выгрузка в локальный каталог (например, примонтированный к Clear NDR). Автоматизация — по расписанию (cron в «Настройках») или кнопкой «Полный цикл».</>,
  },
]

export function HelpTab() {
  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Помощь</CardTitle>
          <CardDescription>
            Цели и задачи системы, принципы работы конвейера и подсказки по типовым ситуациям.
            Сведения о разработчике и благодарности — на вкладке «О системе».
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Репозиторий проекта: <A href={REPO}>github.com/NoIDXMV6/ndr-rules-hub</A> · сайт автора: <A href="https://kozhevatov.ru">kozhevatov.ru</A>
        </CardContent>
      </Card>

      <Accordion type="multiple" defaultValue={['help-purpose']} className="bg-card border border-border rounded-lg px-4">
        <AccordionItem value="help-purpose">
          <AccordionTrigger>Назначение: цели и задачи</AccordionTrigger>
          <AccordionContent className="space-y-2 text-sm leading-relaxed">
            <p>
              <strong>NDR Rules Hub</strong> — вспомогательный сервис для системы <strong>Clear NDR</strong> (Stamus Networks):
              он автоматизирует полный цикл работы с наборами правил Snort/Suricata, которые питают сетевое обнаружение.
            </p>
            <ul className="space-y-1">
              <Li>собрать в одном месте проверенные источники правил — от официальных наборов Talos до открытых фидов;</Li>
              <Li>загружать их по расписанию с учётом лимитов и авторизации (oinkcode, auth-key);</Li>
              <Li>устранять дубликаты и конфликты SID, из-за которых импорт в Clear NDR отказывает;</Li>
              <Li>конвертировать списки индикаторов (IP/домены/URL) в правила Suricata;</Li>
              <Li>собрать один итоговый файл и доставить его в Clear NDR — вручную, по HTTP или из локального каталога;</Li>
              <Li>при необходимости загружать правила через WireGuard VPN, не теряя доступ к самому сервису.</Li>
            </ul>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="help-pipeline">
          <AccordionTrigger>Принципы работы: конвейер обработки</AccordionTrigger>
          <AccordionContent className="space-y-3 text-sm leading-relaxed">
            {steps.map((s) => (
              <div key={s.title}>
                <div className="font-medium text-foreground">{s.title}</div>
                <p className="text-muted-foreground">{s.text}</p>
              </div>
            ))}
            <p className="text-xs text-muted-foreground pt-1">
              Все шаги видны в «Журнале»; состояния источников (ОК/ошибка/кэш) — на вкладке «Источники».
            </p>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="help-sources">
          <AccordionTrigger>Источники правил и лимиты snort.org</AccordionTrigger>
          <AccordionContent className="space-y-2 text-sm leading-relaxed">
            <p>Рекомендуемый базовый набор — <strong>Snort Registered Ruleset</strong> (обновляется Talos ежедневно) плюс <strong>ET Open</strong>. Community-наборы snort.org — подмножества registered, включайте их только без oinkcode.</p>
            <ul className="space-y-1">
              <Li>registered-архивы загружаются по oinkcode из «Настроек» (snort.org → Preferences → Oinkcode, 40 hex-символов);</Li>
              <Li>лимит snort.org: registered — не чаще <strong>1 загрузки в 15 минут</strong>; community — ограничение по IP;</Li>
              <Li>задайте <code>cacheTtlMinutes</code> в extra источника, чтобы не перекачивать архив чаще лимита;</Li>
              <Li>локальные архивы (data/archives) — запасной путь при недоступности snort.org.</Li>
            </ul>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="help-vpn">
          <AccordionTrigger>WireGuard VPN для загрузок</AccordionTrigger>
          <AccordionContent className="space-y-2 text-sm leading-relaxed">
            <p>Вкладка «WireGuard VPN» поднимает туннель внутри контейнера: загрузки правил идут через него (например, из закрытой сети или с «чистого» IP), а web-интерфейс остаётся доступным — трафик самого сервиса исключается из full-tunnel правилом <code>ip rule … lookup main</code>.</p>
            <ul className="space-y-1">
              <Li>требования: <code>/dev/net/tun</code>, <code>NET_ADMIN</code>, <code>net.ipv4.conf.all.src_valid_mark=1</code> (см. README);</Li>
              <Li>при потерянном доступе к UI: <code>docker compose exec rules-hub wg-quick down /app/data/wireguard/wg0.conf</code> или <code>docker compose restart rules-hub</code>;</Li>
              <Li>включается флагом «Гнать загрузки через WireGuard» в «Настройках».</Li>
            </ul>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="help-troubleshooting">
          <AccordionTrigger>Диагностика типовых проблем</AccordionTrigger>
          <AccordionContent className="space-y-2 text-sm leading-relaxed">
            <ul className="space-y-1">
              <Li><strong>HTTP 422</strong> у snort.org — почти всегда «Invalid oinkcode»: проверьте код в «Настройках» (40 символов, без пробелов);</Li>
              <Li><strong>HTTP 403 / 429</strong> — дневной/частотный лимит загрузок: подождите 15–30 минут или включите кэш;</Li>
              <Li><strong>«not in gzip format»</strong> — исправлено с v1.5.0: архив теперь проверяется по magic-байтам, а ссылки личного кабинета snort.org автоматически приводятся к каноническому виду;</Li>
              <Li><strong>«Ошибка связи с API»</strong> — бэкенд недоступен: смотрите <code>docker logs ndr-rules-hub</code> и <code>GET /api/health</code>;</Li>
              <Li>схема БД восстанавливается автоматически: при несовпадении версии старая база бэкапится в <code>data/hub.db.bak-*</code>.</Li>
            </ul>
            <p className="text-xs text-muted-foreground">Подробные инструкции — в README репозитория: <A href={REPO}>github.com/NoIDXMV6/ndr-rules-hub</A></p>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="help-dedup">
          <AccordionTrigger>Политики дедупликации и совместимость</AccordionTrigger>
          <AccordionContent className="space-y-2 text-sm leading-relaxed">
            <ul className="space-y-1">
              <Li><strong>highest-rev</strong> — при конфликте SID остаётся правило с максимальным rev (по умолчанию);</Li>
              <Li><strong>source-priority</strong> — выигрывает источник с меньшим числом приоритета;</Li>
              <Li><strong>renumber-private</strong> — конфликтующие SID переводятся в приватный диапазон (privateSidStart);</Li>
              <Li><strong>dedupContent</strong> — удаляет правила с одинаковым содержимым, но разными SID;</Li>
              <Li><strong>dropIncompatible</strong> — не включает в сборку конструкции, несовместимые с Suricata (replace, rawbytes и др.).</Li>
            </ul>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}
