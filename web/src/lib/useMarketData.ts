import { useEffect, useState } from "react";
import { TRADABLE_TOKENS } from "./config";

export interface PricePoint {
  price: number;
  timestamp: number; // seconds
}

export interface MarketData {
  history: PricePoint[]; // oldest first
  price: number | null; // USD per token
  change24hPct: number | null; // change over the last two reference fixings
  loading: boolean;
}

// The reference price is the ECB's daily EUR/USD fixing (via Frankfurter).
// It is shown, and used to suggest a counter amount; it is never enforced:
// each trader's own signed limit price is what the vault enforces.
const REFRESH_MS = 30 * 60_000;
const DAYS = 60;

async function eurUsdHistory(): Promise<PricePoint[]> {
  const from = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const res = await fetch(`https://api.frankfurter.dev/v1/${from}..?from=EUR&to=USD`);
  if (!res.ok) return [];
  const body = (await res.json()) as { rates: Record<string, { USD: number }> };
  return Object.entries(body.rates)
    .map(([d, r]) => ({ price: r.USD, timestamp: Date.parse(`${d}T16:00:00Z`) / 1000 }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function summarize(history: PricePoint[]): MarketData {
  const price = history.length ? history[history.length - 1].price : null;
  const change24hPct =
    history.length >= 2
      ? ((history[history.length - 1].price - history[history.length - 2].price) / history[history.length - 2].price) * 100
      : null;
  return { history, price, change24hPct, loading: false };
}

export function useMarketData(): Record<string, MarketData> {
  const [data, setData] = useState<Record<string, MarketData>>(
    Object.fromEntries(TRADABLE_TOKENS.map((t) => [t.code, { history: [], price: null, change24hPct: null, loading: true }])),
  );

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const eur = await eurUsdHistory().catch(() => []);
      if (cancelled) return;
      const usd = eur.map((p) => ({ price: 1, timestamp: p.timestamp }));
      setData({ EURC: summarize(eur), USDC: summarize(usd) });
    }
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return data;
}

/** One candle per point (daily fixings have no intraday range). */
export function toCandles(history: PricePoint[]) {
  return history.map((p, i) => {
    const open = i ? history[i - 1].price : p.price;
    return { open, close: p.price, high: Math.max(open, p.price), low: Math.min(open, p.price), timestamp: p.timestamp };
  });
}
