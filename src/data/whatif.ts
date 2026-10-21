/**
 * What-if engines. Small, explainable models that sit on top of the learned references
 * and the condition analytics, so a parameter change can be propagated to the dashboards
 * and to the 3D twin instantly.
 */
import { AN, DS, episodes, policyAlerts } from './analytics';
import { hourToDate, key, MACHINES } from './generator';
import { conditionRatio, LIVE_H } from './live';
import { ASSET_KINDS, FEATURES, type AssetKind, type FeatureKey, type Regime, type SensorKind } from './types';
import { CYCLE_S } from '../three/program';

// ============================================================ A. operating point
export type OpParams = { rpm: number; feed: number; bar: number; regime: Exclude<Regime, 'parada' | 'troca'> };
export const OP_DEFAULT: OpParams = { rpm: 12000, feed: 100, bar: 50, regime: 'desbaste' };
export const ISO_LIMIT_RMS = 4.5; // mm/s, alarm zone for the spindle (ISO 10816-3 class II, zone C)

function factors(a: AssetKind, p: OpParams) {
  const r = p.rpm / 12000;
  const f = p.feed / 100;
  const b = p.bar / 50;
  if (a === 'spindle') return { rms: Math.pow(r, 1.6) * (0.55 + 0.45 * f), corrente: (0.3 + 0.7 * f) * Math.pow(r, 0.35), potencia: (0.25 + 0.75 * f) * Math.pow(r, 0.45) };
  if (a === 'bomba-alta-pressao') return { rms: Math.pow(b, 0.8), corrente: Math.pow(b, 1.15), potencia: Math.pow(b, 1.2) };
  return { rms: 1, corrente: 1, potencia: 1 };
}

export type OpAsset = { asset: AssetKind; rms: number; lo: number; hi: number; corrente: number; potencia: number; outOfEnvelope: boolean; condition: number };

export function operatingPoint(machine: string, p: OpParams) {
  const assets: OpAsset[] = ASSET_KINDS.map((a) => {
    const b = AN[key(machine, a)].baselines[p.regime];
    const f = factors(a, p);
    const cond = conditionRatio(machine, a, 'rms');
    const mean = b.ready ? b.mean.rms : DS.series[key(machine, a)].features.rms[LIVE_H];
    const sd = b.ready ? b.std.rms : mean * 0.05;
    const rms = mean * f.rms * cond;
    const lo = (mean - 3 * sd) * f.rms;
    const hi = (mean + 3 * sd) * f.rms;
    const corrente = (b.ready ? b.mean.corrente : 10) * f.corrente * conditionRatio(machine, a, 'corrente');
    const potencia = (b.ready ? b.mean.potencia : 3) * f.potencia * conditionRatio(machine, a, 'potencia');
    return { asset: a, rms, lo, hi, corrente, potencia, outOfEnvelope: rms > hi, condition: cond };
  });
  const finishing = p.regime === 'acabamento';
  const cycle = CYCLE_S * (finishing ? 1.15 : 1) * Math.pow(12000 / p.rpm, 0.5) * Math.pow(100 / p.feed, 0.8);
  const partsPerHour = (3600 / cycle) * 0.94;
  const kw = assets.reduce((s, a) => s + a.potencia, 0) + 6;
  const kwhPerPart = (kw * cycle) / 3600;
  const partsPerTool = 450 * Math.pow(12000 / p.rpm, 3) * Math.pow(100 / p.feed, 1.2);
  const toolCostPart = 380 / partsPerTool;
  const costPerPart = kwhPerPart * 0.78 + toolCostPart;
  const spindle = assets[0];
  return { assets, cycle, partsPerHour, kw, kwhPerPart, partsPerTool, toolCostPart, costPerPart, spindleMargin: (ISO_LIMIT_RMS - spindle.rms) / ISO_LIMIT_RMS };
}

// ============================================================ B. acquisition fault
export type FaultMode = 'desconectado' | 'congelado' | 'ruido' | 'saturacao';
export const FAULT_LABEL: Record<FaultMode, string> = {
  desconectado: 'Cabo desconectado',
  congelado: 'Sensor congelado',
  ruido: 'Ruído elétrico (picos)',
  saturacao: 'Saturação (clipping)',
};
export type FaultParams = { sensor: SensorKind; mode: FaultMode; hours: number; qualification: boolean };
export const FALSE_ALARM_COST = 420; // R$: technician dispatch + inspection stop
export const WINDOW_SPAN = 72;

function windowScore(machine: string, asset: AssetKind, h: number, override: Partial<Record<FeatureKey, number>>) {
  const s = DS.series[key(machine, asset)];
  const b = AN[key(machine, asset)].baselines[s.regime[h]];
  if (!b?.ready || s.regime[h] === 'troca') return NaN;
  let sum = 0;
  let n = 0;
  for (const f of FEATURES) {
    const x = override[f] ?? s.features[f][h];
    if (Number.isNaN(x) || Number.isNaN(b.mean[f])) continue;
    const z = (x - b.mean[f]) / b.std[f];
    sum += z * z;
    n++;
  }
  if (n < 3) return NaN;
  const D = Math.sqrt(sum / n);
  return 1 - Math.exp(-Math.max(0, D - 1.15) / 2.1);
}

export function faultScenario(machine: string, p: FaultParams) {
  const asset: AssetKind = p.sensor === 'eletrica' ? 'spindle' : p.sensor;
  const feat: FeatureKey = p.sensor === 'eletrica' ? 'corrente' : 'rms';
  const s = DS.series[key(machine, asset)];
  const from = LIVE_H - WINDOW_SPAN + 1;
  const start = LIVE_H - p.hours + 1;
  const hours: number[] = [];
  const raw: (number | null)[] = [];
  const seen: (number | null)[] = [];
  const scoreQ = new Float32Array(WINDOW_SPAN).fill(NaN);
  const scoreRaw = new Float32Array(WINDOW_SPAN).fill(NaN);
  let frozenVal = NaN;
  let invalid = 0;
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < WINDOW_SPAN; i++) step(i);
  function step(i: number) {
    const hh = from + i;
    hours.push(hh);
    const x = s.features[feat][hh];
    const faulty = hh >= start;
    let y = x;
    let valid = true;
    if (faulty) {
      if (p.mode === 'desconectado') {
        y = 0;
        valid = false;
      } else if (p.mode === 'congelado') {
        if (Number.isNaN(frozenVal)) frozenVal = s.features[feat][start - 1];
        y = frozenVal;
        valid = false;
      } else if (p.mode === 'ruido') {
        if (rand() < 0.4) {
          y = x * (2.6 + rand() * 1.8);
          valid = false;
        }
      } else if (p.mode === 'saturacao') {
        y = feat === 'rms' ? 9.99 : x * 3;
        valid = false;
      }
    }
    if (!valid) invalid++;
    raw.push(Number.isNaN(x) ? null : +x.toFixed(3));
    seen.push(Number.isNaN(y) ? null : +y.toFixed(3));
    const extra: Partial<Record<FeatureKey, number>> = { [feat]: y };
    if (faulty && p.mode !== 'congelado' && feat === 'rms') {
      extra.kurtosis = p.mode === 'ruido' && y !== x ? 9 : p.mode === 'desconectado' ? 0 : s.features.kurtosis[hh];
      extra.crest = p.mode === 'saturacao' ? 1.0 : p.mode === 'ruido' && y !== x ? 8 : p.mode === 'desconectado' ? 0 : s.features.crest[hh];
    }
    if (faulty && p.mode === 'congelado' && feat === 'rms') {
      extra.kurtosis = s.features.kurtosis[start - 1];
      extra.crest = s.features.crest[start - 1];
    }
    scoreRaw[i] = windowScore(machine, asset, hh, extra);
    scoreQ[i] = valid ? windowScore(machine, asset, hh, {}) : NaN;
  }
  const alertsRaw = policyAlerts(scoreRaw, 0.35, 6);
  const alertsQ = policyAlerts(scoreQ, 0.35, 6);
  const faultFrom = WINDOW_SPAN - p.hours;
  const epRaw = episodes(alertsRaw.slice(faultFrom), 0);
  const epQ = episodes(alertsQ.slice(faultFrom), 0);
  const baselineAlarm = AN[key(machine, asset)].status[start - 1] === 'atencao' || AN[key(machine, asset)].status[start - 1] === 'critico';
  const alertActiveRaw = alertsRaw[WINDOW_SPAN - 1] === 1;
  const falseAlarms = baselineAlarm ? 0 : Math.max(epRaw.count, alertActiveRaw && p.mode !== 'congelado' ? 1 : 0);
  // a frozen sensor on a degrading asset hides the real evolution (blind spot)
  const masked = p.mode === 'congelado' && (baselineAlarm || AN[key(machine, asset)].ewma[LIVE_H] > 0.3);
  return {
    hours,
    raw,
    seen,
    scoreRaw,
    scoreQ,
    alertsRaw,
    alertsQ,
    falseAlarms: p.qualification ? 0 : falseAlarms,
    falseAlarmsIfOff: falseAlarms,
    qEpisodes: epQ.count,
    validPct: 1 - (p.qualification ? invalid : 0) / WINDOW_SPAN,
    blindHours: p.hours,
    masked,
    asset,
    feat,
    alertNowRaw: alertActiveRaw,
  };
}

// ============================================================ C. degradation projection
export type FailureMode = 'rolamento' | 'desbalanceamento' | 'cavitacao';
export const FAILURE_LABEL: Record<FailureMode, string> = {
  rolamento: 'Desgaste de rolamento',
  desbalanceamento: 'Desbalanceamento',
  cavitacao: 'Cavitação',
};
export type Rate = 'lenta' | 'moderada' | 'rapida';
export const RATE_LABEL: Record<Rate, string> = { lenta: 'Lenta', moderada: 'Moderada', rapida: 'Rápida' };
export type ProjParams = { machine: string; asset: AssetKind; mode: FailureMode; rate: Rate; threshold: number; window: number; horizon: number };
export const FUNCTIONAL_FAILURE = 0.95;
const K: Record<Rate, number> = { lenta: 0.05, moderada: 0.11, rapida: 0.25 };
const P: Record<FailureMode, number> = { rolamento: 1.35, desbalanceamento: 1.0, cavitacao: 1.15 };

export function projScore(e0: number, k: number, p: number, d: number) {
  return 1 - (1 - e0) * Math.exp(-k * Math.pow(Math.max(0, d), p));
}
function crossDay(e0: number, k: number, p: number, level: number) {
  if (e0 >= level) return 0;
  // solve 1-(1-e0)exp(-k d^p) = level
  const d = Math.pow(-Math.log((1 - level) / (1 - e0)) / k, 1 / p);
  return d;
}

export function projection(pp: ProjParams) {
  const an = AN[key(pp.machine, pp.asset)];
  const e0 = Math.max(0.03, Number.isNaN(an.ewma[LIVE_H]) ? 0.03 : an.ewma[LIVE_H]);
  const k = K[pp.rate];
  const p = P[pp.mode];
  const days = Array.from({ length: 31 }, (_, d) => d);
  const mid = days.map((d) => projScore(e0, k, p, d));
  const lo = days.map((d) => projScore(e0, k * 0.65, p, d));
  const hi = days.map((d) => projScore(e0, k * 1.5, p, d));
  const failDay = crossDay(e0, k, p, FUNCTIONAL_FAILURE);
  const failEarly = crossDay(e0, k * 1.5, p, FUNCTIONAL_FAILURE);
  const failLate = crossDay(e0, k * 0.65, p, FUNCTIONAL_FAILURE);
  // alert under the chosen policy: history first, then projection
  const flags = policyAlerts(an.score, pp.threshold, pp.window);
  const ep = episodes(flags, LIVE_H - 24 * 21);
  let alertHour = ep.first >= 0 ? ep.first : -1;
  if (alertHour < 0) {
    const d = crossDay(e0, k, p, pp.threshold);
    alertHour = LIVE_H + Math.ceil(d * 24 + pp.window);
  }
  const leadDays = failDay + (LIVE_H - alertHour) / 24;
  // false alarms of the same policy across the fleet, last 30 days, excluding the true event
  let falseAlarms = 0;
  for (const m of MACHINES)
    for (const a of ASSET_KINDS) {
      if (m.id === 'G300-01' && a === 'bomba-hidraulica') continue;
      falseAlarms += episodes(policyAlerts(AN[key(m.id, a)].score, pp.threshold, pp.window), LIVE_H - 24 * 30).count;
    }
  const atHorizon = projScore(e0, k, p, pp.horizon);
  return { e0, days, mid, lo, hi, failDay, failEarly, failLate, alertHour, leadDays, falseAlarms, atHorizon };
}

// ============================================================ D. maintenance decision
export type CostParams = { marginHour: number; plannedH: number; plannedCost: number; correctiveH: number; correctiveCost: number; prepDays: number };
export const COST_DEFAULT: CostParams = { marginHour: 3200, plannedH: 6, plannedCost: 4800, correctiveH: 30, correctiveCost: 22500, prepDays: 2 };

function normCdf(x: number) {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const pr = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - pr : pr;
}

export function dayInfo(d: number) {
  const date = new Date(hourToDate(LIVE_H + d * 24).getTime() - 3 * 3600_000);
  return { sunday: date.getUTCDay() === 0, dow: date.getUTCDay(), label: `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}` };
}

export function decision(failDay: number, failEarly: number, failLate: number, c: CostParams, maxDay = 21) {
  const median = Math.max(0.5, failDay);
  const sigma = Math.max(0.15, Math.log(Math.max(failLate, median + 0.1) / Math.max(0.3, failEarly)) / 2.6);
  const pFail = (d: number) => (d <= 0 ? 0 : normCdf(Math.log(d / median) / sigma));
  const corrective = c.correctiveH * c.marginHour + c.correctiveCost;
  const rows = Array.from({ length: maxDay + 1 }, (_, d) => {
    const info = dayInfo(d);
    const planned = (info.sunday ? 0 : c.plannedH * c.marginHour) + c.plannedCost;
    const p = pFail(d + 0.5);
    const feasible = d >= c.prepDays;
    return { d, ...info, p, planned, feasible, expected: p * corrective + (1 - p) * planned };
  });
  const options = rows.filter((r) => r.feasible);
  const best = options.reduce((a, b) => (b.expected < a.expected ? b : a), options[0]);
  return { rows, best, corrective };
}
