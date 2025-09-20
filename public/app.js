const form = document.getElementById('query-form');
const symbolInput = document.getElementById('symbol-input');
const timeframeSelect = document.getElementById('timeframe-select');
const limitInput = document.getElementById('limit-input');
const statusEl = document.getElementById('status');
const suggestionsList = document.getElementById('symbol-suggestions');

let chart;
let searchDebounce;

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.toggle('status--error', Boolean(isError));
}

async function fetchSymbols(query) {
  if (!query || query.length < 2) {
    suggestionsList.innerHTML = '';
    return;
  }
  try {
    const res = await fetch(`/api/symbols?q=${encodeURIComponent(query)}`);
    if (!res.ok) {
      throw new Error('Sembol listesi alınamadı');
    }
    const data = await res.json();
    suggestionsList.innerHTML = '';
    data.symbols.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.symbol;
      option.label = `${item.baseAsset}/${item.quoteAsset}`;
      suggestionsList.appendChild(option);
    });
  } catch (err) {
    console.error(err);
  }
}

function buildChartOptions() {
  return {
    chart: {
      id: 'trendChart',
      type: 'candlestick',
      height: 550,
      toolbar: {
        show: true,
        tools: {
          download: true,
          zoom: true,
          zoomin: true,
          zoomout: true,
          pan: true,
          reset: true,
        },
      },
    },
    series: [
      { name: 'Fiyat', type: 'candlestick', data: [] },
      {
        name: 'Trend',
        type: 'line',
        data: [],
        color: '#f97316',
      },
    ],
    plotOptions: {
      candlestick: {
        wick: {
          useFillColor: true,
        },
      },
    },
    colors: ['#38bdf8'],
    xaxis: {
      type: 'datetime',
    },
    yaxis: {
      tooltip: {
        enabled: true,
      },
    },
    tooltip: {
      shared: true,
      x: {
        format: 'dd MMM HH:mm',
      },
    },
    theme: {
      mode: 'dark',
    },
  };
}

function updateChart({ candles, trendLine }, symbol, interval) {
  if (!chart) {
    chart = new ApexCharts(document.querySelector('#chart'), buildChartOptions());
    chart.render();
  }

  const candleSeries = candles.map((item) => ({
    x: new Date(item.time),
    y: [item.open, item.high, item.low, item.close],
  }));

  const trendSeries = trendLine.map((point) => ({
    x: new Date(point.x),
    y: point.y,
  }));

  chart.updateSeries([
    { name: 'Fiyat', type: 'candlestick', data: candleSeries },
    { name: 'Trend', type: 'line', data: trendSeries, color: '#f97316' },
  ]);

  setStatus(
    `${symbol} - ${interval.toUpperCase()} | Güncellenme: ${new Date().toLocaleTimeString()}`
  );
}

async function loadData() {
  const symbol = symbolInput.value.trim().toUpperCase();
  const interval = timeframeSelect.value;
  const limit = limitInput.value ? Number(limitInput.value) : 150;

  if (!symbol) {
    setStatus('Lütfen bir coin giriniz.', true);
    return;
  }

  setStatus('Veriler yükleniyor...');
  try {
    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
    const res = await fetch(`/api/klines?${params.toString()}`);
    if (!res.ok) {
      throw new Error('Veriler getirilemedi');
    }
    const data = await res.json();
    if (!data.candles || data.candles.length === 0) {
      setStatus('Seçilen kriterler için veri bulunamadı.', true);
      return;
    }
    updateChart(data, symbol, interval);
  } catch (err) {
    console.error(err);
    setStatus('Veri alınırken bir sorun oluştu.', true);
  }
}

symbolInput.addEventListener('input', (event) => {
  const value = event.target.value.trim();
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => fetchSymbols(value), 250);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  loadData();
});

window.addEventListener('load', () => {
  loadData();
  fetchSymbols(symbolInput.value.trim());
});
