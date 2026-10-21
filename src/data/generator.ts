/**
 * Deterministic synthetic history: 30 days of hourly analysis windows for 4 GROB G300
 * machines, 4 monitored assets each (spindle + 3 pumps) and one three-phase electrical
 * measurement per machine. Scenarios are scripted so the analytics have a story to tell.
 */
import {
  ASSET_KINDS,
  FEATURES,
  type AssetKind,
  type AssetSeries,
  type FeatureKey,
  type MachineDef,
  type QualityCell,
  type Regime,
  type SensorKind,
  SENSOR_KINDS,
} from './types';

export const HOURS = 720;
/** History is anchored so that the last window (h = 719) is the current hour. */
export const START_MS = Math.floor(Date.now() / 3600_000) * 3600_000 - (HOURS - 1) * 3600_000;

export function hourToDate(h: number): Date {
  return new Date(START_MS + h * 3600_000);
}

export const MACHINES: MachineDef[] = [
  { id: 'G300-01', cell: 'Linha A · Carcaça do estator', startHour: 0, refStart: 0, refEnd: 260, refVersion: 'v1.2' },
  { id: 'G300-02', cell: 'Linha A · Carcaça do estator', startHour: 96, refStart: 96, refEnd: 360, refVersion: 'v1.0' },
  { id: 'G300-03', cell: 'Linha B · Braço oscilante', startHour: 120, refStart: 120, refEnd: 380, refVersion: 'v1.0' },
  { id: 'G300-04', cell: 'Linha B · Bloco do motor', startHour: 500, refStart: 500, refEnd: 640, refVersion: 'v0.3' },
];

// ---------- deterministic PRNG ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd: () => number) {
  const u = Math.max(1e-9, rnd());
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------- operating regimes ----------
function regimeSchedule(machine: MachineDef): { regime: Regime[]; mixed: boolean[] } {
  const rnd = mulberry32(hashSeed(machine.id + 'regime'));
  const regime: Regime[] = [];
  const mixed: boolean[] = [];
  for (let h = 0; h < HOURS; h++) {
    const d = hourToDate(h);
    // local time (UTC-3)
    const local = new Date(d.getTime() - 3 * 3600_000);
    const hour = local.getUTCHours();
    const dow = local.getUTCDay();
    let r: Regime;
    const sunday = dow === 0;
    const night = hour >= 23 || hour < 5;
    if (h < machine.startHour) r = 'parada';
    else if (sunday && rnd() < 0.85) r = 'parada';
    else if (night && rnd() < 0.35) r = 'parada';
    else if (hour === 12 && rnd() < 0.6) r = 'parada';
    else {
      const x = rnd();
      r = x < 0.56 ? 'desbaste' : x < 0.92 ? 'acabamento' : 'troca';
    }
    // the live hours: lines A and B are running; G300-04 is in tool setup
    if (h >= HOURS - 3) r = machine.id === 'G300-04' ? 'parada' : machine.id === 'G300-01' ? 'acabamento' : 'desbaste';
    // current hour: G300-01..03 are producing, G300-04 follows its own schedule
    if (h >= HOURS - 3 && machine.id !== 'G300-04' && r === 'parada') r = rnd() < 0.6 ? 'desbaste' : 'acabamento';
    if (h === HOURS - 1 && machine.id === 'G300-01') r = 'desbaste';
    regime.push(r);
    mixed.push(r !== 'parada' && rnd() < 0.12);
  }
  return { regime, mixed };
}

type Profile = Record<Regime, Record<FeatureKey, number>>;
const P = (rms: number, kurtosis: number, crest: number, corrente: number, potencia: number, fp: number) => ({
  rms,
  kurtosis,
  crest,
  corrente,
  potencia,
  fp,
});
const PROFILES: Record<AssetKind, Profile> = {
  spindle: {
    parada: P(0.25, 3.0, 3.1, 1.8, 0.4, 0.42),
    desbaste: P(2.3, 3.2, 3.6, 46, 25, 0.86),
    acabamento: P(1.35, 3.05, 3.4, 21, 10.5, 0.8),
    troca: P(0.9, 3.7, 4.3, 9, 3.6, 0.62),
  },
  'bomba-refrigeracao': {
    parada: P(0.12, 3.0, 3.0, 0.4, 0.1, 0.3),
    desbaste: P(1.7, 3.0, 3.3, 9.2, 4.3, 0.84),
    acabamento: P(1.6, 3.0, 3.3, 8.8, 4.1, 0.84),
    troca: P(1.1, 3.1, 3.4, 6.0, 2.6, 0.78),
  },
  'bomba-hidraulica': {
    parada: P(0.95, 3.0, 3.2, 5.1, 2.2, 0.78),
    desbaste: P(1.25, 3.05, 3.3, 6.6, 3.1, 0.82),
    acabamento: P(1.2, 3.05, 3.3, 6.4, 3.0, 0.82),
    troca: P(1.3, 3.1, 3.4, 6.9, 3.2, 0.81),
  },
  'bomba-alta-pressao': {
    parada: P(0.1, 3.0, 3.0, 0.3, 0.1, 0.3),
    desbaste: P(2.0, 3.1, 3.4, 14, 7.6, 0.85),
    acabamento: P(1.55, 3.05, 3.35, 10.5, 5.6, 0.83),
    troca: P(0.4, 3.2, 3.6, 2.0, 0.8, 0.55),
  },
};
const NOISE: Record<FeatureKey, number> = { rms: 0.05, kurtosis: 0.03, crest: 0.03, corrente: 0.03, potencia: 0.035, fp: 0.012 };

// ---------- scripted scenarios ----------
/** Bearing wear on G300-01 hydraulic pump: starts at h480, severity 0..1 by h719. */
function hydraulicWear(h: number) {
  if (h < 470) return 0;
  return Math.pow(Math.min(1, (h - 470) / 250), 1.6);
}
export const SPINDLE_EVENTS = [152, 291, 412, 503, 604, 667, 701];
export const MAINTENANCE_WINDOW: [number, number] = [200, 216]; // dirty windows (accumulator repair)

export type Dataset = {
  machines: MachineDef[];
  regime: Record<string, Regime[]>;
  series: Record<string, AssetSeries>; // key machine|asset
  quality: Record<string, QualityCell[]>; // key machine|sensor
};

export const key = (m: string, a: string) => `${m}|${a}`;

export function generate(): Dataset {
  const regimeBy: Record<string, Regime[]> = {};
  const series: Record<string, AssetSeries> = {};
  const quality: Record<string, QualityCell[]> = {};

  for (const m of MACHINES) {
    const { regime, mixed } = regimeSchedule(m);
    regimeBy[m.id] = regime;

    // quality first: decides frozen/gap windows
    for (const s of SENSOR_KINDS) {
      const rnd = mulberry32(hashSeed(m.id + s + 'q'));
      const cells: QualityCell[] = [];
      for (let h = 0; h < HOURS; h++) {
        if (h < m.startHour) {
          cells.push({ completeness: 0, gap: true, sync: true, clip: false, frozen: false, valid: false });
          continue;
        }
        let completeness = 99 + rnd();
        if (rnd() < 0.004) completeness = 93 + rnd() * 4;
        let gap = false;
        let frozen = false;
        let clip = false;
        let sync = rnd() > 0.0015;
        if (m.id === 'G300-03' && s === 'eletrica' && h >= 560 && h < 576) {
          completeness = h < 562 ? 60 : 0;
          gap = true;
        }
        if (m.id === 'G300-03' && s === 'bomba-alta-pressao' && h >= 610 && h < 652) frozen = true;
        if (m.id === 'G300-03' && s === 'bomba-alta-pressao' && h >= 700) frozen = true; // recurrence, still open
        if (m.id === 'G300-02' && s === 'spindle' && (h === 333 || h === 334)) clip = true;
        if (m.id === 'G300-01' && s === 'eletrica' && h >= 688 && h < 690) {
          completeness = 88;
          sync = false;
        }
        if (completeness < 50) gap = true;
        const valid = completeness >= 95 && !frozen && !clip && sync && !gap;
        cells.push({ completeness, gap, sync, clip, frozen, valid });
      }
      quality[key(m.id, s)] = cells;
    }

    for (const a of ASSET_KINDS) {
      const rnd = mulberry32(hashSeed(m.id + a));
      const machineBias = 1 + (hashSeed(m.id) % 9) / 100 - 0.04; // each machine slightly different
      const features = Object.fromEntries(FEATURES.map((f) => [f, new Float32Array(HOURS)])) as Record<FeatureKey, Float32Array>;
      const clean: boolean[] = [];
      const dirtyReason: (string | null)[] = [];
      const q = quality[key(m.id, a)];
      const qe = quality[key(m.id, 'eletrica')];
      let last: Record<FeatureKey, number> | null = null;
      // benign process transients (tool wear, chip load, coolant temperature): short and self-resolving
      const trnd = mulberry32(hashSeed(m.id + a + 'transients'));
      const transients: [number, number, number][] = [];
      for (let k = 0; k < 4; k++) transients.push([Math.floor(m.startHour + 30 + trnd() * (HOURS - m.startHour - 40)), 2 + Math.floor(trnd() * 4), 1.16 + trnd() * 0.16]);

      for (let h = 0; h < HOURS; h++) {
        const r = regime[h];
        const base = PROFILES[a][r];
        const v = {} as Record<FeatureKey, number>;
        for (const f of FEATURES) {
          const mult = f === 'fp' || f === 'kurtosis' || f === 'crest' ? 1 : machineBias;
          v[f] = base[f] * mult * (1 + NOISE[f] * gauss(rnd));
        }
        for (const [t0, dur, amp] of transients) {
          if (h >= t0 && h < t0 + dur && r !== 'parada') {
            v.rms *= amp;
            v.kurtosis += (amp - 1) * 0.5;
            v.corrente *= 1 + (amp - 1) * 0.15;
          }
        }
        // slow spindle drift on G300-01 (tendência crescente)
        if (m.id === 'G300-01' && a === 'spindle' && r !== 'parada') {
          v.rms *= 1 + 0.12 * (h / HOURS);
        }
        // recurring unbalance events on G300-01 spindle
        if (m.id === 'G300-01' && a === 'spindle' && r !== 'parada') {
          for (const e of SPINDLE_EVENTS) {
            if (h >= e && h < e + 3) {
              v.rms *= 1.75;
              v.crest += 0.25;
              v.potencia *= 1.05;
            }
          }
        }
        // hydraulic pump bearing wear on G300-01
        if (m.id === 'G300-01' && a === 'bomba-hidraulica') {
          const s = hydraulicWear(h);
          v.rms *= 1 + 0.36 * s;
          v.kurtosis += 0.26 * s;
          v.crest += 0.12 * s;
          v.corrente *= 1 + 0.045 * s;
          v.potencia *= 1 + 0.03 * s;
          v.fp -= 0.008 * s;
          if (h >= MAINTENANCE_WINDOW[0] && h < MAINTENANCE_WINDOW[1]) {
            v.rms *= 1.9;
            v.kurtosis += 1.4;
            v.corrente *= 1.15;
          }
        }
        // mild coolant pump cavitation hint on G300-02 (short, self-resolving)
        if (m.id === 'G300-02' && a === 'bomba-refrigeracao' && h >= 640 && h < 652 && r !== 'parada') {
          v.rms *= 1.35;
          v.corrente *= 0.93;
        }
        if (h < m.startHour) for (const f of FEATURES) v[f] = NaN;
        // frozen sensor keeps the last value
        if (q[h].frozen && last) {
          v.rms = last.rms;
          v.kurtosis = last.kurtosis;
          v.crest = last.crest;
        }
        if (q[h].clip) v.rms = 9.99;
        if (qe[h].gap) {
          v.corrente = NaN;
          v.potencia = NaN;
          v.fp = NaN;
        }
        for (const f of FEATURES) features[f][h] = v[f];
        if (!q[h].frozen) last = v;

        let reason: string | null = null;
        if (!q[h].valid) reason = q[h].frozen ? 'Sensor congelado' : q[h].clip ? 'Clipping' : q[h].gap ? 'Gap de coleta' : 'Qualidade insuficiente';
        else if (!qe[h].valid) reason = 'Elétrica indisponível';
        else if (r === 'troca') reason = 'Transiente (troca de ferramenta)';
        else if (mixed[h]) reason = 'Regime misto na janela';
        else if (m.id === 'G300-01' && h >= MAINTENANCE_WINDOW[0] && h < MAINTENANCE_WINDOW[1]) reason = 'Intervenção em andamento';
        dirtyReason.push(reason);
        clean.push(reason === null);
      }
      series[key(m.id, a)] = { machine: m.id, asset: a, features, regime, clean, dirtyReason };
    }
  }
  return { machines: MACHINES, regime: regimeBy, series, quality };
}

export function sensorQualityKey(m: string, s: SensorKind) {
  return key(m, s);
}
