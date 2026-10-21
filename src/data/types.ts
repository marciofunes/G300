export type Regime = 'parada' | 'desbaste' | 'acabamento' | 'troca';
export const REGIMES: Regime[] = ['desbaste', 'acabamento', 'troca', 'parada'];
export const REGIME_LABEL: Record<Regime, string> = {
  parada: 'Parada',
  desbaste: 'Desbaste',
  acabamento: 'Acabamento',
  troca: 'Troca de ferramenta',
};

export type FeatureKey = 'rms' | 'kurtosis' | 'crest' | 'corrente' | 'potencia' | 'fp';
export const FEATURES: FeatureKey[] = ['rms', 'kurtosis', 'crest', 'corrente', 'potencia', 'fp'];
export const FEATURE_LABEL: Record<FeatureKey, string> = {
  rms: 'RMS',
  kurtosis: 'Curtose',
  crest: 'Fator de crista',
  corrente: 'Corrente',
  potencia: 'Potência',
  fp: 'FP',
};
export const FEATURE_UNIT: Record<FeatureKey, string> = {
  rms: 'mm/s',
  kurtosis: '',
  crest: '',
  corrente: 'A',
  potencia: 'kW',
  fp: '',
};
export const FEATURE_GROUP: Record<FeatureKey, 'Vibração' | 'Elétrica'> = {
  rms: 'Vibração',
  kurtosis: 'Vibração',
  crest: 'Vibração',
  corrente: 'Elétrica',
  potencia: 'Elétrica',
  fp: 'Elétrica',
};

export type AssetKind = 'spindle' | 'bomba-refrigeracao' | 'bomba-hidraulica' | 'bomba-alta-pressao';
export const ASSET_KINDS: AssetKind[] = ['spindle', 'bomba-refrigeracao', 'bomba-hidraulica', 'bomba-alta-pressao'];
export const ASSET_LABEL: Record<AssetKind, string> = {
  spindle: 'Spindle',
  'bomba-refrigeracao': 'Bomba refrigeração',
  'bomba-hidraulica': 'Bomba hidráulica',
  'bomba-alta-pressao': 'Bomba alta pressão',
};
export const ASSET_SHORT: Record<AssetKind, string> = {
  spindle: 'Spindle',
  'bomba-refrigeracao': 'Bomba 1',
  'bomba-hidraulica': 'Bomba 2',
  'bomba-alta-pressao': 'Bomba 3',
};

export type SensorKind = AssetKind | 'eletrica';
export const SENSOR_KINDS: SensorKind[] = [...ASSET_KINDS, 'eletrica'];
export const SENSOR_LABEL: Record<SensorKind, string> = {
  ...ASSET_LABEL,
  eletrica: 'Elétrica trifásica',
};

export type Status = 'normal' | 'atencao' | 'critico' | 'sem-referencia';
export const STATUS_LABEL: Record<Status, string> = {
  normal: 'Normal',
  atencao: 'Atenção',
  critico: 'Crítico',
  'sem-referencia': 'Sem referência',
};

export type MachineDef = {
  id: string;
  cell: string;
  startHour: number;
  refStart: number;
  refEnd: number;
  refVersion: string;
};

export type QualityCell = {
  completeness: number;
  gap: boolean;
  sync: boolean;
  clip: boolean;
  frozen: boolean;
  valid: boolean;
};

export type AssetSeries = {
  machine: string;
  asset: AssetKind;
  features: Record<FeatureKey, Float32Array>;
  regime: Regime[];
  clean: boolean[];
  dirtyReason: (string | null)[];
};

export type Baseline = {
  mean: Record<FeatureKey, number>;
  std: Record<FeatureKey, number>;
  count: number;
  ready: boolean;
};

export type AssetAnalytics = {
  score: Float32Array; // 0..1, NaN when not computable
  ewma: Float32Array;
  persistence: Float32Array;
  status: Status[];
  z: Record<FeatureKey, Float32Array>;
  baselines: Record<Regime, Baseline>;
};

export type EventKind = 'intervencao' | 'inspecao' | 'falha' | 'dados' | 'alerta' | 'ordem';
export const EVENT_LABEL: Record<EventKind, string> = {
  intervencao: 'Intervenção',
  inspecao: 'Inspeção',
  falha: 'Falha confirmada',
  dados: 'Ocorrência de dados',
  alerta: 'Alerta automático',
  ordem: 'Ordem de manutenção',
};

export type FieldEvent = {
  id: string;
  machine: string;
  asset: SensorKind;
  hour: number;
  kind: EventKind;
  title: string;
  detail?: string;
  caseId?: string;
  source: 'base' | 'feedback';
};

export type CaseStatus = 'aberto' | 'em-analise' | 'encerrado';
export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  aberto: 'Aberto',
  'em-analise': 'Em análise',
  encerrado: 'Encerrado',
};

export type Hypothesis = { id: string; label: string; support: number; evidence: string; missing?: string };

export type InvestigationCase = {
  id: string;
  machine: string;
  asset: SensorKind;
  origin: string;
  openedHour: number;
  closedHour?: number;
  status: CaseStatus;
  title: string;
  summary: string;
  hypotheses: Hypothesis[];
  result?: { outcome: string; mode: string; action: string; note: string; hour: number };
};
