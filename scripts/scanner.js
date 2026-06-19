// scanner.js — Swing trade setup scanner
// 
// Strategy (working around FMP free tier limitations):
//  1. stable/stock-list  → free, returns all US stocks with exchange/sector/price.
//     Filter to US exchanges, price > $1, known sector.
//  2. stable/batch-quote → free bulk quote endpoint; fetch in batches of 50 symbols
//     to get current price, volume, and 1-day change cheaply.
//     Apply dollar-volume filter (price * volume > $30M) and 1-month change proxy.
//  3. stable/historical-price-eod/full → for surviving candidates only (~top 150),
//     fetch 9 months of OHLCV and run the full pattern score + ADR filter.
//  4. Return ranked results.

const FMP_STABLE = 'https://financialmodelingprep.com/stable';

// ---- Tunables ---------------------------------------------------------------

const FILTERS = {
  minPrice:           1,           // price > $1
  minDollarVolume:    30_000_000,  // price * volume > $30M
  minOneMonthChange:  5,           // % (approximated from 20-day history)
  adrMin:             5,           // Average Daily Range % > 5%
  minHistoryDays:     120,         // ~6 months of trading days
  maxCandidates:      80,          // max symbols to fetch full history for (API budget)
};

const TARGET_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NASDAQ Global Select',
  'Nasdaq Global Select', 'Nasdaq Capital Market', 'New York Stock Exchange',
  'NYSE American', 'NYSE Arca', 'nasdaq', 'nyse', 'amex']);

const FALLBACK_BULLISH_SECTORS = [
  'Technology', 'Industrials', 'Healthcare',
  'Financial Services', 'Communication Services',
];

// ---- Helpers ----------------------------------------------------------------

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

function pctChange(a, b) {
  if (!a || a === 0) return 0;
  return ((b - a) / a) * 100;
}

function averageDailyRange(bars, period = 14) {
  const slice = bars.slice(-period);
  const adrs = slice.map(b => ((b.high - b.low) / (b.low || 1)) * 100);
  return adrs.reduce((s, v) => s + v, 0) / adrs.length;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- FMP fetchers -----------------------------------------------------------

async function fmpFetch(url, debug, label) {
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    const msg = `FMP ${res.status} ${label || ''}: ${body.slice(0, 200)}`;
    if (debug) debug.push(msg);
    throw new Error(msg);
  }
  return JSON.parse(body);
}

// Sector performance — find bullish sectors from last trading day
async function getBullishSectors(apiKey, debug) {
  for (let daysAgo = 1; daysAgo <= 5; daysAgo++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const data = await fmpFetch(
        `${FMP_STABLE}/sector-performance-snapshot?date=${dateStr}&apikey=${apiKey}`,
        debug, `sector-perf ${dateStr}`
      );
      if (!Array.isArray(data) || !data.length) continue;
      const bullish = data
        .filter(s => parseFloat(s.averageChange ?? s.changesPercentage ?? 0) > 0)
        .map(s => s.sector);
      if (bullish.length) {
        debug && debug.push(`Bullish sectors (${dateStr}): ${bullish.join(', ')}`);
        return bullish;
      }
    } catch (e) {
      debug && debug.push(`Sector perf ${dateStr} failed: ${e.message.slice(0, 100)}`);
    }
  }
  debug && debug.push('Using fallback bullish sectors');
  return FALLBACK_BULLISH_SECTORS;
}

// Step 1: Get full stock list (free endpoint)
async function getStockList(apiKey, debug) {
  const data = await fmpFetch(
    `${FMP_STABLE}/stock-list?apikey=${apiKey}`,
    debug, 'stock-list'
  );
  if (!Array.isArray(data)) {
    debug && debug.push(`stock-list returned non-array: ${JSON.stringify(data).slice(0, 100)}`);
    return [];
  }
  debug && debug.push(`stock-list: ${data.length} total symbols`);
  return data;
}

// Step 2: Batch quotes — fetch current price/volume for up to 50 symbols at once
async function getBatchQuotes(symbols, apiKey, debug) {
  const results = new Map();
  const batchSize = 50;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize).join(',');
    try {
      const data = await fmpFetch(
        `${FMP_STABLE}/batch-quote?symbols=${encodeURIComponent(batch)}&apikey=${apiKey}`,
        null, 'batch-quote'
      );
      if (Array.isArray(data)) {
        for (const q of data) results.set(q.symbol, q);
      }
    } catch (e) {
      // batch-quote might also need a different approach — try quote-short as fallback
      try {
        const data2 = await fmpFetch(
          `${FMP_STABLE}/quote?symbols=${encodeURIComponent(batch)}&apikey=${apiKey}`,
          null, 'quote'
        );
        if (Array.isArray(data2)) {
          for (const q of data2) results.set(q.symbol, q);
        }
      } catch (e2) {
        debug && debug.push(`batch-quote failed for batch ${i}: ${e2.message.slice(0, 80)}`);
      }
    }
    await sleep(120); // be gentle on rate limits (250/day = ~1 per 5min, but batching helps)
  }
  return results;
}

// Step 3: Historical OHLCV
async function getDailyBars(symbol, apiKey) {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 280); // ~9 calendar months

  const params = new URLSearchParams({
    symbol,
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
    apikey: apiKey,
  });
  const data = await fmpFetch(
    `${FMP_STABLE}/historical-price-eod/full?${params}`,
    null, `history-${symbol}`
  );
  if (!Array.isArray(data) || !data.length) return null;
  return data.slice().reverse().map(b => ({
    date: b.date, open: b.open, high: b.high,
    low: b.low, close: b.close, volume: b.volume,
  }));
}

// ---- Pattern scoring --------------------------------------------------------

function scorePattern(bars) {
  const reasons = [];
  const stages = { uptrend: 0, pullback: 0, breakout: 0 };

  if (bars.length < FILTERS.minHistoryDays) {
    return { score: 0, stages, reasons: ['Insufficient history'] };
  }

  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const sma10   = sma(closes, 10);
  const sma20   = sma(closes, 20);
  const n       = bars.length;
  const last    = n - 1;

  // ---- Stage 3: Breakout (most recent 5 bars) ----
  const breakoutWindow       = 5;
  const consolidationLookback = 30;
  let breakoutScore = 0;

  const priorRangeBars = bars.slice(
    last - breakoutWindow - consolidationLookback + 1,
    last - breakoutWindow + 1
  );
  const avgVolPrior20 = volumes.slice(last - 20, last).reduce((s, v) => s + v, 0) / 20;

  if (priorRangeBars.length > 0) {
    const consolHigh  = Math.max(...priorRangeBars.map(b => b.high));
    const breakoutBar = bars[last];
    const brokeOut    = breakoutBar.close > consolHigh;
    const volSurge    = breakoutBar.volume > avgVolPrior20 * 1.5;

    if (brokeOut) {
      breakoutScore += 50;
      reasons.push(`Price ($${breakoutBar.close.toFixed(2)}) broke above consolidation high ($${consolHigh.toFixed(2)})`);
    } else {
      const distPct = pctChange(breakoutBar.close, consolHigh);
      if (distPct < 3) {
        breakoutScore += 25;
        reasons.push(`Price within 3% of consolidation high — setup forming`);
      }
    }
    if (volSurge) {
      breakoutScore += 50;
      reasons.push(`Volume surge: ${(breakoutBar.volume / avgVolPrior20).toFixed(1)}× 20-day avg`);
    } else if (brokeOut) {
      reasons.push('Breakout lacks volume confirmation');
    }
  }
  stages.breakout = Math.min(100, breakoutScore);

  // ---- Stage 1: Uptrend (look at bars 25–115 ago) ----
  let uptrendScore = 0;
  const uptrendLookback = Math.min(90, n - 25);
  const segment = bars.slice(n - uptrendLookback - 20, n - 20);

  if (segment.length > 10) {
    const segCloses = segment.map(b => b.close);
    const half      = Math.floor(segCloses.length / 2);
    const segLow    = Math.min(...segCloses.slice(0, half));
    const segHigh   = Math.max(...segCloses.slice(half));
    const move      = pctChange(segLow, segHigh);

    if (move >= 20)      { uptrendScore += 50; reasons.push(`Prior uptrend: +${move.toFixed(1)}%`); }
    else if (move >= 10) { uptrendScore += 25; reasons.push(`Partial uptrend: +${move.toFixed(1)}% (below 20% target)`); }

    const segStartIdx = Math.max(0, n - uptrendLookback - 20);
    const segEndIdx   = Math.max(0, n - 20);
    if (sma10[segStartIdx] != null && sma10[segEndIdx] != null) {
      const s10Up = sma10[segEndIdx] > sma10[segStartIdx];
      const s20Up = sma20[segEndIdx] > sma20[segStartIdx];
      if (s10Up && s20Up) { uptrendScore += 30; reasons.push('Both SMA10 and SMA20 rising during uptrend'); }
      else if (s10Up || s20Up) { uptrendScore += 15; }
    }

    const firstH = segment.slice(0, half);
    const secondH = segment.slice(half);
    const hh = Math.max(...secondH.map(b => b.high)) > Math.max(...firstH.map(b => b.high));
    const hl = Math.min(...secondH.map(b => b.low))  > Math.min(...firstH.map(b => b.low));
    if (hh && hl) { uptrendScore += 20; reasons.push('Higher highs and higher lows confirmed'); }
  }
  stages.uptrend = Math.min(100, uptrendScore);

  // ---- Stage 2: Pullback / consolidation ----
  let pullbackScore = 0;
  const pullbackZone = bars.slice(
    last - breakoutWindow - consolidationLookback + 1,
    last - breakoutWindow + 1
  );

  if (pullbackZone.length >= 10) {
    const highs    = pullbackZone.map(b => b.high);
    const lows     = pullbackZone.map(b => b.low);
    const pvols    = pullbackZone.map(b => b.volume);
    const half     = Math.floor(pullbackZone.length / 2);

    const r1 = Math.max(...highs.slice(0, half)) - Math.min(...lows.slice(0, half));
    const r2 = Math.max(...highs.slice(half))     - Math.min(...lows.slice(half));
    if (r2 < r1) { pullbackScore += 25; reasons.push('Range tightening during consolidation'); }

    if (Math.min(...lows.slice(half)) > Math.min(...lows.slice(0, half))) {
      pullbackScore += 25; reasons.push('Higher lows during consolidation');
    }
    if (Math.max(...highs.slice(half)) <= Math.max(...highs.slice(0, half)) * 1.02) {
      pullbackScore += 20; reasons.push('Same or lower highs during consolidation');
    }

    const avgV1 = pvols.slice(0, half).reduce((s, v) => s + v, 0) / half;
    const avgV2 = pvols.slice(half).reduce((s, v) => s + v, 0) / (pvols.length - half);
    if (avgV2 < avgV1) { pullbackScore += 30; reasons.push('Volume declining during consolidation'); }

    const endIdx = last - breakoutWindow;
    if (sma10[endIdx] != null) {
      const px = bars[endIdx].close;
      if (Math.abs(pctChange(sma10[endIdx], px)) < 5 || Math.abs(pctChange(sma20[endIdx], px)) < 5) {
        reasons.push('Price pulled back near SMA10/20');
      }
    }
  }
  stages.pullback = Math.min(100, pullbackScore);

  const score = Math.round(stages.breakout * 0.45 + stages.pullback * 0.35 + stages.uptrend * 0.2);
  return { score, stages, reasons };
}

// ---- Main scan --------------------------------------------------------------

async function scan(apiKey, { limit = 40, onProgress = null, maxCandidatesOverride = null } = {}) {
  const MAX_CANDIDATES = maxCandidatesOverride || FILTERS.maxCandidates;
  const debug = [];

  // 1. Bullish sectors
  const bullishSectors = await getBullishSectors(apiKey, debug);

  // 2. Full stock list (free)
  let stockList;
  try {
    stockList = await getStockList(apiKey, debug);
  } catch (e) {
    return { generatedAt: new Date().toISOString(), bullishSectors, totalScreened: 0,
             totalQualified: 0, debug: [...debug, `stock-list fatal: ${e.message}`], results: [] };
  }

  // Pre-filter by exchange + sector + price from the list itself
  const US_SECTORS = new Set([
    'Technology','Industrials','Healthcare','Financial Services',
    'Communication Services','Consumer Cyclical','Consumer Defensive',
    'Basic Materials','Energy','Real Estate','Utilities',
  ]);

  const preFiltered = stockList.filter(s => {
    if (!s.symbol || s.symbol.includes('.') || s.symbol.length > 5) return false;
    const price = parseFloat(s.price) || 0;
    if (price < FILTERS.minPrice) return false;
    if (!bullishSectors.includes(s.sector)) return false;
    // Exchange check — FMP stock-list uses exchangeShortName or exchange
    const ex = (s.exchangeShortName || s.exchange || '').toUpperCase();
    return ex === 'NASDAQ' || ex === 'NYSE' || ex === 'AMEX';
  });

  debug.push(`Pre-filtered to ${preFiltered.length} symbols (exchange + sector + price)`);

  // Sort by price descending as a rough liquidity proxy, cap to save API calls
  preFiltered.sort((a, b) => (parseFloat(b.price) || 0) - (parseFloat(a.price) || 0));
  const candidates = preFiltered.slice(0, 500); // reasonable cap
  debug.push(`Working candidate pool: ${candidates.length}`);

  // 3. Fetch historical data for candidates, apply all filters
  const results = [];
  let processed = 0;

  for (const c of candidates) {
    processed++;
    if (onProgress) onProgress(processed, candidates.length, c.symbol);

    try {
      await sleep(50); // gentle pacing
      const bars = await getDailyBars(c.symbol, apiKey);
      if (!bars || bars.length < FILTERS.minHistoryDays) continue;

      const lastBar    = bars[bars.length - 1];
      const mo1Bar     = bars[Math.max(0, bars.length - 22)];
      const mo6Bar     = bars[Math.max(0, bars.length - 130)];

      const dollarVol  = lastBar.close * lastBar.volume;
      if (dollarVol < FILTERS.minDollarVolume) continue;

      const change1m   = pctChange(mo1Bar.close, lastBar.close);
      if (change1m < FILTERS.minOneMonthChange) continue;

      const adr = averageDailyRange(bars);
      if (adr < FILTERS.adrMin) continue;

      const { score, stages, reasons } = scorePattern(bars);
      const closes = bars.map(b => b.close);
      const sma10v = sma(closes, 10);
      const sma20v = sma(closes, 20);

      results.push({
        symbol:        c.symbol,
        name:          c.name || c.companyName || c.symbol,
        sector:        c.sector,
        industry:      c.industry || '',
        price:         lastBar.close,
        dollarVolume:  dollarVol,
        oneMonthChange: change1m,
        sixMonthChange: pctChange(mo6Bar.close, lastBar.close),
        adr,
        score,
        stages,
        reasons,
        bars: bars.slice(-120).map((b, i, arr) => {
          const fi = bars.length - arr.length + i;
          return { date: b.date, open: b.open, high: b.high, low: b.low,
                   close: b.close, volume: b.volume,
                   sma10: sma10v[fi], sma20: sma20v[fi] };
        }),
      });

      debug.push(`✓ ${c.symbol} score=${score}`);
    } catch (e) {
      // silently skip
    }

    if (results.length >= limit * 3 || processed >= MAX_CANDIDATES) break;
  }

  results.sort((a, b) => b.score - a.score);

  return {
    generatedAt:    new Date().toISOString(),
    bullishSectors,
    totalScreened:  processed,
    totalQualified: results.length,
    debug,
    results:        results.slice(0, limit),
  };
}

module.exports = { scan, scorePattern, sma, FILTERS };
