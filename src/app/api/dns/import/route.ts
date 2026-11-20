// DNS-фильтрация: импорт базы (SQL-дамп базы фильтрации нежелательных ресурсов).
// POST /api/dns/import — multipart/form-data, поле file:
//   • export.sql — SQL-дамп MariaDB (HeidiSQL) — разбирается потоково;
//   • .rar — распаковывается внешним unrar/unar/7z (если установлен), затем
//     разбирается export.sql из архива.
// Ответ содержит статистику импорта. Операция долгая (дамп ~500 МБ).
import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { apiError } from '@/lib/api-error'
import { guard } from '@/lib/security/guard'
import { DNS_UPLOAD_DIR, importDomainDump } from '@/lib/engine/dns-service'

export const dynamic = 'force-dynamic'
export const maxDuration = 3600

const RAR_TOOLS = ['unrar', 'unar', '7z', '7za']

async function extractRar(rarPath: string, destDir: string): Promise<string> {
  for (const tool of RAR_TOOLS) {
    const found = await new Promise<boolean>((resolve) => {
      const p = execFile(tool, ['-h'], { timeout: 20_000 }, () => resolve(false))
      p.on('error', () => resolve(false))
      // считаем инструмент доступным, если он запустился и не упал с ENOENT
      let ok = false
      p.on('spawn', () => { ok = true })
      setTimeout(() => resolve(ok), 3000)
    }).catch(() => false)
    if (!found) continue
    const args = tool === 'unrar'
      ? ['x', '-y', rarPath, destDir + '/']
      : tool === 'unar'
        ? ['-o', destDir, '-force-overwrite', rarPath]
        : ['x', '-y', `-o${destDir}`, rarPath]
    await new Promise<void>((resolve, reject) => {
      execFile(tool, args, { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()))
    })
    // ищем export.sql (или любой .sql) в результатах
    const files = await walk(destDir)
    const sql = files.find((f) => f.toLowerCase().endsWith('.sql'))
    if (sql) return sql
  }
  throw new Error('в системе нет unrar/unar/7z или в архиве нет .sql файла — распакуйте архив вручную и загрузите export.sql')
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else out.push(p)
  }
  return out
}

export async function POST(req: NextRequest) {
  const g = await guard(req, { rate: { key: 'dns-import', rule: { limit: 5, windowMs: 3600_000 } } })
  if (g instanceof NextResponse) return g
  if (g.role !== 'admin') return NextResponse.json({ error: 'Раздел доступен администратору' }, { status: 403 })
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Нет файла в поле file (multipart/form-data)' }, { status: 400 })
    }
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.sql') && !lower.endsWith('.rar')) {
      return NextResponse.json({ error: 'Ожидается export.sql (SQL-дамп) или .rar-архив с ним' }, { status: 400 })
    }
    await fs.mkdir(DNS_UPLOAD_DIR, { recursive: true })
    const safeName = file.name.replace(/[^\w.\-]+/g, '_')
    const savedPath = path.join(DNS_UPLOAD_DIR, `${Date.now()}-${safeName}`)
    await fs.writeFile(savedPath, Buffer.from(await file.arrayBuffer()))

    let sqlPath = savedPath
    if (lower.endsWith('.rar')) {
      sqlPath = await extractRar(savedPath, path.join(DNS_UPLOAD_DIR, `rar-${Date.now()}`))
    }
    const name = (form.get('name') as string | null)?.trim() || undefined
    const res = await importDomainDump(sqlPath, { name, replace: true })
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch (e) {
    return apiError(e)
  }
}
