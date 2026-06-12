// scanner.js
// Core scanning + scoring logic, shared between the GitHub Action (Node)
// and the Vercel serverless "refresh now" endpoint.
//
// Strategy:
//  1. Use FMP's stock-screener endpoint to pull a broad list of US stocks
//     matching the basic liquidity/price/momentum filters.
//  2. For each candidate, pull ~9 months of daily OHLCV.
//  3. Compute 10/20 SMA, then score the 3-stage pattern:
//       Stage 1: Strong uptrend (20%+ move, both SMAs rising, HH/HL)
//       Stage 2: Pullback & consolidation toward SMA10/20, tightening range,
//                volume declining
//       Stage 3: Breakout (price above consolidation range + volume surge)
//  4. Return a ranked list with per-stage scores + reasons.

const FMP_STABLE = 'https://financialmodelingprep.com/stable';

// ---- Tunables -------------------------------------------------------------

const FILTERS = {
  minPrice: 1,
  minAvgDollarVolume: 30_000_000, // price * volume > $30M
  minOneMonthChange: 5, // %
  adrMin: 5, // Average Daily Range %, > 5%
  minHistoryDays: 130, // ~6 months of trading days
};

// Sectors considered "bullish" are determined dynamically (see getBullishSectors),
// but we keep a fallback list in case the sector-performance call fails.
const FALLBACK_BULLISH_SECTORS = [
  'Technology',
  'Industrials',
  'Healthcare',
  'Financial Services',
  'Communication Services',
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
  if (a === 0) return 0;
  return ((b - a) / a) * 100;
}

// Average Daily Range % over last `period` days: avg((high-low)/low * 100)
function averageDailyRange(bars, period = 14) {
  const slice = bars.slice(-period);
  const adrs = slice.map((b) => ((b.high - b.low) / b.low) * 100);
  return adrs.reduce((s, v) => s + v, 0) / adrs.length;
}

// ---- FMP fetchers -----------------------------------------------------------

async function fmpFetch(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FMP request failed (${res.status}): ${url}\n${body.slice(0, 300)}`);
  }
  return res.json();
}

// Pull sector performance to determine "bullish sectors" dynamically.
// FMP stable endpoint requires a `date` param (most recent trading day).
// We try the last few calendar days until one returns data, since weekends
// and holidays have no snapshot.
async function getBullishSectors(apiKey) {
  for (let daysAgo = 1; daysAgo <= 5; daysAgo++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    const dateStr = d.toISOString().slice(0, 10);

    try {
      const data = await fmpFetch(
        `${FMP_STABLE}/sector-performance-snapshot?date=${dateStr}&apikey=${apiKey}`
      );
      if (!Array.isArray(data) || data.length === 0) continue;

      const bullish = data
        .filter((s) => parseFloat(s.averageChange ?? s.changesPercentage) > 0)
        .map((s) => s.sector);

      if (bullish.length) return bullish;
    } catch (e) {
      console.warn(`Sector performance fetch failed for ${dateStr}:`, e.message);
    }
  }

  console.warn('Sector performance unavailable after retries, using fallback list.');
  return FALLBACK_BULLISH_SECTORS;
}

// Run the FMP stock screener with our base liquidity/price/momentum filters.
// Sector filtering is applied after, since the screener endpoint only accepts
// a single sector value at a time.
async function runScreener(apiKey, bullishSectors) {
  const exchanges = ['NASDAQ', 'NYSE', 'AMEX'];
  const seen = new Map();

  for (const exchange of exchanges) {
    const params = new URLSearchParams({
      priceMoreThan: String(FILTERS.minPrice),
      volumeMoreThan: '500000', // rough pre-filter; refined later with price*vol
      isActivelyTrading: 'true',
      exchange,
      limit: '1000',
      apikey: apiKey,
    });

    try {
      const results = await fmpFetch(`${FMP_STABLE}/company-screener?${params.toString()}`);
      for (const r of results) {
        if (!seen.has(r.symbol)) seen.set(r.symbol, r);
      }
    } catch (e) {
      console.warn(`Screener fetch failed for exchange ${exchange}: ${e.message}`);
    }
  }

  const all = Array.from(seen.values());
  return all.filter((r) => bullishSectors.includes(r.sector));
}

// Get ~9 months of daily candles for a symbol.
async function getDailyBars(apiKey, symbol) {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 280); // ~9 months calendar days, covers ~190 trading days

  const params = new URLSearchParams({
    symbol,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    apikey: apiKey,
  });
  const data = await fmpFetch(`${FMP_STABLE}/historical-price-eod/full?${params.toString()}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  // FMP returns most-recent-first; reverse to chronological order.
  const bars = data
    .slice()
    .reverse()
    .map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
  return bars;
}

// ---- Pattern scoring ---------------------------------------------------------

// Score the 3-stage swing setup. Returns { score, stages, reasons }
function scorePattern(bars) {
  const reasons = [];
  const stages = { uptrend: 0, pullback: 0, breakout: 0 };

  if (bars.length < FILTERS.minHistoryDays) {
    return { score: 0, stages, reasons: ['Insufficient history'] };
  }

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const sma10 = sma(closes, 10);
  const sma20 = sma(closes, 20);

  const n = bars.length;
  const last = n - 1;

  // ---------- Stage 3: Breakout (most recent) ----------
  // Look at the last ~5 bars for a breakout above a recent consolidation high,
  // accompanied by a volume surge vs the prior 20-bar average.
  const breakoutWindow = 5;
  const consolidationLookback = 30; // bars used to define the "range" being broken
  let breakoutScore = 0;

  const recentBars = bars.slice(last - breakoutWindow + 1, last + 1);
  const priorRangeBars = bars.slice(
    last - breakoutWindow - consolidationLookback + 1,
    last - breakoutWindow + 1
  );
  const avgVolPrior20 =
    volumes.slice(last - 20, last).reduce((s, v) => s + v, 0) / 20;

  if (priorRangeBars.length > 0) {
    const consolHigh = Math.max(...priorRangeBars.map((b) => b.high));
    const breakoutBar = bars[last];
    const brokeOut = breakoutBar.close > consolHigh;
    const volSurge = breakoutBar.volume > avgVolPrior20 * 1.5;

    if (brokeOut) {
      breakoutScore += 50;
      reasons.push(
        `Price (${breakoutBar.close.toFixed(2)}) broke above consolidation high (${consolHigh.toFixed(2)})`
      );
    } else {
      const distToBreak = pctChange(breakoutBar.close, consolHigh);
      if (distToBreak < 3) {
        breakoutScore += 25;
        reasons.push(`Price within 3% of consolidation high (setup forming)`);
      }
    }
    if (volSurge) {
      breakoutScore += 50;
      reasons.push(
        `Volume surge: ${(breakoutBar.volume / avgVolPrior20).toFixed(1)}x the 20-day average`
      );
    } else if (brokeOut) {
      reasons.push('Breakout lacks strong volume confirmation');
    }
  }
  stages.breakout = Math.min(100, breakoutScore);

  // ---------- Stage 1: Strong uptrend (look back further) ----------
  // Find a prior up-leg of >= 20% within the last ~90 bars, with SMA10 and
  // SMA20 both rising at the time, and higher-highs/higher-lows structure.
  let uptrendScore = 0;
  const uptrendLookback = Math.min(90, n - 25);
  const segment = bars.slice(n - uptrendLookback - 20, n - 20); // exclude the most recent consolidation/breakout zone

  if (segment.length > 10) {
    const segCloses = segment.map((b) => b.close);
    const segLow = Math.min(...segCloses.slice(0, Math.floor(segCloses.length / 2)));
    const segHigh = Math.max(...segCloses.slice(Math.floor(segCloses.length / 2)));
    const move = pctChange(segLow, segHigh);

    if (move >= 20) {
      uptrendScore += 50;
      reasons.push(`Prior uptrend move of ${move.toFixed(1)}% detected`);
    } else if (move >= 10) {
      uptrendScore += 25;
      reasons.push(`Prior uptrend move of ${move.toFixed(1)}% (below 20% target)`);
    }

    // SMA slope check using start/end of segment in the sma10/sma20 arrays
    const segStartIdx = n - uptrendLookback - 20;
    const segEndIdx = n - 20;
    if (
      sma10[segStartIdx] != null &&
      sma10[segEndIdx] != null &&
      sma20[segStartIdx] != null &&
      sma20[segEndIdx] != null
    ) {
      const sma10Rising = sma10[segEndIdx] > sma10[segStartIdx];
      const sma20Rising = sma20[segEndIdx] > sma20[segStartIdx];
      if (sma10Rising && sma20Rising) {
        uptrendScore += 30;
        reasons.push('Both 10 SMA and 20 SMA were rising during the uptrend');
      } else if (sma10Rising || sma20Rising) {
        uptrendScore += 15;
      }
    }

    // Higher highs / higher lows: compare first-half vs second-half highs/lows
    const half = Math.floor(segment.length / 2);
    const firstHalf = segment.slice(0, half);
    const secondHalf = segment.slice(half);
    const hh = Math.max(...secondHalf.map((b) => b.high)) > Math.max(...firstHalf.map((b) => b.high));
    const hl = Math.min(...secondHalf.map((b) => b.low)) > Math.min(...firstHalf.map((b) => b.low));
    if (hh && hl) {
      uptrendScore += 20;
      reasons.push('Higher highs and higher lows structure confirmed');
    }
  }
  stages.uptrend = Math.min(100, uptrendScore);

  // ---------- Stage 2: Pullback & consolidation ----------
  // Use the ~20-bar window just before the breakout window.
  let pullbackScore = 0;
  const pullbackWindow = bars.slice(
    last - breakoutWindow - consolidationLookback + 1,
    last - breakoutWindow + 1
  );

  if (pullbackWindow.length >= 10) {
    const highs = pullbackWindow.map((b) => b.high);
    const lows = pullbackWindow.map((b) => b.low);
    const volsInWindow = pullbackWindow.map((b) => b.volume);

    // Tightening range: compare range of first half vs second half
    const half = Math.floor(pullbackWindow.length / 2);
    const firstHalfRange = Math.max(...highs.slice(0, half)) - Math.min(...lows.slice(0, half));
    const secondHalfRange = Math.max(...highs.slice(half)) - Math.min(...lows.slice(half));
    const tightening = secondHalfRange < firstHalfRange;
    if (tightening) {
      pullbackScore += 25;
      reasons.push('Trading range tightened during consolidation');
    }

    // Higher lows: second half low > first half low
    const higherLows = Math.min(...lows.slice(half)) > Math.min(...lows.slice(0, half));
    if (higherLows) {
      pullbackScore += 25;
      reasons.push('Higher lows during consolidation');
    }

    // Same or lower highs: second half high <= first half high * 1.02
    const sameOrLowerHighs = Math.max(...highs.slice(half)) <= Math.max(...highs.slice(0, half)) * 1.02;
    if (sameOrLowerHighs) {
      pullbackScore += 20;
      reasons.push('Same or lower highs during consolidation');
    }

    // Volume declining: second half avg vol < first half avg vol
    const avgVol1 = volsInWindow.slice(0, half).reduce((s, v) => s + v, 0) / half;
    const avgVol2 = volsInWindow.slice(half).reduce((s, v) => s + v, 0) / (volsInWindow.length - half);
    if (avgVol2 < avgVol1) {
      pullbackScore += 30;
      reasons.push('Volume declined during consolidation');
    }

    // Price near SMA10/20 at end of pullback window
    const endIdx = last - breakoutWindow;
    if (sma10[endIdx] != null && sma20[endIdx] != null) {
      const px = bars[endIdx].close;
      const nearSma10 = Math.abs(pctChange(sma10[endIdx], px)) < 5;
      const nearSma20 = Math.abs(pctChange(sma20[endIdx], px)) < 5;
      if (nearSma10 || nearSma20) {
        pullbackScore = Math.min(100, pullbackScore + 0); // already weighted above, just informational
        reasons.push('Price pulled back near the 10/20 SMA');
      }
    }
  }
  stages.pullback = Math.min(100, pullbackScore);

  // ---------- Composite score ----------
  // Weight: breakout matters most (it's the trigger), pullback second,
  // uptrend confirms the overall structure.
  const score = Math.round(
    stages.breakout * 0.45 + stages.pullback * 0.35 + stages.uptrend * 0.2
  );

  return { score, stages, reasons };
}

// ---- Main scan ---------------------------------------------------------------

async function scan(apiKey, { limit = 40, onProgress = null } = {}) {
  const bullishSectors = await getBullishSectors(apiKey);
  const candidates = await runScreener(apiKey, bullishSectors);

  const results = [];
  let processed = 0;

  for (const c of candidates) {
    processed++;
    if (onProgress) onProgress(processed, candidates.length, c.symbol);

    try {
      const bars = await getDailyBars(apiKey, c.symbol);
      if (!bars || bars.length < FILTERS.minHistoryDays) continue;

      const last = bars[bars.length - 1];
      const oneMonthAgo = bars[Math.max(0, bars.length - 22)];
      const sixMonthAgo = bars[Math.max(0, bars.length - 130)];

      const dollarVolume = last.close * last.volume;
      if (dollarVolume < FILTERS.minAvgDollarVolume) continue;

      const oneMonthChange = pctChange(oneMonthAgo.close, last.close);
      if (oneMonthChange < FILTERS.minOneMonthChange) continue;

      const sixMonthChange = pctChange(sixMonthAgo.close, last.close);

      const adr = averageDailyRange(bars);
      if (adr < FILTERS.adrMin) continue;

      const { score, stages, reasons } = scorePattern(bars);

      const closes = bars.map((b) => b.close);
      const sma10 = sma(closes, 10);
      const sma20 = sma(closes, 20);

      results.push({
        symbol: c.symbol,
        name: c.companyName,
        sector: c.sector,
        industry: c.industry,
        price: last.close,
        dollarVolume,
        oneMonthChange,
        sixMonthChange,
        adr,
        score,
        stages,
        reasons,
        // Trimmed bar data + SMAs for charting (last 120 bars is plenty)
        bars: bars.slice(-120).map((b, i, arr) => {
          const fullIdx = bars.length - arr.length + i;
          return {
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            sma10: sma10[fullIdx],
            sma20: sma20[fullIdx],
          };
        }),
      });
    } catch (e) {
      console.warn(`Skipping ${c.symbol}: ${e.message}`);
    }

    if (results.length >= limit * 3) break; // safety cap on API usage
  }

  results.sort((a, b) => b.score - a.score);

  return {
    generatedAt: new Date().toISOString(),
    bullishSectors,
    totalScreened: candidates.length,
    totalQualified: results.length,
    results: results.slice(0, limit),
  };
}

module.exports = { scan, scorePattern, sma, FILTERS };
