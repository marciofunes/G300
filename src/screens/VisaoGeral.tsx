import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EChartsOption } from 'echarts';
import { AN, DS, healthIndex, queueAt } from '../data/analytics';
import { key, MACHINES } from '../data/generator';
import { worstStatus } from '../data/helpers';
import { BUFFER_S, dayKpis, events, LIVE_H, livePower, liveRms, liveTimes, ringValues } from '../data/live';
import { ASSET_KINDS, ASSET_LABEL, ASSET_SHORT, STATUS_LABEL } from '../data/types';
import { useCases, useStore } from '../store';
import { STATUS_COLOR } from '../three/MachineTwin';
import { phaseAt, PHASE_LABEL, programTime } from '../three/program';
import { TwinSlot } from '../three/TwinStage';
import { COST_DEFAULT, decision, projection } from '../data/whatif';
import { BASE_AXIS, brl, Card, EChart, Kpi, StatusIcon, TOOLTIP } from '../components/ui';

const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#6250d6'];
const EV_COLOR: Record<string, string> = { ciclo: '#1e8a5a', troca: '#0b7bc0', alerta: '#e38418', dados: '#8a96a3', info: '#6b7785' };

function timeLabels() {
  return ringValues(liveTimes).map((t) => (Number.isNaN(t) ? '' : new Date(t * 1000).toLocaleTimeString('pt-BR')));
}

export function VisaoGeral() {
  const tick = useStore((s) => s.liveTick);
  const machine = useStore((s) => s.machine);
  const setMachine = useStore((s) => s.setMachine);
  const setAsset = useStore((s) => s.setAsset);
  const setCase = useStore((s) => s.setCase);
  const nav = useNavigate();
  const cases = useCases();

  const kpis = MACHINES.map((m) => ({ m, k: dayKpis(m.id) }));
  const parts = kpis.reduce((s, x) => s + x.k.parts, 0);
  const energy = kpis.reduce((s, x) => s + x.k.energy, 0);
  const oee = kpis.reduce((s, x) => s + x.k.oee, 0) / kpis.length;
  let hiSum = 0;
  let hiN = 0;
  let attention = 0;
  for (const m of MACHINES)
    for (const a of ASSET_KINDS) {
      const hi = healthIndex(m.id, a, LIVE_H);
      if (!Number.isNaN(hi)) {
        hiSum += hi;
        hiN++;
      }
      const st = AN[key(m.id, a)].status[LIVE_H];
      if (st === 'atencao' || st === 'critico') attention++;
    }
  const queue = useMemo(() => queueAt(LIVE_H), []);
  const value = useMemo(() => {
    const p = projection({ machine: 'G300-01', asset: 'bomba-hidraulica', mode: 'rolamento', rate: 'moderada', threshold: 0.35, window: 12, horizon: 0 });
    const d = decision(p.failDay, p.failEarly, p.failLate, COST_DEFAULT);
    return { lead: Math.round(p.leadDays), saving: d.corrective - d.best.expected };
  }, []);
  const powerNow = (id: string) => {
    const r = livePower(id);
    return r.v[(r.i - 1 + BUFFER_S) % BUFFER_S];
  };

  const vib = useMemo<EChartsOption>(() => {
    const labels = timeLabels();
    return {
      animation: false,
      grid: { left: 40, right: 12, top: 30, bottom: 24 },
      legend: { top: 0, right: 0, textStyle: { color: '#6b7785', fontSize: 11 }, itemWidth: 14, itemHeight: 3 },
      tooltip: { ...TOOLTIP, valueFormatter: (v: any) => (v == null ? '--' : `${Number(v).toFixed(2)} mm/s`) },
      xAxis: { type: 'category', data: labels, ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, interval: 59 } },
      yAxis: { type: 'value', name: 'vibração RMS (mm/s)', nameTextStyle: { color: '#6b7785', fontSize: 11, align: 'left' }, ...BASE_AXIS },
      series: ASSET_KINDS.map((a, i) => ({
        name: ASSET_SHORT[a],
        type: 'line',
        showSymbol: false,
        color: SERIES[i],
        lineStyle: { width: 1.6 },
        data: ringValues(liveRms(machine, a)).map((v) => (Number.isNaN(v) ? null : +v.toFixed(3))),
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, machine]);

  const pw = useMemo<EChartsOption>(() => {
    const labels = timeLabels();
    return {
      animation: false,
      grid: { left: 40, right: 12, top: 30, bottom: 24 },
      legend: { top: 0, right: 0, textStyle: { color: '#6b7785', fontSize: 11 }, itemWidth: 14, itemHeight: 3 },
      tooltip: { ...TOOLTIP, valueFormatter: (v: any) => (v == null ? '--' : `${Number(v).toFixed(1)} kW`) },
      xAxis: { type: 'category', data: labels, ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, interval: 59 } },
      yAxis: { type: 'value', name: 'potência ativa (kW)', nameTextStyle: { color: '#6b7785', fontSize: 11, align: 'left' }, ...BASE_AXIS },
      series: MACHINES.map((m, i) => ({
        name: m.id,
        type: 'line',
        showSymbol: false,
        color: SERIES[i],
        lineStyle: { width: m.id === machine ? 2.2 : 1.2, opacity: m.id === machine ? 1 : 0.65 },
        data: ringValues(livePower(m.id)).map((v) => (Number.isNaN(v) ? null : +v.toFixed(2))),
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, machine]);

  // value delivered in the last 30 days (estimated)
  let invalidEpisodes = 0;
  for (const m of MACHINES)
    for (const a of ASSET_KINDS) {
      const q = DS.quality[key(m.id, a)];
      for (let h = LIVE_H - 719 + 1; h <= LIVE_H; h++) if (!q[h].valid && q[h - 1].valid && h >= m.startHour) invalidEpisodes++;
    }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Visão geral</h1>
          <p>Operação da linha em tempo real · 4 centros de usinagem GROB G300</p>
        </div>
      </div>
      <div className="kpis">
        <Kpi label="Peças hoje" value={parts.toLocaleString('pt-BR')} sub="somatório da linha, atualizado a cada ciclo" color="var(--accent)" />
        <Kpi label="OEE do dia" value={`${Math.round(oee * 100)}%`} sub="disponibilidade × desempenho × qualidade" color={oee > 0.75 ? 'var(--good)' : 'var(--warn)'} />
        <Kpi label="Energia hoje" value={`${Math.round(energy).toLocaleString('pt-BR')} kWh`} sub={`${(energy / Math.max(1, parts)).toFixed(2).replace('.', ',')} kWh por peça`} />
        <Kpi label="Saúde da frota" value={hiN ? Math.round(hiSum / hiN) : '--'} sub="Health Index médio dos 16 ativos" color="var(--good)" />
        <Kpi label="Ativos em atenção" value={attention} sub="desvio persistente confirmado" color={attention ? 'var(--warn)' : 'var(--good)'} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: '300px minmax(0, 1fr)' }}>
        <Card title="Máquinas" right={<small>agora</small>}>
          <div className="mlist">
            {kpis.map(({ m, k }) => {
              const st = worstStatus(m.id);
              const running = DS.regime[m.id][LIVE_H] !== 'parada';
              return (
                <button key={m.id} className={`mcard ${m.id === machine ? 'sel' : ''}`} onClick={() => setMachine(m.id)}>
                  <span className="mcard-top">
                    <b>{m.id}</b>
                    <span className="status" style={{ color: STATUS_COLOR[st], fontSize: 12 }}>
                      <StatusIcon status={st} size={12} /> {STATUS_LABEL[st]}
                    </span>
                  </span>
                  <span className="foot-note">{m.cell}</span>
                  <span className="mcard-kpis">
                    <span>{running ? PHASE_LABEL[phaseAt(programTime(m.id))] : 'Parada programada'}</span>
                    <span>
                      <b>{k.parts.toLocaleString('pt-BR')}</b> peças · <b>{Math.round(k.oee * 100)}%</b> OEE · <b>{(powerNow(m.id) || 0).toFixed(1).replace('.', ',')}</b> kW
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Card>
        <TwinSlot height={400} scenario={{ view: 'plant', caption: 'Clique em uma máquina para selecionar · arraste para girar' }} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <Card title={`Telemetria ao vivo · ${machine}`} right={<small>1 amostra/s · últimos 3 min</small>}>
          <EChart option={vib} height={230} />
        </Card>
        <Card title="Consumo elétrico ao vivo" right={<small>medidores trifásicos</small>}>
          <EChart option={pw} height={230} />
        </Card>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr)' }}>
        <Card title="Eventos em tempo real" right={<small>ciclos, trocas e alertas</small>}>
          <div className="feed">
            {events.slice(0, 9).map((e) => (
              <div key={e.id} className="feed-row">
                <span className="when">{new Date(e.t * 1000).toLocaleTimeString('pt-BR')}</span>
                <span className="dot" style={{ background: EV_COLOR[e.kind] }} />
                <b>{e.machine}</b>
                <span>{e.text}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Precisa de atenção" right={<small>prioridade = severidade × persistência × confiança</small>}>
          <div className="queue">
            {queue.slice(0, 4).map((q, i) => (
              <button
                key={q.machine + q.asset}
                className={`qitem ${i === 0 ? 'first' : ''}`}
                onClick={() => {
                  setMachine(q.machine);
                  setAsset(q.asset);
                  const c = cases.find((c) => c.machine === q.machine && c.asset === q.asset && c.status !== 'encerrado');
                  if (c) {
                    setCase(c.id);
                    nav('/investigacao');
                  } else nav('/condicao');
                }}
              >
                <span className="rank">{i + 1}</span>
                <span>
                  <b>
                    {q.machine} · {ASSET_LABEL[q.asset]}
                  </b>
                  <div className="meta">{q.reason}</div>
                </span>
                <span style={{ textAlign: 'right' }}>
                  <b style={{ color: STATUS_COLOR[q.status === 'normal' ? 'atencao' : q.status] }}>{q.priority}</b>
                </span>
              </button>
            ))}
          </div>
        </Card>
        <Card title="Valor gerado · últimos 30 dias" right={<small>estimado</small>}>
          <div className="value-list">
            <div>
              <b>1</b>
              <span>
                parada não planejada evitada
                <small>desbalanceamento da ferramenta T12 no spindle da G300-01</small>
              </span>
              <em>{brl(38600)}</em>
            </div>
            <div>
              <b>{invalidEpisodes}</b>
              <span>
                alarmes falsos filtrados
                <small>janelas com falha de aquisição descartadas antes da análise</small>
              </span>
              <em>{brl(invalidEpisodes * 420)}</em>
            </div>
            <div>
              <b>{value.lead} dias</b>
              <span>
                de antecedência
                <small>desgaste na bomba hidráulica da G300-01 detectado antes da falha</small>
              </span>
              <em>{brl(value.saving)}</em>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
