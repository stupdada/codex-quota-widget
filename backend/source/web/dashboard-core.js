(function attachDashboardCore(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  root.DashboardCore = api
})(typeof globalThis === 'object' ? globalThis : this, function createDashboardCore() {
  'use strict'

  const PRESETS = new Set([
    'last_15m', 'last_1h', 'last_3h', 'last_24h', 'last_48h', 'last_72h',
    'today', 'week', 'cycle_5h', 'cycle_7d', 'custom',
  ])
  const BUCKETS = new Set(['auto', '1', '2', '5', '10', '15', '30', '60'])
  const DATA_TABS = new Set(['projects', 'threads', 'activity'])
  const TREND_MODES = new Set(['credits', 'tokens', 'api_cost', 'cost'])

  const number = (value, fallback = 0) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const midpoint = (lower, upper) => {
    const low = number(lower)
    return (low + number(upper, low)) / 2
  }

  const costBounds = (item = {}) => {
    const lower = number(item.cost_base ?? item.cost ?? 0)
    const upper = number(item.cost_max ?? lower, lower)
    const complete = item.cost_complete !== false
    return {
      lower,
      mid: complete ? midpoint(lower, upper) : null,
      upper,
      complete,
      exact: complete && Math.abs(upper - lower) < 0.0000005,
    }
  }

  const rateBounds = (summary = {}) => {
    const minutes = Math.max(1 / 60, number(summary.minutes, 1))
    const lower = number(
      summary.cost_base_per_hour,
      number(summary.cost_base) / minutes * 60,
    )
    const upper = number(
      summary.cost_max_per_hour,
      number(summary.cost_max, number(summary.cost_base)) / minutes * 60,
    )
    return costBounds({
      cost_base: lower,
      cost_max: upper,
      cost_complete: summary.cost_complete,
    })
  }

  const normalizeThreshold = (value, fallback = 20) => {
    if (value === '' || value === null || value === undefined) return number(fallback, 20)
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : number(fallback, 20)
  }

  const normalizePinnedRanges = (value) => {
    if (!Array.isArray(value)) return []
    return value
      .filter((item) => item && item.id && item.start && item.end)
      .map((item) => ({
        id: String(item.id),
        start: String(item.start),
        end: String(item.end),
        label: String(item.label || ''),
      }))
  }

  const normalizeState = (saved = {}, defaults = {}) => {
    const source = saved && typeof saved === 'object' ? saved : {}
    const base = defaults && typeof defaults === 'object' ? defaults : {}
    const canonicalPreset = (value) => value === 'cycle' ? 'cycle_5h' : value
    const basePreset = canonicalPreset(base.preset)
    const sourcePreset = canonicalPreset(source.preset)
    const fallbackPreset = PRESETS.has(basePreset) ? basePreset : 'last_3h'
    const fallbackBucket = BUCKETS.has(String(base.bucketMode)) ? String(base.bucketMode) : 'auto'
    const fallbackTab = DATA_TABS.has(base.activeDataTab) ? base.activeDataTab : 'projects'
    const fallbackTrendValue = base.trendMode
    const sourceTrendValue = source.trendMode
    const fallbackTrend = TREND_MODES.has(fallbackTrendValue) ? fallbackTrendValue : 'credits'
    const pinnedRanges = normalizePinnedRanges(source.pinnedRanges ?? base.pinnedRanges)
    const requestedPinned = String(source.activePinnedId ?? base.activePinnedId ?? '')

    return {
      project: String(source.project ?? base.project ?? ''),
      preset: PRESETS.has(sourcePreset) ? sourcePreset : fallbackPreset,
      customStart: String(source.customStart ?? base.customStart ?? ''),
      customEnd: String(source.customEnd ?? base.customEnd ?? ''),
      customEndMode: ['fixed', 'now'].includes(source.customEndMode)
        ? source.customEndMode
        : (['fixed', 'now'].includes(base.customEndMode) ? base.customEndMode : 'fixed'),
      numberMode: ['compact', 'full'].includes(source.numberMode)
        ? source.numberMode
        : (['compact', 'full'].includes(base.numberMode) ? base.numberMode : 'compact'),
      bucketMode: BUCKETS.has(String(source.bucketMode)) ? String(source.bucketMode) : fallbackBucket,
      pinnedRanges,
      activePinnedId: pinnedRanges.some((item) => item.id === requestedPinned) ? requestedPinned : '',
      threshold: normalizeThreshold(source.threshold, normalizeThreshold(base.threshold, 20)),
      activeDataTab: DATA_TABS.has(source.activeDataTab) ? source.activeDataTab : fallbackTab,
      trendMode: TREND_MODES.has(sourceTrendValue) ? sourceTrendValue : fallbackTrend,
      costChartMode: ['pulse', 'line'].includes(source.costChartMode)
        ? source.costChartMode
        : (['pulse', 'line'].includes(base.costChartMode) ? base.costChartMode : 'pulse'),
    }
  }

  const thresholdStatus = (rate, threshold) => {
    const safeThreshold = normalizeThreshold(threshold, 20)
    const ratio = Math.max(0, number(rate)) / safeThreshold
    return {
      level: ratio >= 1 ? 'exceeded' : ratio >= 0.8 ? 'warning' : 'steady',
      ratio,
      percent: ratio * 100,
    }
  }

  const formatMoney = (value, digits) => {
    const amount = number(value)
    if (Number.isInteger(digits) && digits >= 0) return `$${amount.toFixed(digits)}`
    if (amount === 0) return '$0'
    if (Math.abs(amount) < 0.01) return `$${amount.toFixed(6)}`
    if (Math.abs(amount) < 1) return `$${amount.toFixed(4)}`
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const formatTokens = (value, mode = 'compact') => {
    const amount = number(value)
    if (mode === 'full') return Math.round(amount).toLocaleString('zh-CN')
    const absolute = Math.abs(amount)
    const options = { minimumFractionDigits: 3, maximumFractionDigits: 3 }
    if (absolute >= 100000000) return `${(amount / 100000000).toLocaleString('zh-CN', options)}亿`
    if (absolute >= 10000) return `${(amount / 10000).toLocaleString('zh-CN', options)}万`
    return Math.round(amount).toLocaleString('zh-CN')
  }

  const formatCredits = (value, digits) => {
    const amount = number(value)
    if (Number.isInteger(digits) && digits >= 0) return `${amount.toFixed(digits)} cr`
    const maximumFractionDigits = Math.abs(amount) >= 100 ? 1 : Math.abs(amount) >= 10 ? 2 : 3
    return `${amount.toLocaleString('zh-CN', { maximumFractionDigits, minimumFractionDigits: amount === 0 ? 0 : Math.min(1, maximumFractionDigits) })} cr`
  }

  const pricingPrecision = (value) => {
    const normalized = String(value || 'exact').toLowerCase()
    const labels = {
      exact: '精确',
      bounded: '区间估算',
      fallback: '兼容回退',
      partial: '部分数据',
    }
    return { id: labels[normalized] ? normalized : 'partial', label: labels[normalized] || labels.partial }
  }

  const pricingCoverage = (item = {}) => {
    const apiComplete = item.cost_complete !== false && item.complete !== false
    const creditsComplete = item.credits_complete !== false
    const scope = apiComplete
      ? (creditsComplete ? 'complete' : 'credits_only')
      : (creditsComplete ? 'api_only' : 'both')
    return { scope, apiComplete, creditsComplete }
  }

  const quotaStatus = (cycle, nowValue = Date.now(), staleAfterMinutes = 10) => {
    if (!cycle || typeof cycle !== 'object') {
      return { available: false, stale: false, used: null, remaining: null, observedAt: null, resetAt: null }
    }
    if (cycle.used_percent === null || cycle.used_percent === undefined || cycle.used_percent === '') {
      return { available: false, stale: false, used: null, remaining: null, observedAt: null, resetAt: null }
    }
    const observedAt = Date.parse(cycle.observed_at)
    const resetAt = Date.parse(cycle.reset)
    const now = nowValue instanceof Date ? nowValue.getTime() : number(nowValue, Date.now())
    const used = Math.min(100, Math.max(0, number(cycle.used_percent)))
    const stale = !Number.isFinite(observedAt)
      || now - observedAt > Math.max(1, number(staleAfterMinutes, 10)) * 60 * 1000
      || (Number.isFinite(resetAt) && now > resetAt)
    return {
      available: true,
      stale,
      used,
      remaining: Math.max(0, 100 - used),
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
    }
  }

  const quotaEstimateNote = (estimate = {}) => {
    if (estimate.stale) return '额度观测已过期，暂不推算'
    if (estimate.available !== true) {
      const reasons = {
        quota_unused: '新周期尚未产生可用比例，等待历史样本',
        usage_unavailable: '等待本机用量增量后开始估算',
        history_unavailable: '等待额度与本机用量形成可估样本',
      }
      return reasons[estimate.reason] || '额度样本暂不足，无法估算'
    }

    const weight = Math.round(Math.min(1, Math.max(0, number(estimate.weekly_current_weight))) * 100)
    const sources = {
      current_five_hour: '5h实时估算',
      current_weekly: '7d实时估算',
      current_weekly_blend: `7d实时融合 ${weight}%`,
      historical: '历史回退',
    }
    const source = sources[estimate.estimate_source] || '耦合估算'
    const multiplier = Math.max(0, number(estimate.weekly_multiplier, 6)).toFixed(2)
    const multiplierLabel = estimate.multiplier_source === 'learned'
      ? `动态 ${multiplier}×`
      : `${multiplier}×先验`
    const confidence = {
      high: '高置信',
      medium: '中置信',
      low: '低置信',
    }[estimate.confidence] || '低置信'
    const incomplete = estimate.complete === false ? ' · 已知模型部分' : ''
    return `${source} · ${multiplierLabel} · ${confidence} · 非账单${incomplete}`
  }

  const quotaFreshnessLabel = (five = {}, weekly = {}) => {
    const fiveUsable = five.available === true && five.stale !== true
    const weeklyUsable = weekly.available === true && weekly.stale !== true
    const hasStale = (five.available === true && five.stale === true)
      || (weekly.available === true && weekly.stale === true)
    if (weeklyUsable && !fiveUsable) return { label: '仅7d额度可用', stale: false }
    if (fiveUsable && !weeklyUsable) return { label: '仅5h额度可用', stale: false }
    if (fiveUsable && weeklyUsable) {
      const observedTimes = [five.observedAt, weekly.observedAt].filter(Number.isFinite)
      const freshest = observedTimes.length ? Math.max(...observedTimes) : null
      if (freshest !== null) {
        return {
          label: `观测 ${new Date(freshest).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
          stale: false,
        }
      }
    }
    return {
      label: hasStale ? '数据可能已过期' : '额度未读取',
      stale: hasStale,
    }
  }

  const validateStatsResponse = (data) => {
    if (!data || typeof data !== 'object') return { ok: false, reason: '响应不是对象' }
    const app = data.app
    if (!app || app.app_id !== 'codex-token-dashboard') return { ok: false, reason: '应用标识不匹配' }
    if (number(app.api_version) < 2) return { ok: false, reason: '统计接口版本过旧' }
    if (!data.summary || typeof data.summary !== 'object') return { ok: false, reason: '缺少 summary' }
    if (!Array.isArray(data.series)) return { ok: false, reason: '缺少 series' }
    return { ok: true, reason: '' }
  }

  const metricValue = (item = {}, mode = 'credits') => {
    if (mode === 'tokens') return number(item.total)
    if (mode === 'api_cost') {
      const bounds = costBounds(item)
      return bounds.mid === null ? bounds.lower : bounds.mid
    }
    return number(item.credits)
  }

  const costLabel = (bounds = {}) => {
    if (bounds.complete === false || bounds.mid === null) return `≥ ${formatMoney(bounds.lower)}`
    return formatMoney(bounds.mid)
  }

  const projectLabel = (value) => {
    const cleaned = String(value || '').replace(/[\\/]+$/, '')
    return cleaned.split(/[\\/]/).pop() || '未命名项目'
  }

  const costRatePoint = (point = {}, fallbackBucketMinutes = 1) => {
    const bounds = costBounds(point)
    const fallback = Math.max(1 / 60, number(fallbackBucketMinutes, 1))
    const minutes = Math.max(1 / 60, number(point.effective_minutes, fallback))
    const factor = 60 / minutes
    const scaled = (value) => Number((value * factor).toPrecision(15))
    return {
      lower: scaled(bounds.lower),
      mid: bounds.mid === null ? null : scaled(bounds.mid),
      upper: scaled(bounds.upper),
      complete: bounds.complete,
      exact: bounds.exact,
      minutes,
    }
  }

  const costShare = (rowBounds = {}, summaryBounds = {}) => {
    const summaryUsesMidpoint = summaryBounds.complete !== false && summaryBounds.mid !== null
    const numerator = summaryUsesMidpoint && rowBounds.complete !== false && rowBounds.mid !== null
      ? number(rowBounds.mid)
      : number(rowBounds.lower)
    const denominator = summaryUsesMidpoint
      ? number(summaryBounds.mid)
      : number(summaryBounds.lower)
    const rawPercent = denominator > 0 ? numerator / denominator * 100 : 0
    return {
      percent: Math.min(100, Math.max(0, rawPercent)),
      basis: summaryUsesMidpoint ? 'midpoint' : 'known-lower',
    }
  }

  const clampTimeRange = (startValue, endValue, minimumValue, maximumValue) => {
    const startTime = Date.parse(startValue)
    const endTime = Date.parse(endValue)
    const minimumTime = Date.parse(minimumValue)
    const maximumTime = Date.parse(maximumValue)
    if (![startTime, endTime, minimumTime, maximumTime].every(Number.isFinite)) return null
    const start = Math.max(startTime, minimumTime)
    const end = Math.min(endTime, maximumTime)
    if (start >= end) return null
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    }
  }

  const selectionAnchors = (series = [], selection = null) => {
    if (!Array.isArray(series) || !series.length || !selection) return null
    const first = Math.min(number(selection.start, -1), number(selection.end, -1))
    const last = Math.max(number(selection.start, -1), number(selection.end, -1))
    if (!Number.isInteger(first) || !Number.isInteger(last) || !series[first] || !series[last]) return null
    if (!series[first].iso || !series[last].iso) return null
    return { startIso: String(series[first].iso), endIso: String(series[last].iso) }
  }

  const remapSelection = (series = [], anchors = null) => {
    if (!Array.isArray(series) || !series.length || !anchors) return null
    const times = series.map((point) => Date.parse(point && point.iso))
    if (!times.every(Number.isFinite)) return null
    const startTime = Date.parse(anchors.startIso)
    const endTime = Date.parse(anchors.endIso)
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
    const low = Math.min(startTime, endTime)
    const high = Math.max(startTime, endTime)
    const seriesLow = Math.min(...times)
    const seriesHigh = Math.max(...times)
    if (high < seriesLow || low > seriesHigh) return null
    const nearestIndex = (target) => {
      let bestIndex = 0
      let bestDistance = Number.POSITIVE_INFINITY
      times.forEach((time, index) => {
        const distance = Math.abs(time - target)
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = index
        }
      })
      return bestIndex
    }
    const start = nearestIndex(Math.max(seriesLow, low))
    const end = nearestIndex(Math.min(seriesHigh, high))
    return { start: Math.min(start, end), end: Math.max(start, end) }
  }

  return {
    midpoint,
    costBounds,
    rateBounds,
    normalizeThreshold,
    normalizePinnedRanges,
    normalizeState,
    thresholdStatus,
    formatMoney,
    formatTokens,
    formatCredits,
    pricingPrecision,
    pricingCoverage,
    quotaStatus,
    quotaEstimateNote,
    quotaFreshnessLabel,
    validateStatsResponse,
    metricValue,
    costLabel,
    projectLabel,
    costRatePoint,
    costShare,
    clampTimeRange,
    selectionAnchors,
    remapSelection,
  }
})
