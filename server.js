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
const PIVOT_WINDOW = 5;
const LINE_TOLERANCE = 1e-6;

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

function findPivotPoints(candles, window) {
  const pivotHighs = [];
  const pivotLows = [];
  for (let i = window; i < candles.length - window; i += 1) {
    const current = candles[i];
    let isPivotHigh = true;
    let isPivotLow = true;
    for (let j = i - window; j <= i + window; j += 1) {
      if (j === i) {
        continue;
      }
      if (candles[j].high >= current.high) {
        isPivotHigh = false;
      }
      if (candles[j].low <= current.low) {
        isPivotLow = false;
      }
      if (!isPivotHigh && !isPivotLow) {
        break;
      }
    }
    if (isPivotHigh) {
      pivotHighs.push({ index: i, price: current.high, time: current.time });
    }
    if (isPivotLow) {
      pivotLows.push({ index: i, price: current.low, time: current.time });
    }
  }
  return { pivotHighs, pivotLows };
}

function evaluateTrendLine(candles, pivotA, pivotB, type) {
  const indexDiff = pivotB.index - pivotA.index;
  if (indexDiff === 0) {
    return null;
  }
  const slope = (pivotB.price - pivotA.price) / indexDiff;
  const pivotTolerance = LINE_TOLERANCE * 10;
  let touches = 0;
  for (let idx = pivotA.index; idx < candles.length; idx += 1) {
    const expected = pivotA.price + slope * (idx - pivotA.index);
    if (type === 'support') {
      if (expected > candles[idx].low + LINE_TOLERANCE) {
        return null;
      }
      if (Math.abs(candles[idx].low - expected) <= pivotTolerance) {
        touches += 1;
      }
    } else {
      if (expected < candles[idx].high - LINE_TOLERANCE) {
        return null;
      }
      if (Math.abs(candles[idx].high - expected) <= pivotTolerance) {
        touches += 1;
      }
    }
  }
  if (touches < 2) {
    return null;
  }
  const lastIndex = candles.length - 1;
  const endValue = pivotA.price + slope * (lastIndex - pivotA.index);
  const points = [
    { x: candles[pivotA.index].time, y: Number(pivotA.price.toFixed(6)) },
    { x: candles[pivotB.index].time, y: Number(pivotB.price.toFixed(6)) },
  ];
  if (pivotB.index < lastIndex) {
    points.push({ x: candles[lastIndex].time, y: Number(endValue.toFixed(6)) });
  }
  return {
    type,
    touches,
    pivotA,
    pivotB,
    points,
  };
}

function findBestTrendLine(candles) {
  if (candles.length < PIVOT_WINDOW * 2 + 2) {
    return [];
  }
  const { pivotHighs, pivotLows } = findPivotPoints(candles, PIVOT_WINDOW);

  function searchBest(pivots, type) {
    let best = null;
    for (let i = pivots.length - 1; i >= 1; i -= 1) {
      for (let j = i - 1; j >= 0; j -= 1) {
        const candidate = evaluateTrendLine(candles, pivots[j], pivots[i], type);
        if (!candidate) {
          continue;
        }
        if (!best) {
          best = candidate;
          continue;
        }
        if (candidate.touches > best.touches) {
          best = candidate;
          continue;
        }
        if (candidate.pivotB.index > best.pivotB.index) {
          best = candidate;
          continue;
        }
        if (
          candidate.pivotB.index === best.pivotB.index &&
          candidate.pivotA.index > best.pivotA.index
        ) {
          best = candidate;
        }
      }
    }
    return best;
  }

  const supportLine = searchBest(pivotLows, 'support');
  const resistanceLine = searchBest(pivotHighs, 'resistance');

  if (supportLine && resistanceLine) {
    return supportLine.pivotB.index >= resistanceLine.pivotB.index
      ? supportLine.points
      : resistanceLine.points;
  }
  if (supportLine) {
    return supportLine.points;
  }
  if (resistanceLine) {
    return resistanceLine.points;
  }
  return [];
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
    const trendLine = findBestTrendLine(candles);

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
