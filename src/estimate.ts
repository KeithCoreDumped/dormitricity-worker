import type { SeriesPoint } from "./types.js";

function chargeValue(val: number): number {
    // const charge_values = [25, 50, 75, 100, 150, 200];
    if (val > 225) return val;
    else if (val > 175) return 200;
    else if (val > 125) return 150;
    else if (val > 87.5) return 100;
    else if (val > 62.5) return 75;
    else if (val > 37.5) return 50;
    else if (val > 12.5) return 25;
    else return 0;
}

function removeCharges(recent: SeriesPoint[]): SeriesPoint[] {
    // remove charge events from recent points
    if (!recent.length) return [];

    let current = recent[0]!.kwh;
    let total_charge = 0;
    let res = [recent[0]!];

    for (let { ts, kwh } of recent.slice(1)) {
        let diff = kwh - current;
        current = kwh;
        total_charge += chargeValue(diff);
        res.push({ ts, kwh: kwh - total_charge });
    }
    return res;
}

// function filterRecentPoints(points: SeriesPoint[]): SeriesPoint[] {
//   if (points.length === 0) return [];

//   const lastTs = points[points.length - 1]!.ts;
//   const cutoff = lastTs - 24 * 3600; // last 24 hours

//   const recent = points.filter(p => p.ts >= cutoff);

//   return recent.length >= 5 ? recent : points.slice(-5); // at least 5 points
// }

export function estimate(
    recent: SeriesPoint[]
): { kw: number; r2: number } | null {
    // const recent_filtered = filterRecentPoints(recent);
    const recent_uncharged = removeCharges(recent);
    // return null on insufficient data points
    if (recent_uncharged.length < 2) return null;

    // linear regression of `recent_uncharged` as { ts: number, kwh: number }
    // y = a + b*x
    const n = recent_uncharged.length;
    const sumX = recent_uncharged.reduce((acc, p) => acc + p.ts, 0);
    const sumY = recent_uncharged.reduce((acc, p) => acc + p.kwh, 0);
    const sumXY = recent_uncharged.reduce((acc, p) => acc + p.ts * p.kwh, 0);
    const sumX2 = recent_uncharged.reduce((acc, p) => acc + p.ts * p.ts, 0);

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return null; // every point have the same ts

    const slope = (n * sumXY - sumX * sumY) / denominator; // (kWh / s)

    const intercept = (sumY - slope * sumX) / n;

    // calculate R²
    const meanY = sumY / n;
    let ssRes = 0;
    let ssTot = 0;
    for (const { ts, kwh } of recent_uncharged) {
        const yPred = intercept + slope * ts;
        ssRes += (kwh - yPred) ** 2;
        ssTot += (kwh - meanY) ** 2;
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

    return {
        kw: slope * 3600, // kWh/s → kW
        r2,
    };
}
