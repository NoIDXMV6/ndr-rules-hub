import { describe, it, expect, beforeEach } from 'vitest'
import {
  startBuildProgress, getBuildProgress, isBuildActive,
  setBuildStage, addBuildLog, finishBuildProgress, failBuildProgress,
  resetBuildProgress,
} from '@/lib/engine/build-progress'

describe('build-progress: прогресс сборки', () => {
  beforeEach(() => {
    resetBuildProgress()
  })

  it('жизненный цикл: старт → активна → фазы → завершение с результатом', () => {
    expect(getBuildProgress()).toBeNull()
    expect(isBuildActive()).toBe(false)

    const job = startBuildProgress('manual')
    expect(job.jobId).toBeTruthy()
    expect(job.active).toBe(true)
    expect(job.percent).toBe(0)
    expect(isBuildActive()).toBe(true)

    setBuildStage('merge', 15)
    addBuildLog('Слияние источников…')
    const cur = getBuildProgress()
    expect(cur?.stage).toBe('merge')
    expect(cur?.percent).toBe(15)
    expect(cur?.log).toHaveLength(1)
    expect(cur?.log[0].msg).toBe('Слияние источников…')

    finishBuildProgress({ ok: true, total: 12345, fileName: 'clearndr-import.rules' })
    const done = getBuildProgress()
    expect(done?.active).toBe(false)
    expect(done?.stage).toBe('done')
    expect(done?.percent).toBe(100)
    expect(done?.finishedAt).toBeTruthy()
    expect(done?.result?.ok).toBe(true)
    expect(done?.result?.total).toBe(12345)
    expect(isBuildActive()).toBe(false)
  })

  it('percent зажимается в 0..100', () => {
    startBuildProgress('cron')
    setBuildStage('render', -5)
    expect(getBuildProgress()?.percent).toBe(0)
    setBuildStage('render', 150)
    expect(getBuildProgress()?.percent).toBe(100)
    setBuildStage('render', 72.6)
    expect(getBuildProgress()?.percent).toBe(73)
  })

  it('журнал ограничен кольцом (600 строк) — крупные сборки не раздут память', () => {
    startBuildProgress('manual')
    for (let i = 1; i <= 700; i++) addBuildLog(`строка ${i}`)
    const p = getBuildProgress()
    expect(p?.log.length).toBe(600)
    expect(p?.log[0].msg).toBe('строка 101')
    expect(p?.log[599].msg).toBe('строка 700')
  })

  it('failBuildProgress фиксирует ошибку и завершает задание', () => {
    startBuildProgress('manual')
    failBuildProgress('конфликтные дубликаты содержимого: 3')
    const p = getBuildProgress()
    expect(p?.active).toBe(false)
    expect(p?.error).toBe('конфликтные дубликаты содержимого: 3')
    expect(p?.result?.ok).toBe(false)
    expect(p?.result?.error).toBe('конфликтные дубликаты содержимого: 3')
    expect(isBuildActive()).toBe(false)
  })

  it('новый запуск сбрасывает предыдущее состояние (в т.ч. журнал)', () => {
    startBuildProgress('manual')
    addBuildLog('старая строка')
    finishBuildProgress({ ok: true })
    const second = startBuildProgress('cron')
    expect(second.origin).toBe('cron')
    expect(second.active).toBe(true)
    expect(second.log).toHaveLength(0)
    expect(second.result).toBeNull()
    expect(second.percent).toBe(0)
  })

  it('без активного задания фазы/лог игнорируются (cron до начала сборки)', () => {
    setBuildStage('merge', 15)
    addBuildLog('ничья строка')
    expect(getBuildProgress()).toBeNull()
  })
})
