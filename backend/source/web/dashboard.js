(function dashboardApplication() {
  'use strict'

  const core = window.DashboardCore
  const STORAGE_KEY = 'codex-token-dashboard-state-v3'
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000
  const ACTIVATION_REFRESH_DEBOUNCE_MS = 350
  const RANGE_SWITCH_DEBOUNCE_MS = 150
  const RANGE_CACHE_MAX_AGE_MS = 5 * 60 * 1000
  const RANGE_CACHE_MAX_ENTRIES = 12
  const PREFETCH_PRESETS = Object.freeze(['last_3h', 'last_24h', 'today', 'week', 'cycle_5h', 'cycle_7d'])
  const QUOTA_LINE_KEYS = Object.freeze(['five', 'seven', 'ideal'])
  const SIGNAL_SETTINGS_DEFAULTS = Object.freeze({
    warningBreathMs: 4000,
    criticalBlinkMs: 3000,
    quotaRefreshMs: 3 * 60 * 1000,
    usageRange: 'cycle_5h',
  })
  const SIGNAL_USAGE_RANGES = new Set(['cycle_5h', 'cycle_7d', 'last_3h', 'today', 'week'])
  const DEFAULT_STATE = Object.freeze({
    project: '',
    preset: 'last_3h',
    customStart: '',
    customEnd: '',
    customEndMode: 'fixed',
    numberMode: 'compact',
    bucketMode: 'auto',
    pinnedRanges: [],
    activePinnedId: '',
    threshold: 20,
    activeDataTab: 'projects',
    trendMode: 'cost',
    costChartMode: 'pulse',
    quotaLines: Object.freeze({ five: true, seven: true, ideal: true }),
  })

  const runtime = {
    lastGoodData: null,
    latestRange: null,
    loading: false,
    error: null,
    lastSuccessAt: null,
    selectedRange: null,
    dragStartIndex: null,
    hoverIndex: null,
    chartSeries: [],
    plotGeometry: null,
    requestSeq: 0,
    requestController: null,
    rangeCache: new Map(),
    rangeLoadTimer: 0,
    prefetchTimer: 0,
    prefetchController: null,
    prefetchAttempted: new Set(),
    selectedRowKey: '',
    stickyValueDetail: '',
    statusTimer: 0,
    panelOpeners: {},
    pointerGesture: null,
    pendingQuietData: null,
    resetExitStatus: null,
    resetExitLoading: false,
    quotaHistoryData: null,
    quotaHistoryLoading: false,
    quotaHistoryError: null,
    quotaHistoryRequestSeq: 0,
    quotaHistoryController: null,
    shortcutDraft: { toggleDashboard: null, toggleFloatingWidget: null },
    shortcutRecording: '',
    activationRefreshTimer: 0,
  }

  const $ = (id) => document.getElementById(id)
  const create = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }
  const append = (parent, ...children) => {
    children.filter(Boolean).forEach((child) => parent.append(child))
    return parent
  }
  const numeric = (value, fallback = 0) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function normalizeQuotaLines(value) {
    const source = value && typeof value === 'object' ? value : {}
    const normalized = Object.fromEntries(QUOTA_LINE_KEYS.map((key) => [key, source[key] !== false]))
    if (!QUOTA_LINE_KEYS.some((key) => normalized[key])) normalized.five = true
    return normalized
  }

  function loadState() {
    if (!core) return { ...DEFAULT_STATE }
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      const normalized = core.normalizeState(saved, DEFAULT_STATE)
      return {
        ...normalized,
        trendMode: saved.trendMode === 'quota' ? 'quota' : normalized.trendMode,
        quotaLines: normalizeQuotaLines(saved.quotaLines),
      }
    } catch {
      return { ...DEFAULT_STATE, quotaLines: { ...DEFAULT_STATE.quotaLines } }
    }
  }

  let state = loadState()

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  function setAnimatedText(node, value) {
    const text = String(value)
    if (!node || node.textContent === text) return
    if (!reducedMotion() && typeof node.animate === 'function') {
      node.animate(
        [
          { opacity: 0.42, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      )
    }
    node.textContent = text
  }

  function setTextIfChanged(node, value) {
    const text = String(value)
    if (node && node.textContent !== text) node.textContent = text
  }

  function formatTokens(value) {
    return core.formatTokens(value, state.numberMode)
  }

  function formatPercent(value, digits = 1) {
    return `${numeric(value).toFixed(digits)}%`
  }

  function formatCredits(value) {
    const amount = numeric(value)
    if (amount >= 1000) return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} cr`
    if (amount >= 10) return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} cr`
    return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} cr`
  }

  function toDatetimeLocal(value) {
    const date = value instanceof Date ? value : new Date(value)
    const pad = (numberValue) => String(numberValue).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  function validCustomRange(range) {
    if (!range.start || !range.end) return false
    const start = new Date(range.start).getTime()
    const end = new Date(range.end).getTime()
    return Number.isFinite(start) && Number.isFinite(end) && start < end
  }

  function formatPinnedLabel(start, end, endMode = 'fixed') {
    const clean = (value) => String(value || '').replace('T', ' ').slice(5, 16)
    return `${clean(start)} – ${endMode === 'now' ? '现在' : clean(end)}`
  }

  function syncCustomEndMode() {
    const useNow = state.customEndMode === 'now'
    $('fixedEndMode').setAttribute('aria-pressed', String(!useNow))
    $('nowEndMode').setAttribute('aria-pressed', String(useNow))
    $('customEnd').disabled = useNow
    $('customEndHint').hidden = !useNow
    if (useNow) $('customEnd').value = toDatetimeLocal(Date.now())
  }

  function setLoading(loading) {
    runtime.loading = loading
    document.body.dataset.loading = String(loading)
    ;[$('refreshButton'), $('applyCustom'), $('pinCustom'), $('updatePinned')].forEach((button) => {
      if (button) button.disabled = loading
    })
    if (!loading) $('updatePinned').disabled = !state.activePinnedId
  }

  function setStatus(message, kind = 'info', retry = false) {
    const region = $('statusRegion')
    window.clearTimeout(runtime.statusTimer)
    region.replaceChildren()
    region.dataset.kind = kind
    append(region, create('span', '', message))
    if (retry) {
      const button = create('button', '', '重试')
      button.type = 'button'
      button.addEventListener('click', () => load())
      region.append(button)
    }
    region.hidden = false
    if (kind !== 'error') {
      runtime.statusTimer = window.setTimeout(() => {
        region.hidden = true
      }, kind === 'loading' ? 4200 : 2200)
    }
  }

  function panelButton(panelId) {
    if (panelId === 'thresholdPopover') return $('thresholdButton')
    if (panelId === 'morePanel') return $('moreButton')
    return null
  }

  function closePanel(panelId, restoreFocus = false) {
    const panel = $(panelId)
    if (!panel) return
    const opener = runtime.panelOpeners[panelId]
    panel.hidden = true
    const button = panelButton(panelId)
    if (button) button.setAttribute('aria-expanded', 'false')
    if (panelId === 'thresholdPopover') $('thresholdInlineButton').setAttribute('aria-expanded', 'false')
    if (restoreFocus && opener && opener.isConnected && typeof opener.focus === 'function') {
      opener.focus({ preventScroll: true })
    }
    delete runtime.panelOpeners[panelId]
  }

  function closePanels(exceptId = '', restoreFocus = false) {
    ;['thresholdPopover', 'morePanel'].forEach((panelId) => {
      if (panelId !== exceptId) closePanel(panelId, restoreFocus)
    })
  }

  function togglePanel(panelId, opener = document.activeElement) {
    const panel = $(panelId)
    if (!panel) return
    const shouldOpen = panel.hidden
    closePanels(shouldOpen ? panelId : '')
    panel.hidden = !shouldOpen
    if (shouldOpen && opener) runtime.panelOpeners[panelId] = opener
    const button = panelButton(panelId)
    if (button) button.setAttribute('aria-expanded', String(shouldOpen))
    if (panelId === 'thresholdPopover') $('thresholdInlineButton').setAttribute('aria-expanded', String(shouldOpen))
    if (shouldOpen && panelId === 'thresholdPopover') {
      $('thresholdInput').value = String(state.threshold)
      $('thresholdError').textContent = ''
      window.setTimeout(() => $('thresholdInput').focus(), 0)
    }
  }

  function syncTabIndicator(container) {
    const selected = container.querySelector('[aria-selected="true"]')
    if (!selected) return
    container.style.setProperty('--indicator-x', `${selected.offsetLeft}px`)
    container.style.setProperty('--indicator-width', `${selected.offsetWidth}px`)
  }

  function syncPresetControls() {
    document.querySelectorAll('[data-preset]').forEach((button) => {
      const selected = button.dataset.preset === state.preset
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-pressed', String(selected))
    })
    $('presetModeMobile').value = state.preset
    $('updatePinned').disabled = runtime.loading || !state.activePinnedId
    renderPinnedRanges()
  }

  function syncQuotaControls() {
    document.querySelectorAll('[data-quota-line]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Boolean(state.quotaLines[button.dataset.quotaLine])))
    })
  }

  function syncControls() {
    $('projectInput').value = state.project
    $('projectInputMobile').value = state.project
    $('numberMode').value = state.numberMode
    $('bucketMode').value = state.bucketMode
    $('presetModeMobile').value = state.preset
    $('thresholdInput').value = String(state.threshold)
    $('thresholdButtonValue').textContent = `${core.formatMoney(state.threshold)}/h`
    $('thresholdInlineValue').textContent = `${core.formatMoney(state.threshold)}/h`
    $('customStart').value = state.customStart || toDatetimeLocal(Date.now() - 3 * 60 * 60 * 1000)
    $('customEnd').value = state.customEnd || toDatetimeLocal(Date.now())
    syncCustomEndMode()
    syncPresetControls()
    setActiveDataTab(state.activeDataTab, false)
    setTrendMode(state.trendMode, false)
    setCostChartMode(state.costChartMode, false)
    syncQuotaControls()
  }

  function renderPinnedRanges() {
    const area = $('pinnedRanges')
    area.replaceChildren()
    const ranges = core.normalizePinnedRanges(state.pinnedRanges)
    ranges.forEach((item) => {
      const group = create('span', 'pinned-item')
      group.classList.toggle('is-selected', item.id === state.activePinnedId)
      const selectButton = create('button', '', item.label || formatPinnedLabel(item.start, item.end, item.endMode))
      selectButton.type = 'button'
      selectButton.title = `${item.start} – ${item.end}`
      selectButton.addEventListener('click', () => selectPinnedRange(item.id, true))
      const editButton = create('button', '', '编辑')
      editButton.type = 'button'
      editButton.addEventListener('click', () => selectPinnedRange(item.id, false))
      const deleteButton = create('button', '', '×')
      deleteButton.type = 'button'
      deleteButton.setAttribute('aria-label', `删除固定范围 ${item.label || ''}`)
      deleteButton.addEventListener('click', () => deletePinnedRange(item.id))
      append(group, selectButton, editButton, deleteButton)
      area.append(group)
    })
  }

  function currentCustomRange() {
    return {
      start: $('customStart').value,
      end: state.customEndMode === 'now' ? toDatetimeLocal(Date.now()) : $('customEnd').value,
      endMode: state.customEndMode,
    }
  }

  function showCustomError(message) {
    $('customRangeError').textContent = message
    if (message) setStatus(message, 'error')
  }

  function selectPinnedRange(id, shouldLoad) {
    const item = core.normalizePinnedRanges(state.pinnedRanges).find((range) => range.id === id)
    if (!item) return
    state.preset = 'custom'
    state.activePinnedId = item.id
    state.customStart = item.start
    state.customEnd = item.end
    state.customEndMode = item.endMode === 'now' ? 'now' : 'fixed'
    $('customStart').value = item.start
    $('customEnd').value = item.end
    syncCustomEndMode()
    saveState()
    syncPresetControls()
    if (shouldLoad) load()
  }

  function pinCustomRange() {
    const range = currentCustomRange()
    if (!validCustomRange(range)) {
      showCustomError('自定义范围无效：开始时间必须早于结束时间')
      return
    }
    const item = {
      id: `p${Date.now().toString(36)}`,
      start: range.start,
      end: range.end,
      endMode: range.endMode,
      label: formatPinnedLabel(range.start, range.end, range.endMode),
    }
    state = {
      ...state,
      preset: 'custom',
      activePinnedId: item.id,
      customStart: range.start,
      customEnd: range.end,
      customEndMode: range.endMode,
      pinnedRanges: [...core.normalizePinnedRanges(state.pinnedRanges), item],
    }
    saveState()
    syncPresetControls()
    showCustomError('')
    load()
  }

  function updatePinnedRange() {
    const range = currentCustomRange()
    if (!state.activePinnedId) {
      showCustomError('请先选择一个固定范围')
      return
    }
    if (!validCustomRange(range)) {
      showCustomError('自定义范围无效：开始时间必须早于结束时间')
      return
    }
    state = {
      ...state,
      preset: 'custom',
      customStart: range.start,
      customEnd: range.end,
      customEndMode: range.endMode,
      pinnedRanges: core.normalizePinnedRanges(state.pinnedRanges).map((item) => (
        item.id === state.activePinnedId
          ? { ...item, start: range.start, end: range.end, endMode: range.endMode, label: formatPinnedLabel(range.start, range.end, range.endMode) }
          : item
      )),
    }
    saveState()
    syncPresetControls()
    showCustomError('')
    load()
  }

  function deletePinnedRange(id) {
    state = {
      ...state,
      pinnedRanges: core.normalizePinnedRanges(state.pinnedRanges).filter((item) => item.id !== id),
      activePinnedId: state.activePinnedId === id ? '' : state.activePinnedId,
    }
    saveState()
    syncPresetControls()
  }

  function applyCustomRange() {
    const range = currentCustomRange()
    if (!validCustomRange(range)) {
      showCustomError('自定义范围无效：开始时间必须早于结束时间')
      return
    }
    state = { ...state, preset: 'custom', customStart: range.start, customEnd: range.end, customEndMode: range.endMode }
    saveState()
    syncPresetControls()
    showCustomError('')
    closePanel('morePanel', true)
    load()
  }

  function saveThreshold() {
    const raw = $('thresholdInput').value
    const parsed = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) {
      $('thresholdError').textContent = '请输入大于 0 的有限金额'
      $('thresholdInput').value = String(state.threshold)
      return
    }
    state = { ...state, threshold: parsed }
    saveState()
    $('thresholdError').textContent = ''
    $('thresholdButtonValue').textContent = `${core.formatMoney(state.threshold)}/h`
    $('thresholdInlineValue').textContent = `${core.formatMoney(state.threshold)}/h`
    closePanel('thresholdPopover', true)
    if (runtime.lastGoodData) renderOverview(runtime.lastGoodData)
    renderTrend()
    setStatus(`阈值已更新为 ${core.formatMoney(state.threshold)}/h`)
  }

  function resetThreshold() {
    $('thresholdInput').value = '20'
    state = { ...state, threshold: 20 }
    saveState()
    saveThreshold()
  }

  function detailRow(label, value) {
    const row = create('span', 'detail-line')
    append(row, create('span', '', label), create('strong', '', value))
    return row
  }

  function renderCostDetails(target, bounds, label, suffix = '') {
    target.replaceChildren()
    if (bounds.exact) {
      append(target, detailRow('精确金额', `${core.formatMoney(bounds.mid)}${suffix}`))
    } else {
      const lowerLabel = bounds.complete ? '估算下限' : '已知定价下限'
      append(target, detailRow(lowerLabel, `${core.formatMoney(bounds.lower)}${suffix}`))
      append(target, detailRow('区间中点', bounds.mid === null ? '不可确定' : `${core.formatMoney(bounds.mid)}${suffix}`))
      append(target, detailRow('估算上限', bounds.complete ? `${core.formatMoney(bounds.upper)}${suffix}` : '不可确定'))
    }
    const note = create(
      'p',
      `detail-note${bounds.complete ? '' : ' is-incomplete'}`,
      bounds.exact
        ? `${label}无需估算区间`
        : (bounds.complete ? `${label}以区间中点简洁显示` : 'API 美元估值不完整，未用虚构价格补齐'),
    )
    target.append(note)
  }

  function setValueDetail(kind, visible, sticky = false) {
    const detail = kind === 'cost' ? $('costDetails') : $('rateDetails')
    const button = kind === 'cost' ? $('costDisclosure') : $('rateDisclosure')
    if (sticky) runtime.stickyValueDetail = visible ? kind : ''
    const shouldShow = visible || runtime.stickyValueDetail === kind
    detail.hidden = !shouldShow
    button.setAttribute('aria-expanded', String(shouldShow))
  }

  function bindValueDisclosure(kind) {
    const button = kind === 'cost' ? $('costDisclosure') : $('rateDisclosure')
    button.addEventListener('mouseenter', () => setValueDetail(kind, true))
    button.addEventListener('mouseleave', () => setValueDetail(kind, false))
    button.addEventListener('focus', () => setValueDetail(kind, true))
    button.addEventListener('blur', () => setValueDetail(kind, false))
    button.addEventListener('click', () => {
      const open = runtime.stickyValueDetail !== kind
      runtime.stickyValueDetail = open ? kind : ''
      ;['cost', 'rate'].forEach((valueKind) => setValueDetail(valueKind, valueKind === kind && open))
    })
  }

  function renderThreshold(rate) {
    const container = $('thresholdState')
    const orbit = $('thresholdOrbit')
    const circumference = 2 * Math.PI * 50
    if (!rate.complete || rate.mid === null) {
      container.dataset.thresholdState = 'incomplete'
      setTextIfChanged($('thresholdPercent'), '—')
      setTextIfChanged($('thresholdHeadline'), 'API 估值不完整')
      setTextIfChanged($('thresholdDescription'), 'API 美元计价层级未确认，暂不与阈值比较')
      orbit.style.strokeDashoffset = String(circumference)
      return
    }
    const status = core.thresholdStatus(rate.mid, state.threshold)
    const labels = {
      steady: ['状态平稳', `低于 ${core.formatMoney(state.threshold)}/h 阈值`],
      warning: ['接近阈值', `已使用 ${formatPercent(status.percent)}，请留意趋势`],
      exceeded: ['已超出阈值', `超过 ${core.formatMoney(state.threshold)}/h 的设定`],
    }
    const previousLevel = container.dataset.thresholdState
    container.dataset.thresholdState = status.level
    setTextIfChanged($('thresholdPercent'), formatPercent(status.percent))
    setTextIfChanged($('thresholdHeadline'), labels[status.level][0])
    setTextIfChanged($('thresholdDescription'), labels[status.level][1])
    orbit.style.strokeDashoffset = String(circumference * (1 - clamp(status.ratio, 0, 1)))
    if (status.level === 'exceeded' && previousLevel !== 'exceeded' && !reducedMotion() && typeof container.animate === 'function') {
      container.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.018)' }, { transform: 'scale(1)' }],
        { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      )
    }
  }

  function renderSummaryFacts(summary) {
    const facts = $('summaryFacts')
    const cacheRate = numeric(summary.input) ? numeric(summary.cached) / numeric(summary.input) * 100 : 0
    const values = [
      ['Token 总量', formatTokens(summary.total)],
      ['缓存命中率', formatPercent(cacheRate)],
      ['活跃线程', formatTokens(summary.active_threads)],
      ['活跃耗时', summary.active_duration_label || '—'],
      ['非缓存输入', formatTokens(summary.uncached)],
    ]
    facts.replaceChildren(...values.map(([label, value]) => append(create('span'), create('span', '', label), create('strong', '', value))))
  }

  function formatCountdown(targetTime) {
    if (!Number.isFinite(targetTime)) return '重置时间未知'
    const remaining = Math.max(0, targetTime - Date.now())
    const totalMinutes = Math.ceil(remaining / 60000)
    if (totalMinutes < 60) return `${totalMinutes} 分钟后重置`
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    if (hours < 48) return `${hours} 小时${minutes ? ` ${minutes} 分` : ''}后重置`
    const days = Math.floor(hours / 24)
    return `${days} 天 ${hours % 24} 小时后重置`
  }

  function quotaLevel(remaining) {
    if (remaining <= 10) return 'danger'
    if (remaining <= 25) return 'warning'
    return 'steady'
  }

  function renderQuotaTarget(cycle, ids) {
    const quota = core.quotaStatus(cycle)
    const percent = $(ids.percent)
    const track = $(ids.track)
    const bar = $(ids.bar)
    const reset = $(ids.reset)
    const observed = ids.observed ? $(ids.observed) : null
    const container = percent.closest('[data-quota-row], [data-quota-card]')
    if (!quota.available) {
      percent.textContent = '未读取'
      bar.style.width = '0%'
      track.removeAttribute('aria-valuenow')
      track.setAttribute('aria-valuetext', '未读取到剩余额度')
      reset.textContent = '本机日志暂无额度观测'
      if (observed) observed.textContent = '等待服务端限额事件写入本机日志'
      container.dataset.quotaState = 'missing'
      container.dataset.quotaLevel = 'missing'
      return quota
    }
    const remaining = clamp(quota.remaining, 0, 100)
    percent.textContent = formatPercent(remaining, remaining % 1 ? 1 : 0)
    bar.style.width = `${remaining}%`
    track.setAttribute('aria-valuenow', String(remaining))
    track.setAttribute('aria-valuetext', `剩余额度 ${formatPercent(remaining)}`)
    reset.textContent = formatCountdown(quota.resetAt)
    container.dataset.quotaState = quota.stale ? 'stale' : 'fresh'
    container.dataset.quotaLevel = quotaLevel(remaining)
    if (observed) {
      const observation = quota.observedAt === null
        ? '观测时间未知'
        : `观测于 ${new Date(quota.observedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      observed.textContent = `${quota.stale ? '数据可能已过期 · ' : ''}${observation}`
      observed.dataset.stale = String(quota.stale)
    }
    return quota
  }

  function renderQuotaOverview(data, summary) {
    const cycles = data.cycles || {}
    const five = renderQuotaTarget(cycles.five_hour, {
      percent: 'railQuotaFivePercent', track: 'railQuotaFiveTrack', bar: 'railQuotaFiveBar', reset: 'railQuotaFiveReset',
    })
    const weekly = renderQuotaTarget(cycles.weekly, {
      percent: 'railQuotaWeeklyPercent', track: 'railQuotaWeeklyTrack', bar: 'railQuotaWeeklyBar', reset: 'railQuotaWeeklyReset',
    })
    const freshness = core.quotaFreshnessLabel(five, weekly)
    $('railQuotaFreshness').textContent = freshness.label
    $('railQuotaFreshness').dataset.stale = String(freshness.stale)

    const estimate = data.quota_estimate || {}
    const canEstimate = estimate.available === true
      && !estimate.stale
      && Number.isFinite(Number(estimate.five_hour_usd_equivalent))
      && Number.isFinite(Number(estimate.weekly_usd_equivalent))
    const fiveValue = canEstimate ? core.formatMoney(estimate.five_hour_usd_equivalent) : '—'
    const weeklyValue = canEstimate ? core.formatMoney(estimate.weekly_usd_equivalent) : '—'
    setAnimatedText($('railFiveEstimate'), fiveValue)
    setAnimatedText($('railWeeklyEstimate'), weeklyValue)
    $('railEstimateNote').textContent = core.quotaEstimateNote(estimate)
  }

  function renderTopConsumers(data) {
    const list = $('topConsumersList')
    const summaryBounds = core.costBounds(data.summary || {})
    const rows = Array.isArray(data.cwd_top) ? data.cwd_top.slice(0, 3) : []
    if (!rows.length) {
      list.replaceChildren(create('li', '', '当前范围没有项目消耗'))
      return
    }
    list.replaceChildren(...rows.map((row, index) => {
      const presentation = rowPresentation(row, 'projects', index, summaryBounds)
      const item = create('li')
      const line = create('div', 'consumer-line')
      append(line, create('span', '', presentation.title), create('strong', '', presentation.cost))
      const bar = create('div', 'consumer-bar')
      const fill = create('i')
      fill.style.width = `${clamp(presentation.share, 0, 100)}%`
      bar.append(fill)
      return append(item, line, bar)
    }))
  }

  function renderOverview(data) {
    const summary = data.summary || {}
    const range = data.range || {}
    const cost = core.costBounds(summary)
    const rate = core.rateBounds(summary)
    const rangeLabel = range.label || '当前范围'
    const narrativeLabel = rangeLabel.startsWith('最近')
      ? rangeLabel.replace(/^最近(\d+)(分钟|小时|天)/, '过去 $1 $2')
      : rangeLabel
    setAnimatedText($('rangeNarrative'), narrativeLabel)
    const endLabel = state.preset === 'custom' && state.customEndMode === 'now' ? '现在' : (range.end_label || '')
    $('rangeEyebrow').textContent = `${rangeLabel} · ${range.start_label || ''} – ${endLabel}`
    if (state.trendMode !== 'quota') {
      $('trendRangeLabel').textContent = `${rangeLabel} · ${range.bucket_label || `${range.bucket_minutes || 1} 分钟粒度`}`
    }
    setAnimatedText($('costValue'), core.costLabel(cost))
    setAnimatedText($('rateValue'), `${core.costLabel(rate)}/h`)
    renderCostDetails(
      $('costDetails'),
      cost,
      '预计费用',
      '',
    )
    renderCostDetails(
      $('rateDetails'),
      rate,
      '费用速率',
      '/h',
    )
    renderThreshold(rate)
    renderSummaryFacts(summary)
    renderQuotaOverview(data, summary)
    renderTopConsumers(data)
    $('insightFooter').textContent = `${summary.active_duration_label || '尚无耗时'} · 本机统计`
    $('thresholdButtonValue').textContent = `${core.formatMoney(state.threshold)}/h`
    $('thresholdInlineValue').textContent = `${core.formatMoney(state.threshold)}/h`
  }

  function buildTrendSeries(data = runtime.lastGoodData, mode = state.trendMode, threshold = state.threshold) {
    if (!data) return []
    const bucketMinutes = numeric(data.range && data.range.bucket_minutes, 1)
    const points = (data.series || []).map((point, index) => {
      if (mode === 'tokens') {
        return {
          index,
          mode,
          time: point.time || '',
          iso: point.iso || '',
          total: numeric(point.total),
          uncached: numeric(point.uncached),
          output: numeric(point.output),
          plot: numeric(point.total),
          complete: true,
          minutes: bucketMinutes,
        }
      }
      const rate = core.costRatePoint(point, bucketMinutes)
      return {
        index,
        mode,
        time: point.time || '',
        iso: point.iso || '',
        lower: rate.lower,
        mid: rate.mid,
        upper: rate.upper,
        plot: rate.mid === null ? rate.lower : rate.mid,
        complete: rate.complete,
        minutes: rate.minutes,
        threshold: numeric(threshold, 20),
        unpricedTokens: numeric(point.unpriced_tokens),
      }
    })
    return points
  }

  function nullableQuotaPercent(value) {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null
  }

  function quotaPointLabel(value) {
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return String(value || '')
    const rangeStart = Date.parse(runtime.latestRange?.start || '')
    const rangeEnd = Date.parse(runtime.latestRange?.end || '')
    const durationDays = Number.isFinite(rangeStart) && Number.isFinite(rangeEnd)
      ? Math.max(0, rangeEnd - rangeStart) / 86400000
      : 7
    const includeYear = durationDays >= 180
    return date.toLocaleString('zh-CN', {
      ...(includeYear ? { year: '2-digit' } : {}),
      month: '2-digit',
      day: '2-digit',
      hour: durationDays <= 30 ? '2-digit' : undefined,
      minute: durationDays <= 7 ? '2-digit' : undefined,
      hour12: false,
    }).replace(/\//g, '-')
  }

  function quotaPrimaryValue(point) {
    const candidates = [
      state.quotaLines.five ? point.five : null,
      state.quotaLines.seven ? point.seven : null,
      state.quotaLines.ideal ? point.ideal : null,
    ]
    return candidates.find((value) => value !== null) ?? 0
  }

  function buildQuotaSeries(data = runtime.quotaHistoryData) {
    const samples = data && Array.isArray(data.samples) ? data.samples : []
    return samples.map((sample, index) => {
      const iso = String(sample.observed_at || '')
      const point = {
        index,
        mode: 'quota',
        time: quotaPointLabel(iso),
        iso,
        timestamp: Date.parse(iso),
        five: nullableQuotaPercent(sample.five_hour_remaining),
        seven: nullableQuotaPercent(sample.seven_day_remaining),
        ideal: nullableQuotaPercent(sample.seven_day_ideal_remaining),
        fiveReset: String(sample.five_hour_reset_at || ''),
        sevenReset: String(sample.seven_day_reset_at || ''),
        stale: sample.stale === true,
        breakBefore: sample.break_before === true,
        fiveBreakBefore: sample.five_hour_break_before === true || sample.break_before === true,
        sevenBreakBefore: sample.seven_day_break_before === true || sample.break_before === true,
      }
      point.plot = quotaPrimaryValue(point)
      return point
    }).filter((point) => Number.isFinite(point.timestamp))
      .sort((left, right) => left.timestamp - right.timestamp)
      .map((point, index) => ({ ...point, index }))
  }

  function quotaLineDefinitions() {
    return [
      { key: 'five', resetKey: 'fiveReset', breakKey: 'fiveBreakBefore', label: '5h 剩余', color: cssColor('--quota-five', '#704fd1'), dash: [] },
      { key: 'seven', resetKey: 'sevenReset', breakKey: 'sevenBreakBefore', label: '7d 剩余', color: cssColor('--quota-seven', '#cf5158'), dash: [] },
      { key: 'ideal', resetKey: 'sevenReset', breakKey: 'sevenBreakBefore', label: '7d 理想', color: cssColor('--quota-ideal', '#454b55'), dash: [7, 5] },
    ]
  }

  function cssColor(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  }

  function roundedRectPath(context, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2)
    context.beginPath()
    context.moveTo(x + safeRadius, y)
    context.arcTo(x + width, y, x + width, y + height, safeRadius)
    context.arcTo(x + width, y + height, x, y + height, safeRadius)
    context.arcTo(x, y + height, x, y, safeRadius)
    context.arcTo(x, y, x + width, y, safeRadius)
    context.closePath()
  }

  function quotaLineRuns(series, definition) {
    const runs = []
    let run = []
    let previous = null
    const flush = () => {
      if (run.length) runs.push(run)
      run = []
    }
    series.forEach((point) => {
      const value = point[definition.key]
      if (point.stale || value === null) return
      const previousReset = previous ? Date.parse(previous[definition.resetKey]) : Number.NaN
      const currentReset = Date.parse(point[definition.resetKey])
      const resetChanged = previous
        && Number.isFinite(previousReset)
        && Number.isFinite(currentReset)
        && Math.abs(previousReset - currentReset) > 30_000
      const gapMs = previous ? point.timestamp - previous.timestamp : 0
      const maxBridgeMs = definition.key === 'five' ? 90 * 60 * 1000 : 12 * 60 * 60 * 1000
      const canBridgeGap = previous
        && !resetChanged
        && Number.isFinite(previousReset)
        && Number.isFinite(currentReset)
        && gapMs > 0
        && gapMs <= maxBridgeMs
      if (previous && !canBridgeGap) flush()
      run.push(point)
      previous = point
    })
    flush()
    return runs.map((items) => items.map((point, index) => {
      if (index === 0 || index === items.length - 1) return point
      const values = [items[index - 1][definition.key], point[definition.key], items[index + 1][definition.key]].sort((a, b) => a - b)
      return { ...point, [definition.key]: values[1] }
    }))
  }

  function drawQuotaTrend(canvas, series, hoverIndex) {
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(320, Math.round(rect.width))
    const height = Math.max(240, Math.round(rect.height))
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    const context = canvas.getContext('2d')
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)

    const visibleDefinitions = quotaLineDefinitions().filter((definition) => state.quotaLines[definition.key])
    const hasVisibleValues = series.some((point) => !point.stale && visibleDefinitions.some((definition) => point[definition.key] !== null))
    const empty = $('trendEmpty')
    const status = $('quotaChartStatus')
    empty.hidden = hasVisibleValues
    status.hidden = true
    status.classList.remove('is-error')
    if (!hasVisibleValues) {
      empty.textContent = runtime.quotaHistoryLoading
        ? '正在读取额度历史…'
        : (runtime.quotaHistoryError ? `额度历史读取失败：${runtime.quotaHistoryError}` : '当前范围没有可绘制的额度记录')
      runtime.plotGeometry = null
      return
    }
    if (runtime.quotaHistoryLoading) {
      status.textContent = '正在更新额度历史…'
      status.hidden = false
    } else if (runtime.quotaHistoryError) {
      status.textContent = `更新失败，保留上次数据：${runtime.quotaHistoryError}`
      status.classList.add('is-error')
      status.hidden = false
    }

    const mobile = width < 600
    context.save()
    context.font = `13px "Segoe UI Variable", "Microsoft YaHei UI", sans-serif`
    const yAxisLabels = ['0%', '25%', '50%', '75%', '100%']
    const labelWidth = Math.max(...yAxisLabels.map((label) => context.measureText(label).width))
    const yLabelX = mobile ? 16 : 0
    const pad = {
      left: clamp(Math.ceil(labelWidth + yLabelX + 12), mobile ? 58 : 52, mobile ? 84 : 92),
      right: mobile ? 10 : 18,
      top: 18,
      bottom: 34,
    }
    const innerWidth = width - pad.left - pad.right
    const innerHeight = height - pad.top - pad.bottom
    const startTimestamp = series[0].timestamp
    const endTimestamp = series[series.length - 1].timestamp
    const timestampSpan = Math.max(1, endTimestamp - startTimestamp)
    const nearestIndexForTimestamp = (targetTimestamp) => {
      let low = 0
      let high = series.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (series[middle].timestamp < targetTimestamp) low = middle + 1
        else high = middle
      }
      if (low <= 0) return 0
      if (low >= series.length) return series.length - 1
      const before = series[low - 1]
      const after = series[low]
      return targetTimestamp - before.timestamp <= after.timestamp - targetTimestamp ? low - 1 : low
    }
    const xFor = (index) => {
      const safeIndex = clamp(Math.round(numeric(index)), 0, series.length - 1)
      return pad.left + innerWidth * clamp((series[safeIndex].timestamp - startTimestamp) / timestampSpan, 0, 1)
    }
    const indexForX = (x) => {
      const ratio = clamp((numeric(x) - pad.left) / Math.max(1, innerWidth), 0, 1)
      return nearestIndexForTimestamp(startTimestamp + timestampSpan * ratio)
    }
    const yFor = (value) => pad.top + innerHeight * (1 - clamp(numeric(value) / 100, 0, 1))
    runtime.plotGeometry = { width, height, pad, innerWidth, innerHeight, maxValue: 100, xFor, yFor, indexForX }

    context.textBaseline = 'middle'
    context.lineWidth = 1
    yAxisLabels.forEach((label, step) => {
      const value = step * 25
      const y = yFor(value)
      context.strokeStyle = 'rgba(88, 99, 113, 0.13)'
      context.beginPath()
      context.moveTo(pad.left, y)
      context.lineTo(width - pad.right, y)
      context.stroke()
      context.fillStyle = 'rgba(77, 86, 99, 0.72)'
      context.fillText(label, yLabelX, y)
    })

    context.lineCap = 'round'
    context.lineJoin = 'round'
    visibleDefinitions.forEach((definition) => {
      context.strokeStyle = definition.color
      context.fillStyle = definition.color
      context.lineWidth = definition.key === 'ideal' ? 1.8 : (mobile ? 2 : 2.35)
      context.setLineDash(definition.dash)
      quotaLineRuns(series, definition).forEach((run) => {
        if (run.length === 1) {
          context.beginPath()
          context.arc(xFor(run[0].index), yFor(run[0][definition.key]), 2.2, 0, Math.PI * 2)
          context.fill()
          return
        }
        const coordinates = run.map((point) => ({ x: xFor(point.index), y: yFor(point[definition.key]) }))
        context.beginPath()
        context.moveTo(coordinates[0].x, coordinates[0].y)
        for (let index = 1; index < coordinates.length - 1; index += 1) {
          const point = coordinates[index]
          const next = coordinates[index + 1]
          context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2)
        }
        const finalPoint = coordinates[coordinates.length - 1]
        context.lineTo(finalPoint.x, finalPoint.y)
        context.stroke()
      })
    })
    context.setLineDash([])

    const midpointIndex = nearestIndexForTimestamp(startTimestamp + timestampSpan / 2)
    const timeIndexes = Array.from(new Set([0, midpointIndex, series.length - 1]))
    context.fillStyle = 'rgba(77, 86, 99, 0.72)'
    context.textBaseline = 'alphabetic'
    timeIndexes.forEach((index) => {
      const label = String(series[index].time || '')
      const measure = context.measureText(label).width
      const visibleEdgeInset = mobile ? 16 : 0
      const x = clamp(xFor(index) - measure / 2, pad.left, width - pad.right - visibleEdgeInset - measure)
      context.fillText(label, x, height - 8)
    })

    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < series.length) {
      const point = series[hoverIndex]
      const x = xFor(hoverIndex)
      context.strokeStyle = 'rgba(77, 86, 99, 0.22)'
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(x, pad.top)
      context.lineTo(x, pad.top + innerHeight)
      context.stroke()
      visibleDefinitions.forEach((definition) => {
        const value = point[definition.key]
        if (point.stale || value === null) return
        context.fillStyle = definition.color
        context.beginPath()
        context.arc(x, yFor(value), 4.5, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = cssColor('--surface', '#fcfcfd')
        context.beginPath()
        context.arc(x, yFor(value), 1.7, 0, Math.PI * 2)
        context.fill()
      })
    }
    context.restore()
  }

  function drawTrend(canvas = $('trendCanvas'), series = runtime.chartSeries, hoverIndex = runtime.hoverIndex, selection = runtime.selectedRange) {
    if (!canvas) return
    if (state.trendMode === 'quota') {
      drawQuotaTrend(canvas, series, hoverIndex)
      return
    }
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(320, Math.round(rect.width))
    const height = Math.max(240, Math.round(rect.height))
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    const context = canvas.getContext('2d')
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)
    $('trendEmpty').hidden = series.length > 0
    if (!series.length) {
      runtime.plotGeometry = null
      return
    }

    const mobile = width < 600
    const isCost = series[0].mode === 'cost'
    const candidateValues = isCost
      ? series.flatMap((point) => [point.lower, point.upper, point.plot, point.threshold])
      : series.flatMap((point) => [point.total, point.output])
    const maxValue = Math.max(1, ...candidateValues.map((value) => numeric(value))) * 1.08
    context.save()
    context.font = `13px "Segoe UI Variable", "Microsoft YaHei UI", sans-serif`
    const yAxisLabels = Array.from({ length: 4 }, (_, step) => {
      const value = maxValue * step / 3
      return isCost ? `${core.formatMoney(value)}/h` : core.formatTokens(value, 'compact')
    })
    const thresholdLabel = isCost ? `阈值 ${core.formatMoney(numeric(series[0].threshold, state.threshold))}/h` : ''
    const labelWidth = Math.max(
      ...yAxisLabels.map((label) => context.measureText(label).width),
      isCost ? context.measureText(thresholdLabel).width : 0,
    )
    const leftMaximum = Math.max(mobile ? 104 : 128, width * 0.34)
    const pad = {
      left: clamp(Math.ceil(labelWidth + 12), mobile ? 52 : 62, leftMaximum),
      right: mobile ? 10 : 18,
      top: 18,
      bottom: 34,
    }
    const innerWidth = width - pad.left - pad.right
    const innerHeight = height - pad.top - pad.bottom
    const xFor = (index) => pad.left + innerWidth * index / Math.max(1, series.length - 1)
    const yFor = (value) => pad.top + innerHeight * (1 - clamp(numeric(value) / maxValue, 0, 1))

    runtime.plotGeometry = { width, height, pad, innerWidth, innerHeight, maxValue, xFor, yFor }

    context.textBaseline = 'middle'
    context.lineWidth = 1
    for (let step = 0; step <= 3; step += 1) {
      const value = maxValue * step / 3
      const y = yFor(value)
      context.strokeStyle = 'rgba(88, 99, 113, 0.13)'
      context.beginPath()
      context.moveTo(pad.left, y)
      context.lineTo(width - pad.right, y)
      context.stroke()
      context.fillStyle = 'rgba(77, 86, 99, 0.72)'
      context.fillText(yAxisLabels[step], 0, y)
    }

    if (isCost) {
      const threshold = numeric(series[0].threshold, state.threshold)
      const thresholdY = yFor(threshold)
      context.strokeStyle = 'rgba(169, 92, 18, 0.62)'
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(pad.left, thresholdY)
      context.lineTo(width - pad.right, thresholdY)
      context.stroke()
      context.fillStyle = cssColor('--warning', '#a95c12')
      context.textAlign = 'right'
      context.fillText(thresholdLabel, pad.left - 8, thresholdY)
      context.textAlign = 'left'

      const runs = []
      let currentRun = []
      series.forEach((point) => {
        if (point.complete) {
          currentRun.push(point)
        } else if (currentRun.length) {
          runs.push(currentRun)
          currentRun = []
        }
      })
      if (currentRun.length) runs.push(currentRun)
      context.fillStyle = 'rgba(69, 126, 190, 0.11)'
      runs.filter((run) => run.length > 1).forEach((run) => {
        context.beginPath()
        run.forEach((point, runIndex) => {
          const x = xFor(point.index)
          const y = yFor(point.upper)
          if (runIndex === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        })
        run.slice().reverse().forEach((point) => context.lineTo(xFor(point.index), yFor(point.lower)))
        context.closePath()
        context.fill()
      })
    } else {
      context.beginPath()
      series.forEach((point, index) => {
        const x = xFor(index)
        const y = yFor(point.total)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.lineTo(xFor(series.length - 1), yFor(0))
      context.lineTo(xFor(0), yFor(0))
      context.closePath()
      context.fillStyle = 'rgba(21, 117, 255, 0.09)'
      context.fill()
    }

    if (selection) {
      const startIndex = Math.min(selection.start, selection.end)
      const endIndex = Math.max(selection.start, selection.end)
      const startX = xFor(startIndex)
      const endX = xFor(endIndex)
      context.fillStyle = 'rgba(21, 117, 255, 0.085)'
      roundedRectPath(context, startX - 5, pad.top, Math.max(10, endX - startX + 10), innerHeight, 7)
      context.fill()
    }

    context.lineCap = 'round'
    context.lineJoin = 'round'
    if (isCost && state.costChartMode === 'pulse') {
      const baselineY = yFor(0)
      const pointSpacing = innerWidth / Math.max(1, series.length - 1)
      const densityStep = mobile ? 4 : 5
      const pulseWidth = clamp(Math.min(pointSpacing, densityStep) * 0.3, 0.7, mobile ? 1.1 : 1.3)
      const visiblePulses = []
      const pixelColumns = new Map()
      series.forEach((point, index) => {
        const x = xFor(index)
        const column = Math.floor((x - pad.left) / densityStep)
        const current = pixelColumns.get(column)
        if (!current || point.plot > current.point.plot) pixelColumns.set(column, { point, x })
      })
      visiblePulses.push(...pixelColumns.values())

      context.lineWidth = pulseWidth
      visiblePulses.forEach(({ point, x }) => {
        if (point.plot <= 0) return
        const topY = yFor(point.plot)
        context.strokeStyle = point.complete ? 'rgba(49, 95, 206, 0.14)' : 'rgba(99, 107, 119, 0.21)'
        context.beginPath()
        context.moveTo(x, baselineY)
        context.lineTo(x, topY)
        context.stroke()
      })

      context.lineWidth = mobile ? 1.65 : 1.9
      for (let index = 1; index < visiblePulses.length; index += 1) {
        const previous = visiblePulses[index - 1]
        const current = visiblePulses[index]
        context.strokeStyle = previous.point.complete && current.point.complete
          ? cssColor('--accent', '#315fce')
          : 'rgba(99, 107, 119, 0.68)'
        context.beginPath()
        context.moveTo(previous.x, yFor(previous.point.plot))
        context.lineTo(current.x, yFor(current.point.plot))
        context.stroke()
      }
    } else {
      context.lineWidth = mobile ? 2 : 2.4
      for (let index = 1; index < series.length; index += 1) {
        const previous = series[index - 1]
        const current = series[index]
        const complete = previous.complete && current.complete
        context.strokeStyle = complete
          ? (isCost ? cssColor('--accent', '#315fce') : cssColor('--focus', '#1575ff'))
          : 'rgba(99, 107, 119, 0.65)'
        context.beginPath()
        context.moveTo(xFor(index - 1), yFor(previous.plot))
        context.lineTo(xFor(index), yFor(current.plot))
        context.stroke()
      }
    }
    if (series.length === 1) {
      context.fillStyle = isCost && state.costChartMode === 'pulse'
        ? cssColor('--accent', '#315fce')
        : (isCost ? cssColor('--accent', '#315fce') : cssColor('--focus', '#1575ff'))
      context.beginPath()
      context.arc(xFor(0), yFor(series[0].plot), 3, 0, Math.PI * 2)
      context.fill()
    }

    if (!isCost) {
      context.strokeStyle = 'rgba(91, 99, 112, 0.55)'
      context.lineWidth = 1.2
      context.beginPath()
      series.forEach((point, index) => {
        if (index === 0) context.moveTo(xFor(index), yFor(point.output))
        else context.lineTo(xFor(index), yFor(point.output))
      })
      context.stroke()
    }

    const timeIndexes = Array.from(new Set([0, Math.floor((series.length - 1) / 2), series.length - 1]))
    context.fillStyle = 'rgba(77, 86, 99, 0.72)'
    context.textBaseline = 'alphabetic'
    timeIndexes.forEach((index) => {
      const text = String(series[index].time || '')
      const measure = context.measureText(text).width
      const x = clamp(xFor(index) - measure / 2, pad.left, width - pad.right - measure)
      context.fillText(text, x, height - 8)
    })

    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < series.length) {
      const point = series[hoverIndex]
      const x = xFor(hoverIndex)
      const y = yFor(point.plot)
      context.strokeStyle = 'rgba(77, 86, 99, 0.22)'
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(x, pad.top)
      context.lineTo(x, pad.top + innerHeight)
      context.stroke()
      context.fillStyle = point.complete
        ? (isCost ? cssColor('--accent', '#315fce') : cssColor('--focus', '#1575ff'))
        : cssColor('--muted', '#686f7a')
      context.beginPath()
      context.arc(x, y, 5, 0, Math.PI * 2)
      context.fill()
      context.fillStyle = cssColor('--silver', '#edf0f4')
      context.beginPath()
      context.arc(x, y, 2, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }

  function tooltipRow(label, value) {
    const row = create('div', 'tooltip-row')
    append(row, create('span', '', label), create('strong', '', value))
    return row
  }

  function quotaPercentLabel(value) {
    return value === null ? '—' : `${numeric(value).toFixed(1)}%`
  }

  function quotaTooltipTime(point) {
    const date = new Date(point.iso)
    if (!Number.isFinite(date.getTime())) return point.time || point.iso || '当前数据点'
    return date.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
  }

  function showTrendTooltip(index, clientX, clientY) {
    const tooltip = $('trendTooltip')
    const point = runtime.chartSeries[index]
    const geometry = runtime.plotGeometry
    if (!point || !geometry) {
      tooltip.hidden = true
      return
    }
    tooltip.replaceChildren(create('div', 'tooltip-time', point.mode === 'quota' ? quotaTooltipTime(point) : (point.time || point.iso || '当前数据点')))
    if (point.mode === 'quota') {
      append(tooltip, tooltipRow('5h 剩余', quotaPercentLabel(point.five)))
      append(tooltip, tooltipRow('7d 剩余', quotaPercentLabel(point.seven)))
      append(tooltip, tooltipRow('7d 理想', quotaPercentLabel(point.ideal)))
      const delta = point.seven === null || point.ideal === null ? null : point.seven - point.ideal
      append(tooltip, tooltipRow('7d 偏差', delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} 个百分点`))
      if (point.stale) tooltip.append(create('p', 'detail-note is-incomplete', '此记录已过期，曲线在这里断开'))
      else if (point.breakBefore || point.fiveBreakBefore || point.sevenBreakBefore) {
        tooltip.append(create('p', 'detail-note', '此处是重置或记录缺口后的新线段'))
      }
    } else if (point.mode === 'cost') {
      append(tooltip, tooltipRow('费用速率', point.complete ? `${core.formatMoney(point.mid)}/h` : `≥ ${core.formatMoney(point.lower)}/h`))
      const intervalMinutes = Math.max(0, numeric(point.minutes, 1))
      const intervalCost = point.complete
        ? core.formatMoney(point.mid * intervalMinutes / 60)
        : '不可确定'
      append(tooltip, tooltipRow(intervalMinutes <= 1.01 ? '本分钟估算费用' : '本区间估算费用', intervalCost))
      append(tooltip, tooltipRow('估算下限', `${core.formatMoney(point.lower)}/h`))
      append(tooltip, tooltipRow('估算上限', point.complete ? `${core.formatMoney(point.upper)}/h` : '不可确定'))
      append(tooltip, tooltipRow('阈值占用', point.complete ? formatPercent(point.mid / state.threshold * 100) : '不可比较'))
      if (!point.complete) tooltip.append(create('p', 'detail-note is-incomplete', `API 美元计价未确认 ${formatTokens(point.unpricedTokens)} tokens`))
    } else {
      append(tooltip, tooltipRow('Token 总量', formatTokens(point.total)))
      append(tooltip, tooltipRow('非缓存输入', formatTokens(point.uncached)))
      append(tooltip, tooltipRow('输出', formatTokens(point.output)))
    }
    const plotRect = $('trendPlot').getBoundingClientRect()
    const canvasRect = $('trendCanvas').getBoundingClientRect()
    const pointX = clientX === undefined
      ? canvasRect.left - plotRect.left + geometry.xFor(index)
      : clientX - plotRect.left
    const pointY = clientY === undefined
      ? canvasRect.top - plotRect.top + geometry.yFor(point.plot)
      : clientY - plotRect.top
    const tooltipWidth = 252
    const left = clamp(pointX + 14, 6, Math.max(6, plotRect.width - tooltipWidth - 6))
    const top = Math.max(6, pointY - 154)
    tooltip.style.left = `${left}px`
    tooltip.style.top = `${top}px`
    tooltip.hidden = false
  }

  function chartIndexFromPointer(event) {
    const geometry = runtime.plotGeometry
    if (!geometry || !runtime.chartSeries.length) return null
    const rect = $('trendCanvas').getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const inside = x >= geometry.pad.left
      && x <= geometry.width - geometry.pad.right
      && y >= geometry.pad.top
      && y <= geometry.height - geometry.pad.bottom
    if (!inside) return null
    if (state.trendMode === 'quota' && typeof geometry.indexForX === 'function') return geometry.indexForX(x)
    const ratio = (x - geometry.pad.left) / geometry.innerWidth
    return clamp(Math.round(ratio * (runtime.chartSeries.length - 1)), 0, runtime.chartSeries.length - 1)
  }

  function selectionBounds() {
    if (!runtime.selectedRange) return null
    return {
      start: Math.min(runtime.selectedRange.start, runtime.selectedRange.end),
      end: Math.max(runtime.selectedRange.start, runtime.selectedRange.end),
    }
  }

  function updateSelectionBar() {
    const bounds = selectionBounds()
    const bar = $('selectionBar')
    if (!bounds || !runtime.chartSeries.length) {
      bar.hidden = true
      return
    }
    bar.hidden = false
    const start = runtime.chartSeries[bounds.start]
    const end = runtime.chartSeries[bounds.end]
    $('selectedRangeText').textContent = `已选择 ${start.time || start.iso} – ${end.time || end.iso}`
  }

  function clearSelection() {
    runtime.selectedRange = null
    runtime.dragStartIndex = null
    runtime.pointerGesture = null
    updateSelectionBar()
    drawTrend()
  }

  function applySelectedRange() {
    if (state.trendMode === 'quota') return
    const bounds = selectionBounds()
    if (!bounds || !runtime.latestRange) return
    const startPoint = runtime.chartSeries[bounds.start]
    const endPoint = runtime.chartSeries[bounds.end]
    const bucketMinutes = numeric(runtime.latestRange.bucket_minutes, 1)
    const bucketEnd = new Date(new Date(endPoint.iso).getTime() + bucketMinutes * 60 * 1000)
    const clampedRange = core.clampTimeRange(
      startPoint.iso,
      bucketEnd.toISOString(),
      runtime.latestRange.start,
      runtime.latestRange.end,
    )
    if (!clampedRange) return
    state = {
      ...state,
      preset: 'custom',
      customStart: toDatetimeLocal(clampedRange.start),
      customEnd: toDatetimeLocal(clampedRange.end),
      customEndMode: 'fixed',
      activePinnedId: '',
    }
    saveState()
    $('customStart').value = state.customStart
    $('customEnd').value = state.customEnd
    syncCustomEndMode()
    syncPresetControls()
    clearSelection()
    load()
  }

  function syncQuotaHeader() {
    const count = runtime.quotaHistoryData && Array.isArray(runtime.quotaHistoryData.samples)
      ? runtime.quotaHistoryData.samples.length
      : 0
    const label = runtime.latestRange?.label || '当前范围'
    $('trendRangeLabel').textContent = count
      ? `${label} · ${count.toLocaleString('zh-CN')} 个额度样本`
      : `${label} · 额度记录`
  }

  async function loadQuotaHistory(options = {}) {
    const requestedRange = runtime.latestRange
    if (!requestedRange?.start || !requestedRange?.end) return
    const requestedKey = `${requestedRange.start}|${requestedRange.end}`
    const requestSeq = runtime.quotaHistoryRequestSeq + 1
    runtime.quotaHistoryRequestSeq = requestSeq
    if (runtime.quotaHistoryController) runtime.quotaHistoryController.abort()
    const controller = new AbortController()
    runtime.quotaHistoryController = controller
    runtime.quotaHistoryLoading = true
    runtime.quotaHistoryError = null
    if (state.trendMode === 'quota') {
      syncQuotaHeader()
      renderTrend()
    }
    try {
      const params = new URLSearchParams({
        start: requestedRange.start,
        end: requestedRange.end,
        max_points: '4096',
      })
      const response = await fetch(`/api/quota-history?${params.toString()}`, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (!data || !Array.isArray(data.samples)) throw new Error('响应缺少 samples')
      const currentKey = `${runtime.latestRange?.start || ''}|${runtime.latestRange?.end || ''}`
      if (requestSeq !== runtime.quotaHistoryRequestSeq || requestedKey !== currentKey) return
      runtime.quotaHistoryData = data
      runtime.quotaHistoryError = null
      if (state.trendMode === 'quota') {
        syncQuotaHeader()
        renderTrend()
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return
      if (requestSeq !== runtime.quotaHistoryRequestSeq) return
      runtime.quotaHistoryError = error && error.message ? error.message : String(error)
      if (state.trendMode === 'quota') renderTrend()
      if (!options.quiet) setStatus(`额度历史读取失败：${runtime.quotaHistoryError}`, 'error')
    } finally {
      if (requestSeq === runtime.quotaHistoryRequestSeq) {
        runtime.quotaHistoryLoading = false
        if (state.trendMode === 'quota') renderTrend()
      }
    }
  }

  function toggleQuotaLine(key) {
    if (!QUOTA_LINE_KEYS.includes(key)) return
    const nextLines = { ...state.quotaLines, [key]: !state.quotaLines[key] }
    if (!QUOTA_LINE_KEYS.some((lineKey) => nextLines[lineKey])) {
      setStatus('至少保留一条额度曲线')
      return
    }
    state = { ...state, quotaLines: nextLines }
    syncQuotaControls()
    saveState()
    renderTrend()
  }

  function renderTrend(selectionAnchor = null) {
    runtime.chartSeries = state.trendMode === 'quota'
      ? buildQuotaSeries(runtime.quotaHistoryData)
      : buildTrendSeries(runtime.lastGoodData, state.trendMode, state.threshold)
    if (state.trendMode === 'quota') runtime.selectedRange = null
    else if (selectionAnchor) runtime.selectedRange = core.remapSelection(runtime.chartSeries, selectionAnchor)
    runtime.hoverIndex = null
    $('trendTooltip').hidden = true
    updateSelectionBar()
    drawTrend()
    if (!reducedMotion() && typeof $('trendCanvas').animate === 'function') {
      $('trendCanvas').animate(
        [{ opacity: 0.45, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      )
    }
  }

  function setTrendMode(mode, shouldRender = true) {
    const nextMode = ['tokens', 'quota'].includes(mode) ? mode : 'cost'
    state = { ...state, trendMode: nextMode }
    const tokenMode = state.trendMode === 'tokens'
    const quotaMode = state.trendMode === 'quota'
    $('costChartMode').hidden = tokenMode || quotaMode
    $('quotaChartControls').hidden = !quotaMode
    $('quotaChartStatus').hidden = true
    $('trendTitle').textContent = quotaMode ? '额度剩余趋势' : (tokenMode ? 'Token 消耗趋势' : '费用速率趋势')
    if (quotaMode) syncQuotaHeader()
    else if (runtime.lastGoodData) {
      const range = runtime.lastGoodData.range || {}
      $('trendRangeLabel').textContent = `${range.label || '当前范围'} · ${range.bucket_label || `${range.bucket_minutes || 1} 分钟粒度`}`
    }
    $('trendEmpty').textContent = quotaMode ? '正在读取额度历史…' : '当前范围没有可绘制的数据'
    $('trendCanvas').setAttribute(
      'aria-label',
      quotaMode
        ? '额度剩余趋势图，可用左右方向键浏览数据点'
        : (tokenMode ? 'Token 趋势图，可用左右方向键浏览数据点' : '费用速率趋势图，可用左右方向键浏览数据点'),
    )
    document.querySelectorAll('[data-trend-mode]').forEach((button) => {
      const selected = button.dataset.trendMode === state.trendMode
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
      if (selected) $('trendPlot').setAttribute('aria-labelledby', button.id)
    })
    syncTabIndicator($('trendMode'))
    saveState()
    if (shouldRender) {
      renderTrend()
      if (quotaMode) loadQuotaHistory()
    }
  }

  function setCostChartMode(mode, shouldRender = true) {
    state = { ...state, costChartMode: mode === 'line' ? 'line' : 'pulse' }
    document.querySelectorAll('[data-cost-chart-mode]').forEach((button) => {
      const selected = button.dataset.costChartMode === state.costChartMode
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    })
    saveState()
    if (shouldRender && runtime.lastGoodData && state.trendMode === 'cost') renderTrend()
  }

  function bindTrendEvents() {
    const canvas = $('trendCanvas')
    const beginSelection = (event, index) => {
      runtime.dragStartIndex = index
      runtime.selectedRange = { start: index, end: index }
      runtime.hoverIndex = index
      try {
        canvas.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture can fail if the browser has already handed the gesture to scrolling.
      }
      showTrendTooltip(index, event.clientX, event.clientY)
      updateSelectionBar()
      drawTrend()
    }
    canvas.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      const index = chartIndexFromPointer(event)
      if (index === null) return
      if (state.trendMode === 'quota') {
        runtime.hoverIndex = index
        showTrendTooltip(index, event.clientX, event.clientY)
        drawTrend()
        return
      }
      runtime.pointerGesture = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        startIndex: index,
        previousSelection: runtime.selectedRange ? { ...runtime.selectedRange } : null,
      }
      if (event.pointerType !== 'touch') beginSelection(event, index)
    })
    canvas.addEventListener('pointermove', (event) => {
      if (state.trendMode === 'quota') {
        const index = chartIndexFromPointer(event)
        runtime.hoverIndex = index
        if (index === null) $('trendTooltip').hidden = true
        else showTrendTooltip(index, event.clientX, event.clientY)
        drawTrend()
        return
      }
      const gesture = runtime.pointerGesture
      if (gesture && gesture.pointerId === event.pointerId && gesture.pointerType === 'touch' && runtime.dragStartIndex === null) {
        if (gesture.scrollIntent) return
        const deltaX = event.clientX - gesture.startX
        const deltaY = event.clientY - gesture.startY
        if (Math.abs(deltaY) > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
          gesture.scrollIntent = true
          return
        }
        if (Math.abs(deltaX) < 10 || Math.abs(deltaX) <= Math.abs(deltaY)) return
        event.preventDefault()
        beginSelection(event, gesture.startIndex)
      }
      const index = chartIndexFromPointer(event)
      if (index === null) {
        if (runtime.dragStartIndex === null) {
          runtime.hoverIndex = null
          $('trendTooltip').hidden = true
          drawTrend()
        }
        return
      }
      runtime.hoverIndex = index
      if (runtime.dragStartIndex !== null) {
        event.preventDefault()
        runtime.selectedRange = { start: runtime.dragStartIndex, end: index }
        updateSelectionBar()
      }
      showTrendTooltip(index, event.clientX, event.clientY)
      drawTrend()
    })
    const endPointer = (event) => {
      const gesture = runtime.pointerGesture
      if (!gesture || gesture.pointerId !== event.pointerId) return
      if (runtime.dragStartIndex === null) {
        if (gesture.scrollIntent) {
          runtime.pointerGesture = null
          flushPendingQuietData()
          return
        }
        const index = chartIndexFromPointer(event)
        runtime.pointerGesture = null
        if (flushPendingQuietData()) return
        if (index !== null) {
          runtime.hoverIndex = index
          showTrendTooltip(index, event.clientX, event.clientY)
          drawTrend()
        }
        return
      }
      runtime.dragStartIndex = null
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      runtime.pointerGesture = null
      if (flushPendingQuietData()) return
      updateSelectionBar()
      drawTrend()
    }
    const cancelPointer = (event) => {
      const gesture = runtime.pointerGesture
      if (!gesture || gesture.pointerId !== event.pointerId) return
      runtime.selectedRange = gesture.previousSelection
      runtime.dragStartIndex = null
      runtime.pointerGesture = null
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (flushPendingQuietData()) return
      updateSelectionBar()
      drawTrend()
    }
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', cancelPointer)
    canvas.addEventListener('pointerleave', () => {
      if (runtime.dragStartIndex !== null) return
      runtime.hoverIndex = null
      $('trendTooltip').hidden = true
      drawTrend()
    })
    canvas.addEventListener('dblclick', clearSelection)
    canvas.addEventListener('keydown', (event) => {
      if (!runtime.chartSeries.length) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        clearSelection()
        $('trendTooltip').hidden = true
        return
      }
      if (!['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        const current = runtime.hoverIndex === null ? 0 : runtime.hoverIndex
        runtime.hoverIndex = clamp(current + direction, 0, runtime.chartSeries.length - 1)
        showTrendTooltip(runtime.hoverIndex)
        drawTrend()
      } else {
        if (state.trendMode === 'quota') return
        const index = runtime.hoverIndex === null ? 0 : runtime.hoverIndex
        runtime.selectedRange = runtime.selectedRange
          ? { start: runtime.selectedRange.start, end: index }
          : { start: index, end: index }
        updateSelectionBar()
        drawTrend()
      }
    })
  }

  function relativeAge(minutes) {
    const value = Math.max(0, numeric(minutes))
    if (value < 1) return '刚刚'
    if (value < 60) return `${Math.round(value)} 分钟前`
    if (value < 1440) return `${(value / 60).toFixed(value < 120 ? 1 : 0)} 小时前`
    return `${(value / 1440).toFixed(value < 2880 ? 1 : 0)} 天前`
  }

  function modelsLabel(row) {
    const models = Array.isArray(row.models_used) && row.models_used.length
      ? row.models_used
      : [row.model].filter(Boolean)
    return models.join(' + ') || '模型未知'
  }

  function rowPresentation(row, kind, index, summaryBounds) {
    const bounds = core.costBounds(row)
    const shareInfo = core.costShare(bounds, summaryBounds)
    const share = shareInfo.percent
    const shareName = shareInfo.basis === 'known-lower' ? '已知费用下限占比' : '费用中点占比'
    if (kind === 'projects') {
      return {
        key: `project:${row.project || row.cwd || index}`,
        title: core.projectLabel(row.project || row.cwd),
        meta: [],
        cost: core.costLabel(bounds),
        share,
        shareLabel: `${shareName} ${formatPercent(share)}`,
        bounds,
      }
    }
    if (kind === 'threads') {
      const structure = numeric(row.subagent_count) > 0
        ? `Ultra · ${formatTokens(row.subagent_count)} 个子代理 · 深度 ${formatTokens(row.max_depth)}`
        : '单线程任务'
      return {
        key: `thread:${row.thread_id || row.short_thread || index}`,
        title: `${row.short_thread || '未知线程'} · ${core.projectLabel(row.project || row.cwd)}`,
        meta: [modelsLabel(row), structure, `活跃 ${row.active_duration_label || '—'}`, relativeAge(row.last_age_min)],
        cost: core.costLabel(bounds),
        share,
        bounds,
      }
    }
    return {
      key: `activity:${row.thread_id || row.short_thread || index}`,
      title: `${relativeAge(row.last_age_min)} · ${core.projectLabel(row.project || row.cwd)}`,
      meta: [row.short_thread || '未知线程', modelsLabel(row), `${formatTokens(row.total)} tokens`],
      cost: core.costLabel(bounds),
      share,
      bounds,
    }
  }

  function makeEditorialRow(row, kind, index, summaryBounds) {
    const presentation = rowPresentation(row, kind, index, summaryBounds)
    const item = create('li')
    const button = create('button', 'editorial-row')
    button.type = 'button'
    button.dataset.rowKey = presentation.key
    button.setAttribute('aria-expanded', String(runtime.selectedRowKey === presentation.key))
    button.setAttribute('aria-controls', 'detailRegion')

    const rank = create('span', 'editorial-rank', String(index + 1).padStart(2, '0'))
    const main = create('span', 'editorial-main')
    append(main, create('span', 'editorial-title', presentation.title))
    const meta = create('span', 'editorial-meta')
    presentation.meta.forEach((value) => meta.append(create('span', '', value)))
    if (presentation.meta.length) main.append(meta)

    const value = create('span', 'editorial-value')
    const cost = create('span', `editorial-cost${presentation.bounds.complete ? '' : ' is-incomplete'}`, presentation.cost)
    const shareLabel = kind === 'projects'
      ? `${presentation.shareLabel} · ${formatTokens(row.total)} tokens`
      : (kind === 'threads' ? relativeAge(row.last_age_min) : String(row.last_seen || ''))
    append(value, cost, create('span', 'editorial-share', shareLabel))
    append(button, rank, main, value)
    button.addEventListener('click', () => {
      const shouldOpen = runtime.selectedRowKey !== presentation.key
      runtime.selectedRowKey = shouldOpen ? presentation.key : ''
      document.querySelectorAll('.editorial-row').forEach((other) => {
        other.setAttribute('aria-expanded', String(shouldOpen && other === button))
      })
      if (shouldOpen) renderRowDetails(row, kind, presentation)
      else closeRowDetails()
    })
    item.append(button)
    return item
  }

  function detailStat(label, value) {
    const node = create('div', 'detail-stat')
    append(node, create('span', '', label), create('strong', 'detail-value', value))
    return node
  }

  function rowButtonByKey(key) {
    return Array.from(document.querySelectorAll('.editorial-row')).find((button) => button.dataset.rowKey === key) || null
  }

  function closeRowDetails(restoreFocus = false) {
    const closingKey = runtime.selectedRowKey
    runtime.selectedRowKey = ''
    $('detailRegion').hidden = true
    $('detailRegion').replaceChildren()
    document.querySelectorAll('.editorial-row').forEach((button) => button.setAttribute('aria-expanded', 'false'))
    if (restoreFocus && closingKey) {
      const trigger = rowButtonByKey(closingKey)
      if (trigger) trigger.focus({ preventScroll: true })
    }
  }

  function renderLineage(members) {
    if (!Array.isArray(members) || !members.length) return null
    const list = create('ol', 'lineage-tree')
    list.setAttribute('aria-label', '线程家族结构')
    members.forEach((member) => {
      const item = create('li', 'lineage-item')
      item.style.setProperty('--depth', String(Math.max(0, numeric(member.depth))))
      const copy = create('div')
      const role = member.agent_nickname || member.agent_role || (member.is_subagent ? '子代理' : '根线程')
      append(copy, create('div', 'lineage-title', `${member.short_thread || '未知线程'} · ${role}`))
      append(copy, create('div', 'lineage-meta', `${core.projectLabel(member.project || member.cwd)} · ${modelsLabel(member)} · ${formatTokens(member.total)} tokens · 活跃 ${member.active_duration_label || '—'}`))
      const bounds = core.costBounds(member)
      append(item, copy, create('span', 'lineage-cost', core.costLabel(bounds)))
      list.append(item)
    })
    return list
  }

  function pricingWarningText(row) {
    const coverage = core.pricingCoverage(row)
    if (coverage.scope === 'complete') return ''
    const affected = numeric(row.unpriced_tokens) > 0
      ? `${formatTokens(row.unpriced_tokens)} tokens`
      : '部分请求'
    const models = Array.isArray(row.unpriced_models) && row.unpriced_models.length
      ? `：${row.unpriced_models.map((value) => String(value).replace(/\s*\(API USD\)\s*$/, '')).join(' + ')}`
      : ''
    if (coverage.scope === 'api_only') {
      return `其中 ${affected} 无法确定 API 美元费率${models}；本地日志只记录请求层级，未记录服务端实际采用的 service_tier；Codex Credits 已完整计算。`
    }
    if (coverage.scope === 'credits_only') {
      return `其中 ${affected} 缺少可验证的 Credits 定价${models}；API 美元估值仍完整。`
    }
    return `其中 ${affected} 缺少可验证的 Credits 与 API 美元定价${models}；两项都只显示已知部分。`
  }

  function renderRowDetails(row, kind, presentation, shouldScroll = true) {
    const region = $('detailRegion')
    region.replaceChildren()
    const header = create('header', 'detail-header')
    const copy = create('div')
    append(copy, create('h3', '', presentation.title))
    const fullPath = row.cwd || row.project || '未记录项目路径'
    const context = kind === 'activity'
      ? `${fullPath} · ${row.last_seen || ''}`
      : fullPath
    append(copy, create('p', '', context))
    const close = create('button', 'detail-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', '关闭明细')
    close.addEventListener('click', () => closeRowDetails(true))
    append(header, copy, close)
    region.append(header)

    const bounds = presentation.bounds
    const stats = create('div', 'detail-stats')
    append(stats,
      detailStat(bounds.exact ? '精确费用' : (bounds.complete ? '费用中点' : '已知费用下限'), core.costLabel(bounds)),
      detailStat(
        bounds.exact ? '费用口径' : '估算区间',
        bounds.exact
          ? '精确金额，无估算区间'
          : (bounds.complete ? `${core.formatMoney(bounds.lower)} – ${core.formatMoney(bounds.upper)}` : `${core.formatMoney(bounds.lower)} 起，无法确定上限`),
      ),
      detailStat('Token 总量', formatTokens(row.total)),
      detailStat('非缓存输入', formatTokens(row.uncached)),
      detailStat('缓存输入', formatTokens(row.cached)),
      detailStat('输出', formatTokens(row.output)),
      detailStat('模型', modelsLabel(row)),
      detailStat('活跃耗时', row.active_duration_label || '—'),
      detailStat('最近时间', row.last_seen || relativeAge(row.last_age_min)),
    )
    region.append(stats)

    const pricingWarning = pricingWarningText(row)
    if (pricingWarning) region.append(create('p', 'pricing-warning', pricingWarning))

    if (kind === 'threads') {
      const lineage = renderLineage(row.members)
      if (lineage) region.append(lineage)
    }
    region.hidden = false
    if (shouldScroll && !reducedMotion()) region.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function renderEmptyState() {
    const item = create('li', 'empty-state')
    append(item, create('strong', '', '这个范围还没有用量记录'))
    append(item, create('span', '', state.project ? '可以清除项目筛选，或切换到更长的时间范围。' : '可以切换到更长的时间范围后再看。'))
    const actions = create('div', 'empty-actions')
    if (state.project) {
      const clearProject = create('button', 'quiet-action', '清除项目筛选')
      clearProject.type = 'button'
      clearProject.addEventListener('click', () => {
        state = { ...state, project: '' }
        $('projectInput').value = ''
        $('projectInputMobile').value = ''
        saveState()
        load()
      })
      actions.append(clearProject)
    }
    const useDay = create('button', 'primary-action', '查看最近 24 小时')
    useDay.type = 'button'
    useDay.addEventListener('click', () => {
      state = { ...state, preset: 'last_24h', activePinnedId: '' }
      saveState()
      syncPresetControls()
      load()
    })
    actions.append(useDay)
    item.append(actions)
    return item
  }

  function renderDataView(data = runtime.lastGoodData, tab = state.activeDataTab) {
    if (!data) return
    const list = $('dataList')
    const summaryBounds = core.costBounds(data.summary || {})
    const sourceRows = tab === 'threads' ? data.thread_top : (tab === 'activity' ? data.latest : data.cwd_top)
    const rows = Array.isArray(sourceRows) ? sourceRows : []
    const selectedKey = runtime.selectedRowKey
    const focusedRow = document.activeElement && typeof document.activeElement.closest === 'function'
      ? document.activeElement.closest('.editorial-row')
      : null
    const focusedKey = focusedRow ? focusedRow.dataset.rowKey : ''
    const focusWasDetailClose = Boolean(document.activeElement && document.activeElement.classList.contains('detail-close'))
    const sortBasis = summaryBounds.complete
      ? '按预计费用中点排序'
      : '按显示费用排序：完整项使用中点，未定价项使用已知下限'
    const contexts = {
      projects: `${sortBasis} · 项目 Top 10`,
      threads: `根线程家族 · ${sortBasis} · Top 20`,
      activity: '最近线程活动 · 20 条',
    }
    $('listContext').textContent = contexts[tab]
    list.replaceChildren()
    if (!rows.length) {
      closeRowDetails()
      list.append(renderEmptyState())
      return
    }
    rows.forEach((row, index) => list.append(makeEditorialRow(row, tab, index, summaryBounds)))
    restoreSelectedRow(rows, tab, summaryBounds, selectedKey)
    if (focusedKey) {
      const replacement = rowButtonByKey(focusedKey)
      if (replacement) replacement.focus({ preventScroll: true })
    } else if (focusWasDetailClose) {
      const replacementClose = $('detailRegion').querySelector('.detail-close')
      if (replacementClose) replacementClose.focus({ preventScroll: true })
    }
  }

  function restoreSelectedRow(rows, tab, summaryBounds, selectedKey) {
    if (!selectedKey) {
      $('detailRegion').hidden = true
      $('detailRegion').replaceChildren()
      return
    }
    const selectedIndex = rows.findIndex((row, index) => rowPresentation(row, tab, index, summaryBounds).key === selectedKey)
    if (selectedIndex < 0) {
      closeRowDetails()
      return
    }
    runtime.selectedRowKey = selectedKey
    const presentation = rowPresentation(rows[selectedIndex], tab, selectedIndex, summaryBounds)
    renderRowDetails(rows[selectedIndex], tab, presentation, false)
  }

  function setActiveDataTab(tab, shouldRender = true) {
    const nextTab = ['projects', 'threads', 'activity'].includes(tab) ? tab : 'projects'
    state = { ...state, activeDataTab: nextTab }
    document.body.dataset.activeTab = nextTab
    document.querySelectorAll('[data-tab]').forEach((button) => {
      const selected = button.dataset.tab === nextTab
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
      if (selected) $('auditStage').setAttribute('aria-labelledby', button.id)
    })
    $('auditStage').dataset.tone = nextTab === 'projects' ? 'light' : 'dark'
    const contexts = {
      projects: '按预计费用中点排序 · 项目 Top 10',
      threads: '根线程家族 · 按显示费用排序 · Top 20',
      activity: '最近线程活动 · 20 条',
    }
    $('listContext').textContent = contexts[nextTab]
    syncTabIndicator($('dataTabs'))
    saveState()
    if (shouldRender && runtime.lastGoodData) renderDataView(runtime.lastGoodData, nextTab)
  }

  function renderDiagnostics(data = runtime.lastGoodData) {
    if (!data) return
    const scan = data.scan_counts || {}
    const pricing = data.pricing || {}
    const range = data.range || {}
    const models = Array.isArray(pricing.models_used) && pricing.models_used.length
      ? pricing.models_used.join(' + ')
      : '无活动模型'
    const unknown = Array.isArray(pricing.unpriced_models) && pricing.unpriced_models.length
      ? pricing.unpriced_models.join(' + ')
      : '无'
    const lines = [
      `范围       ${range.label || '当前范围'} · ${range.start_label || ''} – ${range.end_label || ''}`,
      `趋势粒度   ${range.bucket_label || `${range.bucket_minutes || 1} 分钟`}`,
      `已识别模型 ${models}`,
      `未完整定价项 ${unknown}`,
      `扫描文件   ${formatTokens(scan.included_files || 0)} included · ${formatTokens(scan.duplicates_skipped || 0)} duplicates skipped`,
      `归档会话   ${formatTokens(scan.archived_included || 0)} included`,
      `子代理     ${formatTokens(scan.subagent_sessions_included || 0)} included · ${formatTokens(scan.orphan_subagents || 0)} orphan`,
      `继承基线   ${formatTokens(scan.inherited_baseline_events_skipped || 0)} events · ${formatTokens(scan.inherited_baseline_tokens_skipped || 0)} tokens skipped`,
      `fork 基线  ${formatTokens(scan.fork_baselines_skipped || 0)} skipped`,
    ]
    $('diagnosticsPanel').textContent = lines.join('\n')
  }

  function renderAll(data, selectionAnchor = null) {
    renderOverview(data)
    renderDiagnostics(data)
    renderTrend(selectionAnchor)
    renderDataView(data, state.activeDataTab)
    const nowLabel = data.now ? data.now.split(' ')[1] || data.now : new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    $('lastUpdated').textContent = `更新于 ${nowLabel}`
  }

  function commitLoadedData(data, selectionAnchor = null) {
    runtime.lastGoodData = data
    runtime.latestRange = data.range || null
    runtime.error = null
    runtime.lastSuccessAt = new Date()
    runtime.selectedRange = null
    renderAll(data, selectionAnchor)
    if (state.trendMode === 'quota') loadQuotaHistory({ quiet: true })
  }

  function flushPendingQuietData() {
    if (!runtime.pendingQuietData) return false
    const data = runtime.pendingQuietData
    const selectionAnchor = core.selectionAnchors(runtime.chartSeries, runtime.selectedRange)
    runtime.pendingQuietData = null
    commitLoadedData(data, selectionAnchor)
    return true
  }

  function requestParams(overrides = {}) {
    const preset = overrides.preset || state.preset || 'last_3h'
    const project = overrides.project !== undefined ? overrides.project : (state.project || '')
    const bucketMode = overrides.bucketMode || state.bucketMode
    const params = new URLSearchParams({ preset, project })
    if (preset === 'custom') {
      const range = currentCustomRange()
      params.set('start', range.start)
      params.set('end', range.end)
    }
    if (bucketMode !== 'auto') params.set('bucket', bucketMode)
    return params
  }

  function rangeCacheKey(params = requestParams()) {
    return params.toString()
  }

  function cacheRangeData(key, data) {
    runtime.rangeCache.delete(key)
    runtime.rangeCache.set(key, { data, savedAt: Date.now() })
    while (runtime.rangeCache.size > RANGE_CACHE_MAX_ENTRIES) {
      runtime.rangeCache.delete(runtime.rangeCache.keys().next().value)
    }
  }

  function readRangeCache(key) {
    const cached = runtime.rangeCache.get(key)
    if (!cached) return null
    if (Date.now() - cached.savedAt > RANGE_CACHE_MAX_AGE_MS) {
      runtime.rangeCache.delete(key)
      return null
    }
    runtime.rangeCache.delete(key)
    runtime.rangeCache.set(key, cached)
    return cached.data
  }

  function cancelPrefetch() {
    window.clearTimeout(runtime.prefetchTimer)
    runtime.prefetchTimer = 0
    if (runtime.prefetchController) runtime.prefetchController.abort()
    runtime.prefetchController = null
  }

  function scheduleIdlePrefetch(delay = 1200) {
    window.clearTimeout(runtime.prefetchTimer)
    if (document.hidden) return
    runtime.prefetchTimer = window.setTimeout(prefetchNextRange, delay)
  }

  async function prefetchNextRange() {
    runtime.prefetchTimer = 0
    if (document.hidden || runtime.loading || runtime.rangeLoadTimer) {
      scheduleIdlePrefetch(1200)
      return
    }
    const candidate = PREFETCH_PRESETS.map((preset) => ({ preset, params: requestParams({ preset }) }))
      .find(({ preset, params }) => (
        preset !== state.preset &&
        !readRangeCache(rangeCacheKey(params)) &&
        !runtime.prefetchAttempted.has(rangeCacheKey(params))
      ))
    if (!candidate) return

    const key = rangeCacheKey(candidate.params)
    runtime.prefetchAttempted.add(key)
    candidate.params.set('prefetch', '1')
    const controller = new AbortController()
    runtime.prefetchController = controller
    try {
      const response = await fetch(`/api/stats?${candidate.params.toString()}`, { signal: controller.signal })
      if (!response.ok) return
      cacheRangeData(key, await response.json())
    } catch (error) {
      if (!error || error.name !== 'AbortError') console.debug('range prefetch failed', error)
    } finally {
      if (runtime.prefetchController === controller) runtime.prefetchController = null
      scheduleIdlePrefetch(600)
    }
  }

  function scheduleRangeLoad(options = {}) {
    window.clearTimeout(runtime.rangeLoadTimer)
    cancelPrefetch()
    const cached = options.force ? null : readRangeCache(rangeCacheKey())
    if (cached) {
      commitLoadedData(cached)
      setStatus('已显示缓存，正在更新…', 'loading')
    } else if (!options.quiet) {
      setStatus('正在切换时间范围…', 'loading')
    }
    runtime.rangeLoadTimer = window.setTimeout(() => {
      runtime.rangeLoadTimer = 0
      load({ ...options, quiet: Boolean(options.quiet || cached) })
    }, RANGE_SWITCH_DEBOUNCE_MS)
  }

  async function load(options = {}) {
    state = {
      ...state,
      project: $('projectInput').value.trim(),
      numberMode: $('numberMode').value || state.numberMode,
      bucketMode: $('bucketMode').value || state.bucketMode,
    }
    if (state.preset === 'custom') {
      const range = currentCustomRange()
      state.customStart = range.start
      state.customEnd = range.end
      if (!validCustomRange(range)) {
        showCustomError('自定义范围无效：开始时间必须早于结束时间')
        return
      }
    }
    saveState()
    if (!options.quiet) cancelPrefetch()
    if (!options.quiet) runtime.pendingQuietData = null
    const params = requestParams()
    const cacheKey = rangeCacheKey(params)
    if (options.force) params.set('refresh', '1')
    const requestSeq = runtime.requestSeq + 1
    runtime.requestSeq = requestSeq
    if (runtime.requestController) runtime.requestController.abort()
    const controller = new AbortController()
    runtime.requestController = controller
    setLoading(true)
    if (!options.quiet) {
      const cycleStatus = {
        cycle: '正在定位 5 小时周期…',
        cycle_5h: '正在定位 5 小时周期…',
        cycle_7d: '正在定位 7 天周期…',
      }[state.preset]
      setStatus(cycleStatus || '正在更新统计…', 'loading')
    }
    try {
      const response = await fetch(`/api/stats?${params.toString()}`, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      cacheRangeData(cacheKey, data)
      if (requestSeq !== runtime.requestSeq) return
      if (options.quiet && runtime.pointerGesture) {
        runtime.pendingQuietData = data
        runtime.error = null
        return
      }
      const selectionAnchor = options.quiet
        ? core.selectionAnchors(runtime.chartSeries, runtime.selectedRange)
        : null
      runtime.pendingQuietData = null
      commitLoadedData(data, selectionAnchor)
      if (!options.quiet || options.announceFresh) setStatus('统计已更新')
      scheduleIdlePrefetch()
    } catch (error) {
      if (error && error.name === 'AbortError') return
      if (requestSeq !== runtime.requestSeq) return
      runtime.error = error
      const lastGood = runtime.lastSuccessAt
        ? `，已保留 ${runtime.lastSuccessAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 的数据`
        : ''
      setStatus(`读取失败：${error && error.message ? error.message : String(error)}${lastGood}`, 'error', true)
    } finally {
      if (requestSeq === runtime.requestSeq) setLoading(false)
    }
  }

  async function loadInitialSnapshot() {
    const params = requestParams()
    setLoading(true)
    setStatus('正在读取最近统计…', 'loading')
    try {
      const response = await fetch(`/api/stats-cache?${params.toString()}`)
      if (!response.ok) {
        setLoading(false)
        await load()
        return
      }
      const data = await response.json()
      cacheRangeData(rangeCacheKey(params), data)
      commitLoadedData(data)
      setStatus('已显示上次统计，正在后台更新…', 'loading')
      setLoading(false)
      await load({ quiet: true, force: true, announceFresh: true })
    } catch (_error) {
      setLoading(false)
      await load()
    }
  }

  function scheduleActivationRefresh({ allowHidden = false } = {}) {
    if ((!allowHidden && document.hidden) || !runtime.lastGoodData || runtime.loading) return
    window.clearTimeout(runtime.activationRefreshTimer)
    runtime.activationRefreshTimer = window.setTimeout(() => {
      runtime.activationRefreshTimer = 0
      if ((allowHidden || !document.hidden) && !runtime.loading) load({ quiet: true, force: true })
    }, ACTIVATION_REFRESH_DEBOUNCE_MS)
  }

  function bindRovingTablist(selector, dataKey, activate) {
    const buttons = Array.from(document.querySelectorAll(selector))
    buttons.forEach((button) => {
      button.addEventListener('click', () => activate(button.dataset[dataKey]))
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const currentIndex = buttons.indexOf(button)
        let nextIndex = currentIndex
        if (event.key === 'Home') nextIndex = 0
        else if (event.key === 'End') nextIndex = buttons.length - 1
        else {
          const direction = event.key === 'ArrowLeft' ? -1 : 1
          nextIndex = (currentIndex + direction + buttons.length) % buttons.length
        }
        const nextButton = buttons[nextIndex]
        nextButton.focus()
        activate(nextButton.dataset[dataKey])
      })
    })
  }

  async function postJson(path, payload = {}) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`)
    return result
  }

  async function refreshStartupStatus() {
    const input = $('startupEnabled')
    const label = $('startupStatus')
    input.disabled = true
    try {
      const response = await fetch('/api/app/startup')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json()
      input.checked = Boolean(result.enabled)
      input.disabled = result.supported === false
      label.textContent = result.supported === false ? '当前系统不支持' : '手动启用后，登录 Windows 时启动'
    } catch (error) {
      label.textContent = `读取失败：${error && error.message ? error.message : String(error)}`
    } finally {
      if (label.textContent !== '当前系统不支持') input.disabled = false
    }
  }

  async function setStartupEnabled() {
    const input = $('startupEnabled')
    const expected = input.checked
    input.disabled = true
    try {
      const result = await postJson('/api/app/startup', { enabled: expected })
      input.checked = Boolean(result.result && result.result.enabled)
      $('startupStatus').textContent = input.checked ? '已启用' : '已关闭'
    } catch (error) {
      input.checked = !expected
      $('startupStatus').textContent = `设置失败：${error && error.message ? error.message : String(error)}`
    } finally {
      input.disabled = false
    }
  }

  function resetExitTime(value) {
    if (!value) return '未知时间'
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) return String(value)
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  }

  function renderResetExitStatus(status) {
    runtime.resetExitStatus = status
    const available = status && status.available ? status.available : {}
    const armed = Boolean(status && status.armed)
    const completed = Boolean(status && status.phase === 'completed')
    const cycle = armed ? status.cycle : ''
    const five = $('armResetFive')
    const weekly = $('armResetWeekly')
    five.disabled = runtime.resetExitLoading || !available.five_hour
    weekly.disabled = runtime.resetExitLoading || !available.weekly
    $('cancelResetExit').disabled = runtime.resetExitLoading || (!armed && !completed)
    $('cancelResetExit').textContent = completed ? '清除记录' : '取消待命'
    five.classList.toggle('is-armed', cycle === 'five_hour')
    weekly.classList.toggle('is-armed', cycle === 'weekly')
    const line = $('resetExitStatus')
    line.classList.toggle('is-error', Boolean(status && status.error))
    line.classList.toggle('is-complete', Boolean(status && status.phase === 'completed'))
    if (!status) {
      line.textContent = '未读取到待命状态'
      return
    }
    if (status.phase === 'completed') {
      line.textContent = `已完成：${status.cycle_label || ''} 重置已确认，Codex Desktop 已退出并验证（${resetExitTime(status.completed_at)}）`
      return
    }
    if (armed) {
      const baseline = status.baseline || {}
      const prefix = status.phase === 'retry_close' ? '已确认重置，正在重试关闭 Codex' : `已待命：${status.cycle_label}`
      const confirmation = Number(status.confirmation_count || 0) > 0 ? ` · 确认 ${status.confirmation_count}/2` : ''
      line.textContent = `${prefix} · 基线 ${resetExitTime(baseline.reset)} · 每 ${status.poll_seconds || 15} 秒直接检测${confirmation}${status.error ? ` · ${status.error}` : ''}`
      return
    }
    if (status.error) {
      line.textContent = status.error
      return
    }
    const unavailable = []
    if (!available.five_hour) unavailable.push('5h 当前不可用')
    if (!available.weekly) unavailable.push('7d 当前不可用')
    line.textContent = unavailable.length ? `未待命 · ${unavailable.join(' · ')}` : '未待命；选择一个周期后仅触发一次'
  }

  async function refreshResetExitStatus(refresh = true) {
    runtime.resetExitLoading = true
    if (runtime.resetExitStatus) renderResetExitStatus(runtime.resetExitStatus)
    try {
      const response = await fetch(`/api/app/quota-reset-exit?refresh=${refresh ? '1' : '0'}`)
      const payload = await response.json()
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      renderResetExitStatus(payload.result)
    } catch (error) {
      renderResetExitStatus({
        ...(runtime.resetExitStatus || {}),
        error: `读取失败：${error && error.message ? error.message : String(error)}`,
      })
    } finally {
      runtime.resetExitLoading = false
      if (runtime.resetExitStatus) renderResetExitStatus(runtime.resetExitStatus)
    }
  }

  async function armResetExit(cycle) {
    runtime.resetExitLoading = true
    if (runtime.resetExitStatus) renderResetExitStatus(runtime.resetExitStatus)
    try {
      const payload = await postJson('/api/app/quota-reset-exit', { action: 'arm', cycle })
      renderResetExitStatus(payload.result)
    } catch (error) {
      renderResetExitStatus({
        ...(runtime.resetExitStatus || {}),
        error: `待命失败：${error && error.message ? error.message : String(error)}`,
      })
    } finally {
      runtime.resetExitLoading = false
      if (runtime.resetExitStatus) renderResetExitStatus(runtime.resetExitStatus)
    }
  }

  async function cancelResetExit() {
    runtime.resetExitLoading = true
    if (runtime.resetExitStatus) renderResetExitStatus(runtime.resetExitStatus)
    try {
      const payload = await postJson('/api/app/quota-reset-exit', { action: 'cancel' })
      renderResetExitStatus(payload.result)
    } catch (error) {
      renderResetExitStatus({
        ...(runtime.resetExitStatus || {}),
        error: `取消失败：${error && error.message ? error.message : String(error)}`,
      })
    } finally {
      runtime.resetExitLoading = false
      if (runtime.resetExitStatus) renderResetExitStatus(runtime.resetExitStatus)
    }
  }

  function shortcutBridge() {
    const bridge = window.tokenDesktopShortcuts
    return bridge && typeof bridge.get === 'function' && typeof bridge.set === 'function' ? bridge : null
  }

  function normalizeShortcutDraft(settings) {
    const value = settings && typeof settings === 'object' ? settings : {}
    return {
      toggleDashboard: typeof value.toggleDashboard === 'string' && value.toggleDashboard ? value.toggleDashboard : null,
      toggleFloatingWidget: typeof value.toggleFloatingWidget === 'string' && value.toggleFloatingWidget ? value.toggleFloatingWidget : null,
    }
  }

  function formatShortcut(value) {
    return value ? String(value).replace(/Super/g, 'Win') : '无'
  }

  function renderShortcutDialog() {
    document.querySelectorAll('[data-shortcut-action]').forEach((row) => {
      const action = row.dataset.shortcutAction
      const recording = runtime.shortcutRecording === action
      row.classList.toggle('is-recording', recording)
      const output = row.querySelector(`[data-shortcut-value="${action}"]`)
      const recordButton = row.querySelector(`[data-shortcut-record="${action}"]`)
      if (output) output.textContent = recording ? '请按组合键…' : formatShortcut(runtime.shortcutDraft[action])
      if (recordButton) recordButton.textContent = recording ? '录制中' : '录制'
    })
  }

  function stopShortcutRecording() {
    runtime.shortcutRecording = ''
    renderShortcutDialog()
  }

  async function openShortcutDialog() {
    closePanel('morePanel')
    runtime.shortcutRecording = ''
    $('shortcutError').textContent = ''
    const dialog = $('shortcutDialog')
    if (!dialog.open) dialog.showModal()
    const bridge = shortcutBridge()
    if (!bridge) {
      runtime.shortcutDraft = normalizeShortcutDraft(null)
      $('shortcutError').textContent = '快捷键仅在 Codex 用量监控桌面程序内可设置'
      renderShortcutDialog()
      return
    }
    try {
      runtime.shortcutDraft = normalizeShortcutDraft(await bridge.get())
      renderShortcutDialog()
    } catch (error) {
      $('shortcutError').textContent = `读取失败：${error && error.message ? error.message : String(error)}`
    }
  }

  function closeShortcutDialog() {
    runtime.shortcutRecording = ''
    $('shortcutError').textContent = ''
    const dialog = $('shortcutDialog')
    if (dialog.open) dialog.close()
  }

  function shortcutKey(event) {
    if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) return event.key
    if (/^[a-z0-9]$/i.test(event.key)) return event.key.toUpperCase()
    const aliases = {
      ' ': 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      Home: 'Home',
      End: 'End',
      Insert: 'Insert',
      Tab: 'Tab',
    }
    return aliases[event.key] || ''
  }

  function captureShortcut(event) {
    const action = runtime.shortcutRecording
    if (!action || !$('shortcutDialog').open) return false
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      stopShortcutRecording()
      return true
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      runtime.shortcutDraft = { ...runtime.shortcutDraft, [action]: null }
      stopShortcutRecording()
      return true
    }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return true
    const key = shortcutKey(event)
    const modifiers = [
      event.ctrlKey ? 'Ctrl' : '',
      event.altKey ? 'Alt' : '',
      event.shiftKey ? 'Shift' : '',
      event.metaKey ? 'Super' : '',
    ].filter(Boolean)
    if (!key || (!modifiers.length && !/^F(?:[1-9]|1[0-2])$/.test(key))) {
      $('shortcutError').textContent = '请使用带 Ctrl、Alt、Shift 或 Win 的组合键，也可以直接使用 F1–F12'
      return true
    }
    const accelerator = [...modifiers, key].join('+')
    const duplicate = Object.entries(runtime.shortcutDraft)
      .some(([otherAction, value]) => otherAction !== action && value === accelerator)
    if (duplicate) {
      $('shortcutError').textContent = '这个组合键已经用于另一项功能'
      return true
    }
    runtime.shortcutDraft = { ...runtime.shortcutDraft, [action]: accelerator }
    $('shortcutError').textContent = ''
    stopShortcutRecording()
    return true
  }

  async function saveShortcutSettings() {
    const bridge = shortcutBridge()
    if (!bridge) {
      $('shortcutError').textContent = '快捷键仅在 Codex 用量监控桌面程序内可设置'
      return
    }
    $('saveShortcutSettings').disabled = true
    $('shortcutError').textContent = ''
    try {
      const result = await bridge.set(runtime.shortcutDraft)
      if (!result || result.ok !== true) {
        $('shortcutError').textContent = result?.error || '快捷键保存失败'
        if (result?.settings) runtime.shortcutDraft = normalizeShortcutDraft(result.settings)
        renderShortcutDialog()
        return
      }
      closeShortcutDialog()
      setStatus('快捷键已保存')
    } catch (error) {
      $('shortcutError').textContent = `保存失败：${error && error.message ? error.message : String(error)}`
    } finally {
      $('saveShortcutSettings').disabled = false
    }
  }

  function signalSettingsBridge() {
    const bridge = window.tokenDesktopSignalSettings
    return bridge
      && typeof bridge.get === 'function'
      && typeof bridge.set === 'function'
      && typeof bridge.reset === 'function'
      ? bridge
      : null
  }

  function signalSeconds(value, fallbackMs) {
    const number = Number(value)
    const safeMs = Number.isFinite(number) ? number : fallbackMs
    return Number(Math.min(20, Math.max(1, safeMs / 1000)).toFixed(1)).toString()
  }

  function signalMinutes(value, fallbackMs) {
    const number = Number(value)
    const safeMs = Number.isFinite(number) ? number : fallbackMs
    return Math.round(Math.min(30, Math.max(1, safeMs / 60000))).toString()
  }

  function renderSignalSettings(settings = SIGNAL_SETTINGS_DEFAULTS) {
    const warning = signalSeconds(settings.warningBreathMs, SIGNAL_SETTINGS_DEFAULTS.warningBreathMs)
    const critical = signalSeconds(settings.criticalBlinkMs, SIGNAL_SETTINGS_DEFAULTS.criticalBlinkMs)
    const refresh = signalMinutes(settings.quotaRefreshMs, SIGNAL_SETTINGS_DEFAULTS.quotaRefreshMs)
    $('signalWarningBreathRange').value = warning
    $('signalWarningBreathInput').value = warning
    $('signalCriticalBlinkRange').value = critical
    $('signalCriticalBlinkInput').value = critical
    $('signalQuotaRefreshRange').value = refresh
    $('signalQuotaRefreshInput').value = refresh
    $('signalUsageRangeSelect').value = SIGNAL_USAGE_RANGES.has(settings.usageRange)
      ? settings.usageRange
      : SIGNAL_SETTINGS_DEFAULTS.usageRange
  }

  function readSignalSettings() {
    const secondsToMs = (value, fallback) => {
      const number = Number(value)
      return Number.isFinite(number) ? Math.round(clamp(number, 1, 20) * 1000) : fallback
    }
    const minutes = Number($('signalQuotaRefreshInput').value)
    const usageRange = $('signalUsageRangeSelect').value
    return {
      warningBreathMs: secondsToMs($('signalWarningBreathInput').value, SIGNAL_SETTINGS_DEFAULTS.warningBreathMs),
      criticalBlinkMs: secondsToMs($('signalCriticalBlinkInput').value, SIGNAL_SETTINGS_DEFAULTS.criticalBlinkMs),
      quotaRefreshMs: Number.isFinite(minutes)
        ? Math.round(clamp(minutes, 1, 30) * 60000)
        : SIGNAL_SETTINGS_DEFAULTS.quotaRefreshMs,
      usageRange: SIGNAL_USAGE_RANGES.has(usageRange) ? usageRange : SIGNAL_SETTINGS_DEFAULTS.usageRange,
    }
  }

  async function openSignalSettingsDialog() {
    closePanel('morePanel')
    $('signalSettingsError').textContent = ''
    const dialog = $('signalSettingsDialog')
    if (!dialog.open) dialog.showModal()
    const bridge = signalSettingsBridge()
    if (!bridge) {
      renderSignalSettings()
      $('signalSettingsError').textContent = '灯效设置仅在 Codex 用量监控桌面程序内可用'
      return
    }
    try {
      renderSignalSettings(await bridge.get())
    } catch (error) {
      $('signalSettingsError').textContent = `读取失败：${error && error.message ? error.message : String(error)}`
    }
  }

  function closeSignalSettingsDialog() {
    $('signalSettingsError').textContent = ''
    const dialog = $('signalSettingsDialog')
    if (dialog.open) dialog.close()
  }

  async function saveDesktopSignalSettings() {
    const bridge = signalSettingsBridge()
    if (!bridge) {
      $('signalSettingsError').textContent = '灯效设置仅在 Codex 用量监控桌面程序内可用'
      return
    }
    $('saveSignalSettings').disabled = true
    $('signalSettingsError').textContent = ''
    try {
      renderSignalSettings(await bridge.set(readSignalSettings()))
      closeSignalSettingsDialog()
      setStatus('灯效与用量设置已保存')
    } catch (error) {
      $('signalSettingsError').textContent = `保存失败：${error && error.message ? error.message : String(error)}`
    } finally {
      $('saveSignalSettings').disabled = false
    }
  }

  async function resetDesktopSignalSettings() {
    const bridge = signalSettingsBridge()
    if (!bridge) {
      $('signalSettingsError').textContent = '灯效设置仅在 Codex 用量监控桌面程序内可用'
      return
    }
    $('resetSignalSettings').disabled = true
    $('signalSettingsError').textContent = ''
    try {
      renderSignalSettings(await bridge.reset())
      setStatus('灯效与用量设置已恢复默认')
    } catch (error) {
      $('signalSettingsError').textContent = `恢复失败：${error && error.message ? error.message : String(error)}`
    } finally {
      $('resetSignalSettings').disabled = false
    }
  }

  function bindSignalSettingPair(rangeId, inputId) {
    $(rangeId).addEventListener('input', () => { $(inputId).value = $(rangeId).value })
    $(inputId).addEventListener('input', () => { $(rangeId).value = $(inputId).value })
  }

  function dismissTopLayer() {
    if ($('signalSettingsDialog').open) {
      closeSignalSettingsDialog()
      return true
    }
    if ($('shortcutDialog').open) {
      closeShortcutDialog()
      return true
    }
    const openPanelId = ['thresholdPopover', 'morePanel'].find((panelId) => !$(panelId).hidden)
    if (openPanelId) {
      closePanel(openPanelId, true)
      return true
    }

    const openValueKind = runtime.stickyValueDetail
      || (!$('costDetails').hidden ? 'cost' : (!$('rateDetails').hidden ? 'rate' : ''))
    if (openValueKind) {
      runtime.stickyValueDetail = ''
      setValueDetail(openValueKind, false)
      return true
    }

    if (!$('detailRegion').hidden) {
      closeRowDetails(true)
      return true
    }

    if (runtime.selectedRange) {
      clearSelection()
      return true
    }

    if (!$('trendTooltip').hidden) {
      runtime.hoverIndex = null
      $('trendTooltip').hidden = true
      drawTrend()
      return true
    }
    return false
  }

  function bindControls() {
    $('thresholdButton').addEventListener('click', (event) => togglePanel('thresholdPopover', event.currentTarget))
    $('thresholdInlineButton').addEventListener('click', (event) => {
      closePanel('morePanel')
      togglePanel('thresholdPopover', $('moreButton'))
    })
    $('moreButton').addEventListener('click', async (event) => {
      togglePanel('morePanel', event.currentTarget)
      if (!$('morePanel').hidden) await Promise.all([refreshStartupStatus(), refreshResetExitStatus(true)])
    })
    document.querySelectorAll('[data-close-panel]').forEach((button) => {
      button.addEventListener('click', () => closePanel(button.dataset.closePanel, true))
    })
    document.addEventListener('pointerdown', (event) => {
      ;['thresholdPopover', 'morePanel'].forEach((panelId) => {
        const panel = $(panelId)
        const button = panelButton(panelId)
        if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) closePanel(panelId)
      })
    })
    document.addEventListener('keydown', (event) => {
      if (captureShortcut(event)) return
      if (event.key !== 'Escape') return
      if (dismissTopLayer()) {
        event.preventDefault()
        event.stopPropagation()
      }
    })

    const selectPreset = (preset, keepPanelOpen = false) => {
      state = { ...state, preset, activePinnedId: '' }
      saveState()
      syncPresetControls()
      if (preset === 'custom') {
        if ($('morePanel').hidden) togglePanel('morePanel', document.activeElement)
        $('customStart').focus()
      } else {
        if (!keepPanelOpen) closePanel('morePanel', true)
        scheduleRangeLoad()
      }
    }
    document.querySelectorAll('[data-preset]').forEach((button) => {
      button.addEventListener('click', () => selectPreset(button.dataset.preset))
    })
    $('presetModeMobile').addEventListener('change', () => selectPreset($('presetModeMobile').value, true))
    ;[$('projectInput'), $('projectInputMobile')].forEach((input) => {
      input.addEventListener('input', () => {
        const value = input.value
        $('projectInput').value = value
        $('projectInputMobile').value = value
        state = { ...state, project: value.trim() }
        saveState()
      })
      input.addEventListener('change', () => scheduleRangeLoad())
    })
    $('refreshButton').addEventListener('click', () => load({ force: true }))
    $('shortcutSettingsButton').addEventListener('click', openShortcutDialog)
    $('closeShortcutDialog').addEventListener('click', closeShortcutDialog)
    $('cancelShortcutSettings').addEventListener('click', closeShortcutDialog)
    $('saveShortcutSettings').addEventListener('click', saveShortcutSettings)
    $('shortcutDialog').addEventListener('cancel', (event) => {
      event.preventDefault()
      closeShortcutDialog()
    })
    document.querySelectorAll('[data-shortcut-record]').forEach((button) => {
      button.addEventListener('click', () => {
        runtime.shortcutRecording = button.dataset.shortcutRecord
        $('shortcutError').textContent = ''
        renderShortcutDialog()
      })
    })
    document.querySelectorAll('[data-shortcut-clear]').forEach((button) => {
      button.addEventListener('click', () => {
        runtime.shortcutDraft = { ...runtime.shortcutDraft, [button.dataset.shortcutClear]: null }
        runtime.shortcutRecording = ''
        $('shortcutError').textContent = ''
        renderShortcutDialog()
      })
    })
    $('signalSettingsButton').addEventListener('click', openSignalSettingsDialog)
    $('closeSignalSettingsDialog').addEventListener('click', closeSignalSettingsDialog)
    $('cancelSignalSettings').addEventListener('click', closeSignalSettingsDialog)
    $('saveSignalSettings').addEventListener('click', saveDesktopSignalSettings)
    $('resetSignalSettings').addEventListener('click', resetDesktopSignalSettings)
    $('signalSettingsDialog').addEventListener('cancel', (event) => {
      event.preventDefault()
      closeSignalSettingsDialog()
    })
    bindSignalSettingPair('signalWarningBreathRange', 'signalWarningBreathInput')
    bindSignalSettingPair('signalCriticalBlinkRange', 'signalCriticalBlinkInput')
    bindSignalSettingPair('signalQuotaRefreshRange', 'signalQuotaRefreshInput')
    $('startupEnabled').addEventListener('change', setStartupEnabled)
    $('armResetFive').addEventListener('click', () => armResetExit('five_hour'))
    $('armResetWeekly').addEventListener('click', () => armResetExit('weekly'))
    $('cancelResetExit').addEventListener('click', cancelResetExit)
    $('saveThreshold').addEventListener('click', saveThreshold)
    $('resetThreshold').addEventListener('click', resetThreshold)
    $('thresholdInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveThreshold()
    })
    $('fixedEndMode').addEventListener('click', () => {
      state = { ...state, customEndMode: 'fixed', customEnd: $('customEnd').value || toDatetimeLocal(Date.now()) }
      syncCustomEndMode()
      saveState()
    })
    $('nowEndMode').addEventListener('click', () => {
      state = { ...state, customEndMode: 'now', customEnd: toDatetimeLocal(Date.now()) }
      syncCustomEndMode()
      saveState()
    })
    $('applyCustom').addEventListener('click', applyCustomRange)
    $('pinCustom').addEventListener('click', pinCustomRange)
    $('updatePinned').addEventListener('click', updatePinnedRange)
    $('numberMode').addEventListener('change', () => {
      state = { ...state, numberMode: $('numberMode').value }
      saveState()
      if (runtime.lastGoodData) renderAll(runtime.lastGoodData)
    })
    $('bucketMode').addEventListener('change', () => {
      state = { ...state, bucketMode: $('bucketMode').value }
      saveState()
      scheduleRangeLoad()
    })
    $('diagnosticsToggle').addEventListener('click', () => {
      const panel = $('diagnosticsPanel')
      panel.hidden = !panel.hidden
      $('diagnosticsToggle').setAttribute('aria-expanded', String(!panel.hidden))
      $('diagnosticsToggle').textContent = panel.hidden ? '显示扫描诊断' : '隐藏扫描诊断'
    })
    bindRovingTablist('[data-trend-mode]', 'trendMode', setTrendMode)
    bindRovingTablist('[data-cost-chart-mode]', 'costChartMode', setCostChartMode)
    bindRovingTablist('[data-tab]', 'tab', setActiveDataTab)
    document.querySelectorAll('[data-quota-line]').forEach((button) => {
      button.addEventListener('click', () => toggleQuotaLine(button.dataset.quotaLine))
    })
    $('applySelection').addEventListener('click', applySelectedRange)
    $('clearSelection').addEventListener('click', clearSelection)
    bindValueDisclosure('cost')
    bindValueDisclosure('rate')
    bindTrendEvents()
    window.addEventListener('resize', () => {
      syncTabIndicator($('trendMode'))
      syncTabIndicator($('dataTabs'))
      drawTrend()
    })
  }

  function initialize() {
    if (!core) {
      document.body.dataset.loading = 'false'
      setStatus('前端计算核心未加载，请刷新页面', 'error', true)
      return
    }
    document.body.dataset.view = 'focus'
    syncControls()
    bindControls()
    window.requestAnimationFrame(() => {
      document.body.classList.add('is-ready')
      syncTabIndicator($('trendMode'))
      syncTabIndicator($('dataTabs'))
    })
    loadInitialSnapshot()
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleActivationRefresh()
    })
    window.addEventListener('focus', scheduleActivationRefresh)
    window.addEventListener('pageshow', scheduleActivationRefresh)
    if (window.tokenDashboardActivation && typeof window.tokenDashboardActivation.subscribe === 'function') {
      window.tokenDashboardActivation.subscribe(() => scheduleActivationRefresh({ allowHidden: true }))
    }
    window.setInterval(() => {
      if (!document.hidden && !runtime.loading) {
        load({ quiet: true })
      }
    }, REFRESH_INTERVAL_MS)
    window.setInterval(() => {
      if (!document.hidden && state.customEndMode === 'now') $('customEnd').value = toDatetimeLocal(Date.now())
    }, 1000)
    window.setInterval(() => {
      if (!document.hidden && !$('morePanel').hidden) refreshResetExitStatus(false)
    }, 15000)
  }

  initialize()
})()
