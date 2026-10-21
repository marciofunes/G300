/**
 * Machining program shared by the 3D animation and the live telemetry, so what the
 * operator sees moving and the signals streaming on screen describe the same cycle.
 */
export const CYCLE_S = 26;

const OFFSETS: Record<string, number> = { 'G300-01': 0, 'G300-02': 7.3, 'G300-03': 15.1, 'G300-04': 21.7 };

export function machineOffset(id: string) {
  return OFFSETS[id] ?? 0;
}

/** Program time (0..CYCLE_S) of a machine at wall-clock seconds, at nominal speed. */
export function programTime(id: string, nowSec = Date.now() / 1000) {
  return (((nowSec + machineOffset(id)) % CYCLE_S) + CYCLE_S) % CYCLE_S;
}

export type Phase = 'troca' | 'aproximacao' | 'corte' | 'indexacao' | 'retorno';
export const PHASE_LABEL: Record<Phase, string> = {
  troca: 'Troca de ferramenta',
  aproximacao: 'Aproximação',
  corte: 'Corte',
  indexacao: 'Indexação da mesa',
  retorno: 'Retorno',
};

export function phaseAt(t: number): Phase {
  if (t < 3) return 'troca';
  if (t < 4.5) return 'aproximacao';
  if (t < 13) return 'corte';
  if (t < 15.8) return 'indexacao';
  if (t < 22.5) return 'corte';
  return 'retorno';
}

/** Completed cycles of a machine since a reference instant (used for the part counter). */
export function cyclesSince(id: string, fromSec: number, nowSec = Date.now() / 1000) {
  const a = Math.floor((fromSec + machineOffset(id)) / CYCLE_S);
  const b = Math.floor((nowSec + machineOffset(id)) / CYCLE_S);
  return Math.max(0, b - a);
}
