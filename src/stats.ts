export const JEV_PRICE_PER_MTOK = 0.042;

export function costUsd(inputTokens: number, pricePerMTok = JEV_PRICE_PER_MTOK): number {
  return (inputTokens * pricePerMTok) / 1_000_000;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

export function wilson(successes: number, n: number, z = 1.959963984540054): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
