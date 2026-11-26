export const MINUTE = 60_000;
export const HALF_HOUR = 30 * MINUTE;
export const trusted = new Set(['ACTUAL', 'VERIFIED_NO_TRADE']);

function csv(text) {
  const records = [];
  let row = [], field = '', quoted = false;
  const body = text.replace(/^\uFEFF/, '');
  for (let i = 0; i <= body.length; i++) {
    const char = i === body.length ? '\n' : body[i];
    if (quoted) {
      if (i === body.length) throw new Error('CSV 따옴표 형식 오류');
      if (char === '"' && body[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = '';
      if (char !== ',') {
        if (row.some(v => v.trim())) records.push(row);
        row = [];
        if (char === '\r' && body[i + 1] === '\n') i++;
      }
    } else if (char === '"' && !field) quoted = true;
    else field += char;
  }
  const headers = (records.shift() ?? []).map(s => s.trim());
  return { headers, rows: records.filter(row => row.length === headers.length)
    .map(row => Object.fromEntries(headers.map((header, i) => [header, row[i]]))) };
}

const num = input => typeof input === 'string' && input.trim() ? Number(input.trim()) : NaN;

function timestamp(row) {
  const raw = num(row.timestamp);
  if (Number.isFinite(raw)) return raw < 1e11 ? raw * 1000 : raw;
  const value = row.time_utc || row.filled_at;
  return value && /(?:Z|[+-][0-9:]{4,5})$/i.test(value) ? Date.parse(value) : NaN;
}

export function readMarket(text, now = Date.now()) {
  const { headers, rows } = csv(text);
  if (!headers.includes('source') || !headers.includes('close') ||
      !headers.some(h => h === 'quality' || h === 'actual')) throw new Error('디지털엑스 분봉 열이 없습니다.');
  const input = new Map();
  for (const row of rows) {
    const time = timestamp(row), price = num(row.close);
    if (row.source?.trim().toUpperCase() !== 'DIGITALX' || !Number.isFinite(time) ||
        time % MINUTE || time + MINUTE > now || !(price > 0)) continue;
    const checkedStamp = row.time_utc ? timestamp({ time_utc: row.time_utc.trim() }) : time;
    if (checkedStamp !== time) continue;
    const prev = input.get(time);
    const valid = row.quality ? trusted.has(row.quality.trim().toUpperCase()) : row.actual === '1';
    if (prev?.conflict) continue;
    if (!prev || (!prev.valid && valid)) input.set(time, { time, price, valid });
    else if (valid && prev.valid && price !== prev.price) input.set(time, { time, price, valid: false, conflict: true });
  }
  const keys = [...input.keys()].sort((a, b) => a - b);
  if (!keys.length) throw new Error('확정 디지털엑스 분봉이 없습니다.');
  if (!keys.some(time => input.get(time).valid)) throw new Error('검증된 디지털엑스 가격이 없습니다.');
  const derived = new Map();
  const output = keys.map(open => {
    const current = input.get(open);
    const back = input.get(open - HALF_HOUR);
    const previous = derived.get(open - MINUTE);
    const v = current.valid && back?.valid
      ? (current.price === back.price ? 0 : Math.log(current.price) - Math.log(back.price)) : null;
    const a = v !== null && previous?.v != null ? v - previous.v : null;
    const j = a !== null && previous?.a != null ? a - previous.a : null;
    const side = a === null ? null
      : previous.v <= 0 && v >= 0 && v > previous.v ? 'BUY'
      : previous.v > 0 && v <= 0 ? 'SELL' : null;
    const value = { time: open + MINUTE, price: current.valid ? current.price : null, v, a, j, side };
    derived.set(open, value);
    return value;
  });
  return output;
}

export function readFills(text) {
  const { headers, rows } = csv(text);
  if (!headers.includes('side') || !headers.some(h => ['timestamp', 'time_utc', 'filled_at'].includes(h)))
    throw new Error('체결 CSV에 시각 또는 매매 구분이 없습니다.');
  return rows.map(row => {
    const time = timestamp(row), side = row.side.trim().toUpperCase();
    const price = num(row.price ?? row.filled_price);
    return { time, side, price: price > 0 ? price : null, kind: 'fill' };
  }).filter(row => Number.isFinite(row.time) && ['BUY', 'SELL'].includes(row.side))
    .sort((a, b) => a.time - b.time);
}

export function viewWindow(market, fills, hours, interval, now = Date.now()) {
  const last = market.at(-1)?.time ?? 0;
  const lastFill = fills.at(-1)?.time ?? 0;
  const end = Math.max(last, Math.min(lastFill, now));
  const start = end - hours * 60 * MINUTE;
  const visible = market.filter(row => row.time >= start && row.time <= end);
  const prices = interval === MINUTE ? visible : visible.filter(row => row.time % HALF_HOUR === 0);
  const live = interval === HALF_HOUR ? visible.findLast(row => row.price !== null) : null;
  const pending = live && live.time > Math.floor(last / HALF_HOUR) * HALF_HOUR ? live : null;
  const signals = visible.filter(row => row.side !== null).map(row => ({
    time: row.time, side: row.side, price: row.price, kind: 'signal',
  }));
  const events = [...fills.filter(row => row.time >= start && row.time <= end), ...signals];
  return { start, end, prices, visible, pending, events };
}

export function lineSegments(rows, key, interval) {
  const lines = [];
  let line = [], previous = null;
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined || !Number.isFinite(value) ||
        (previous !== null && row.time - previous !== interval)) {
      if (line.length) lines.push(line);
      line = [];
    }
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      line.push({ time: row.time, value });
      previous = row.time;
    } else previous = null;
  }
  if (line.length) lines.push(line);
  return lines;
}
