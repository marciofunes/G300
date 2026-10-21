import { create } from 'zustand';
import { BASE_CASES, BASE_EVENTS } from './data/cases';
import { HOURS } from './data/generator';
import type { AssetKind, FieldEvent, InvestigationCase, SensorKind } from './data/types';
import type { AssetVisual, QualityState, TwinFrameState } from './three/MachineTwin';

export type Period = 24 | 168 | 720;
export type CamPreset = 'geral' | 'trabalho' | 'agregados';
export type TwinView = 'plant' | 'machine';

/** What the screen wants the persistent 3D stage to show. */
export type TwinScenario = {
  view: TwinView;
  focusAsset?: AssetKind;
  focusSensor?: SensorKind;
  sensorHalos?: boolean;
  assets?: Partial<Record<AssetKind, AssetVisual>>;
  quality?: Partial<Record<SensorKind, QualityState>>;
  frame?: Partial<Pick<TwinFrameState, 'speed' | 'rpm' | 'stopped' | 'maintenance' | 'regime'>>;
  caption?: string;
  badge?: string;
  camera?: CamPreset;
};

type Feedback = { events: FieldEvent[]; results: Record<string, InvestigationCase['result']> };

function loadFeedback(): Feedback {
  try {
    const raw = localStorage.getItem('ipman-g300-feedback');
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable: start empty */
  }
  return { events: [], results: {} };
}
function saveFeedback(f: Feedback) {
  try {
    localStorage.setItem('ipman-g300-feedback', JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

export const LIVE_HOUR = HOURS - 1;

type State = {
  liveTick: number;
  machine: string;
  asset: AssetKind;
  sensor: SensorKind;
  period: Period;
  xray: boolean;
  caseId: string;
  camPreset: CamPreset;
  camNonce: number;
  slot: HTMLElement | null;
  scenario: TwinScenario;
  twinReady: boolean;
  feedback: Feedback;
  bumpLive: () => void;
  setMachine: (m: string) => void;
  setAsset: (a: AssetKind) => void;
  setSensor: (s: SensorKind) => void;
  setPeriod: (p: Period) => void;
  setXray: (x: boolean) => void;
  setCase: (c: string) => void;
  setCamPreset: (p: CamPreset) => void;
  setSlot: (el: HTMLElement | null) => void;
  setScenario: (s: TwinScenario) => void;
  setTwinReady: (r: boolean) => void;
  registerResult: (caseId: string, r: NonNullable<InvestigationCase['result']>, c: InvestigationCase) => void;
  resetFeedback: () => void;
  addEvent: (e: Omit<FieldEvent, 'id' | 'source'>) => void;
};

export const useStore = create<State>((set, get) => ({
  liveTick: 0,
  machine: 'G300-01',
  asset: 'bomba-hidraulica',
  sensor: 'bomba-hidraulica',
  period: 168,
  xray: false,
  caseId: '#0007',
  camPreset: 'geral',
  camNonce: 0,
  slot: null,
  scenario: { view: 'plant' },
  twinReady: false,
  feedback: loadFeedback(),
  bumpLive: () => set((s) => ({ liveTick: s.liveTick + 1 })),
  setMachine: (machine) => set({ machine }),
  setAsset: (asset) => set({ asset, sensor: asset }),
  setSensor: (sensor) => set((s) => ({ sensor, asset: sensor === 'eletrica' ? s.asset : (sensor as AssetKind) })),
  setPeriod: (period) => set({ period }),
  setXray: (xray) => set({ xray }),
  setCase: (caseId) => set({ caseId }),
  setCamPreset: (camPreset) => set((s) => ({ camPreset, camNonce: s.camNonce + 1 })),
  setSlot: (slot) => set({ slot }),
  setScenario: (scenario) => set({ scenario }),
  setTwinReady: (twinReady) => set({ twinReady }),
  registerResult: (caseId, r, c) => {
    const fb = get().feedback;
    const ev: FieldEvent = {
      id: `fb-${Date.now()}`,
      machine: c.machine,
      asset: c.asset,
      hour: LIVE_HOUR,
      kind: r.outcome === 'Falha confirmada' ? 'falha' : 'inspecao',
      title: `${r.outcome}: ${r.mode}`,
      detail: [r.action, r.note].filter(Boolean).join(' · '),
      caseId,
      source: 'feedback',
    };
    const next = { events: [...fb.events, ev], results: { ...fb.results, [caseId]: r } };
    saveFeedback(next);
    set({ feedback: next });
  },
  addEvent: (e) => {
    const fb = get().feedback;
    const next = { ...fb, events: [...fb.events, { ...e, id: `fb-${Date.now()}`, source: 'feedback' as const }] };
    saveFeedback(next);
    set({ feedback: next });
  },
  resetFeedback: () => {
    const next = { events: [], results: {} };
    saveFeedback(next);
    set({ feedback: next });
  },
}));

export function useEvents(): FieldEvent[] {
  const fb = useStore((s) => s.feedback);
  return [...BASE_EVENTS, ...fb.events].sort((a, b) => a.hour - b.hour);
}

export function useCases(): InvestigationCase[] {
  const fb = useStore((s) => s.feedback);
  return BASE_CASES.map((c) => {
    const r = fb.results[c.id];
    return r ? { ...c, status: 'encerrado' as const, result: r, closedHour: LIVE_HOUR } : c;
  });
}
