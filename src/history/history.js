(() => {
const {
  normalizeQuotaHistoryPayload,
  buildChartSeries,
  lineSvgPath,
  resetLineSeriesKeys,
  seriesPathSegments,
  nearestSeriesPoint
} = window.CodexQuotaHistoryChart;

const SVG_NS = "http://www.w3.org/2000/svg";
const state = {
  samples: [],
  chart: null,
  resizeFrame: null,
  visibleSeries: {
    primary: true,
    secondary: true,
    longIdeal: true,
    longVelocityRequired: false
  }
};

const els = {
  scope: document.getElementById("historyScope"),
  chart: document.getElementById("historyChart"),
  tooltip: document.getElementById("historyTooltip"),
  tooltipSeries: document.getElementById("tooltipSeries"),
  tooltipTime: document.getElementById("tooltipTime"),
  tooltipValue: document.getElementById("tooltipValue"),
  empty: document.getElementById("emptyState"),
  refresh: document.getElementById("refreshHistoryBtn"),
  toggles: {
    primary: document.getElementById("togglePrimary"),
    secondary: document.getElementById("toggleSecondary"),
    longIdeal: document.getElementById("toggleIdeal"),
    longVelocityRequired: document.getElementById("toggleVelocity")
  }
};

const DRAW_ORDER = ["longIdeal", "longVelocityRequired", "secondary", "primary"];
const SERIES_STYLE = {
  primary: { strokeWidth: 3, dash: null, opacity: 1, minDistancePx: 10, bucketSizePx: 2, bucketMode: "last" },
  secondary: { strokeWidth: 3.4, dash: null, opacity: 1, minDistancePx: 10, bucketSizePx: 2, bucketMode: "last" },
  longIdeal: { strokeWidth: 2, dash: "7 7", opacity: 0.72, minDistancePx: 6, bucketSizePx: 2, bucketMode: "last" },
  longVelocityRequired: {
    strokeWidth: 2.2,
    dash: "5 6",
    opacity: 0.82,
    minDistancePx: 6,
    bucketSizePx: 2,
    bucketMode: "median"
  }
};

const cnTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const cnFullTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function createSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function formatTime(value, full = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return (full ? cnFullTime : cnTime).format(date).replace(/\//g, "-").replace(",", "");
}

function percentText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const rounded = Math.round(number * 10) / 10;
  return `${Number.isInteger(rounded) ? Math.round(rounded) : rounded}%`;
}

function setScopeText(samples) {
  if (samples.length === 0) {
    els.scope.textContent = "暂无历史样本";
    return;
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  els.scope.textContent = `来源 quota-history.json, ${samples.length} 个样本, 北京时间 ${formatTime(first.fetchedAt, true)} 到 ${formatTime(last.fetchedAt, true)}`;
}

async function loadHistory() {
  els.scope.textContent = "读取本机历史样本...";
  hideTooltip();
  try {
    const payload = await window.codexQuota.getQuotaHistory();
    state.samples = normalizeQuotaHistoryPayload(payload);
    setScopeText(state.samples);
    render();
  } catch (error) {
    state.samples = [];
    els.scope.textContent = `读取失败: ${error?.message || String(error)}`;
    render();
  }
}

function render() {
  const bounds = els.chart.getBoundingClientRect();
  const width = Math.max(720, Math.round(bounds.width || 960));
  const height = Math.max(360, Math.round(bounds.height || 520));
  const plotBox = {
    x: 72,
    y: 26,
    width: width - 102,
    height: height - 96
  };

  els.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clearSvg(els.chart);
  els.empty.hidden = state.samples.length > 0;
  if (state.samples.length === 0) {
    state.chart = null;
    return;
  }

  state.chart = buildChartSeries(state.samples, plotBox);
  drawGrid(els.chart, state.chart, width, height);
  drawResetLines(els.chart, state.chart);
  drawSeries(els.chart, state.chart);
  drawInteractionLayer(els.chart, state.chart);
}

function drawGrid(svg, chart) {
  const { plotBox } = chart;
  svg.appendChild(
    createSvgElement("rect", {
      x: plotBox.x,
      y: plotBox.y,
      width: plotBox.width,
      height: plotBox.height,
      fill: "#ffffff",
      stroke: "#cfd8df",
      "stroke-width": 1.2
    })
  );

  for (const value of [90, 70, 50, 30, 10]) {
    svg.appendChild(
      createSvgElement("line", {
        x1: plotBox.x,
        y1: chart.yScale(value),
        x2: plotBox.x + plotBox.width,
        y2: chart.yScale(value),
        stroke: "#f3f5f7",
        "stroke-width": 1
      })
    );
  }

  for (const value of [100, 80, 60, 40, 20, 0]) {
    const y = chart.yScale(value);
    svg.appendChild(
      createSvgElement("line", {
        x1: plotBox.x,
        y1: y,
        x2: plotBox.x + plotBox.width,
        y2: y,
        stroke: "#e2e8ee",
        "stroke-width": 1
      })
    );
    const text = createSvgElement("text", {
      x: plotBox.x - 16,
      y: y + 5,
      "text-anchor": "end",
      fill: "#596875",
      "font-size": 13
    });
    text.textContent = `${value}%`;
    svg.appendChild(text);
  }

  for (const time of timeTicks(chart.minTimeMs, chart.maxTimeMs, 8)) {
    const x = chart.xScale(time);
    svg.appendChild(
      createSvgElement("line", {
        x1: x,
        y1: plotBox.y,
        x2: x,
        y2: plotBox.y + plotBox.height,
        stroke: "#eef2f5",
        "stroke-width": 1
      })
    );
    const text = createSvgElement("text", {
      x,
      y: plotBox.y + plotBox.height + 30,
      "text-anchor": "middle",
      fill: "#596875",
      "font-size": 12
    });
    text.textContent = formatTime(time);
    svg.appendChild(text);
  }

  const yAxis = createSvgElement("text", {
    x: 20,
    y: plotBox.y + plotBox.height / 2,
    "text-anchor": "middle",
    fill: "#40515f",
    "font-size": 13,
    transform: `rotate(-90 20 ${plotBox.y + plotBox.height / 2})`
  });
  yAxis.textContent = "剩余额度百分比";
  svg.appendChild(yAxis);
}

function drawResetLines(svg, chart) {
  const resetLines = [];
  for (const key of resetLineSeriesKeys(state.visibleSeries)) {
    let lastReset = null;
    for (const sample of chart.samples) {
      const reset = sample[key]?.resetsAt;
      if (!reset || reset === lastReset) continue;
      lastReset = reset;
      const resetMs = Date.parse(reset);
      if (Number.isFinite(resetMs) && resetMs >= chart.minTimeMs && resetMs <= chart.maxTimeMs) {
        resetLines.push({ key, resetMs });
      }
    }
  }

  for (const line of resetLines) {
    svg.appendChild(
      createSvgElement("line", {
        x1: chart.xScale(line.resetMs),
        y1: chart.plotBox.y,
        x2: chart.xScale(line.resetMs),
        y2: chart.plotBox.y + chart.plotBox.height,
        stroke: line.key === "primary" ? "#d24b42" : "#2477a8",
        "stroke-opacity": 0.16,
        "stroke-dasharray": "5 7",
        "stroke-width": 1.2
      })
    );
  }
}

function drawSeries(svg, chart) {
  for (const key of DRAW_ORDER) {
    if (!state.visibleSeries[key]) continue;
    const series = chart.series[key];
    const style = SERIES_STYLE[key];
    for (const pathPoints of seriesPathSegments(series.points, style)) {
      const path = lineSvgPath(pathPoints);
      if (!path) continue;
      const attributes = {
        d: path,
        fill: "none",
        stroke: series.color,
        "stroke-width": style.strokeWidth,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
        "stroke-opacity": style.opacity,
        "vector-effect": "non-scaling-stroke"
      };
      if (style.dash) attributes["stroke-dasharray"] = style.dash;
      svg.appendChild(createSvgElement("path", attributes));
    }
  }
}

function visibleSeries(chart) {
  return Object.fromEntries(Object.entries(chart.series).filter(([key]) => state.visibleSeries[key]));
}

function drawInteractionLayer(svg, chart) {
  const crosshair = createSvgElement("line", {
    x1: 0,
    y1: chart.plotBox.y,
    x2: 0,
    y2: chart.plotBox.y + chart.plotBox.height,
    stroke: "#8da0ae",
    "stroke-opacity": 0.35,
    "stroke-width": 1,
    hidden: "true"
  });
  const dot = createSvgElement("circle", {
    cx: 0,
    cy: 0,
    r: 5,
    fill: "#ffffff",
    stroke: "#17232d",
    "stroke-width": 2,
    hidden: "true"
  });
  const overlay = createSvgElement("rect", {
    x: chart.plotBox.x,
    y: chart.plotBox.y,
    width: chart.plotBox.width,
    height: chart.plotBox.height,
    fill: "transparent"
  });

  overlay.addEventListener("mousemove", (event) => {
    const position = svgPointFromMouse(svg, event);
    const nearest = nearestSeriesPoint(visibleSeries(chart), position, 48);
    if (!nearest) {
      crosshair.setAttribute("hidden", "true");
      dot.setAttribute("hidden", "true");
      hideTooltip();
      return;
    }

    crosshair.removeAttribute("hidden");
    crosshair.setAttribute("x1", nearest.x);
    crosshair.setAttribute("x2", nearest.x);
    dot.removeAttribute("hidden");
    dot.setAttribute("cx", nearest.x);
    dot.setAttribute("cy", nearest.y);
    dot.setAttribute("stroke", nearest.color);
    showTooltip(nearest, event);
  });
  overlay.addEventListener("mouseleave", () => {
    crosshair.setAttribute("hidden", "true");
    dot.setAttribute("hidden", "true");
    hideTooltip();
  });

  svg.appendChild(crosshair);
  svg.appendChild(dot);
  svg.appendChild(overlay);
}

function showTooltip(point, event) {
  els.tooltipSeries.textContent = point.label;
  els.tooltipSeries.style.color = point.color;
  els.tooltipTime.textContent = `时间 ${formatTime(point.fetchedAt, true)}`;
  els.tooltipValue.textContent = `${valueLabel(point)} ${percentText(point.remainingPercent)}`;
  els.tooltip.hidden = false;

  const shell = els.chart.parentElement.getBoundingClientRect();
  const tooltipRect = els.tooltip.getBoundingClientRect();
  const rawLeft = event.clientX - shell.left + 18;
  const rawTop = event.clientY - shell.top - tooltipRect.height - 14;
  const left = clamp(rawLeft, 8, shell.width - tooltipRect.width - 8);
  const top = clamp(rawTop, 8, shell.height - tooltipRect.height - 8);
  els.tooltip.style.left = `${left}px`;
  els.tooltip.style.top = `${top}px`;
}

function valueLabel(point) {
  if (point.valueKind === "idealRemainingPercent") return "理想剩余";
  if (point.valueKind === "requiredRemainingPercent") return "近速需留";
  return "剩余额度";
}

function hideTooltip() {
  els.tooltip.hidden = true;
}

function svgPointFromMouse(svg, event) {
  const rect = svg.getBoundingClientRect();
  const [viewX, viewY, viewWidth, viewHeight] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
  return {
    x: viewX + ((event.clientX - rect.left) / rect.width) * viewWidth,
    y: viewY + ((event.clientY - rect.top) / rect.height) * viewHeight
  };
}

function timeTicks(minTimeMs, maxTimeMs, count) {
  const span = Math.max(1, maxTimeMs - minTimeMs);
  return Array.from({ length: count }, (_item, index) => minTimeMs + (span * index) / (count - 1));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scheduleRender() {
  if (state.resizeFrame) return;
  state.resizeFrame = window.requestAnimationFrame(() => {
    state.resizeFrame = null;
    render();
  });
}

els.refresh.addEventListener("click", loadHistory);
for (const [key, input] of Object.entries(els.toggles)) {
  input.addEventListener("change", () => {
    state.visibleSeries[key] = input.checked;
    hideTooltip();
    render();
  });
}
window.addEventListener("resize", scheduleRender);
loadHistory();
})();
