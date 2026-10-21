import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);
import { useEffect, useRef, type ReactNode } from 'react';
import { hourToDate } from '../data/generator';
import { STATUS_LABEL, type Status } from '../data/types';
import { STATUS_COLOR } from '../three/MachineTwin';

export function EChart({ option, height = 220, onClick }: { option: EChartsOption; height?: number; onClick?: (p: any) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p) => clickRef.current?.(p));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true, lazyUpdate: true, silent: true });
  }, [option]);
  return <div ref={ref} style={{ width: '100%', height }} />;
}

export const BASE_AXIS = {
  axisLine: { lineStyle: { color: '#c9d1d9' } },
  axisTick: { show: false },
  axisLabel: { color: '#6b7785', fontSize: 11 },
  splitLine: { lineStyle: { color: '#eef1f4' } },
};
export const TOOLTIP = {
  trigger: 'axis' as const,
  backgroundColor: '#fff',
  borderColor: '#dfe4ea',
  textStyle: { color: '#1d2a36', fontSize: 12 },
  axisPointer: { type: 'line' as const, lineStyle: { color: '#9aa6b2' } },
};

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const c = STATUS_COLOR[status];
  if (status === 'normal')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="7" fill={c} />
        <path d="M4.5 8.2l2.2 2.2 4.6-4.8" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
    );
  if (status === 'atencao')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <path d="M8 1.5l7 12.5H1z" fill={c} />
        <rect x="7.2" y="5.5" width="1.6" height="4.6" fill="#fff" />
        <rect x="7.2" y="11.2" width="1.6" height="1.6" fill="#fff" />
      </svg>
    );
  if (status === 'critico')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <rect x="1" y="1" width="14" height="14" rx="3" fill={c} />
        <path d="M5 5l6 6M11 5l-6 6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={c} strokeWidth="2" strokeDasharray="3 2" />
    </svg>
  );
}

export function StatusBadge({ status, big }: { status: Status; big?: boolean }) {
  return (
    <span className="status" style={{ color: STATUS_COLOR[status], fontSize: big ? 24 : undefined }}>
      <StatusIcon status={status} size={big ? 20 : 14} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Kpi({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value" style={{ color }}>
        {value}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Card({ title, right, hint, children, style }: { title: ReactNode; right?: ReactNode; hint?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="card" style={style}>
      <h3>
        <span>{title}</span>
        {right}
      </h3>
      {hint && <div className="hint">{hint}</div>}
      {children}
    </div>
  );
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export function fmtHour(h: number, withDow = false) {
  const d = new Date(hourToDate(Math.floor(h)).getTime() - 3 * 3600_000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${withDow ? DOW[d.getUTCDay()] + ' ' : ''}${dd}/${mm} ${hh}:00`;
}
export function fmtDay(h: number) {
  const d = new Date(hourToDate(Math.floor(h)).getTime() - 3 * 3600_000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export const pct = (x: number, d = 0) => (Number.isNaN(x) ? '--' : `${(x * 100).toFixed(d)}%`);
export const num = (x: number, d = 1) => (Number.isNaN(x) ? '--' : x.toFixed(d).replace('.', ','));

export function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="bar">
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, unit = '', onChange, format, hint }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; format?: (v: number) => string; hint?: string;
}) {
  return (
    <label className="ctl">
      <span className="ctl-top">
        <span>{label}</span>
        <b>{format ? format(value) : `${value.toLocaleString('pt-BR')}${unit}`}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="ctl-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="ctl toggle-ctl">
      <span className="ctl-top">
        <span>{label}</span>
        <span className={`switch ${checked ? 'on' : ''}`} onClick={(e) => { e.preventDefault(); onChange(!checked); }}>
          <i />
        </span>
      </span>
      {hint && <span className="ctl-hint">{hint}</span>}
    </label>
  );
}

export function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="ctl">
      <span className="ctl-top">
        <span>{label}</span>
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** KPI comparing the current operation with the simulated scenario. */
export function DeltaKpi({ label, now, scen, fmt, better = 'lower', unit = '' }: {
  label: string; now: number; scen: number; fmt: (v: number) => string; better?: 'lower' | 'higher' | 'none'; unit?: string;
}) {
  const diff = scen - now;
  const rel = now !== 0 ? diff / Math.abs(now) : 0;
  const good = better === 'none' || Math.abs(rel) < 0.005 ? null : better === 'lower' ? diff < 0 : diff > 0;
  const color = good === null ? 'var(--muted)' : good ? 'var(--good)' : 'var(--crit)';
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">
        {fmt(scen)}
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>{unit}</span>
      </div>
      <div className="sub">
        atual {fmt(now)}{' '}
        {Math.abs(rel) >= 0.005 && (
          <b style={{ color }}>
            {diff > 0 ? '▲' : '▼'} {Math.abs(rel * 100).toFixed(rel > 9.99 ? 0 : 1)}%
          </b>
        )}
      </div>
    </div>
  );
}

export function WhatIfPanel({ title, children, onReset }: { title: string; children: ReactNode; onReset?: () => void }) {
  return (
    <div className="card whatif-panel">
      <h3>
        <span>
          <span className="chip whatif">What-if</span> {title}
        </span>
        {onReset && (
          <button className="btn" onClick={onReset}>
            Restaurar
          </button>
        )}
      </h3>
      <div className="ctl-list">{children}</div>
    </div>
  );
}

export const brl = (v: number) => `R$ ${v >= 10000 ? (v / 1000).toFixed(1).replace('.', ',') + ' mil' : Math.round(v).toLocaleString('pt-BR')}`;

export type HeatCell = { color: string; label?: string; title?: string };
export function HeatGrid({
  rows,
  cols,
  cells,
  onCell,
  colEvery = 1,
  rowWidth = 130,
  cellH = 26,
  showLabels = false,
}: {
  rows: string[];
  cols: string[];
  cells: HeatCell[][];
  onCell?: (r: number, c: number) => void;
  colEvery?: number;
  rowWidth?: number;
  cellH?: number;
  showLabels?: boolean;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `${rowWidth}px repeat(${cols.length}, minmax(0, 1fr))`, gap: 3, fontSize: 11.5, alignItems: 'center' }}>
      {rows.map((r, ri) => (
        <div key={r} style={{ display: 'contents' }}>
          <div style={{ color: '#52606d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r}</div>
          {cells[ri].map((c, ci) => (
            <div
              key={ci}
              title={c.title}
              onClick={() => onCell?.(ri, ci)}
              style={{
                background: c.color,
                height: cellH,
                borderRadius: 4,
                display: 'grid',
                placeItems: 'center',
                color: '#1d2a36',
                fontVariantNumeric: 'tabular-nums',
                cursor: onCell ? 'pointer' : 'default',
              }}
            >
              {showLabels ? c.label : null}
            </div>
          ))}
        </div>
      ))}
      <div />
      {cols.map((c, i) => (
        <div key={i} style={{ color: '#6b7785', fontSize: 10.5, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'visible' }}>
          {i % colEvery === 0 ? c : ''}
        </div>
      ))}
    </div>
  );
}
