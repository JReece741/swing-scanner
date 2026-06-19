// api/scan.js — Vercel serverless function: GET /api/scan
// On-demand live scan triggered by the "Refresh now" button.
// API key stays server-side (set as a Vercel environment variable).

const { scan } = require('../scripts/scanner');

module.exports = async (req, res) => {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured: FMP_API_KEY not set' });
    return;
  }

  try {
    // Vercel hobby plan: 60s max. We limit candidates aggressively for the
    // live/on-demand scan. The GitHub Action has no timeout so runs the full scan.
    const data = await scan(apiKey, { limit: 20, maxCandidatesOverride: 40 });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Scan failed', detail: e.message });
  }
};
