/**
 * Live telemetry: one sample per second per asset, derived from the current operating
 * regime, the asset condition and the machining program phase (the same program the 3D
 * twin is executing, so signals and animation stay in sync).
 */
import { AN, DS } from './analytics';
import { HOURS, hourToDate, key, MACHINES } from './generator';
import { ASSET_KINDS, type AssetKind } from './types';
import { CYCLE_S, phaseAt, programTime, type Phase } from '../three/program';

export const LIVE_H = HOURS - 1;
export const BUFFER_S = 180;

export type LiveEvent = { id: number; t: number; machine: string; kind: 'ciclo' | 'troca' | 'alerta' | 'dados' | 'info'; text: string };

type Ring = { v: Float64Array; i: number; n: number };
const ring = (): Ring => ({ v: new Float64Array(BUFFER_S).fill(NaN), i: 0, n: 0 });
const push = (r: Ring, x: number) => {
  r.v[r.i] = x;
  r.i = (r.i + 1) % BUFFER_S;
  r.n = Math.min(BUFFER_S, r.n + 1);
};
export function ringValues(r: Ring) {
  const out: number[] = [];
  for (let k = 0; k < BUFFER_S; k++) out.push(r.v[(r.i + k) % BUFFER_S]);
  return out;
}

const rms: Record<string, Ring> = {};
const current: Record<string, Ring> = {};
const power: Record<string, Ring> = {};
const lastValue: Record<string, number> = {};
const latest: Record<string, { rms: number; corrente: number; potencia: number }> = {};
export const liveTimes: Ring = ring();
export const events: LiveEvent[] = [];
let evId = 0;
let lastSec = 0;
const lastPhase: Record<string, Phase> = {};
const TOOLS = ['T03', 'T07', 'T12', 'T15', 'T21', 'T04'];
const cycleCount: Record<string, number> = {};

function gauss(seed: number) {
  // deterministic-ish noise from a seed (fast, good enough for telemetry jitter)
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  const y = Math.sin(seed * 78.233) * 12345.678;
  const u = Math.max(1e-6, x - Math.floor(x));
  const v = y - Math.floor(y);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function phaseFactor(phase: Phase, asset: AssetKind) {
  if (asset === 'spindle') return phase === 'corte' ? 1 : phase === 'troca' ? 0.35 : 0.55;
  if (asset === 'bomba-alta-pressao') return phase === 'corte' ? 1 : 0.4;
  if (asset === 'bomba-refrigeracao') return phase === 'troca' ? 0.85 : 1;
  return 1;
}

export function conditionRatio(machine: string, asset: AssetKind, feat: 'rms' | 'corrente' | 'potencia') {
  const s = DS.series[key(machine, asset)];
  const b = AN[key(machine, asset)].baselines[s.regime[LIVE_H]];
  let sum = 0;
  let n = 0;
  for (let h = LIVE_H - 5; h <= LIVE_H; h++) {
    const bb = AN[key(machine, asset)].baselines[s.regime[h]];
    if (!bb?.ready || !s.clean[h] || Number.isNaN(s.features[feat][h])) continue;
    sum += s.features[feat][h] / bb.mean[feat];
    n++;
  }
  if (!n || !b?.ready) return 1;
  return Math.min(2.5, Math.max(0.7, sum / n));
}

export function sample(machine: string, asset: AssetKind, nowSec: number) {
  const s = DS.series[key(machine, asset)];
  const regime = s.regime[LIVE_H];
  const a = AN[key(machine, asset)];
  const b = a.baselines[regime];
  const q = DS.quality[key(machine, asset)][LIVE_H];
  const base = (f: 'rms' | 'corrente' | 'potencia') => (b?.ready ? b.mean[f] : s.features[f][LIVE_H]);
  const ph = phaseAt(programTime(machine, nowSec));
  const running = regime !== 'parada';
  const pf = running ? phaseFactor(ph, asset) : 1;
  const seed = nowSec * 7.13 + machine.charCodeAt(5) * 101 + asset.length * 17;
  const spike = asset === 'spindle' && running && ph === 'corte' && gauss(seed + 9) > 2.2 ? 1.35 : 1;
  let r = base('rms') * conditionRatio(machine, asset, 'rms') * pf * spike * (1 + 0.06 * gauss(seed));
  const c = base('corrente') * conditionRatio(machine, asset, 'corrente') * (0.45 + 0.55 * pf) * (1 + 0.025 * gauss(seed + 3));
  const p = base('potencia') * conditionRatio(machine, asset, 'potencia') * (0.45 + 0.55 * pf) * (1 + 0.03 * gauss(seed + 5));
  const k = key(machine, asset);
  if (q.frozen && lastValue[k] !== undefined) r = lastValue[k];
  else lastValue[k] = r;
  return { rms: r, corrente: c, potencia: p, phase: ph, running };
}

function emit(machine: string, kind: LiveEvent['kind'], text: string, t: number) {
  events.unshift({ id: ++evId, t, machine, kind, text });
  if (events.length > 60) events.length = 60;
}

export function tickLive(nowSec = Math.floor(Date.now() / 1000)) {
  if (nowSec === lastSec) return;
  lastSec = nowSec;
  push(liveTimes, nowSec);
  for (const m of MACHINES) {
    let total = 0;
    for (const a of ASSET_KINDS) {
      const k = key(m.id, a);
      rms[k] ??= ring();
      current[k] ??= ring();
      const x = sample(m.id, a, nowSec);
      push(rms[k], x.rms);
      push(current[k], x.corrente);
      latest[k] = { rms: x.rms, corrente: x.corrente, potencia: x.potencia };
      total += x.potencia;
    }
    power[m.id] ??= ring();
    const running = DS.regime[m.id][LIVE_H] !== 'parada';
    push(power[m.id], total + (running ? 6 : 1.8));

    if (!running) continue;
    const ph = phaseAt(programTime(m.id, nowSec));
    const prev = lastPhase[m.id];
    if (prev && prev !== ph) {
      if (ph === 'troca') {
        cycleCount[m.id] = (cycleCount[m.id] ?? 1180 + m.id.charCodeAt(5) * 37) + 1;
        emit(m.id, 'ciclo', `Ciclo ${cycleCount[m.id].toLocaleString('pt-BR')} concluído · ${CYCLE_S} s · peça OK`, nowSec);
        if (cycleCount[m.id] % 3 === 0) {
          const t1 = TOOLS[cycleCount[m.id] % TOOLS.length];
          const t2 = TOOLS[(cycleCount[m.id] + 1) % TOOLS.length];
          emit(m.id, 'troca', `Troca de ferramenta ${t1} → ${t2}`, nowSec);
        }
      }
    }
    lastPhase[m.id] = ph;
  }
  // condition messages from the analytics, at a calm pace
  if (nowSec % 40 === 0) {
    for (const m of MACHINES)
      for (const a of ASSET_KINDS) {
        const an = AN[key(m.id, a)];
        const st = an.status[LIVE_H];
        if (st === 'atencao' || st === 'critico')
          emit(m.id, 'alerta', `${labelAsset(a)} · score ${Math.round(an.ewma[LIVE_H] * 100)} · desvio persistente`, nowSec);
      }
  }
  if (nowSec % 55 === 0) {
    for (const m of MACHINES) {
      const q = DS.quality[key(m.id, 'bomba-alta-pressao')][LIVE_H];
      if (q.frozen) emit(m.id, 'dados', 'Sensor VSE004 da bomba de alta pressão sem variação: janelas descartadas', nowSec);
    }
  }
}

function labelAsset(a: AssetKind) {
  return a === 'spindle' ? 'Spindle' : a === 'bomba-refrigeracao' ? 'Bomba de refrigeração' : a === 'bomba-hidraulica' ? 'Bomba hidráulica' : 'Bomba de alta pressão';
}

/** Pre-fill the buffers so charts open with the last minutes of signal. */
export function warmup() {
  const now = Math.floor(Date.now() / 1000);
  for (let t = now - BUFFER_S + 1; t <= now; t++) tickLive(t);
  events.length = 0;
  for (const m of MACHINES) {
    if (DS.regime[m.id][LIVE_H] === 'parada') emit(m.id, 'info', 'Parada programada', now - 120);
    else emit(m.id, 'info', `Programa P-${m.id.slice(-2)}40 em execução`, now - 90);
  }
  tickLive(now + 0);
}

export const liveRms = (m: string, a: AssetKind) => rms[key(m, a)] ?? ring();
export const liveCurrent = (m: string, a: AssetKind) => current[key(m, a)] ?? ring();
export const livePower = (m: string) => power[m] ?? ring();
export const liveLatest = (m: string, a: AssetKind) => latest[key(m, a)];

// ---------- shift / day KPIs ----------
function localMidnightHour() {
  const now = hourToDate(LIVE_H);
  const local = new Date(now.getTime() - 3 * 3600_000);
  return LIVE_H - local.getUTCHours();
}

export function dayKpis(machine: string, nowSec = Date.now() / 1000) {
  const from = Math.max(0, localMidnightHour());
  const regime = DS.regime[machine];
  let runH = 0;
  let energy = 0;
  for (let h = from; h < LIVE_H; h++) {
    if (regime[h] !== 'parada') runH++;
    let p = 0;
    for (const a of ASSET_KINDS) {
      const v = DS.series[key(machine, a)].features.potencia[h];
      if (!Number.isNaN(v)) p += v;
    }
    energy += p + (regime[h] !== 'parada' ? 6 : 1.8);
  }
  const secInHour = nowSec % 3600;
  const liveRunning = regime[LIVE_H] !== 'parada';
  const elapsedH = LIVE_H - from + secInHour / 3600;
  const runTotal = runH + (liveRunning ? secInHour / 3600 : 0);
  const pw = livePower(machine);
  const lastP = pw.v[(pw.i - 1 + BUFFER_S) % BUFFER_S] || 0;
  energy += (lastP * secInHour) / 3600;
  const perf = 0.94;
  const qual = 0.996;
  const parts = Math.floor(runTotal * (3600 / CYCLE_S) * perf * qual);
  const availability = elapsedH > 0 ? runTotal / elapsedH : 0;
  return { parts, energy, availability, oee: availability * perf * qual, running: liveRunning, kwhPerPart: parts ? energy / parts : NaN };
}
