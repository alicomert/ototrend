const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

let symbolsCache = [];
let lastSymbolsFetch = 0;
const SYMBOL_CACHE_TTL = 1000 * 60 * 15; // 15 minutes

function fetchJson(apiUrl) {
  return new Promise((resolve, reject) => {
    https
      .get(apiUrl, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Request failed: ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(body);
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

async function getSymbols() {
  const now = Date.now();
  if (symbolsCache.length && now - lastSymbolsFetch < SYMBOL_CACHE_TTL) {
    return symbolsCache;
  }
  const exchangeInfoUrl = 'https://api.binance.com/api/v3/exchangeInfo';
  const data = await fetchJson(exchangeInfoUrl);
  symbolsCache = (data.symbols || [])
    .filter((symbol) => symbol.status === 'TRADING' && symbol.quoteAsset === 'USDT')
    .map((symbol) => ({
      symbol: symbol.symbol,
      baseAsset: symbol.baseAsset,
      quoteAsset: symbol.quoteAsset,
    }));
  lastSymbolsFetch = now;
  return symbolsCache;
}

function linearRegression(values) {
  const n = values.length;
  if (n === 0) {
    return { slope: 0, intercept: 0 };
  }
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    const x = i;
    const y = values[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return { slope: 0, intercept: values[0] || 0 };
  }
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

async function handleSymbolsRequest(res, query) {
  try {
    const q = (query.q || '').toUpperCase();
    const allSymbols = await getSymbols();
    const filtered = q
      ? allSymbols.filter(
          (item) =>
            item.symbol.includes(q) ||
            item.baseAsset.includes(q) ||
            item.quoteAsset.includes(q)
        )
      : allSymbols;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        symbols: filtered.slice(0, 30),
        total: filtered.length,
      })
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unable to fetch symbols', details: err.message }));
  }
}

async function handleKlinesRequest(res, query) {
  const symbol = (query.symbol || '').toUpperCase();
  const interval = query.interval || '1h';
  const limit = Math.min(parseInt(query.limit, 10) || 150, 500);
  if (!symbol) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'symbol query parameter is required' }));
    return;
  }
  const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const raw = await fetchJson(klinesUrl);
    const candles = raw.map((item) => ({
      time: item[0],
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[5]),
    }));
    const closes = candles.map((c) => c.close);
    const { slope, intercept } = linearRegression(closes);
    const trendLine = candles.length
      ? [
          { x: candles[0].time, y: Number(intercept.toFixed(6)) },
          {
            x: candles[candles.length - 1].time,
            y: Number((intercept + slope * (candles.length - 1)).toFixed(6)),
          },
        ]
      : [];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candles, trendLine }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unable to fetch klines', details: err.message }));
  }
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function serveStaticFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': getContentType(filePath) });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/api/symbols' && req.method === 'GET') {
    handleSymbolsRequest(res, parsedUrl.query);
    return;
  }

  if (parsedUrl.pathname === '/api/klines' && req.method === 'GET') {
    handleKlinesRequest(res, parsedUrl.query);
    return;
  }

  const pathname = decodeURIComponent(parsedUrl.pathname || '/');
  const sanitizedPath = path.normalize(pathname).replace(/^(\.{2}[\/])+/g, '');
  let targetPath = path.join(PUBLIC_DIR, sanitizedPath);

  if (pathname === '/' || path.extname(sanitizedPath) === '') {
    targetPath = path.join(PUBLIC_DIR, 'index.html');
  }

  const resolvedPath = path.resolve(targetPath);

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  serveStaticFile(res, resolvedPath);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
