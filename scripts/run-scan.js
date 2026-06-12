// scripts/run-scan.js
// Entry point for GitHub Actions: runs the scan and writes data/latest.json

const fs = require('fs');
const path = require('path');
const { scan } = require('./scanner');

async function main() {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    console.error('Missing FMP_API_KEY environment variable.');
    process.exit(1);
  }

  console.log('Starting scan...');
  const data = await scan(apiKey, {
    limit: 40,
    onProgress: (done, total, symbol) => {
      if (done % 25 === 0 || done === total) {
        console.log(`  ...processed ${done}/${total} (${symbol})`);
      }
    },
  });

  const json = JSON.stringify(data, null, 2);

  // Repo-level copy (history / debugging)
  const rootOut = path.join(__dirname, '..', 'data', 'latest.json');
  fs.mkdirSync(path.dirname(rootOut), { recursive: true });
  fs.writeFileSync(rootOut, json);

  // Public copy (served statically by Vercel/GitHub Pages)
  const publicOut = path.join(__dirname, '..', 'public', 'data', 'latest.json');
  fs.mkdirSync(path.dirname(publicOut), { recursive: true });
  fs.writeFileSync(publicOut, json);

  console.log(`Wrote ${data.results.length} results to ${rootOut} and ${publicOut}`);
  console.log(`Screened ${data.totalScreened}, qualified ${data.totalQualified}`);
}

main().catch((e) => {
  console.error('Scan failed:', e);
  process.exit(1);
});
