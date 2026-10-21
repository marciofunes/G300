import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { AN, AN_CONTAMINATED, contaminatedBaseline, DS } from '../data/analytics';
import { key, MACHINES } from '../data/generator';
import { LIVE_H } from '../data/live';
import { ISO_LIMIT_RMS, OP_DEFAULT, operatingPoint, type OpParams } from '../data/whatif';
import { ASSET_KINDS, ASSET_LABEL, ASSET_SHORT, FEATURE_LABEL, FEATURE_UNIT, FEATURES, REGIME_LABEL, type AssetKind, type FeatureKey } from '../data/types';
import { useStore } from '../store';
import { TwinSlot } from '../three/TwinStage';
import type { AssetVisual } from '../three/MachineTwin';
import { BASE_AXIS, Card, DeltaKpi, EChart, fmtDay, fmtHour, num, Seg, Select, Slider, TOOLTIP, Toggle, WhatIfPanel } from '../components/ui';

const brl2 = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`;

export function Referencias() {
  const machine = useStore((s) => s.machine);
  const asset = useStore((s) => s.asset);
  const period = useStore((s) => s.period);
  const setAsset = useStore((s) => s.setAsset);
  const [p, setP] = useState<OpParams>(OP_DEFAULT);
  const [feat, setFeat] = useState<FeatureKey>('rms');
  const [contaminated, setContaminated] = useState(false);
  const set = (patch: Partial<OpParams>) => setP((x) => ({ ...x, ...patch }));
  const now = useMemo(() => operatingPoint(machine, { ...OP_DEFAULT, regime: p.regime }), [machine, p.regime]);
  const scen = useMemo(() => operatingPoint(machine, p), [machine, p]);
  const m = MACHINES.find((x) => x.id === machine)!;

  // ---- 3D: the twin runs the simulated operating point
  const assets: Partial<Record<AssetKind, AssetVisual>> = {};
  for (const a of scen.assets) {
    if (a.asset === 'spindle') {
      if (a.rms > ISO_LIMIT_RMS) assets.spindle = { status: 'critico', score: 0.9 };
      else if (a.rms > 0.85 * ISO_LIMIT_RMS) assets.spindle = { status: 'atencao', score: 0.6 };
      else assets.spindle = { status: 'normal', score: 0.05 };
    }
  }
  const speed = now.cycle / scen.cycle;
  const changed = p.rpm !== OP_DEFAULT.rpm || p.feed !== OP_DEFAULT.feed || p.bar !== OP_DEFAULT.bar;
  const scenario = {
    view: 'machine' as const,
    focusAsset: asset,
    camera: 'geral' as const,
    assets,
    frame: { speed, rpm: p.rpm / 12000, regime: p.regime },
    badge: changed ? 'Cenário simulado' : 'Operação atual',
    caption: `${p.rpm.toLocaleString('pt-BR')} rpm · avanço ${p.feed}% · refrigeração ${p.bar} bar · ciclo ${scen.cycle.toFixed(1).replace('.', ',')} s`,
  };

  // ---- predicted vibration vs context-aware envelope
  const bars = useMemo<EChartsOption>(() => {
    const cats = ASSET_KINDS.map((a) => ASSET_SHORT[a]);
    return {
      animation: false,
      grid: { left: 80, right: 24, top: 30, bottom: 26 },
      legend: { top: 0, left: 0, textStyle: { color: '#6b7785', fontSize: 11 }, data: ['Faixa normal para o cenário', 'Vibração prevista', 'Operação atual'] },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: '#fff', borderColor: '#dfe4ea', textStyle: { color: '#1d2a36', fontSize: 12 },
        formatter: (ps: any) => {
          const i = ps[0].dataIndex;
          const a = scen.assets[i];
          return `<b>${ASSET_LABEL[a.asset]}</b><br/>Prevista: ${a.rms.toFixed(2)} mm/s<br/>Faixa normal: ${a.lo.toFixed(2)} a ${a.hi.toFixed(2)} mm/s<br/>Atual: ${now.assets[i].rms.toFixed(2)} mm/s${a.condition > 1.15 ? '<br/><b style="color:#e38418">Desvio não explicado pela operação (condição do ativo)</b>' : ''}`;
        },
      },
      xAxis: { type: 'value', min: 0, max: Math.max(6, Math.ceil(Math.max(...scen.assets.map((a) => a.rms)) + 0.5)), name: 'mm/s', nameTextStyle: { color: '#6b7785', fontSize: 11 }, ...BASE_AXIS },
      yAxis: { type: 'category', data: cats, inverse: true, ...BASE_AXIS, splitLine: { show: false } },
      series: [
        { name: 'base', type: 'bar', stack: 'env', data: scen.assets.map((a) => +a.lo.toFixed(3)), itemStyle: { color: 'transparent' }, barWidth: 18, silent: true, tooltip: { show: false } },
        { name: 'Faixa normal para o cenário', type: 'bar', stack: 'env', data: scen.assets.map((a) => +(a.hi - a.lo).toFixed(3)), itemStyle: { color: 'rgba(42,120,214,0.18)', borderRadius: 4 }, color: '#9ec5f4', barWidth: 18 },
        {
          name: 'Operação atual', type: 'scatter', symbol: 'rect', symbolSize: [3, 22], color: '#52606d', data: now.assets.map((a, i) => [+a.rms.toFixed(3), i]),
        },
        {
          name: 'Vibração prevista', type: 'scatter', symbol: 'diamond', symbolSize: 16,
          data: scen.assets.map((a, i) => ({ value: [+a.rms.toFixed(3), i], itemStyle: { color: a.asset === 'spindle' && a.rms > ISO_LIMIT_RMS ? '#d03b3b' : a.outOfEnvelope ? '#e38418' : '#1e8a5a' } })),
          color: '#1e8a5a',
          markLine: { symbol: 'none', silent: true, lineStyle: { color: '#d03b3b', type: 'dashed' }, label: { formatter: `limite ISO 10816 do spindle (${ISO_LIMIT_RMS} mm/s)`, color: '#d03b3b', fontSize: 10, position: 'insideEndTop' }, data: [{ xAxis: ISO_LIMIT_RMS }] },
        },
      ],
    };
  }, [scen, now]);

  // ---- measured vs learned reference (history)
  const ser = DS.series[key(machine, asset)];
  const an = AN[key(machine, asset)];
  const base = an.baselines[p.regime];
  const from = Math.max(m.startHour, LIVE_H - Math.max(period, 168) + 1);
  const history = useMemo<EChartsOption>(() => {
    const xs: number[] = [];
    for (let h = from; h <= LIVE_H; h++) if (ser.regime[h] === p.regime && ser.clean[h]) xs.push(h);
    const useC = contaminated && machine === 'G300-01' && asset === 'bomba-hidraulica';
    const b = useC ? contaminatedBaseline(p.regime) : base;
    const mu = b.mean[feat];
    const lo = mu - 3 * b.std[feat];
    const hi = mu + 3 * b.std[feat];
    const vals = xs.map((h) => ser.features[feat][h]);
    return {
      animation: false,
      grid: { left: 50, right: 16, top: 30, bottom: 26 },
      legend: { top: 0, right: 0, textStyle: { color: '#6b7785', fontSize: 11 }, data: ['Medido', 'Referência', 'Faixa normal ±3σ'] },
      tooltip: { ...TOOLTIP, valueFormatter: (v: any) => (v == null ? '--' : Number(v).toFixed(3)) },
      xAxis: { type: 'category', data: xs.map((h) => fmtHour(h)), ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, interval: Math.max(1, Math.floor(xs.length / 6)) } },
      yAxis: { type: 'value', scale: true, name: `${FEATURE_LABEL[feat]}${FEATURE_UNIT[feat] ? ' (' + FEATURE_UNIT[feat] + ')' : ''}`, nameTextStyle: { color: '#6b7785', fontSize: 11, align: 'left' }, ...BASE_AXIS },
      series: b.ready
        ? [
            { name: 'lower', type: 'line', stack: 'env', data: xs.map(() => lo), lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } },
            { name: 'Faixa normal ±3σ', type: 'line', stack: 'env', data: xs.map(() => hi - lo), lineStyle: { opacity: 0 }, areaStyle: { color: useC ? 'rgba(227,132,24,0.13)' : 'rgba(42,120,214,0.13)' }, showSymbol: false, silent: true, color: useC ? '#f3c27d' : '#9ec5f4', tooltip: { show: false } },
            { name: 'Referência', type: 'line', data: xs.map(() => mu), showSymbol: false, lineStyle: { type: 'dashed', width: 1.2 }, color: '#2a78d6', silent: true },
            { name: 'Medido', type: 'line', data: vals.map((v) => ({ value: +v.toFixed(4), itemStyle: { color: v > hi || v < lo ? '#e38418' : '#256abf' } })), symbolSize: 5, showSymbol: true, lineStyle: { width: 1.4, color: '#256abf' }, color: '#256abf' },
          ]
        : [{ name: 'Medido', type: 'line', data: vals, color: '#256abf', showSymbol: false }],
    };
  }, [from, ser, p.regime, feat, base, contaminated, machine, asset]);

  // ---- reference quality: G300-01 hydraulic pump detection date
  const firstAlert = (st: string[]) => st.findIndex((s, h) => h > 300 && (s === 'atencao' || s === 'critico'));
  const detOk = firstAlert(AN[key('G300-01', 'bomba-hidraulica')].status);
  const detBad = firstAlert(AN_CONTAMINATED.status);
  const delay = detBad < 0 ? LIVE_H - detOk : detBad - detOk;
  const widen = contaminatedBaseline('desbaste').std.rms / AN[key('G300-01', 'bomba-hidraulica')].baselines.desbaste.std.rms - 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Comportamento normal</h1>
          <p>Referência aprendida por regime e simulação do ponto de operação · {machine}</p>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: '300px minmax(0, 1fr)' }}>
        <WhatIfPanel title="Ponto de operação" onReset={() => setP({ ...OP_DEFAULT, regime: p.regime })}>
          <Select label="Regime" value={p.regime} options={[{ v: 'desbaste', label: 'Desbaste' }, { v: 'acabamento', label: 'Acabamento' }]} onChange={(v) => set({ regime: v })} />
          <Slider label="Rotação do spindle" value={p.rpm} min={6000} max={18000} step={500} unit=" rpm" onChange={(v) => set({ rpm: v })} />
          <Slider label="Avanço (carga de corte)" value={p.feed} min={50} max={130} step={5} unit="%" onChange={(v) => set({ feed: v })} />
          <Slider label="Pressão de refrigeração" value={p.bar} min={20} max={80} step={5} unit=" bar" onChange={(v) => set({ bar: v })} hint="Bomba de alta pressão (Bomba 3)" />
        </WhatIfPanel>
        <TwinSlot height={400} scenario={scenario} />
      </div>
      <div className="kpis">
        <DeltaKpi label="Tempo de ciclo" now={now.cycle} scen={scen.cycle} fmt={(v) => `${v.toFixed(1).replace('.', ',')} s`} />
        <DeltaKpi label="Peças por hora" now={now.partsPerHour} scen={scen.partsPerHour} fmt={(v) => `${Math.round(v)}`} better="higher" />
        <DeltaKpi label="Energia por peça" now={now.kwhPerPart} scen={scen.kwhPerPart} fmt={(v) => `${v.toFixed(3).replace('.', ',')} kWh`} />
        <DeltaKpi label="Custo variável por peça" now={now.costPerPart} scen={scen.costPerPart} fmt={brl2} />
        <DeltaKpi label="Margem até o limite de vibração" now={now.spindleMargin} scen={scen.spindleMargin} fmt={(v) => `${Math.round(v * 100)}%`} better="higher" />
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)' }}>
        <Card
          title="Vibração prevista por ativo"
          right={<small>{REGIME_LABEL[p.regime]} · faixa normal ajustada ao cenário</small>}
          hint="A referência acompanha o contexto de operação: mudar rotação e avanço desloca a faixa normal. O que continua fora da faixa não é explicado pela operação."
        >
          <EChart option={bars} height={230} />
          <div className="foot-note">
            Ferramenta: {Math.round(scen.partsPerTool)} peças por aresta (atual {Math.round(now.partsPerTool)}) · {scen.kw.toFixed(1).replace('.', ',')} kW médios no ciclo
          </div>
        </Card>
        <Card
          title={`Medido × referência aprendida · ${ASSET_LABEL[asset]}`}
          right={<Seg value={feat} options={FEATURES.slice(0, 5).map((f) => ({ v: f, label: f === 'crest' ? 'Crista' : FEATURE_LABEL[f] }))} onChange={setFeat} />}
          hint={base.ready ? `Somente janelas válidas em ${REGIME_LABEL[p.regime].toLowerCase()} · referência ${m.refVersion} com ${base.count} janelas.` : `Referência de ${REGIME_LABEL[p.regime].toLowerCase()} em aprendizado: ${base.count} janelas.`}
        >
          <EChart option={history} height={230} onClick={() => undefined} />
          <div className="trail" style={{ marginTop: 4 }}>
            {ASSET_KINDS.map((a) => (
              <button key={a} className={`chip ${a === asset ? '' : 'grey'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setAsset(a)}>
                {ASSET_SHORT[a]}
              </button>
            ))}
          </div>
        </Card>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)' }}>
        <WhatIfPanel title="Qualidade da referência">
          <Toggle
            label="Aprender incluindo janelas de manutenção"
            checked={contaminated}
            onChange={(v) => {
              setContaminated(v);
              if (v) setAsset('bomba-hidraulica');
            }}
            hint="Exemplo real da linha: troca do acumulador hidráulico da G300-01. Ative e veja a faixa normal no gráfico acima (G300-01 · Bomba 2)."
          />
        </WhatIfPanel>
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <DeltaKpi label="Largura da faixa normal" now={1} scen={contaminated ? 1 + widen : 1} fmt={(v) => `${v.toFixed(2).replace('.', ',')}×`} />
          <div className="kpi">
            <div className="label">Detecção do desgaste</div>
            <div className="value" style={{ fontSize: 20 }}>{contaminated ? (detBad < 0 ? 'Não detectado' : fmtDay(detBad)) : fmtDay(detOk)}</div>
            <div className="sub">referência correta: {fmtDay(detOk)}</div>
          </div>
          <div className="kpi">
            <div className="label">Antecedência perdida</div>
            <div className="value" style={{ color: contaminated ? 'var(--crit)' : 'var(--good)' }}>{contaminated ? `${num(delay / 24, 0)} dias` : '0 dias'}</div>
            <div className="sub">{contaminated ? 'a faixa larga esconde o início da degradação' : 'janelas de intervenção excluídas do aprendizado'}</div>
          </div>
        </div>
      </div>
    </>
  );
}
