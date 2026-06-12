// public/app.js

const DATA_URL = 'data/latest.json'; // static daily snapshot
const SCAN_API_URL = '/api/scan'; // Vercel serverless function (on-demand)

let currentData = null;

const els = {
  status: document.getElementById('status'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  refreshBtn: document.getElementById('refreshBtn'),
  refreshIcon: document.getElementById('refreshIcon'),
  summary: document.getElementById('summary'),
  grid: document.getElementById('grid'),
  sortSelect: document.getElementById('sortSelect'),
  modalBackdrop: document.getElementById('modalBackdrop'),
  modal: document.getElementById('modal'),
  modalContent: document.getElementById('modalContent'),
  modalClose: document.getElementById('modalClose'),
};

// ---------- Status helpers ----------

function setStatus(state, text) {
  els.statusDot.classList.remove('live', 'error', 'loading');
  if (state) els.statusDot.classList.add(state);
  els.statusText.textContent = text;
}

function timeAgo(iso) {
  if (!iso) return 'unknown';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ---------- Data loading ----------

async function loadStaticData() {
  setStatus('loading', 'Loading scan results…');
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentData = data;
    render(data);
    setStatus('live', `Last updated ${timeAgo(data.generatedAt)}`);
  } catch (e) {
    console.error(e);
    setStatus('error', 'No scan data found — run a scan to get started');
    renderEmpty();
  }
}

async function runLiveScan() {
  els.refreshBtn.disabled = true;
  els.refreshIcon.classList.add('spinning');
  setStatus('loading', 'Running live scan… this can take 30–60s');

  try {
    const res = await fetch(SCAN_API_URL, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    currentData = data;
    render(data);
    setStatus('live', `Refreshed ${timeAgo(data.generatedAt)}`);
  } catch (e) {
    console.error(e);
    setStatus('error', `Live scan failed: ${e.message}`);
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshIcon.classList.remove('spinning');
  }
}

// ---------- Rendering ----------

function scoreClass(score) {
  if (score >= 65) return 'score-high';
  if (score >= 35) return 'score-mid';
  return 'score-low';
}

function fmtPct(v) {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function fmtDollarVol(v) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

function render(data) {
  renderSummary(data);
  renderGrid(data.results);
}

function renderSummary(data) {
  els.summary.innerHTML = `
    <div class="summary-card">
      <p class="summary-label">Qualified setups</p>
      <p class="summary-value">${data.totalQualified}</p>
    </div>
    <div class="summary-card">
      <p class="summary-label">Screened</p>
      <p class="summary-value">${data.totalScreened}</p>
    </div>
    <div class="summary-card">
      <p class="summary-label">Last scan</p>
      <p class="summary-value">${timeAgo(data.generatedAt)}</p>
    </div>
    <div class="summary-card" style="grid-column: span 2;">
      <p class="summary-label">Bullish sectors</p>
      <p class="summary-value small">${(data.bullishSectors || []).join(', ') || 'none detected'}</p>
    </div>
  `;
}

function renderEmpty() {
  els.summary.innerHTML = '';
  els.grid.innerHTML = `
    <div class="empty-state">
      <h3>No scan data yet</h3>
      <p>Press "Refresh now" to run a live scan, or wait for the next scheduled run.</p>
    </div>
  `;
}

function getSortValue(item, key) {
  switch (key) {
    case 'oneMonthChange': return item.oneMonthChange;
    case 'sixMonthChange': return item.sixMonthChange;
    case 'adr': return item.adr;
    case 'dollarVolume': return item.dollarVolume;
    default: return item.score;
  }
}

function renderGrid(results) {
  if (!results || results.length === 0) {
    renderEmpty();
    return;
  }

  const sortKey = els.sortSelect.value;
  const sorted = [...results].sort((a, b) => getSortValue(b, sortKey) - getSortValue(a, sortKey));

  els.grid.innerHTML = sorted.map((item) => cardHtml(item)).join('');

  // Attach click handlers
  els.grid.querySelectorAll('.card').forEach((card, i) => {
    card.addEventListener('click', () => openModal(sorted[i]));
  });
}

function cardHtml(item) {
  const s = item.stages || { uptrend: 0, pullback: 0, breakout: 0 };
  return `
    <article class="card" data-symbol="${item.symbol}">
      <div class="card-head">
        <div>
          <p class="card-symbol">${item.symbol}</p>
          <p class="card-name">${item.name || ''}</p>
        </div>
        <div>
          <p class="card-score ${scoreClass(item.score)}">${item.score}</p>
          <p class="card-score-label">Setup score</p>
        </div>
      </div>

      <div>
        <div class="stage-bar">
          <div class="stage-seg"><div class="stage-fill uptrend" style="width:${s.uptrend}%"></div></div>
          <div class="stage-seg"><div class="stage-fill pullback" style="width:${s.pullback}%"></div></div>
          <div class="stage-seg"><div class="stage-fill breakout" style="width:${s.breakout}%"></div></div>
        </div>
        <div class="stage-labels">
          <span>Uptrend</span><span>Pullback</span><span>Breakout</span>
        </div>
      </div>

      <div class="card-metrics">
        <div>
          <div class="metric-label">Price</div>
          <div class="metric-value">$${item.price.toFixed(2)}</div>
        </div>
        <div>
          <div class="metric-label">1M change</div>
          <div class="metric-value ${item.oneMonthChange >= 0 ? 'positive' : 'negative'}">${fmtPct(item.oneMonthChange)}</div>
        </div>
        <div>
          <div class="metric-label">6M change</div>
          <div class="metric-value ${item.sixMonthChange >= 0 ? 'positive' : 'negative'}">${fmtPct(item.sixMonthChange)}</div>
        </div>
        <div>
          <div class="metric-label">ADR%</div>
          <div class="metric-value">${item.adr.toFixed(1)}%</div>
        </div>
        <div>
          <div class="metric-label">$ Volume</div>
          <div class="metric-value">${fmtDollarVol(item.dollarVolume)}</div>
        </div>
        <div>
          <div class="metric-label">Sector</div>
          <div class="metric-value" style="font-size:11px;">${(item.sector || '').slice(0, 14)}</div>
        </div>
      </div>

      <div class="card-sector">${item.industry || ''}</div>
    </article>
  `;
}

// ---------- Modal / Chart ----------

let chartInstances = [];

function destroyCharts() {
  chartInstances.forEach((c) => c.remove());
  chartInstances = [];
}

function openModal(item) {
  const s = item.stages || { uptrend: 0, pullback: 0, breakout: 0 };

  els.modalContent.innerHTML = `
    <div class="modal-header">
      <div>
        <h2 class="modal-title">${item.symbol}</h2>
        <p class="modal-subtitle">${item.name || ''} &middot; ${item.sector || ''}</p>
      </div>
      <div class="modal-score ${scoreClass(item.score)}">${item.score}<div class="card-score-label">Setup score</div></div>
    </div>

    <div class="modal-stages">
      <div class="modal-stage">
        <div class="modal-stage-label">Uptrend</div>
        <div class="modal-stage-value" style="color:var(--green)">${s.uptrend}</div>
      </div>
      <div class="modal-stage">
        <div class="modal-stage-label">Pullback</div>
        <div class="modal-stage-value" style="color:var(--blue)">${s.pullback}</div>
      </div>
      <div class="modal-stage">
        <div class="modal-stage-label">Breakout</div>
        <div class="modal-stage-value" style="color:var(--amber)">${s.breakout}</div>
      </div>
    </div>

    <div class="chart-container" id="priceChart"></div>
    <div class="volume-container" id="volumeChart"></div>

    <ul class="reasons-list">
      ${(item.reasons || []).map((r) => `<li>${r}</li>`).join('')}
    </ul>
  `;

  els.modalBackdrop.classList.add('open');
  destroyCharts();

  // Defer chart creation until the modal is in the DOM and sized
  requestAnimationFrame(() => buildCharts(item));
}

function closeModal() {
  els.modalBackdrop.classList.remove('open');
  destroyCharts();
}

function buildCharts(item) {
  const bars = item.bars || [];
  if (!bars.length || !window.LightweightCharts) return;

  const priceEl = document.getElementById('priceChart');
  const volEl = document.getElementById('volumeChart');

  const chartOptions = {
    layout: {
      background: { color: '#1b1f26' },
      textColor: '#8a93a3',
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: '#2c323c' },
      horzLines: { color: '#2c323c' },
    },
    rightPriceScale: { borderColor: '#2c323c' },
    timeScale: { borderColor: '#2c323c' },
    crosshair: { mode: 0 },
  };

  // ----- Price chart -----
  const priceChart = LightweightCharts.createChart(priceEl, {
    ...chartOptions,
    width: priceEl.clientWidth,
    height: 320,
    timeScale: { ...chartOptions.timeScale, visible: false },
  });

  const candleSeries = priceChart.addCandlestickSeries({
    upColor: '#3ddc97',
    downColor: '#e55a5a',
    borderUpColor: '#3ddc97',
    borderDownColor: '#e55a5a',
    wickUpColor: '#3ddc97',
    wickDownColor: '#e55a5a',
  });

  candleSeries.setData(
    bars.map((b) => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }))
  );

  const sma10Series = priceChart.addLineSeries({
    color: '#5b8def',
    lineWidth: 2,
    title: '10 SMA',
  });
  sma10Series.setData(
    bars.filter((b) => b.sma10 != null).map((b) => ({ time: b.date, value: b.sma10 }))
  );

  const sma20Series = priceChart.addLineSeries({
    color: '#f0a742',
    lineWidth: 2,
    title: '20 SMA',
  });
  sma20Series.setData(
    bars.filter((b) => b.sma20 != null).map((b) => ({ time: b.date, value: b.sma20 }))
  );

  // ----- Volume chart -----
  const volumeChart = LightweightCharts.createChart(volEl, {
    ...chartOptions,
    width: volEl.clientWidth,
    height: 120,
  });

  const volumeSeries = volumeChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceLineVisible: false,
  });

  volumeSeries.setData(
    bars.map((b, i) => ({
      time: b.date,
      value: b.volume,
      color: i > 0 && b.close >= bars[i - 1].close ? 'rgba(61,220,151,0.6)' : 'rgba(229,90,90,0.6)',
    }))
  );

  // Sync time scales
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    volumeChart.timeScale().setVisibleLogicalRange(range);
  });
  volumeChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    priceChart.timeScale().setVisibleLogicalRange(range);
  });

  priceChart.timeScale().fitContent();
  volumeChart.timeScale().fitContent();

  chartInstances.push(priceChart, volumeChart);

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    priceChart.applyOptions({ width: priceEl.clientWidth });
    volumeChart.applyOptions({ width: volEl.clientWidth });
  });
  resizeObserver.observe(priceEl);
}

// ---------- Event listeners ----------

els.refreshBtn.addEventListener('click', runLiveScan);
els.sortSelect.addEventListener('change', () => {
  if (currentData) renderGrid(currentData.results);
});
els.modalClose.addEventListener('click', closeModal);
els.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === els.modalBackdrop) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ---------- Init ----------

loadStaticData();
