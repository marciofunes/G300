/**
 * Condition analytics, kept deliberately simple and explainable:
 *  - normal behaviour: baseline per (machine, asset, regime) from clean windows only
 *  - anomalies: z-scores vs baseline, score, EWMA, persistence, priority
 */
import { generate, HOURS, key, MACHINES, MAINTENANCE_WINDOW, type Dataset } from './generator';
import {
  ASSET_KINDS,
  FEATURES,
  type AssetAnalytics,
  type AssetKind,
  type Baseline,
  type FeatureKey,
  type Regime,
  type Status,
} from './types';

export const SCORE_ATTENTION = 0.35;
export const SCORE_CRITICAL = 0.65;
export const PERSIST_WINDOW = 12;

export type AlertPolicy = { attention: number; critical: number; persist: number; minFraction: number };
export const DEFAULT_POLICY: AlertPolicy = { attention: SCORE_ATTENTION, critical: SCORE_CRITICAL, persist: PERSIST_WINDOW, minFraction: 0.4 };
export const BASELINE_MIN = 40;

const ANALYZED: Regime[] = ['desbaste', 'acabamento', 'parada'];

function emptyBaseline(): Baseline {
  const z = Object.fromEntries(FEATURES.map((f) => [f, NaN])) as Record<FeatureKey, number>;
  return { mean: { ...z }, std: { ...z }, count: 0, ready: false };
}

export function computeBaseline(
  ds: Dataset,
  machine: string,
  asset: AssetKind,
  regime: Regime,
  from: number,
  to: number,
  includeDirty = false,
): Baseline {
  const s = ds.series[key(machine, asset)];
  const vals: Record<FeatureKey, number[]> = Object.fromEntries(FEATURES.map((f) => [f, []])) as any;
  let count = 0;
  for (let h = from; h < Math.min(to, HOURS); h++) {
    if (s.regime[h] !== regime) continue;
    const ok = s.clean[h] || (includeDirty && s.dirtyReason[h] === 'Intervenção em andamento');
    if (!ok) continue;
    count++;
    for (const f of FEATURES) if (!Number.isNaN(s.features[f][h])) vals[f].push(s.features[f][h]);
  }
  const b = emptyBaseline();
  b.count = count;
  for (const f of FEATURES) {
    const v = vals[f];
    if (v.length < 5) continue;
    const mean = v.reduce((a, x) => a + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (v.length - 1));
    b.mean[f] = mean;
    // floor the deviation so near-constant signals do not explode the z-score
    b.std[f] = Math.max(sd, Math.abs(mean) * 0.02, 0.01);
  }
  b.ready = count >= BASELINE_MIN;
  return b;
}

export function analyzeAsset(
  ds: Dataset,
  machine: string,
  asset: AssetKind,
  policy: AlertPolicy = DEFAULT_POLICY,
  override?: Record<Regime, Baseline>,
): AssetAnalytics {
  const m = MACHINES.find((x) => x.id === machine)!;
  const s = ds.series[key(machine, asset)];
  const q = ds.quality[key(machine, asset)];
  const baselines = override ?? ({} as Record<Regime, Baseline>);
  if (!override)
    for (const r of ['desbaste', 'acabamento', 'parada', 'troca'] as Regime[]) {
      baselines[r] = r === 'troca' ? emptyBaseline() : computeBaseline(ds, machine, asset, r, m.refStart, m.refEnd);
    }
  const score = new Float32Array(HOURS).fill(NaN);
  const ewma = new Float32Array(HOURS).fill(NaN);
  const persistence = new Float32Array(HOURS).fill(0);
  const z = Object.fromEntries(FEATURES.map((f) => [f, new Float32Array(HOURS).fill(NaN)])) as Record<FeatureKey, Float32Array>;
  const status: Status[] = [];
  let e = NaN;
  const recent: number[] = [];
  for (let h = 0; h < HOURS; h++) {
    const r = s.regime[h];
    const b = baselines[r];
    if (h >= m.startHour && q[h].valid && b.ready && ANALYZED.includes(r) && s.dirtyReason[h] !== 'Intervenção em andamento') {
      let sum = 0;
      let n = 0;
      for (const f of FEATURES) {
        const x = s.features[f][h];
        if (Number.isNaN(x) || Number.isNaN(b.mean[f])) continue;
        const zz = (x - b.mean[f]) / b.std[f];
        z[f][h] = zz;
        sum += zz * zz;
        n++;
      }
      if (n >= 3) {
        const D = Math.sqrt(sum / n);
        const sc = 1 - Math.exp(-Math.max(0, D - 1.15) / 2.1);
        score[h] = sc;
        e = Number.isNaN(e) ? sc : 0.7 * e + 0.3 * sc;
        recent.push(sc >= policy.attention ? 1 : 0);
        if (recent.length > policy.persist) recent.shift();
      }
    }
    ewma[h] = e;
    persistence[h] = recent.length ? recent.reduce((a, x) => a + x, 0) / recent.length : 0;
    const readyCount = ANALYZED.filter((rr) => baselines[rr].ready).length;
    let st: Status;
    if (h < m.startHour || readyCount === 0 || Number.isNaN(e)) st = 'sem-referencia';
    else if (e >= policy.critical && persistence[h] >= Math.max(0.5, policy.minFraction)) st = 'critico';
    else if (e >= policy.attention && persistence[h] >= policy.minFraction) st = 'atencao';
    else st = 'normal';
    status.push(st);
  }
  return { score, ewma, persistence, status, z, baselines };
}

export type Analytics = Record<string, AssetAnalytics>;

export function analyze(ds: Dataset): Analytics {
  const out: Analytics = {};
  for (const m of MACHINES) for (const a of ASSET_KINDS) out[key(m.id, a)] = analyzeAsset(ds, m.id, a);
  return out;
}

// ---------- helpers used by the screens ----------
export const DS = generate();
export const AN = analyze(DS);

/** v1.1 of G300-01 hydraulic pump reference: built before the maintenance windows were marked dirty. */
export function contaminatedBaseline(regime: Regime) {
  return computeBaseline(DS, 'G300-01', 'bomba-hidraulica', regime, 0, MAINTENANCE_WINDOW[1] + 40, true);
}

/** Same asset analysed with the reference that wrongly absorbed the maintenance windows. */
export const AN_CONTAMINATED = (() => {
  const b = {} as Record<Regime, Baseline>;
  for (const r of ['desbaste', 'acabamento', 'parada'] as Regime[]) b[r] = contaminatedBaseline(r);
  b.troca = emptyBaseline();
  return analyzeAsset(DS, 'G300-01', 'bomba-hidraulica', DEFAULT_POLICY, b);
})();

/**
 * Re-evaluates the alert policy on the stored window scores.
 * Returns per-hour alert flag for a threshold and a persistence window.
 */
export function policyAlerts(scores: Float32Array, threshold: number, window: number, minFraction = 0.4) {
  const out = new Uint8Array(scores.length);
  let e = NaN;
  const recent: number[] = [];
  for (let h = 0; h < scores.length; h++) {
    const sc = scores[h];
    if (!Number.isNaN(sc)) {
      e = Number.isNaN(e) ? sc : 0.7 * e + 0.3 * sc;
      recent.push(sc >= threshold ? 1 : 0);
      if (recent.length > window) recent.shift();
    }
    const frac = recent.length ? recent.reduce((a, x) => a + x, 0) / recent.length : 0;
    out[h] = !Number.isNaN(e) && e >= threshold && frac >= minFraction && recent.length >= Math.min(window, 3) ? 1 : 0;
  }
  return out;
}

export function episodes(flags: Uint8Array, from = 0) {
  let n = 0;
  let first = -1;
  for (let h = Math.max(1, from); h < flags.length; h++) {
    if (flags[h] && !flags[h - 1]) {
      n++;
      if (first < 0) first = h;
    }
  }
  return { count: n, first };
}

export function qualityConfidence(machine: string, asset: string, h: number, span = 24) {
  const q = DS.quality[key(machine, asset)];
  let ok = 0;
  let n = 0;
  for (let i = Math.max(0, h - span + 1); i <= h; i++) {
    n++;
    if (q[i].valid) ok++;
  }
  return n ? ok / n : 0;
}

export function recentEvents(machine: string, asset: AssetKind, h: number, span = 168) {
  const a = AN[key(machine, asset)];
  let count = 0;
  let prev = false;
  for (let i = Math.max(0, h - span); i <= h; i++) {
    const hi = !Number.isNaN(a.score[i]) && a.score[i] >= 0.5;
    if (hi && !prev) count++;
    prev = hi;
  }
  return count;
}

export type QueueItem = {
  machine: string;
  asset: AssetKind;
  status: Status;
  score: number;
  persistence: number;
  confidence: number;
  priority: number;
  reason: string;
  trend: number;
};

export function trendPct(machine: string, asset: AssetKind, h: number) {
  // RMS relative to baseline mean of its regime, last 7 days vs previous 7 days
  const s = DS.series[key(machine, asset)];
  const a = AN[key(machine, asset)];
  const avg = (from: number, to: number) => {
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, from); i < to; i++) {
      const b = a.baselines[s.regime[i]];
      if (!b?.ready || !s.clean[i]) continue;
      sum += s.features.rms[i] / b.mean.rms;
      n++;
    }
    return n ? sum / n : NaN;
  };
  const now = avg(h - 167, h + 1);
  const before = avg(h - 335, h - 167);
  return (now - before) * 100;
}

export function queueAt(h: number, machineFilter?: string): QueueItem[] {
  const items: QueueItem[] = [];
  for (const m of MACHINES) {
    if (machineFilter && machineFilter !== m.id) continue;
    for (const asset of ASSET_KINDS) {
      const a = AN[key(m.id, asset)];
      const st = a.status[h];
      if (st === 'sem-referencia') continue;
      const score = a.ewma[h];
      const persistence = a.persistence[h];
      const confidence = qualityConfidence(m.id, asset, h);
      const ev = recentEvents(m.id, asset, h);
      const trend = trendPct(m.id, asset, h);
      let reason = '';
      if (st === 'critico' || st === 'atencao') reason = persistence > 0.6 ? 'Desvio persistente' : 'Desvio intermitente';
      else if (ev >= 2) reason = `Evento recorrente (${ev} em 7 dias)`;
      else if (trend > 4) reason = 'Tendência crescente';
      else continue;
      const severity = Math.max(score, ev >= 2 ? 0.3 : 0, trend > 4 ? 0.2 : 0);
      const priority = Math.round(100 * severity * Math.max(persistence, ev >= 2 ? 0.35 : 0.2) * confidence);
      items.push({ machine: m.id, asset, status: st, score, persistence, confidence, priority, reason, trend });
    }
  }
  return items.sort((x, y) => y.priority - x.priority);
}

export function contributions(machine: string, asset: AssetKind, h: number, span = 6) {
  const a = AN[key(machine, asset)];
  const acc = Object.fromEntries(FEATURES.map((f) => [f, 0])) as Record<FeatureKey, number>;
  let total = 0;
  for (let i = Math.max(0, h - span + 1); i <= h; i++) {
    for (const f of FEATURES) {
      const v = a.z[f][i];
      if (Number.isNaN(v)) continue;
      acc[f] += v * v;
      total += v * v;
    }
  }
  const out = {} as Record<FeatureKey, number>;
  for (const f of FEATURES) out[f] = total ? acc[f] / total : 0;
  return out;
}

export function latestZ(machine: string, asset: AssetKind, h: number) {
  const a = AN[key(machine, asset)];
  const out = {} as Record<FeatureKey, number>;
  for (const f of FEATURES) {
    let v = NaN;
    for (let i = h; i >= Math.max(0, h - 12); i--) {
      if (!Number.isNaN(a.z[f][i])) {
        v = a.z[f][i];
        break;
      }
    }
    out[f] = v;
  }
  return out;
}

export function healthIndex(machine: string, asset: AssetKind, h: number) {
  const e = AN[key(machine, asset)].ewma[h];
  return Number.isNaN(e) ? NaN : Math.round(100 * (1 - e));
}

export function firstHourWithStatus(machine: string, asset: AssetKind, wanted: Status[]) {
  const a = AN[key(machine, asset)];
  return a.status.findIndex((s) => wanted.includes(s));
}
