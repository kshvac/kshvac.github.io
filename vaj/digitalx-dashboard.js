import { MINUTE, HALF_HOUR, readMarket, readFills, viewWindow, lineSegments } from './digitalx-market.js';

const CLOUD = 'https://d251mfkhswowwo.cloudfront.net/';
const $ = id => document.getElementById(id);
const sideLabel = side => side === 'BUY' ? '매수' : '매도';
const sideColor = side => side === 'BUY' ? '#ff827e' : '#83b8ff';
const formatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const detailFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const timeLabel = time => formatter.format(time);
const fmtPrice = value => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const fmtIndex = value => value.toFixed(6);
const indicatorTitles = { v: 'V30 · 30분 가격 변화', a: 'A30 · V30의 1분 변화', j: 'J30 · A30의 1분 변화' };
const panelColor = { price: '#72d5c2', v: '#7adcc5', a: '#ffd18b', j: '#ec9ac3' };
let coin = 'BTC', interval = HALF_HOUR, hours = 24, key = 'v';
let data = null, fills = [], fillSource = null, plotFocus = null, view = null;
let generation = 0, marketSource = null, marketRefreshing = false, request = null;

async function get(url, parse, parent) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([parent, AbortSignal.timeout(5500)]) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return parse(await response.text());
}
async function getFile(name, parse, signal, needsCopy = () => false) {
  let primary = null;
  const stamp = '?t=' + Date.now();
  try { primary = await get(CLOUD + name + stamp, parse, signal); }
  catch (error) { if (signal.aborted) throw error; }
  if (primary !== null && !needsCopy(primary)) return { data: primary, source: 'feed' };
  try {
    const backup = await get('./data/' + name + stamp, parse, signal);
    if (primary !== null && (backup.at(-1)?.time ?? 0) <= (primary.at(-1)?.time ?? 0)) {
      return { data: primary, source: 'feed' };
    }
    return { data: backup, source: 'backup' };
  } catch (error) {
    if (primary !== null) return { data: primary, source: 'feed' };
    throw error;
  }
}

function status(message, warning = false) {
  $('status').classList.toggle('warn', warning);
  $('status').lastElementChild.textContent = message;
}
function fillStatus(message, warning = false) {
  $('fills-status').classList.toggle('warn', warning);
  $('fills-status').textContent = message;
}
function lastValid(rows) {
  return rows?.findLast(row => row.price !== null);
}

async function load(reset = false) {
  if (marketRefreshing && !reset) return;
  request?.abort();
  request = new AbortController();
  const revision = ++generation, selected = coin, signal = request.signal;
  marketRefreshing = true;
  if (reset || !data) {
    data = null; fills = []; fillSource = null; marketSource = null; plotFocus = null; view = null;
    status(selected + ' · 디지털엑스 데이터 연결 중');
    fillStatus('실제 체결 자료 확인 중');
    render();
  }
  const [marketResult, fillResult] = await Promise.allSettled([
    getFile(selected + '_VAJ_1m.csv', readMarket, signal, rows => Date.now() - lastValid(rows)?.time > 5 * MINUTE),
    getFile(selected + '_fills.csv', readFills, signal),
  ]);
  if (revision !== generation) return;
  marketRefreshing = false;
  if (marketResult.status === 'fulfilled') {
    data = marketResult.value.data;
    marketSource = marketResult.value.source;
    const row = lastValid(data);
    const lag = Math.max(0, Math.floor((Date.now() - row.time) / MINUTE));
    const freshness = lag > 3 ? ' · 가격 게시 지연 ' + (lag >= 60
      ? Math.floor(lag / 60).toLocaleString('ko-KR') + '시간 ' + (lag % 60) + '분'
      : lag + '분') : '';
    status(selected + '/KRW · 최근 확정 가격 ' + timeLabel(row.time) + ' KST' +
      (marketSource === 'backup' ? ' · 게시 보관본' : '') + freshness, lag > 3 || marketSource === 'backup');
  } else if (data) status(selected + ' · 새 가격 조회 실패 · 직전 자료 표시', true);
  else status(selected + ' · 디지털엑스 가격을 불러오지 못했습니다.', true);
  if (fillResult.status === 'fulfilled') {
    fills = fillResult.value.data;
    fillSource = fillResult.value.source;
    const latest = fills.at(-1);
    const notice = latest ? '마지막 확인 체결 ' + detailFormatter.format(latest.time) + ' KST'
      : '체결 파일에 표시할 주문이 없습니다.';
    fillStatus(notice + (fillSource === 'backup' ? ' · 게시 보관본' : '') +
      (fills.length && fills.every(row => row.price === null) ? ' · 시각만 제공' : ''), fillSource === 'backup');
  } else {
    fillStatus(fills.length ? '새 체결 조회 실패 · 직전 체결 표시' : '체결 자료 조회 실패 · 가격과 V30 신호는 표시합니다.', true);
  }
  render();
}

function renderMetrics() {
  const priceRow = lastValid(data);
  const row = data?.at(-1);
  const price = priceRow ? fmtPrice(priceRow.price) + ' 원' : '—';
  const values = [['최근 확정가', price], ...['v', 'a', 'j'].map(id => [
    id.toUpperCase() + '30', row?.[id] == null ? '—' : fmtIndex(row[id]),
  ])];
  $('metrics').replaceChildren(...values.map(([name, value]) => {
    const box = document.createElement('div'); box.className = 'metric';
    const label = document.createElement('small'); label.textContent = name;
    const figure = document.createElement('strong'); figure.textContent = value;
    box.append(label, figure); return box;
  }));
}

function markedEvents() {
  return (view?.events ?? []).filter(event => $(event.side.toLowerCase()).checked &&
    (event.kind === 'fill' || $('signals').checked));
}

function context(id) {
  const canvas = $(id);
  const { width: w, height: h } = canvas.getBoundingClientRect();
  if (!w || !h) return null;
  const density = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * density); canvas.height = Math.round(h * density);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(density, density);
  return { ctx, w, h };
}

function chart(id, points, field, step, events, provisional = null) {
  const surface = context(id);
  if (!surface) return;
  const { ctx, w, h } = surface;
  let lines = lineSegments(points, field, step);
  const indicatePrice = field === 'price';
  if (!view) { $(id + '-empty').hidden = false; return; }
  const candidates = lines.flat().map(point => point.value);
  if (provisional) candidates.push(provisional.price);
  if (indicatePrice) for (const event of events) if (event.kind === 'fill' && event.price !== null) candidates.push(event.price);
  if (!indicatePrice && candidates.length) candidates.push(0);
  $(id + '-empty').hidden = candidates.length > 0;
  const assets = candidates.length ? candidates : [0, 1];
  let lo = Math.min(...assets), hi = Math.max(...assets);
  const pad = Math.max((hi - lo) * .12, Math.max(Math.abs(lo), Math.abs(hi), .000001) * .00012);
  lo -= pad; hi += pad;
  const label = indicatePrice ? fmtPrice : fmtIndex;
  ctx.font = '11px system-ui,sans-serif';
  const labels = Array.from({ length: 5 }, (_, i) => label(hi - (hi - lo) * i / 4));
  const left = Math.max(50, ...labels.map(value => ctx.measureText(value).width + 11));
  const right = w - 10, top = 16, bottom = h - 25;
  const { start, end } = view;
  const x = t => left + (t - start) / (end - start) * (right - left);
  const y = value => bottom - (bottom - top) * (value - lo) / (hi - lo);

  ctx.font = '11px system-ui,sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#a9bed1';
  labels.forEach((text, i) => {
    const yy = top + (bottom - top) * i / 4;
    ctx.fillText(text, left - 5, yy);
    ctx.strokeStyle = '#293a4c'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
  });
  ctx.textBaseline = 'top';
  const ticks = w >= 650 ? 6 : 3;
  for (let i = 0; i < ticks; i++) {
    const t = start + (end - start) * i / (ticks - 1);
    ctx.textAlign = i === 0 ? 'left' : i === ticks - 1 ? 'right' : 'center';
    ctx.fillText(timeLabel(t), x(t), bottom + 8);
  }
  if (!indicatePrice && candidates.length) {
    ctx.strokeStyle = '#a6b6ca'; ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(left, y(0)); ctx.lineTo(right, y(0)); ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.save(); ctx.beginPath(); ctx.rect(left - 1, top - 8, right - left + 2, bottom - top + 9); ctx.clip();
  const ordered = [...events].sort((a, b) => Number(a.kind === 'fill') - Number(b.kind === 'fill'));
  for (const event of ordered) {
    const px = x(event.time);
    ctx.strokeStyle = sideColor(event.side);
    ctx.globalAlpha = event.kind === 'fill' ? .82 : .64;
    ctx.lineWidth = event.kind === 'fill' ? 1.65 : 1.05;
    ctx.setLineDash(event.kind === 'signal' ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;

  ctx.strokeStyle = panelColor[field]; ctx.fillStyle = panelColor[field]; ctx.lineWidth = 2;
  for (const line of lines) {
    if (line.length === 1) {
      ctx.beginPath(); ctx.arc(x(line[0].time), y(line[0].value), 2.9, 0, 2 * Math.PI); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(x(line[0].time), y(line[0].value));
      line.slice(1).forEach(point => ctx.lineTo(x(point.time), y(point.value)));
      ctx.stroke();
    }
  }
  if (provisional) {
    const previous = lines.at(-1)?.at(-1);
    if (previous && provisional.time - previous.time < HALF_HOUR) {
      ctx.setLineDash([2, 5]); ctx.beginPath();
      ctx.moveTo(x(previous.time), y(previous.value)); ctx.lineTo(x(provisional.time), y(provisional.price));
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.beginPath(); ctx.arc(x(provisional.time), y(provisional.price), 3.4, 0, 2 * Math.PI); ctx.fill();
  }

  let lastLabel = -100;
  for (const event of events) {
    const px = x(event.time), ink = sideColor(event.side);
    const at = indicatePrice && event.kind === 'fill' ? event.price : field === 'v' && event.kind === 'signal' ? 0 : null;
    if (at !== null && candidates.length) {
      ctx.beginPath(); ctx.arc(px, y(at), 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = ink; ctx.fill();
    }
    if (indicatePrice && event.kind === 'fill') {
      ctx.beginPath(); ctx.moveTo(px - 3, top - 2); ctx.lineTo(px + 3, top - 2); ctx.lineTo(px, top + 3);
      ctx.closePath(); ctx.fillStyle = ink; ctx.fill();
      if (Math.abs(px - lastLabel) > 28) {
        ctx.font = 'bold 10px system-ui,sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
        ctx.fillText(sideLabel(event.side), Math.min(right - 11, Math.max(left + 11, px)), top + 5);
        lastLabel = px;
      }
    }
  }
  if (plotFocus && events.includes(plotFocus)) {
    const px = x(plotFocus.time);
    ctx.strokeStyle = '#f1f8ff'; ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(px, top - 2); ctx.lineTo(px, bottom); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
}

function draw() {
  const events = markedEvents();
  chart('price', view?.prices ?? [], 'price', interval, events, view?.pending);
  chart('indicator', view?.visible ?? [], key, MINUTE, events);
}

function renderEvents() {
  const list = $('event-list');
  const events = markedEvents().sort((a, b) => b.time - a.time || (a.kind === 'fill' ? -1 : 1));
  $('event-count').textContent = events.length + '건';
  list.replaceChildren();
  if (!events.length) {
    const label = document.createElement('p'); label.className = 'event-empty'; label.textContent = '선택 범위에 표시할 체결 또는 V30 신호가 없습니다.';
    list.append(label); return;
  }
  for (const event of events.slice(0, 24)) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'event ' + event.side.toLowerCase() + ' ' + event.kind;
    button.setAttribute('aria-pressed', String(plotFocus === event));
    const used = event.kind === 'fill' ? '체결' : '신호';
    const eventTime = event.kind === 'fill' ? detailFormatter.format(event.time) : timeLabel(event.time);
    button.textContent = eventTime + ' ' + sideLabel(event.side) + ' ' + used;
    button.title = event.kind === 'fill' && event.price !== null ? '체결가 ' + fmtPrice(event.price) + '원' : button.textContent;
    button.onclick = () => { plotFocus = plotFocus === event ? null : event; renderEvents(); draw(); };
    list.append(button);
  }
  if (events.length > 24) {
    const label = document.createElement('span'); label.className = 'event-empty';
    label.textContent = '최근 24건 표시'; list.append(label);
  }
}

function render() {
  renderMetrics();
  view = data ? viewWindow(data, fills, hours, interval) : null;
  plotFocus = null;
  $('price-title').textContent = '디지털엑스 ' + (interval / MINUTE) + '분 종가';
  $('price-note').textContent = view ? timeLabel(view.start) + ' – ' + timeLabel(view.end) + ' KST · KRW' : '원화(KRW) · 한국시간';
  $('indicator-title').textContent = indicatorTitles[key];
  $('live-key').hidden = !view?.pending;
  renderEvents(); draw();
}

for (const [id, attribute, update] of [
  ['coins', 'coin', value => { if (coin !== value) { coin = value; load(true); } }],
  ['intervals', 'interval', value => { interval = Number(value) * MINUTE; render(); }],
  ['ranges', 'hours', value => { hours = Number(value); render(); }],
  ['indicators', 'key', value => { key = value; render(); }],
]) $(id).onclick = event => {
  const button = event.target.closest('button[data-' + attribute + ']');
  if (!button) return;
  $(id).querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  update(button.dataset[attribute]);
};
for (const id of ['buy', 'sell', 'signals']) $(id).onchange = () => { plotFocus = null; renderEvents(); draw(); };
$('refresh').onclick = () => load();
new ResizeObserver(draw).observe($('price'));
setInterval(() => { if (!document.hidden) load(); }, MINUTE);
load(true);
