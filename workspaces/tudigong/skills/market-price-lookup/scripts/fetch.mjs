#!/usr/bin/env node
// East Money price fetcher for the market-price-lookup skill.
// Works for ANY instrument East Money serves — A-shares, HK/US stocks, ETFs,
// funds, indices, sector boards, bonds, etc. — by resolving a name/code to its
// full secid via the suggest API, then reading the quote or K-line. No API key
// and no third-party dependency; uses the Node built-in fetch only. All calls go
// through the machine-global rate limiter in ./rate-limiter.mjs.
//
// quote falls back to the latest daily close (kline, a steadier host) when the
// real-time endpoint is unavailable, so a congested quote host still yields data.
//
// Usage:
//   node fetch.mjs resolve <query> [count]       -> candidate instruments + their secid
//   node fetch.mjs quote   <secid|query>         -> real-time quote (falls back to daily close)
//   node fetch.mjs kline   <secid|query> [lmt] [klt]
// Examples:
//   node fetch.mjs resolve 贵州茅台
//   node fetch.mjs quote 1.600519
//   node fetch.mjs quote 苹果
//   node fetch.mjs kline 100.KS11 6

import { reserveSlot } from './rate-limiter.mjs';

function intEnv(key, def) {
  const n = parseInt(process.env[key] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// East Money hosts get slow (not dead) while recovering from a throttle, so the
// timeout is generous. One gentle retry (MAX_ATTEMPTS) covers transient socket
// resets; the quote path additionally falls back from realtime to daily-close.
const TIMEOUT_MS = intEnv('EM_TIMEOUT_MS', 20000);
const MAX_ATTEMPTS = intEnv('EM_MAX_ATTEMPTS', 2);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const REFERER = 'https://quote.eastmoney.com/';
// Public frontend token baked into East Money's own web client — not a secret.
const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

// A full secid looks like "<market>.<code>", e.g. "1.600519", "100.KS11".
function isSecid(s) {
  return /^\d+\.[A-Za-z0-9]+$/.test(String(s || ''));
}

// Rate-limited JSON GET. attempts>1 gives gentle retries on transient failure.
async function emGet(url, attempts = MAX_ATTEMPTS) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    await reserveSlot();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: REFERER }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Resolve a free-text name or code to candidate instruments (any market/type).
async function resolve(query, count = 6) {
  const url =
    'https://searchapi.eastmoney.com/api/suggest/get' +
    `?input=${encodeURIComponent(query)}&type=14&token=${SUGGEST_TOKEN}&count=${count}` +
    '&markettype=&securitytype=&classify=';
  const json = await emGet(url);
  const data = (json && json.QuotationCodeTable && json.QuotationCodeTable.Data) || [];
  return data
    .map((it) => ({ secid: it.QuoteID, code: it.Code, name: it.Name, type: it.SecurityTypeName, market: it.MarketType }))
    .filter((x) => x.secid);
}

// Turn a secid-or-query into { secid, resolved, alternatives }. When a bare query
// resolves to several hits, the caller gets alternatives so it can catch a wrong
// auto-pick (e.g. "KS11" whose top hit is a bond, not the index).
async function toSecid(input) {
  if (isSecid(input)) return { secid: input, resolved: null, alternatives: [] };
  const cands = await resolve(input, 6);
  if (!cands.length) return { secid: null, resolved: null, alternatives: [] };
  return { secid: cands[0].secid, resolved: cands[0], alternatives: cands.slice(1) };
}

async function quote(input) {
  const { secid, resolved, alternatives } = await toSecid(input);
  if (!secid) return notFound(input);

  // 1) Real-time quote (push2). One attempt — on any failure fall back to kline.
  try {
    const url =
      'https://push2.eastmoney.com/api/qt/stock/get' +
      `?invt=2&fltt=2&secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170`;
    const json = await emGet(url, 1); // one shot — fall straight to the kline fallback on failure
    const d = json && json.data;
    if (d && d.f43 != null) {
      return {
        ok: true, mode: 'quote', source: 'realtime', secid,
        code: d.f57, name: d.f58, type: resolved && resolved.type,
        price: d.f43, open: d.f46, high: d.f44, low: d.f45, prevClose: d.f60,
        change: d.f169, changePct: d.f170, volume: d.f47, amount: d.f48,
        resolved, alternatives,
      };
    }
  } catch (e) {
    // fall through to the daily-close fallback below
  }

  // 2) Fallback: latest daily close from kline (push2his — a steadier host).
  try {
    const kd = await klineData(secid, 2, 101);
    if (kd && kd.bars.length) {
      const last = kd.bars[kd.bars.length - 1];
      const prev = kd.bars.length > 1 ? kd.bars[kd.bars.length - 2] : null;
      return {
        ok: true, mode: 'quote', source: 'daily-close', stale: true, secid,
        name: kd.name || (resolved && resolved.name), type: resolved && resolved.type,
        asOf: last.date, price: last.close, open: last.open, high: last.high, low: last.low,
        prevClose: prev ? prev.close : null, change: last.change, changePct: last.changePct,
        volume: last.volume,
        note: '实时报价源暂时不可用，此为最近一个交易日的收盘数据（非实时），回答时请据实说明。',
        resolved, alternatives,
      };
    }
  } catch (e) {
    // both endpoints failed
  }

  return {
    ok: false, secid, resolved, reason: 'no-data',
    hint: `实时(push2)与日K(push2his)都拿不到 secid=${secid} 的数据（可能被限流/拥堵，或该标的不支持此接口）。稍后再试，别臆测数字。`,
  };
}

async function kline(input, lmt = 6, klt = 101) {
  const { secid, resolved, alternatives } = await toSecid(input);
  if (!secid) return notFound(input);
  const kd = await klineData(secid, lmt, klt);
  if (!kd) return noData(secid, resolved);
  return { ok: true, mode: 'kline', secid, name: kd.name, type: resolved && resolved.type, bars: kd.bars, resolved, alternatives };
}

// Fetch + parse K-line bars for a secid. Returns { name, bars } or null.
async function klineData(secid, lmt = 6, klt = 101, attempts = MAX_ATTEMPTS) {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    `?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6` +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    `&klt=${klt}&fqt=1&end=20500101&lmt=${lmt}`;
  const json = await emGet(url, attempts);
  const d = json && json.data;
  if (!d || !Array.isArray(d.klines) || d.klines.length === 0) return null;
  return { name: d.name, bars: d.klines.map(parseBar) };
}

// One K-line row: "date,open,close,high,low,volume,amount,amplitude%,changePct%,change,turnover%".
function parseBar(line) {
  const p = String(line).split(',');
  return {
    date: p[0],
    open: num(p[1]),
    close: num(p[2]),
    high: num(p[3]),
    low: num(p[4]),
    volume: num(p[5]),
    amount: num(p[6]),
    amplitudePct: num(p[7]),
    changePct: num(p[8]),
    change: num(p[9]),
    turnoverPct: num(p[10]),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The name/code matched nothing in East Money's search.
function notFound(query) {
  return {
    ok: false,
    query,
    reason: 'not-found',
    hint:
      `East Money 搜不到「${query}」对应的标的。请换个名称或代码，或先用 resolve 模式列候选。` +
      '注意：韩国半导体指数（KRXSEM）East Money / yfinance / FinanceDatabase 均无收录，' +
      '只能改答 KOSPI（用 100.KS11）或引导用户到 Investing.com，切勿臆测数字。',
  };
}

// Resolved to a secid but the endpoint returned nothing.
function noData(secid, resolved) {
  return {
    ok: false,
    secid,
    resolved,
    reason: 'no-data',
    hint: `secid=${secid} 在 East Money 行情接口查无数据（该标的可能不支持此接口，或代码需人工核对）。别臆测数字。`,
  };
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  const [mode, query, arg3, arg4] = process.argv.slice(2);
  try {
    if (mode === 'resolve') {
      if (!query) throw new Error('用法：fetch.mjs resolve <query> [count]');
      print({ ok: true, mode: 'resolve', query, candidates: await resolve(query, Number(arg3) || 6) });
    } else if (mode === 'quote') {
      if (!query) throw new Error('用法：fetch.mjs quote <secid|query>');
      print(await quote(query));
    } else if (mode === 'kline') {
      if (!query) throw new Error('用法：fetch.mjs kline <secid|query> [lmt] [klt]');
      print(await kline(query, Number(arg3) || 6, Number(arg4) || 101));
    } else {
      throw new Error('用法：fetch.mjs resolve|quote|kline <query> ...');
    }
  } catch (e) {
    // Network failure / timeout / bad input all funnel here so the caller always
    // receives structured JSON instead of a stack trace.
    print({ ok: false, reason: 'error', message: String((e && e.message) || e) });
    process.exitCode = 1;
  }
}

main();
