'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { ExternalLink, Github, Globe, Heart } from 'lucide-react'
import { TECH, TechItem } from './tech-logos'

export const APP_VERSION = '1.6.0' // синхронно с релизом (package.json)

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

function TechLogo({ item }: { item: TechItem }) {
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
        <span className="block text-xs text-muted-foreground leading-tight truncate">{item.role}</span>
      </span>
    </a>
  )
}

export function AboutTab() {
  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-4">
            <img src="/logo.svg" alt="Логотип NDR Rules Hub" className="h-16 w-16 rounded-xl border border-border" />
            <div>
              <CardTitle className="text-lg">NDR Rules Hub</CardTitle>
              <CardDescription className="mt-0.5">
                Управление источниками правил Snort/Suricata и сборка наборов для Clear NDR
              </CardDescription>
              <div className="flex gap-2 mt-2">
                <Badge variant="outline" className="border-input text-foreground">версия {APP_VERSION}</Badge>
                <Badge variant="outline" className="border-input text-muted-foreground">open source</Badge>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Автор и разработчик — Павел Кожеватов (<A href={AUTHOR_SITE}>kozhevatov.ru</A>) · код: <A href={REPO}>github.com/NoIDXMV6/ndr-rules-hub</A>
        </CardContent>
      </Card>

      <Accordion type="multiple" className="bg-card border border-border rounded-lg px-4">
        <AccordionItem value="about-author">
          <AccordionTrigger>О разработчике</AccordionTrigger>
          <AccordionContent className="space-y-3 text-sm leading-relaxed">
            <div className="font-medium text-foreground">Кожеватов Павел Русланович</div>
            <ul className="space-y-1">
              <Li>автор и разработчик NDR Rules Hub;</Li>
              <Li>
                старший преподаватель кафедры математического обеспечения и стандартизации информационных
                технологий (МОСИТ) <strong>РТУ МИРЭА</strong>; ведёт дисциплины «Сети ЭВМ и ТК» и
                «Информационная безопасность сетей»; научно-педагогический стаж — 15 лет, по образованию — математик;
              </Li>
              <Li>
                помощник начальника <strong>ФГБУ ВНИИ ГОЧС (ФЦ) МЧС России</strong> (по данным официального
                состава научно-технического совета института);
              </Li>
              <Li>профиль практики: сетевая безопасность, обнаружение сетевых угроз (NDR/IDS), преподавание.</Li>
            </ul>
            <p className="text-xs text-muted-foreground">
              Данные собраны из открытых источников (страница преподавателя РТУ МИРЭА, состав НТС ФГБУ ВНИИ ГОЧС (ФЦ)).
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <A href={AUTHOR_SITE}><Globe className="h-3.5 w-3.5" /> kozhevatov.ru — сайт автора</A>
              <A href="https://github.com/NoIDXMV6"><Github className="h-3.5 w-3.5" /> github.com/NoIDXMV6</A>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="about-project">
          <AccordionTrigger>Проект и репозиторий</AccordionTrigger>
          <AccordionContent className="space-y-2 text-sm leading-relaxed">
            <p>
              Сервис объединяет, дедуплицирует и экспортирует наборы правил Snort/Suricata для импорта в
              Clear NDR: единый файл правил с гарантией отсутствия конфликтов SID, автоматизация обновлений
              по расписанию и опциональная загрузка через WireGuard.
            </p>
            <ul className="space-y-1">
              <Li>исходный код и релизы: <A href={REPO}>github.com/NoIDXMV6/ndr-rules-hub</A>;</Li>
              <Li>текущая версия: {APP_VERSION} (<A href={`${REPO}/releases`}>страница релизов</A>);</Li>
              <Li>поставка: Docker-образ (<code>docker compose up -d --build</code>), данные — в томе <code>./data</code>;</Li>
              <Li>стек: Next.js + React + TypeScript, Prisma/SQLite, Tailwind CSS + shadcn/ui — полный список ниже.</Li>
            </ul>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="about-thanks">
          <AccordionTrigger>Благодарности</AccordionTrigger>
          <AccordionContent className="space-y-4 text-sm leading-relaxed">
            <div>
              <div className="font-medium text-foreground flex items-center gap-1.5"><Heart className="h-4 w-4 text-red-500" /> Clear NDR — Stamus Networks</div>
              <p className="text-muted-foreground">
                NDR Rules Hub создан как вспомогательный инструмент для Clear NDR — открытой платформы
                сетевого обнаружения и реагирования (NDR) на базе Suricata от Stamus Networks. Спасибо команде
                за открытый код, документацию и сообщество.
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
                Благодарность автору проекта <A href="https://github.com/angolo40/mikrocata2selks">angolo40/mikrocata2selks</A> —
                интеграции устройств MikroTik с SELKS/Clear NDR (TZSP-зеркалирование трафика, Telegram-уведомления,
                блокировка через firewall): практический ориентир по связке «роутер + NDR».
              </p>
            </div>
            <div>
              <div className="font-medium text-foreground">Источники правил</div>
              <p className="text-muted-foreground">
                Cisco Talos (snort.org), Emerging Threats, PT Attack Detection Team, Quadrant Information Security,
                OISF (Suricata), abuse.ch, CINS Score, Blocklist.de, Spamhaus, Phishing Army — спасибо за открытые фиды.
              </p>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="about-tech">
          <AccordionTrigger>Технологии и библиотеки</AccordionTrigger>
          <AccordionContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {TECH.map((t) => <TechLogo key={t.name} item={t} />)}
            </div>
            <p className="text-xs text-muted-foreground pt-3">
              Иконки технологий — из набора simple-icons (лицензия CC0). Кликом по карточке открывается сайт проекта.
            </p>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="about-logo">
          <AccordionTrigger>Логотип</AccordionTrigger>
          <AccordionContent className="space-y-3 text-sm leading-relaxed">
            <div className="flex items-center gap-5 flex-wrap">
              <img src="/logo.svg" alt="Логотип NDR Rules Hub" className="h-28 w-28 rounded-2xl border border-border" />
              <div className="max-w-lg">
                <p>
                  Фирменный знак системы: <strong>щит</strong> — защита сети; три <strong>строки правил</strong> —
                  наборы Snort/Suricata, сливаемые в один чистый файл; <strong>пульс-узел</strong> — непрерывное
                  обновление правил; три <strong>узла сети</strong> внизу — источники и приёмники, которые связывает хаб.
                </p>
                <p className="text-muted-foreground pt-1">
                  Цвета: фирменный синий #005792 и эмеральд — в тон интерфейсу. Файл: <code>public/logo.svg</code> (SVG, масштабируется без потерь).
                </p>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}
