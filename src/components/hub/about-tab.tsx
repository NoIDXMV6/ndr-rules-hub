'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { ExternalLink, Github, Globe, Heart } from 'lucide-react'
import { TECH, TechItem } from './tech-logos'
import { Rich } from './rich'
import { useI18n, type Lang } from '@/lib/i18n'

export const APP_VERSION = '1.10.0' // синхронно с релизом (package.json)

const REPO = 'https://github.com/NoIDXMV6/ndr-rules-hub'
const AUTHOR_SITE = 'https://kozhevatov.ru'

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80 inline-flex items-center gap-0.5">
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  )
}

function Li({ children }: { children: React.ReactNode }) {
  return <li className="ml-4 list-disc marker:text-muted-foreground/60">{children}</li>
}

function TechLogo({ item, lang }: { item: TechItem; lang: Lang }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      title={`${item.name} — ${item.vendor} · ${item.url}`}
      className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 hover:border-primary/40 transition-colors"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
        <path d={item.path} fill={item.color} />
      </svg>
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-tight text-foreground">{item.name}</span>
        <span className="block text-xs text-muted-foreground leading-tight truncate">{lang === 'en' && item.roleEn ? item.roleEn : item.role}</span>
      </span>
    </a>
  )
}

interface AboutSection {
  trigger: string
  /** JSX-содержимое аккордеона (rich-структура различается между секциями) */
  body: React.ReactNode
}

function sections(lang: Lang, techNote: string): AboutSection[] {
  const ru = lang === 'ru'
  return [
    {
      trigger: ru ? 'О разработчике' : 'About the developer',
      body: (
        <div className="space-y-3 text-sm leading-relaxed">
          <div className="font-medium text-foreground">{ru ? 'Кожеватов Павел Русланович' : 'Pavel R. Kozhevatov'}</div>
          <ul className="space-y-1">
            <Li>{ru ? 'автор и разработчик NDR Rules Hub;' : 'author and developer of NDR Rules Hub;'}</Li>
            <Li>
              {ru
                ? <>старший преподаватель кафедры математического обеспечения и стандартизации информационных технологий (МОСИТ) <strong>РТУ МИРЭА</strong>; ведёт дисциплины «Сети ЭВМ и ТК» и «Информационная безопасность сетей»; научно-педагогический стаж — 15 лет, по образованию — математик;</>
                : <>senior lecturer at the Department of Software Engineering and Standardization of Information Technologies (MOSIT), <strong>RTU MIREA</strong> (Russian Technological University); teaches “Computer Networks and Data Communication” and “Network Information Security”; 15 years of academic experience, educated as a mathematician;</>}
            </Li>
            <Li>
              {ru
                ? <>помощник начальника <strong>ФГБУ ВНИИ ГОЧС (ФЦ) МЧС России</strong> (по данным официального состава научно-технического совета института);</>
                : <>assistant to the head of <strong>All-Russian Research Institute for Civil Defense and Emergencies (FC), EMERCOM of Russia</strong> (per the official roster of the institute’s scientific and technical council);</>}
            </Li>
            <Li>{ru ? 'профиль практики: сетевая безопасность, обнаружение сетевых угроз (NDR/IDS), преподавание.' : 'practice profile: network security, network threat detection (NDR/IDS), teaching.'}</Li>
          </ul>
          <p className="text-xs text-muted-foreground">
            {ru
              ? 'Данные собраны из открытых источников (страница преподавателя РТУ МИРЭА, состав НТС ФГБУ ВНИИ ГОЧС (ФЦ)).'
              : 'Data collected from public sources (RTU MIREA lecturer page, the scientific and technical council roster of the All-Russian Research Institute for Civil Defense and Emergencies).'}
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <A href={AUTHOR_SITE}><Globe className="h-3.5 w-3.5" /> kozhevatov.ru — {ru ? 'сайт автора' : "author's site"}</A>
            <A href="https://github.com/NoIDXMV6"><Github className="h-3.5 w-3.5" /> github.com/NoIDXMV6</A>
          </div>
        </div>
      ),
    },
    {
      trigger: ru ? 'Проект и репозиторий' : 'Project and repository',
      body: (
        <div className="space-y-2 text-sm leading-relaxed">
          <p>
            {ru
              ? 'Сервис объединяет, дедуплицирует и экспортирует наборы правил Snort/Suricata для импорта в Clear NDR: единый файл правил с гарантией отсутствия конфликтов SID, автоматизация обновлений по расписанию и опциональная загрузка через WireGuard.'
              : 'The service merges, deduplicates and exports Snort/Suricata rulesets for import into Clear NDR: a single rule file guaranteed free of SID conflicts, scheduled update automation and optional WireGuard-based downloads.'}
          </p>
          <ul className="space-y-1">
            <Li>{ru ? 'исходный код и релизы: ' : 'source code and releases: '} <A href={REPO}>github.com/NoIDXMV6/ndr-rules-hub</A>;</Li>
            <Li>{ru ? 'текущая версия: ' : 'current version: '}{APP_VERSION} (<A href={`${REPO}/releases`}>{ru ? 'страница релизов' : 'releases page'}</A>);</Li>
            <Li>{ru ? <>поставка: Docker-образ (<code className="font-mono text-[0.85em]">docker compose up -d --build</code>), данные — в томе <code className="font-mono text-[0.85em]">./data</code>;</> : <>delivery: Docker image (<code className="font-mono text-[0.85em]">docker compose up -d --build</code>), data lives in the <code className="font-mono text-[0.85em]">./data</code> volume;</>}</Li>
            <Li>{ru ? 'стек: Next.js + React + TypeScript, Prisma/SQLite, Tailwind CSS + shadcn/ui — полный список ниже.' : 'stack: Next.js + React + TypeScript, Prisma/SQLite, Tailwind CSS + shadcn/ui — full list below.'}</Li>
          </ul>
        </div>
      ),
    },
    {
      trigger: ru ? 'Благодарности' : 'Acknowledgements',
      body: (
        <div className="space-y-4 text-sm leading-relaxed">
          <div>
            <div className="font-medium text-foreground flex items-center gap-1.5"><Heart className="h-4 w-4 text-red-500" /> Clear NDR — Stamus Networks</div>
            <p className="text-muted-foreground">
              {ru
                ? 'NDR Rules Hub создан как вспомогательный инструмент для Clear NDR — открытой платформы сетевого обнаружения и реагирования (NDR) на базе Suricata от Stamus Networks. Спасибо команде за открытый код, документацию и сообщество.'
                : 'NDR Rules Hub was created as a companion tool for Clear NDR — an open Suricata-based network detection and response (NDR) platform by Stamus Networks. Many thanks to the team for the open code, documentation and community.'}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
              <A href="https://www.stamus-networks.com">stamus-networks.com</A>
              <A href="https://docs.clearndr.io">docs.clearndr.io</A>
              <A href="https://github.com/StamusNetworks">github.com/StamusNetworks</A>
            </div>
          </div>
          <div>
            <div className="font-medium text-foreground flex items-center gap-1.5"><Heart className="h-4 w-4 text-red-500" /> mikrocata2selks — Giuseppe Trifilio (angolo40)</div>
            <p className="text-muted-foreground">
              {ru
                ? <>Благодарность автору проекта <A href="https://github.com/angolo40/mikrocata2selks">angolo40/mikrocata2selks</A> — интеграции устройств MikroTik с SELKS/Clear NDR (TZSP-зеркалирование трафика, Telegram-уведомления, блокировка через firewall): практический ориентир по связке «роутер + NDR».</>
                : <>Thanks to the author of <A href="https://github.com/angolo40/mikrocata2selks">angolo40/mikrocata2selks</A> — an integration of MikroTik devices with SELKS/Clear NDR (TZSP traffic mirroring, Telegram notifications, firewall blocking): a practical reference for the “router + NDR” pairing.</>}
            </p>
          </div>
          <div>
            <div className="font-medium text-foreground">{ru ? 'Источники правил' : 'Rule feed providers'}</div>
            <p className="text-muted-foreground">
              {ru
                ? 'Cisco Talos (snort.org), Emerging Threats, PT Attack Detection Team, Quadrant Information Security, OISF (Suricata), abuse.ch, CINS Score, Blocklist.de, Spamhaus, Phishing Army — спасибо за открытые фиды.'
                : 'Cisco Talos (snort.org), Emerging Threats, PT Attack Detection Team, Quadrant Information Security, OISF (Suricata), abuse.ch, CINS Score, Blocklist.de, Spamhaus, Phishing Army — thank you for the open feeds.'}
            </p>
          </div>
        </div>
      ),
    },
    {
      trigger: ru ? 'Технологии и библиотеки' : 'Technologies and libraries',
      body: (
        <div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {TECH.map((tl) => <TechLogo key={tl.name} item={tl} lang={lang} />)}
          </div>
          <p className="text-xs text-muted-foreground pt-3">{techNote}</p>
        </div>
      ),
    },
    {
      trigger: ru ? 'Логотип' : 'Logo',
      body: (
        <div className="space-y-3 text-sm leading-relaxed">
          <div className="flex items-center gap-5 flex-wrap">
            <img src="/logo.svg" alt="NDR Rules Hub logo" className="h-28 w-28 rounded-2xl border border-border" />
            <div className="max-w-lg">
              <p>
                <Rich
                  text={ru
                    ? 'Фирменный знак системы: **щит** — защита сети; три **строки правил** — наборы Snort/Suricata, сливаемые в один чистый файл; **пульс-узел** — непрерывное обновление правил; три **узла сети** внизу — источники и приёмники, которые связывает хаб.'
                    : 'The system emblem: a **shield** for network protection; three **rule lines** — Snort/Suricata sets merging into one clean file; a **pulse node** — continuous rule updates; three **network nodes** at the bottom — sources and sinks connected by the hub.'}
                />
              </p>
              <p className="text-muted-foreground pt-1">
                {ru
                  ? <>Цвета: фирменный синий #005792 и эмеральд — в тон интерфейсу. Файл: <code className="font-mono text-[0.85em]">public/logo.svg</code> (SVG, масштабируется без потерь).</>
                  : <>Colors: the brand blue #005792 and emerald, matching the UI. File: <code className="font-mono text-[0.85em]">public/logo.svg</code> (SVG, scales without loss).</>}
              </p>
            </div>
          </div>
        </div>
      ),
    },
  ]
}

export function AboutTab() {
  const { t, tr, lang } = useI18n()
  const secs = sections(lang, t.about.techIconsNote)
  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-4">
            <img src="/logo.svg" alt="NDR Rules Hub logo" className="h-16 w-16 rounded-xl border border-border" />
            <div>
              <CardTitle className="text-lg">NDR Rules Hub</CardTitle>
              <CardDescription className="mt-0.5">
                {lang === 'ru'
                  ? 'Управление источниками правил Snort/Suricata и сборка наборов для Clear NDR'
                  : 'Managing Snort/Suricata rule sources and building rulesets for Clear NDR'}
              </CardDescription>
              <div className="flex gap-2 mt-2">
                <Badge variant="outline" className="border-input text-foreground">{tr(t.about.version, { v: APP_VERSION })}</Badge>
                <Badge variant="outline" className="border-input text-muted-foreground">{t.about.openSource}</Badge>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {lang === 'ru'
            ? <>Автор и разработчик — Павел Кожеватов (<A href={AUTHOR_SITE}>kozhevatov.ru</A>) · код: <A href={REPO}>github.com/NoIDXMV6/ndr-rules-hub</A></>
            : <>{t.about.authorLine} (<A href={AUTHOR_SITE}>kozhevatov.ru</A>) · {t.about.codeLabel} <A href={REPO}>github.com/NoIDXMV6/ndr-rules-hub</A></>}
        </CardContent>
      </Card>

      <Accordion type="multiple" className="bg-card border border-border rounded-lg px-4">
        {secs.map((s) => (
          <AccordionItem key={s.trigger} value={`about-${s.trigger}`}>
            <AccordionTrigger>{s.trigger}</AccordionTrigger>
            <AccordionContent>{s.body}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  )
}
