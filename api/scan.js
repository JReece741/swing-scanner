// api/scan.js
// Vercel serverless function: GET /api/scan
// Runs a live scan on demand (button press) and returns JSON.
// Keeps the FMP API key server-side (set as a Vercel env var).

const { scan } = require('../scripts/scanner');

module.exports = async (req, res) => {
  const apiKey = process.env.FMP_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured: FMP_API_KEY not set' });
    return;
  }

  try {
    const data = await scan(apiKey, { limit: 40 });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Scan failed', detail: e.message });
  }
};
