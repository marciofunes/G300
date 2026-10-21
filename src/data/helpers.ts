import { AN, DS } from './analytics';
import { key, MACHINES } from './generator';
import { LIVE_H } from './live';
import { ASSET_KINDS, SENSOR_KINDS, type AssetKind, type SensorKind, type Status } from './types';
import type { AssetVisual, QualityState, TwinFrameState } from '../three/MachineTwin';

export function qualityState(machine: string, sensor: SensorKind, h = LIVE_H): QualityState {
  const q = DS.quality[key(machine, sensor)][h];
  const m = MACHINES.find((x) => x.id === machine)!;
  if (h < m.startHour) return 'off';
  if (q.frozen) return 'frozen';
  if (q.clip) return 'clip';
  if (q.gap || q.completeness < 95 || !q.sync) return 'gap';
  return 'ok';
}

const SEVERITY: Record<Status, number> = { critico: 3, atencao: 2, normal: 1, 'sem-referencia': 0 };
export function worstStatus(machine: string, h = LIVE_H): Status {
  let worst: Status = 'sem-referencia';
  for (const a of ASSET_KINDS) {
    const s = AN[key(machine, a)].status[h];
    if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return worst;
}

export function liveFrame(machine: string, h = LIVE_H): TwinFrameState {
  const assets = {} as Record<AssetKind, AssetVisual>;
  for (const a of ASSET_KINDS) {
    const an = AN[key(machine, a)];
    assets[a] = { status: an.status[h], score: Number.isNaN(an.ewma[h]) ? 0 : an.ewma[h] };
  }
  const quality = {} as Record<SensorKind, QualityState>;
  for (const s of SENSOR_KINDS) quality[s] = qualityState(machine, s, h);
  return { regime: DS.regime[machine][h], assets, quality, speed: 1, rpm: 1, stopped: false };
}
