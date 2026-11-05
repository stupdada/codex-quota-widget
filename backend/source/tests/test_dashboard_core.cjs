const test = require('node:test')
const assert = require('node:assert/strict')

let core = {}
try {
  core = require('../web/dashboard-core.js')
} catch {
  // RED begins with the extracted core absent.
}

function needs(name) {
  assert.equal(typeof core[name], 'function', `${name} should be exported`)
  return core[name]
}

test('complete costs expose an arithmetic midpoint', () => {
  const midpoint = needs('midpoint')
  const costBounds = needs('costBounds')
  assert.equal(midpoint(43.65, 47.20), 45.425)
  assert.deepEqual(costBounds({
    cost_base: 43.65,
    cost_max: 47.20,
    cost_complete: true,
  }), {
    lower: 43.65,
    mid: 45.425,
    upper: 47.20,
    complete: true,
    exact: false,
  })
})

test('incomplete pricing never invents a midpoint', () => {
  const costBounds = needs('costBounds')
  const costLabel = needs('costLabel')
  const bounds = costBounds({ cost_base: 4.2, cost_max: 9.9, cost_complete: false })
  assert.equal(bounds.mid, null)
  assert.equal(costLabel(bounds), '≥ $4.20')
})

test('hourly bounds use API values and preserve completeness', () => {
  const rateBounds = needs('rateBounds')
  assert.deepEqual(rateBounds({
    cost_base_per_hour: 14.55,
    cost_max_per_hour: 15.73,
    cost_complete: true,
  }), {
    lower: 14.55,
    mid: 15.14,
    upper: 15.73,
    complete: true,
    exact: false,
  })
})

test('threshold states meet exact boundaries', () => {
  const thresholdStatus = needs('thresholdStatus')
  assert.equal(thresholdStatus(15.98, 20).level, 'steady')
  assert.equal(thresholdStatus(16, 20).level, 'warning')
  assert.equal(thresholdStatus(19.99, 20).level, 'warning')
  assert.equal(thresholdStatus(20, 20).level, 'exceeded')
  assert.equal(thresholdStatus(25, 20).percent, 125)
})

test('threshold normalization rejects invalid values', () => {
  const normalizeThreshold = needs('normalizeThreshold')
  assert.equal(normalizeThreshold('', 20), 20)
  assert.equal(normalizeThreshold(-1, 20), 20)
  assert.equal(normalizeThreshold('25.5', 20), 25.5)
})

test('quota estimate note exposes live blend, learned multiplier and confidence', () => {
  const quotaEstimateNote = needs('quotaEstimateNote')
  assert.equal(quotaEstimateNote({
    available: true,
    estimate_source: 'current_weekly_blend',
    weekly_current_weight: 0.5,
    weekly_multiplier: 6.12,
    multiplier_source: 'learned',
    confidence: 'medium',
    complete: true,
  }), '7d实时融合 50% · 动态 6.12× · 中置信 · 非账单')
})

test('quota estimate note makes historical prior fallback explicit', () => {
  const quotaEstimateNote = needs('quotaEstimateNote')
  assert.equal(quotaEstimateNote({
    available: true,
    estimate_source: 'historical',
    weekly_current_weight: 0,
    weekly_multiplier: 6,
    multiplier_source: 'prior',
    confidence: 'low',
    complete: true,
  }), '历史回退 · 6.00×先验 · 低置信 · 非账单')
})

test('stale five-hour evidence does not hide a fresh weekly-only state', () => {
  const quotaFreshnessLabel = needs('quotaFreshnessLabel')
  assert.deepEqual(quotaFreshnessLabel(
    { available: true, stale: true, observedAt: Date.parse('2026-07-13T03:00:00+08:00') },
    { available: true, stale: false, observedAt: Date.parse('2026-07-13T13:00:00+08:00') },
  ), {
    label: '仅7d额度可用',
    stale: false,
  })
})

test('persisted v3 state is normalized without losing valid choices', () => {
  const normalizeState = needs('normalizeState')
  const defaults = {
    project: '', preset: 'last_3h', customStart: '', customEnd: '',
    numberMode: 'compact', bucketMode: 'auto', pinnedRanges: [], activePinnedId: '',
    threshold: 20, activeDataTab: 'projects', trendMode: 'cost',
    customEndMode: 'fixed', costChartMode: 'pulse',
  }
  const state = normalizeState({
    project: 42,
    preset: 'cycle',
    numberMode: 'full',
    bucketMode: '15',
    threshold: '25.5',
    activeDataTab: 'bad',
    trendMode: 'bad',
    customEndMode: 'now', costChartMode: 'line', source: 'combined',
    pinnedRanges: 'bad',
  }, defaults)
  assert.equal(state.project, '42')
  assert.equal(state.preset, 'cycle_5h')
  assert.equal(state.numberMode, 'full')
  assert.equal(state.bucketMode, '15')
  assert.equal(state.threshold, 25.5)
  assert.equal(state.activeDataTab, 'projects')
  assert.equal(state.trendMode, 'cost')
  assert.equal(state.customEndMode, 'now')
  assert.equal(state.costChartMode, 'line')
  assert.equal(Object.hasOwn(state, 'source'), false)
  assert.deepEqual(state.pinnedRanges, [])
})

test('five-hour and seven-day cycle presets survive state normalization', () => {
  const normalizeState = needs('normalizeState')
  const defaults = { preset: 'last_3h' }
  assert.equal(normalizeState({ preset: 'cycle_5h' }, defaults).preset, 'cycle_5h')
  assert.equal(normalizeState({ preset: 'cycle_7d' }, defaults).preset, 'cycle_7d')
})

test('both quota-cycle presets are accepted and legacy cycle migrates to 5h', () => {
  const normalizeState = needs('normalizeState')
  const defaults = { preset: 'last_3h' }
  assert.equal(normalizeState({ preset: 'cycle_5h' }, defaults).preset, 'cycle_5h')
  assert.equal(normalizeState({ preset: 'cycle_7d' }, defaults).preset, 'cycle_7d')
  assert.equal(normalizeState({ preset: 'cycle' }, defaults).preset, 'cycle_5h')
})

test('token and money formats preserve the original dashboard conventions', () => {
  const formatTokens = needs('formatTokens')
  const formatMoney = needs('formatMoney')
  assert.equal(formatTokens(12_345, 'compact'), '1.235万')
  assert.equal(formatTokens(123_456_789, 'compact'), '1.235亿')
  assert.equal(formatTokens(12_345, 'full'), '12,345')
  assert.equal(formatMoney(0), '$0')
  assert.equal(formatMoney(0.005), '$0.005000')
  assert.equal(formatMoney(0.42), '$0.4200')
  assert.equal(formatMoney(45.425), '$45.43')
})

test('credits formatting and metric selection are credits-first', () => {
  const formatCredits = needs('formatCredits')
  const metricValue = needs('metricValue')
  assert.equal(formatCredits(0), '0 cr')
  assert.equal(formatCredits(1940.933), '1,940.9 cr')
  const row = { credits: 12.5, total: 999, cost_base: 2, cost_max: 4, cost_complete: true }
  assert.equal(metricValue(row, 'credits'), 12.5)
  assert.equal(metricValue(row, 'tokens'), 999)
  assert.equal(metricValue(row, 'api_cost'), 3)
})

test('quota freshness distinguishes missing fresh and stale server evidence', () => {
  const quotaStatus = needs('quotaStatus')
  const now = Date.parse('2026-07-11T10:00:00Z')
  assert.equal(quotaStatus(null, now).available, false)
  assert.equal(quotaStatus({ used_percent: null }, now).available, false)
  const fresh = quotaStatus({
    used_percent: 30,
    observed_at: '2026-07-11T09:55:00Z',
    reset: '2026-07-11T13:00:00Z',
  }, now)
  assert.equal(fresh.available, true)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.remaining, 70)
  const stale = quotaStatus({
    used_percent: 30,
    observed_at: '2026-07-11T09:30:00Z',
    reset: '2026-07-11T13:00:00Z',
  }, now)
  assert.equal(stale.stale, true)
})

test('response validation rejects legacy or malformed payloads', () => {
  const validateStatsResponse = needs('validateStatsResponse')
  assert.equal(validateStatsResponse(null).ok, false)
  assert.equal(validateStatsResponse({ app: { app_id: 'codex-token-dashboard', api_version: 1 }, summary: {}, series: [] }).ok, false)
  assert.equal(validateStatsResponse({ app: { app_id: 'codex-token-dashboard', api_version: 2 }, summary: {}, series: [] }).ok, true)
})

test('pricing precision has explicit user-facing states', () => {
  const pricingPrecision = needs('pricingPrecision')
  assert.deepEqual(pricingPrecision('exact'), { id: 'exact', label: '精确' })
  assert.deepEqual(pricingPrecision('bounded'), { id: 'bounded', label: '区间估算' })
  assert.deepEqual(pricingPrecision('unknown'), { id: 'partial', label: '部分数据' })
})

test('pricing coverage separates API and Credits completeness', () => {
  const pricingCoverage = needs('pricingCoverage')
  assert.deepEqual(pricingCoverage({}), {
    scope: 'complete', apiComplete: true, creditsComplete: true,
  })
  assert.deepEqual(pricingCoverage({ cost_complete: false, credits_complete: true }), {
    scope: 'api_only', apiComplete: false, creditsComplete: true,
  })
  assert.deepEqual(pricingCoverage({ cost_complete: true, credits_complete: false }), {
    scope: 'credits_only', apiComplete: true, creditsComplete: false,
  })
  assert.deepEqual(pricingCoverage({ cost_complete: false, credits_complete: false }), {
    scope: 'both', apiComplete: false, creditsComplete: false,
  })
})

test('project labels preserve the useful path tail', () => {
  const projectLabel = needs('projectLabel')
  assert.equal(projectLabel('C:\\Users\\Administrator\\Documents\\Codex\\TOKEN'), 'TOKEN')
  assert.equal(projectLabel('/home/me/Stock/'), 'Stock')
  assert.equal(projectLabel(''), '未命名项目')
})

test('bucket cost rate uses real effective minutes', () => {
  const costRatePoint = needs('costRatePoint')
  const point = costRatePoint({
    cost_base: 1,
    cost_max: 1.4,
    cost_complete: true,
    effective_minutes: 5,
  }, 30)
  assert.equal(point.lower, 12)
  assert.equal(point.mid, 14.4)
  assert.ok(Math.abs(point.upper - 16.8) < 1e-12)
  assert.equal(point.minutes, 5)
})

test('bucket cost rate falls back for older API payloads', () => {
  const costRatePoint = needs('costRatePoint')
  const point = costRatePoint({
    cost_base: 2,
    cost_max: 2,
    cost_complete: true,
  }, 30)
  assert.equal(point.mid, 4)
  assert.equal(point.minutes, 30)
})

test('cost shares use one honest basis when aggregate pricing is incomplete', () => {
  const costShare = needs('costShare')
  const completeRow = { lower: 60, mid: 90, upper: 120, complete: true }
  const incompleteSummary = { lower: 100, mid: null, upper: 180, complete: false }
  assert.deepEqual(costShare(completeRow, incompleteSummary), {
    percent: 60,
    basis: 'known-lower',
  })

  const completeSummary = { lower: 100, mid: 150, upper: 200, complete: true }
  assert.deepEqual(costShare(completeRow, completeSummary), {
    percent: 60,
    basis: 'midpoint',
  })
})

test('cost shares are bounded even when rounded source rows exceed their aggregate', () => {
  const costShare = needs('costShare')
  assert.equal(costShare(
    { lower: 101, mid: null, upper: 101, complete: false },
    { lower: 100, mid: null, upper: 100, complete: false },
  ).percent, 100)
})

test('selected bucket ranges clamp to the real API range on both edges', () => {
  const clampTimeRange = needs('clampTimeRange')
  assert.deepEqual(clampTimeRange(
    '2026-07-10T08:45:00Z',
    '2026-07-10T09:45:00Z',
    '2026-07-10T09:00:00Z',
    '2026-07-10T09:30:00Z',
  ), {
    start: '2026-07-10T09:00:00.000Z',
    end: '2026-07-10T09:30:00.000Z',
  })
  assert.equal(clampTimeRange('bad', 'also bad', '2026-07-10T09:00:00Z', '2026-07-10T09:30:00Z'), null)
})

test('selection anchors remap across quiet refreshes without using stale indexes', () => {
  const selectionAnchors = needs('selectionAnchors')
  const remapSelection = needs('remapSelection')
  const before = [
    { iso: '2026-07-10T09:00:00Z' },
    { iso: '2026-07-10T09:15:00Z' },
    { iso: '2026-07-10T09:30:00Z' },
  ]
  const anchors = selectionAnchors(before, { start: 0, end: 1 })
  assert.deepEqual(anchors, {
    startIso: '2026-07-10T09:00:00Z',
    endIso: '2026-07-10T09:15:00Z',
  })
  const after = [
    { iso: '2026-07-10T08:45:00Z' },
    { iso: '2026-07-10T09:00:00Z' },
    { iso: '2026-07-10T09:15:00Z' },
    { iso: '2026-07-10T09:30:00Z' },
  ]
  assert.deepEqual(remapSelection(after, anchors), { start: 1, end: 2 })
  assert.equal(remapSelection(after, {
    startIso: '2026-07-10T10:00:00Z',
    endIso: '2026-07-10T10:15:00Z',
  }), null)
})
