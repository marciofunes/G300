import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { AN, DS, qualityConfidence } from '../data/analytics';
import { PATTERN_LIBRARY } from '../data/cases';
import { key, MACHINES } from '../data/generator';
import { LIVE_H } from '../data/live';
import { COST_DEFAULT, dayInfo, decision, projection, projScore, type CostParams } from '../data/whatif';
import { CASE_STATUS_LABEL, EVENT_LABEL, SENSOR_LABEL, type AssetKind, type InvestigationCase } from '../data/types';
import { useCases, useEvents, useStore } from '../store';
import { TwinSlot } from '../three/TwinStage';
import { Bar, BASE_AXIS, brl, Card, EChart, fmtHour, Kpi, Slider, TOOLTIP, Toggle, WhatIfPanel } from '../components/ui';

const EV_COLOR: Record<string, string> = { falha: '#d03b3b', inspecao: '#6d4bb3', intervencao: '#0b7bc0', alerta: '#e38418', dados: '#8a96a3', ordem: '#1e8a5a' };

function ResultModal({ c, onClose }: { c: InvestigationCase; onClose: () => void }) {
  const registerResult = useStore((s) => s.registerResult);
  const [outcome, setOutcome] = useState('Falha confirmada');
  const [mode, setMode] = useState(c.hypotheses[0]?.label ?? '');
  const [action, setAction] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Registrar resultado · caso {c.id}</h2>
        <div className="foot-note">O retorno de campo vira evento rotulado e reforça os padrões usados nos próximos diagnósticos.</div>
        <label>
          Resultado da verificação em campo
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option>Falha confirmada</option>
            <option>Sem falha (falso positivo)</option>
            <option>Inconclusivo, manter em observação</option>
            <option>Problema de dados</option>
          </select>
        </label>
        <label>
          Modo de falha / causa
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {c.hypotheses.map((h) => (
              <option key={h.id}>{h.label}</option>
            ))}
            <option>Outro</option>
          </select>
        </label>
        <label>
          Ação executada
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="ex.: troca do rolamento do motor da bomba" />
        </label>
        <label>
          Observação
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="o que foi encontrado na inspeção" />
        </label>
        <div className="actions">
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn primary"
            onClick={() => {
              registerResult(c.id, { outcome, mode, action, note, hour: LIVE_H }, c);
              onClose();
            }}
          >
            Registrar
          </button>
        </div>
      </div>
    </div>
  );
}

export function Investigacao() {
  const caseId = useStore((s) => s.caseId);
  const setCase = useStore((s) => s.setCase);
  const setMachine = useStore((s) => s.setMachine);
  const setAsset = useStore((s) => s.setAsset);
  const addEvent = useStore((s) => s.addEvent);
  const resetFeedback = useStore((s) => s.resetFeedback);
  const feedbackCount = useStore((s) => s.feedback.events.length);
  const cases = useCases();
  const events = useEvents();
  const [modal, setModal] = useState(false);
  const [costs, setCosts] = useState<CostParams>(COST_DEFAULT);
  const [day, setDay] = useState<number | null>(null);
  const [showStop, setShowStop] = useState(false);
  const c = cases.find((x) => x.id === caseId) ?? cases[0];
  const conditionCase = c.asset !== 'eletrica' && c.origin !== 'Qualidade de dados' && c.status !== 'encerrado';
  const asset = (c.asset === 'eletrica' ? 'spindle' : c.asset) as AssetKind;

  const select = (id: string) => {
    const cc = cases.find((x) => x.id === id)!;
    setCase(id);
    setMachine(cc.machine);
    if (cc.asset !== 'eletrica') setAsset(cc.asset as AssetKind);
    setDay(null);
    setShowStop(false);
  };

  const pr = useMemo(() => projection({ machine: c.machine, asset, mode: 'rolamento', rate: 'moderada', threshold: 0.35, window: 12, horizon: 0 }), [c.machine, asset]);
  const dec = useMemo(() => decision(pr.failDay, pr.failEarly, pr.failLate, costs), [pr, costs]);
  const d = day ?? dec.best.d;
  const row = dec.rows[d];
  const saving = dec.corrective - row.expected;
  const order = events.find((e) => e.kind === 'ordem' && e.caseId === c.id);

  const scoreAtDay = projScore(pr.e0, 0.11, 1.35, d);
  const scenario = conditionCase
    ? {
        view: 'machine' as const,
        focusAsset: asset,
        camera: (asset === 'spindle' ? 'trabalho' : 'agregados') as 'trabalho' | 'agregados',
        frame: showStop ? { stopped: true, maintenance: asset } : undefined,
        assets: showStop ? undefined : { [asset]: { status: scoreAtDay >= 0.65 ? ('critico' as const) : ('atencao' as const), score: scoreAtDay } },
        badge: showStop ? 'Intervenção simulada' : `Sem intervenção até ${row.label}`,
        caption: showStop
          ? `${row.label}${row.sunday ? ' (domingo, parada programada)' : ''}: máquina parada para troca do rolamento · ${costs.plannedH} h`
          : `${SENSOR_LABEL[c.asset]} em ${row.label}: score projetado ${Math.round(scoreAtDay * 100)} · risco de falha ${Math.round(row.p * 100)}%`,
      }
    : { view: 'machine' as const, focusSensor: c.asset, sensorHalos: true, badge: 'Caso de dados', caption: c.summary };

  const costChart = useMemo<EChartsOption>(() => {
    return {
      animation: false,
      grid: { left: 60, right: 16, top: 30, bottom: 34 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: '#fff', borderColor: '#dfe4ea', textStyle: { color: '#1d2a36', fontSize: 12 },
        formatter: (ps: any) => {
          const r = dec.rows[ps[0].dataIndex];
          return `<b>${r.label}${r.sunday ? ' · domingo' : ''}</b><br/>Custo esperado: ${brl(r.expected)}<br/>Risco de falha antes: ${Math.round(r.p * 100)}%${r.feasible ? '' : '<br/>Antes do prazo de preparação'}`;
        },
      },
      xAxis: { type: 'category', data: dec.rows.map((r) => (r.sunday ? `${r.label} dom` : r.label)), ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, interval: 1, rotate: 0 } },
      yAxis: { type: 'value', name: 'custo esperado (R$)', nameTextStyle: { color: '#6b7785', fontSize: 11, align: 'left' }, ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, formatter: (v: number) => `${Math.round(v / 1000)} mil` } },
      series: [
        {
          type: 'bar',
          barWidth: '62%',
          data: dec.rows.map((r) => ({
            value: Math.round(r.expected),
            itemStyle: {
              color: !r.feasible ? '#e6eaee' : r.d === dec.best.d ? '#1e8a5a' : r.sunday ? '#86b6ef' : '#c3d4e6',
              borderColor: r.d === d ? '#1d2a36' : 'transparent',
              borderWidth: 2,
              borderRadius: [4, 4, 0, 0],
            },
          })),
          markLine: { symbol: 'none', silent: true, lineStyle: { color: '#d03b3b', type: 'dashed' }, label: { formatter: `operar até falhar: ${brl(dec.corrective)}`, color: '#d03b3b', fontSize: 10, position: 'insideEndTop' }, data: [{ yAxis: dec.corrective }] },
        },
      ],
    };
  }, [dec, d]);

  const timeline = useMemo<EChartsOption>(() => {
    const s = DS.series[key(c.machine, asset)];
    const a = AN[key(c.machine, asset)];
    const from = Math.max(0, c.openedHour - 120);
    const xs: number[] = [];
    for (let h = from; h <= LIVE_H; h++) xs.push(h);
    const labels = xs.map((h) => fmtHour(h));
    const evs = events.filter((e) => e.machine === c.machine && (e.asset === c.asset || e.caseId === c.id) && e.hour >= from && e.kind !== 'ordem');
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 26, bottom: 26 },
      legend: { top: 0, right: 0, textStyle: { color: '#6b7785', fontSize: 11 }, data: ['Vibração RMS', 'Referência'] },
      tooltip: { ...TOOLTIP, valueFormatter: (v: any) => (v == null ? '--' : Number(v).toFixed(2)) },
      xAxis: { type: 'category', data: labels, ...BASE_AXIS, axisLabel: { ...BASE_AXIS.axisLabel, interval: Math.floor(xs.length / 6) } },
      yAxis: { type: 'value', scale: true, name: 'RMS (mm/s)', nameTextStyle: { color: '#6b7785', fontSize: 11, align: 'left' }, ...BASE_AXIS },
      series: [
        {
          name: 'Vibração RMS', type: 'line', showSymbol: false, color: '#2a78d6', lineStyle: { width: 1.4 },
          data: xs.map((h) => (Number.isNaN(s.features.rms[h]) ? null : +s.features.rms[h].toFixed(3))),
          markLine: {
            symbol: 'none', silent: true,
            data: evs.map((e) => ({ xAxis: fmtHour(e.hour), lineStyle: { color: EV_COLOR[e.kind], width: 1.5, type: 'solid' }, label: { formatter: EVENT_LABEL[e.kind], color: EV_COLOR[e.kind], fontSize: 10, position: 'insideEndTop' } })) as any,
          },
        },
        {
          name: 'Referência', type: 'line', showSymbol: false, color: '#9aa6b2', lineStyle: { width: 1, type: 'dashed' },
          data: xs.map((h) => {
            const b = a.baselines[s.regime[h]];
            return b?.ready && s.regime[h] !== 'parada' ? +b.mean.rms.toFixed(3) : null;
          }),
        },
      ],
    };
  }, [c, asset, events]);

  const conf = qualityConfidence(c.machine, c.asset, LIVE_H);
  const machineDef = MACHINES.find((m) => m.id === c.machine)!;
  const durH = (c.closedHour ?? LIVE_H) - c.openedHour;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Investigação e decisão</h1>
          <p>
            Caso {c.id} · {c.machine} / {SENSOR_LABEL[c.asset]} · {c.title}
          </p>
        </div>
        <div className="trail">
          {cases.map((x) => (
            <button key={x.id} className={`chip ${x.id === c.id ? '' : 'grey'}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => select(x.id)}>
              {x.id} · {x.machine} · {CASE_STATUS_LABEL[x.status]}
            </button>
          ))}
        </div>
      </div>
      <div className="kpis">
        <Kpi label="Origem" value={c.origin} sub={machineDef.cell} color="var(--accent)" />
        <Kpi label="Duração" value={`${durH} h`} sub={`aberto em ${fmtHour(c.openedHour)}`} />
        <Kpi label="Qualidade dos dados" value={conf > 0.9 ? 'Adequada' : conf > 0.6 ? 'Parcial' : 'Insuficiente'} sub={`${Math.round(conf * 100)}% de janelas válidas (24 h)`} color={conf > 0.9 ? 'var(--good)' : 'var(--warn)'} />
        <Kpi label="Status" value={order && c.status !== 'encerrado' ? 'Programado' : CASE_STATUS_LABEL[c.status]} sub={order ? order.title : c.result ? c.result.outcome : 'aguardando decisão'} color="var(--ref)" />
      </div>

      {conditionCase ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: '300px minmax(0, 1fr)' }}>
            <WhatIfPanel title="Quando intervir?" onReset={() => { setCosts(COST_DEFAULT); setDay(null); setShowStop(false); }}>
              <Slider label="Data da intervenção" value={d} min={0} max={21} format={(v) => `${dec.rows[v].label}${dec.rows[v].sunday ? ' (dom)' : ''} · em ${v} d`} onChange={setDay} />
              <Toggle label="Visualizar a máquina em manutenção" checked={showStop} onChange={setShowStop} />
              <Slider label="Margem perdida por hora parada" value={costs.marginHour} min={1000} max={6000} step={100} format={(v) => brl(v)} onChange={(v) => setCosts({ ...costs, marginHour: v })} />
              <Slider label="Duração do reparo planejado" value={costs.plannedH} min={2} max={16} unit=" h" onChange={(v) => setCosts({ ...costs, plannedH: v })} />
              <Slider label="Custo do reparo corretivo" value={costs.correctiveCost} min={8000} max={60000} step={500} format={(v) => brl(v)} onChange={(v) => setCosts({ ...costs, correctiveCost: v })} hint={`inclui dano secundário · ${costs.correctiveH} h de parada`} />
              <Slider label="Prazo para peças e equipe" value={costs.prepDays} min={0} max={7} unit=" d" onChange={(v) => setCosts({ ...costs, prepDays: v })} />
            </WhatIfPanel>
            <TwinSlot height={400} scenario={scenario} />
          </div>
          <div className="kpis">
            <Kpi label="Custo esperado na data" value={brl(row.expected)} sub={`${row.label}${row.sunday ? ' · parada programada' : ''}`} color={row.d === dec.best.d ? 'var(--good)' : 'var(--text)'} />
            <Kpi label="Operar até falhar" value={brl(dec.corrective)} sub={`${costs.correctiveH} h de parada + reparo corretivo`} color="var(--crit)" />
            <Kpi label="Economia esperada" value={brl(Math.max(0, saving))} sub="em relação a operar até a falha" color="var(--good)" />
            <Kpi label="Risco de falha antes" value={`${Math.round(row.p * 100)}%`} sub={`falha provável em ${dayInfo(Math.round(pr.failDay)).label}`} color={row.p > 0.2 ? 'var(--crit)' : row.p > 0.05 ? 'var(--warn)' : 'var(--good)'} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(300px, 1fr)' }}>
            <Card title="Custo esperado por data de intervenção" right={<small>verde = melhor data · azul = domingos</small>}>
              <EChart option={costChart} height={250} onClick={(p) => setDay(p.dataIndex)} />
            </Card>
            <Card title="Recomendação">
              <div className="reco">
                <b>
                  Programar a troca do rolamento da {SENSOR_LABEL[c.asset].toLowerCase()} para {dec.best.sunday ? 'domingo, ' : ''}
                  {dec.best.label}
                </b>
                <p>
                  Custo esperado de {brl(dec.best.expected)} contra {brl(dec.corrective)} de operar até a falha. Risco de falha até lá: {Math.round(dec.best.p * 100)}%.
                  {dec.best.sunday ? ' A troca aproveita a parada programada e não perde produção.' : ''}
                </p>
                {order ? (
                  <div className="chip">✓ {order.title}</div>
                ) : (
                  <button
                    className="btn primary"
                    onClick={() => {
                      addEvent({ machine: c.machine, asset: c.asset, hour: LIVE_H, kind: 'ordem', title: `OM-${4810 + cases.indexOf(c)} programada para ${dec.best.label}`, detail: `Troca do rolamento · ${costs.plannedH} h`, caseId: c.id });
                      setDay(dec.best.d);
                    }}
                  >
                    Criar ordem de manutenção
                  </button>
                )}
              </div>
            </Card>
          </div>
        </>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: '300px minmax(0, 1fr)' }}>
          <Card title="Resumo">
            <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>{c.summary}</p>
            {c.result && (
              <div className="hyp" style={{ marginTop: 12, background: '#f6f2fc', borderColor: '#d9ccf2' }}>
                <div className="top">
                  <span>Resultado registrado</span>
                  <span>{c.closedHour ? fmtHour(c.closedHour) : ''}</span>
                </div>
                <p>
                  <b>{c.result.outcome}</b> · {c.result.mode}
                  {c.result.action ? ` · ${c.result.action}` : ''}
                </p>
              </div>
            )}
          </Card>
          <TwinSlot height={400} scenario={scenario} />
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr)' }}>
        <Card title="Linha do tempo" right={<small>sinal, referência e ocorrências de campo</small>}>
          <EChart option={timeline} height={220} />
          <div className="timeline-events" style={{ marginTop: 8 }}>
            {events
              .filter((e) => e.machine === c.machine && (e.asset === c.asset || e.caseId === c.id))
              .slice(-4)
              .reverse()
              .map((e) => (
                <div key={e.id} className={`ev ${e.kind}`}>
                  <span>
                    <b style={{ color: EV_COLOR[e.kind] }}>{EVENT_LABEL[e.kind]}</b>
                    <div className="when">{fmtHour(e.hour)}</div>
                  </span>
                  <span>
                    {e.title}
                    {e.detail && <div className="foot-note">{e.detail}</div>}
                  </span>
                </div>
              ))}
          </div>
        </Card>
        <Card title="Hipóteses" right={<small>suporte das evidências</small>}>
          {c.hypotheses.map((hy) => (
            <div className="hyp" key={hy.id}>
              <div className="top">
                <span>{hy.label}</span>
                <span>{Math.round(hy.support * 100)}%</span>
              </div>
              <div style={{ marginTop: 6 }}>
                <Bar value={hy.support} color="#6d4bb3" />
              </div>
              <p>{hy.evidence}</p>
              {hy.missing && <p className="missing">Para confirmar: {hy.missing}</p>}
            </div>
          ))}
          {!c.result && (
            <button className="btn" style={{ width: '100%', justifyContent: 'center', padding: 9 }} onClick={() => setModal(true)}>
              Registrar resultado de campo
            </button>
          )}
        </Card>
        <Card title="Padrões aprendidos" right={<small>alimentados pelos retornos de campo</small>}>
          <table className="t">
            <tbody>
              {PATTERN_LIBRARY.map((p) => {
                const confirmed = p.id === 'pat-rolamento' && cases.find((x) => x.id === '#0007')?.result?.outcome === 'Falha confirmada';
                return (
                  <tr key={p.id}>
                    <td>
                      <b>{p.label}</b> <span className="foot-note">· {p.asset}</span>
                      <div className="foot-note">{p.signature}</div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <span className={`chip ${confirmed || p.confirmations ? '' : 'risk'}`}>{confirmed ? 'confirmado' : p.confirmations ? `${p.confirmations} confirm.` : 'candidato'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {feedbackCount > 0 && (
            <button className="btn" style={{ marginTop: 10 }} onClick={resetFeedback}>
              Desfazer registros desta sessão ({feedbackCount})
            </button>
          )}
        </Card>
      </div>
      {modal && <ResultModal c={c} onClose={() => setModal(false)} />}
    </>
  );
}
