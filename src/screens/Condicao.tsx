import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { AN, contributions, healthIndex } from '../data/analytics';
import { key } from '../data/generator';
import { LIVE_H } from '../data/live';
import { dayInfo, FAILURE_LABEL, FUNCTIONAL_FAILURE, projection, RATE_LABEL, type FailureMode, type Rate } from '../data/whatif';
import { ASSET_KINDS, ASSET_LABEL, ASSET_SHORT, FEATURE_GROUP, FEATURE_LABEL, FEATURES, type Status } from '../data/types';
import { useStore } from '../store';
import { TwinSlot } from '../three/TwinStage';
import { Bar, BASE_AXIS, Card, EChart, fmtDay, Kpi, Select, Slider, StatusBadge, TOOLTIP, WhatIfPanel } from '../components/ui';

const DEFAULT_MODE: Record<string, FailureMode> = { spindle: 'desbalanceamento', 'bomba-refrigeracao': 'cavitacao', 'bomba-hidraulica': 'rolamento', 'bomba-alta-pressao': 'cavitacao' };

export function Condicao() {
  const machine = useStore((s) => s.machine);
  const asset = useStore((s) => s.asset);
  const setAsset = useStore((s) => s.setAsset);
  const [mode, setMode] = useState<FailureMode | null>(null);
  const [rate, setRate] = useState<Rate>('moderada');
  const [horizon, setHorizon] = useState(7);
  const [threshold, setThreshold] = useState(35);
  const [persist, setPersist] = useState(12);
  const fm = mode ?? DEFAULT_MODE[asset];
  const pr = useMemo(
    () => projection({ machine, asset, mode: fm, rate, threshold: threshold / 100, window: persist, horizon }),
    [machine, asset, fm, rate, threshold, persist, horizon],
  );
  const contrib = contributions(machine, asset, LIVE_H);
  const an = AN[key(machine, asset)];

  const scoreAt = pr.atHorizon;
  const stAt: Status = scoreAt >= FUNCTIONAL_FAILURE ? 'critico' : scoreAt >= Math.max(0.65, threshold / 100) ? 'critico' : scoreAt >= threshold / 100 ? 'atencao' : 'normal';
  const hd = dayInfo(horizon);
  const scenario = {
    view: 'machine' as const,
    focusAsset: asset,
    camera: (asset === 'spindle' ? 'trabalho' : 'agregados') as 'trabalho' | 'agregados',
    assets: { [asset]: { status: stAt, score: scoreAt } },
    badge: horizon === 0 ? 'Agora' : `Projeção +${horizon} dias`,
    caption: `${ASSET_LABEL[asset]} em ${hd.label}: score ${Math.round(scoreAt * 100)} · ${FAILURE_LABEL[fm].toLowerCase()} (${RATE_LABEL[rate].toLowerCase()})`,
  };

  const chart = useMemo<EChartsOption>(() => {
    const histDays = 14;
    const hist: (number | null)[] = [];
    const labels: string[] = [];
    for (let d = -histDays; d < 0; d++) {
      const h = LIVE_H + d * 24;
      const v = an.ewma[h];
      hist.push(Number.isNaN(v) ? null : +v.toFixed(3));
      labels.push(fmtDay(h));
    }
    for (let d = 0; d <= 21; d++) labels.push(dayInfo(d).label);
    const pad = (arr: number[]) => [...new Array(histDays).fill(null), ...arr.slice(0, 22).map((v) => +v.toFixed(3))];
    const histFull = [...hist, +pr.e0.toFixed(3), ...new Array(21).fill(null)];
    const failIdx = histDays + Math.min(21, Math.round(pr.failDay));
    const alertIdx = histDays + Math.round((pr.alertHour - LIVE_H) / 24);
    const marks: any[] = [{ xAxis: labels[histDays + horizon], lineStyle: { color: '#1d2a36', type: 'solid' }, label: { formatter: horizon ? `+${horizon} d (3D)` : 'hoje (3D)', color: '#1d2a36', fontSize: 10 } }];
    if (pr.failDay <= 21) marks.push({ xAxis: labels[failIdx], lineStyle: { color: '#d03b3b' }, label: { formatter: 'falha provável', color: '#d03b3b', fontSize: 10, position: 'insideEndBottom' } });
    if (alertIdx >= 0 && alertIdx < labels.length) marks.push({ xAxis: labels[alertIdx], lineStyle: { color: '#e38418' }, label: { formatter: 'alerta', color: '#e38418', fontSize: 10, position: 'insideStartTop' } });
    return {
      animation: false,
      grid: { left: 40, right: 16, top: 30, bottom: 26 },
      legend: { top: 0, right: 0, textStyle: { color: '#6b7785', fontSize: 11 }, data: ['Histórico', 'Projeção', 'Faixa de incerteza'] },
      tooltip: { ...TOOLTIP, valueFormatter: (v: any) => (v == null ? '--' : `${Math.round(v * 100)}`) },
      xAxis: { type: 'category', data: labels, ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, interval: 3 } },
      yAxis: { type: 'value', min: 0, max: 1, name: 'score de anomalia', nameTextStyle: { color: '#6b7785', fontSize: 11, align: 'left' }, ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, formatter: (v: number) => `${Math.round(v * 100)}` } },
      series: [
        { name: 'lo', type: 'line', stack: 'band', data: pad(pr.lo), lineStyle: { opacity: 0 }, showSymbol: false, silent: true, tooltip: { show: false } },
        { name: 'Faixa de incerteza', type: 'line', stack: 'band', data: pad(pr.hi.map((v, i) => v - pr.lo[i])), lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(235,104,52,0.14)' }, showSymbol: false, silent: true, color: '#f3b49a', tooltip: { show: false } },
        {
          name: 'Histórico', type: 'line', data: histFull, showSymbol: false, color: '#256abf', lineStyle: { width: 2 },
          markLine: {
            symbol: 'none', silent: true,
            data: [
              { yAxis: threshold / 100, lineStyle: { color: '#e38418', type: 'dashed' }, label: { formatter: 'limiar de alerta', color: '#9a5208', fontSize: 10, position: 'insideStartTop' } },
              { yAxis: FUNCTIONAL_FAILURE, lineStyle: { color: '#d03b3b', type: 'dashed' }, label: { formatter: 'falha funcional', color: '#d03b3b', fontSize: 10, position: 'insideStartTop' } },
              ...marks,
            ],
          },
        },
        { name: 'Projeção', type: 'line', data: pad(pr.mid), showSymbol: false, color: '#eb6834', lineStyle: { width: 2, type: 'dashed' } },
      ],
    };
  }, [an, pr, horizon, threshold]);

  const alertDate = pr.alertHour <= LIVE_H ? fmtDay(pr.alertHour) : dayInfo(Math.round((pr.alertHour - LIVE_H) / 24)).label;
  const failLabel = pr.failDay > 30 ? '> 30 dias' : dayInfo(Math.round(pr.failDay)).label;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Condição dos ativos</h1>
          <p>Saúde atual, projeção da degradação e política de alertas · {machine}</p>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {ASSET_KINDS.map((a) => {
          const x = AN[key(machine, a)];
          const hi = healthIndex(machine, a, LIVE_H);
          return (
            <button key={a} className={`kpi asset-cell ${a === asset ? 'sel' : ''}`} style={{ display: 'block', textAlign: 'left' }} onClick={() => { setAsset(a); setMode(null); }}>
              <div className="label">{ASSET_LABEL[a]}</div>
              <div style={{ marginTop: 6 }}>
                <StatusBadge status={x.status[LIVE_H]} big />
              </div>
              <div className="sub" style={{ marginTop: 6 }}>
                Health Index {Number.isNaN(hi) ? '--' : hi} · score {Number.isNaN(x.ewma[LIVE_H]) ? '--' : Math.round(x.ewma[LIVE_H] * 100)}
              </div>
            </button>
          );
        })}
      </div>
      <div className="grid" style={{ gridTemplateColumns: '300px minmax(0, 1fr)' }}>
        <WhatIfPanel title="Projeção e política de alerta" onReset={() => { setMode(null); setRate('moderada'); setHorizon(7); setThreshold(35); setPersist(12); }}>
          <Select label="Modo de falha" value={fm} options={(Object.keys(FAILURE_LABEL) as FailureMode[]).map((f) => ({ v: f, label: FAILURE_LABEL[f] }))} onChange={setMode} />
          <Select label="Velocidade de evolução" value={rate} options={(Object.keys(RATE_LABEL) as Rate[]).map((r) => ({ v: r, label: RATE_LABEL[r] }))} onChange={setRate} />
          <Slider label="Ver no 3D em" value={horizon} min={0} max={21} format={(v) => (v === 0 ? 'hoje' : `+${v} dias (${dayInfo(v).label})`)} onChange={setHorizon} />
          <Slider label="Limiar de alerta" value={threshold} min={20} max={60} format={(v) => `score ${v}`} onChange={setThreshold} />
          <Slider label="Persistência mínima" value={persist} min={3} max={24} format={(v) => `${v} janelas (h)`} onChange={setPersist} />
        </WhatIfPanel>
        <TwinSlot height={400} scenario={scenario} />
      </div>
      <div className="kpis">
        <Kpi label={`Score em ${hd.label}`} value={Math.round(scoreAt * 100)} sub={`hoje ${Math.round(pr.e0 * 100)}`} color={stAt === 'normal' ? 'var(--good)' : stAt === 'atencao' ? 'var(--warn)' : 'var(--crit)'} />
        <Kpi label="Alerta emitido em" value={alertDate} sub={pr.alertHour <= LIVE_H ? 'pela política simulada' : 'previsto pela projeção'} color="var(--warn)" />
        <Kpi label="Falha funcional provável" value={failLabel} sub={`entre ${dayInfo(Math.round(pr.failEarly)).label} e ${pr.failLate > 30 ? '> 30 d' : dayInfo(Math.round(pr.failLate)).label}`} color="var(--crit)" />
        <Kpi label="Antecedência para planejar" value={`${Math.max(0, Math.round(pr.leadDays))} dias`} sub="do alerta até a falha provável" color="var(--accent)" />
        <Kpi label="Alarmes falsos na frota" value={pr.falseAlarms} sub="mesma política, últimos 30 dias" color={pr.falseAlarms > 4 ? 'var(--crit)' : pr.falseAlarms ? 'var(--warn)' : 'var(--good)'} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(280px, 1fr)' }}>
        <Card title={`Projeção do score · ${ASSET_LABEL[asset]}`} right={<small>histórico de 14 dias + 21 dias projetados</small>} hint="Limiar mais baixo antecipa o alerta, mas aumenta os alarmes falsos na frota. Ajuste a política e compare.">
          <EChart option={chart} height={260} />
        </Card>
        <Card title={`O que explica o desvio · ${ASSET_SHORT[asset]}`} right={<small>contribuição por variável</small>}>
          {FEATURES.map((f) => (
            <div className="contrib" key={f}>
              <span>
                {FEATURE_LABEL[f]} <span className="foot-note">{FEATURE_GROUP[f]}</span>
              </span>
              <Bar value={contrib[f]} color={FEATURE_GROUP[f] === 'Vibração' ? '#2a78d6' : '#eb6834'} />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(contrib[f] * 100)}%</span>
            </div>
          ))}
          <div className="foot-note" style={{ marginTop: 6 }}>
            {an.status[LIVE_H] === 'normal' ? 'Ativo dentro do normal: a projeção simula o início do modo de falha escolhido a partir de hoje.' : 'Vibração domina o desvio e a carga elétrica segue quase estável: padrão de dano mecânico incipiente.'}
          </div>
        </Card>
      </div>
    </>
  );
}
