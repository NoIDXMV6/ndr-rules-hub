// ─────────────────────────────────────────────────────────────────────────────
// Ограничение скорости отдачи файлов (bandwidth throttling).
// Глобальный «ведёрко с токенами» (token bucket) делит суммарную пропускную
// способность канала между всеми активными скачиваниями: каждое скачивание
// забирает из ведра порции байтов и, когда ведро пусто, честно ждёт — так
// отдача правил не выедает канал целиком (утилизация канала — настраиваемая,
// см. настройку downloadBandwidthKbps).
// ─────────────────────────────────────────────────────────────────────────────

export class Bandwidth {
  private rate: number // байт/сек (0 — без ограничения)
  private burst: number // ёмкость ведра, байт
  private available: number
  private last = Date.now()

  constructor(bytesPerSec: number, burstFactor = 4, burstBytes?: number) {
    this.rate = Math.max(0, bytesPerSec)
    // ёмкость ведра: явное значение (тесты/тонкая настройка) или floor 64 КБ × burstFactor;
    // floor защищает от патологических ожиданий при очень малых лимитах канала
    this.burst = burstBytes ?? Math.max(65536, this.rate * burstFactor)
    this.available = this.burst
  }

  private refill(): void {
    if (this.rate <= 0) {
      this.available = Number.POSITIVE_INFINITY
      return
    }
    const now = Date.now()
    const elapsed = (now - this.last) / 1000
    if (elapsed > 0) {
      this.available = Math.min(this.burst, this.available + elapsed * this.rate)
      this.last = now
    }
  }

  /** Резервирует n байтов; при нехватке ждёт, пока ведро наполнится.
   *  Запросы больше ёмкости ведра резервируются по частям (без дедлоков). */
  async take(n: number): Promise<void> {
    if (this.rate <= 0) return
    let remaining = n
    while (remaining > 0) {
      const want = Math.min(remaining, this.burst)
      for (;;) {
        this.refill()
        if (this.available >= want) {
          this.available -= want
          remaining -= want
          break
        }
        const deficit = want - this.available
        const waitMs = Math.min(Math.ceil((deficit / this.rate) * 1000), 500)
        await new Promise((r) => setTimeout(r, Math.max(1, waitMs)))
      }
    }
  }
}

// Глобальный лимитер пересоздаётся при изменении настройки (kbps → байт/сек)
let globalBw: Bandwidth | null = null
let globalKbps = -1

export function globalDownloadBandwidth(kbps: number): Bandwidth {
  if (!globalBw || globalKbps !== kbps) {
    globalKbps = kbps
    globalBw = new Bandwidth(kbps * 1024)
  }
  return globalBw
}

/** Только для тестов: сбросить глобальный лимитер */
export function resetGlobalBandwidth(): void {
  globalBw = null
  globalKbps = -1
}

/**
 * Обернуть буфер (файл сборки/архива) в ReadableStream, который отдаёт данные
 * с учётом ведра bw. Без bw (rate 0) отдаётся обычным потоком чанками.
 */
export function throttledStream(src: Buffer, bw: Bandwidth | null, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let pos = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pos >= src.length) {
        controller.close()
        return
      }
      const end = Math.min(pos + chunkSize, src.length)
      const chunk = src.subarray(pos, end)
      if (bw) await bw.take(chunk.length)
      pos = end
      controller.enqueue(new Uint8Array(chunk))
    },
  })
}
