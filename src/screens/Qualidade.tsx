import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { DS } from '../data/analytics';
import { key, MACHINES } from '../data/generator';
import { qualityState } from '../data/helpers';
import { LIVE_H } from '../data/live';
import { FALSE_ALARM_COST, FAULT_LABEL, faultScenario, WINDOW_SPAN, type FaultMode, type FaultParams } from '../data/whatif';
import { ASSET_SHORT, SENSOR_KINDS, SENSOR_LABEL, type SensorKind } from '../data/types';
import { useStore } from '../store';
import { TwinSlot } from '../three/TwinStage';
import type { QualityState } from '../three/MachineTwin';
import { BASE_AXIS, brl, Card, DeltaKpi, EChart, fmtHour, HeatGrid, Select, Slider, TOOLTIP, Toggle, WhatIfPanel, type HeatCell } from '../components/ui';

const Q_COLOR = { ok: '#1e8a5a', gap: '#e38418', frozen: '#8a96a3', clip: '#d03b3b', off: '#cfd6dd' };
const Q_LABEL = { ok: 'OK', gap: 'Gap / incompleto', frozen: 'Congelado', clip: 'Saturação / picos', off: 'Sem coleta' };
const FAULT_Q: Record<FaultMode, QualityState> = { desconectado: 'gap', congelado: 'frozen', ruido: 'clip', saturacao: 'clip' };

export function Qualidade() {
  const machine = useStore((s) => s.machine);
  const period = useStore((s) => s.period);
  const [sensor, setSensor] = useState<SensorKind>('bomba-refrigeracao');
  const [mode, setMode] = useState<FaultMode>('ruido');
  const [hours, setHours] = useState(12);
  const [qualification, setQualification] = useState(true);
  const params: FaultParams = { sensor, mode, hours, qualification };
  const sc = useMemo(() => faultScenario(machine, params), [machine, sensor, mode, hours, qualification]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = MACHINES.find((x) => x.id === machine)!;

  // current, real status of the acquisition (monitoring)
  const per = useMemo(() => {
    const from = Math.max(m.startHour, LIVE_H - 23);
    return SENSOR_KINDS.map((s) => {
      const q = DS.quality[key(machine, s)];
      let comp = 0;
      let n = 0;
      let valid = 0;
      for (let h = from; h <= LIVE_H; h++) {
        n++;
        comp += q[h].completeness;
        if (q[h].valid) valid++;
      }
      return { s, comp: n ? comp / n : 0, valid: n ? valid / n : 0, now: qualityState(machine, s) };
    });
  }, [machine, m.startHour]);

  const avail = useMemo(() => {
    const blocks = 28;
    const span = Math.max(1, Math.ceil(period / blocks));
    const start = LIVE_H - span * blocks + 1;
    const cols = Array.from({ length: blocks }, (_, b) => fmtHour(Math.max(0, start + b * span)));
    const cells: HeatCell[][] = SENSOR_KINDS.map((s) => {
      const q = DS.quality[key(machine, s)];
      return Array.from({ length: blocks }, (_, b) => {
        let v = 0;
        let n = 0;
        let worst: keyof typeof Q_COLOR = 'ok';
        for (let h = start + b * span; h < start + (b + 1) * span; h++) {
          if (h < 0) continue;
          const st = qualityState(machine, s, h);
          n++;
          if (q[h].valid) v++;
          if (st !== 'ok' && (worst === 'ok' || st === 'clip')) worst = st;
        }
        const color = n === 0 || (worst === 'off' && v === 0) ? Q_COLOR.off : worst === 'ok' ? '#93d1b2' : Q_COLOR[worst];
        return { color, title: `${SENSOR_LABEL[s]} · ${fmtHour(start + b * span)}\nJanelas válidas: ${n ? Math.round((v / n) * 100) : 0}%\n${Q_LABEL[worst]}` };
      });
    });
    return { cols, cells };
  }, [machine, period]);

  const chart = useMemo<EChartsOption>(() => {
    const labels = sc.hours.map((h) => fmtHour(h));
    const faultStart = WINDOW_SPAN - hours;
    const unit = sc.feat === 'rms' ? 'mm/s' : 'A';
    return {
      animation: false,
      grid: [
        { left: 50, right: 16, top: 28, height: '34%' },
        { left: 50, right: 16, top: '60%', height: '28%' },
      ],
      legend: { top: 0, right: 0, textStyle: { color: '#6b7785', fontSize: 11 }, data: ['Sinal real', 'Sinal recebido', 'Score sem qualificação', 'Score com qualificação'] },
      tooltip: { ...TOOLTIP, valueFormatter: (v: any) => (v == null ? 'descartado' : Number(v).toFixed(2)) },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [
        { type: 'category', data: labels, gridIndex: 0, ...BASE_AXIS, axisLabel: { show: false } },
        { type: 'category', data: labels, gridIndex: 1, ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, interval: 11 } },
      ],
      yAxis: [
        { type: 'value', gridIndex: 0, scale: true, name: `${sc.feat === 'rms' ? 'vibração' : 'corrente'} (${unit})`, nameTextStyle: { color: '#6b7785', fontSize: 11, align: 'left' }, ...BASE_AXIS },
        { type: 'value', gridIndex: 1, min: 0, max: 1, name: 'score de anomalia', nameTextStyle: { color: '#6b7785', fontSize: 11, align: 'left' }, ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, formatter: (v: number) => `${Math.round(v * 100)}` } },
      ],
      series: [
        { name: 'Sinal real', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, color: '#9aa6b2', lineStyle: { width: 1, type: 'dashed' }, data: sc.raw },
        {
          name: 'Sinal recebido', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, color: '#2a78d6', lineStyle: { width: 1.6 }, data: sc.seen,
          markArea: { silent: true, itemStyle: { color: 'rgba(227,132,24,0.12)' }, label: { show: true, color: '#9a5208', fontSize: 10, position: 'insideTop' }, data: [[{ name: FAULT_LABEL[mode], xAxis: labels[faultStart] }, { xAxis: labels[labels.length - 1] }]] },
        },
        {
          name: 'Score sem qualificação', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, color: '#d03b3b', lineStyle: { width: 1.5 },
          data: Array.from(sc.scoreRaw, (v) => (Number.isNaN(v) ? null : +v.toFixed(3))),
          markLine: { symbol: 'none', silent: true, lineStyle: { type: 'dashed', color: '#9aa6b2' }, label: { formatter: 'limiar de atenção', color: '#6b7785', fontSize: 10, position: 'insideEndTop' }, data: [{ yAxis: 0.35 }] },
        },
        { name: 'Score com qualificação', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, color: '#1e8a5a', lineStyle: { width: 2 }, data: Array.from(sc.scoreQ, (v) => (Number.isNaN(v) ? null : +v.toFixed(3))) },
      ],
    };
  }, [sc, hours, mode]);

  // what the 3D should show
  const assetVisual = qualification
    ? { status: 'sem-referencia' as const, score: 0, color: '#8a96a3' }
    : sc.alertNowRaw
      ? { status: 'critico' as const, score: 0.8 }
      : undefined;
  const scenario = {
    view: 'machine' as const,
    focusSensor: sensor,
    sensorHalos: true,
    quality: { [sensor]: FAULT_Q[mode] },
    assets: assetVisual && sensor !== 'eletrica' ? { [sc.asset]: assetVisual } : undefined,
    badge: 'Cenário simulado',
    camera: (sensor === 'spindle' ? 'trabalho' : sensor === 'eletrica' ? 'geral' : 'agregados') as 'trabalho' | 'geral' | 'agregados',
    caption: qualification
      ? `${FAULT_LABEL[mode]} em ${SENSOR_LABEL[sensor]}: janelas descartadas, ativo sem avaliação até o reparo`
      : sc.alertNowRaw
        ? `${FAULT_LABEL[mode]} sem qualificação: alarme falso no ${ASSET_SHORT[sc.asset]}`
        : `${FAULT_LABEL[mode]} sem qualificação: o problema passa despercebido`,
  };

  const reset = () => {
    setMode('ruido');
    setHours(12);
    setQualification(true);
  };
  const costNow = 0;
  const costScen = sc.falseAlarms * FALSE_ALARM_COST;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Qualidade dos dados</h1>
          <p>Confiabilidade da coleta antes de qualquer análise · {machine}</p>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: '300px minmax(0, 1fr)' }}>
        <WhatIfPanel title="Falha de coleta" onReset={reset}>
          <Select label="Sensor" value={sensor} options={SENSOR_KINDS.map((s) => ({ v: s, label: SENSOR_LABEL[s] }))} onChange={(v) => setSensor(v as SensorKind)} />
          <Select label="Tipo de falha" value={mode} options={(Object.keys(FAULT_LABEL) as FaultMode[]).map((f) => ({ v: f, label: FAULT_LABEL[f] }))} onChange={setMode} />
          <Slider label="Duração" value={hours} min={2} max={48} unit=" h" onChange={setHours} />
          <Toggle
            label="Qualificação automática das janelas"
            checked={qualification}
            onChange={setQualification}
            hint={qualification ? 'Janelas suspeitas são descartadas e o sensor entra em manutenção.' : 'Todo dado recebido vai direto para a análise de condição.'}
          />
        </WhatIfPanel>
        <TwinSlot height={400} scenario={scenario} />
      </div>
      <div className="kpis">
        <DeltaKpi label="Janelas válidas (72 h)" now={1} scen={sc.validPct} fmt={(v) => `${Math.round(v * 100)}%`} better="higher" />
        <DeltaKpi label="Alarmes falsos" now={0} scen={sc.falseAlarms} fmt={(v) => `${v}`} />
        <DeltaKpi label="Custo dos alarmes falsos" now={costNow} scen={costScen} fmt={brl} />
        <div className="kpi">
          <div className="label">Risco para a decisão</div>
          <div className="value" style={{ fontSize: 18, color: sc.masked && !qualification ? 'var(--crit)' : qualification ? 'var(--good)' : sc.falseAlarms ? 'var(--warn)' : 'var(--good)' }}>
            {qualification ? 'Controlado' : sc.masked ? 'Falha mascarada' : sc.falseAlarms ? 'Alarme indevido' : 'Baixo'}
          </div>
          <div className="sub">
            {qualification
              ? `${hours} h sem avaliação do ativo, com ordem para reparar o sensor`
              : sc.masked
                ? 'valor congelado esconde a degradação real do ativo'
                : sc.falseAlarms
                  ? `equipe acionada sem necessidade (${brl(FALSE_ALARM_COST)} por evento)`
                  : 'sinal ainda plausível'}
          </div>
        </div>
      </div>
      <Card title={`Efeito da falha no sinal e no score · ${SENSOR_LABEL[sensor]}`} right={<small>últimas {WINDOW_SPAN} h com a falha injetada no fim</small>}>
        <EChart option={chart} height={300} />
      </Card>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(300px, 0.8fr) minmax(0, 1.4fr)' }}>
        <Card title="Estado atual da coleta" right={<small>últimas 24 h · clique para simular</small>}>
          <table className="t">
            <thead>
              <tr>
                <th>Sensor</th>
                <th style={{ textAlign: 'right' }}>Completude</th>
                <th style={{ textAlign: 'right' }}>Válidas</th>
                <th>Agora</th>
              </tr>
            </thead>
            <tbody>
              {per.map((p) => (
                <tr key={p.s} className={`click ${p.s === sensor ? 'sel' : ''}`} onClick={() => setSensor(p.s)}>
                  <td>
                    <b>{p.s === 'eletrica' ? 'Elétrica' : ASSET_SHORT[p.s]}</b>
                  </td>
                  <td style={{ textAlign: 'right' }}>{p.comp.toFixed(1).replace('.', ',')}%</td>
                  <td style={{ textAlign: 'right' }}>{Math.round(p.valid * 100)}%</td>
                  <td>
                    <span className="status" style={{ color: Q_COLOR[p.now], fontSize: 12 }}>
                      <span className="dot" style={{ background: Q_COLOR[p.now] }} />
                      {Q_LABEL[p.now]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Disponibilidade por sensor" right={<small>% de janelas válidas · histórico selecionado</small>}>
          <HeatGrid rows={SENSOR_KINDS.map((s) => SENSOR_LABEL[s])} cols={avail.cols} cells={avail.cells} colEvery={7} rowWidth={140} />
        </Card>
      </div>
    </>
  );
}
