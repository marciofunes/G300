import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { MACHINES } from '../data/generator';
import { tickLive, warmup } from '../data/live';
import { ASSET_KINDS, ASSET_LABEL, type AssetKind } from '../data/types';
import { useStore, type Period } from '../store';
import { TwinStage } from '../three/TwinStage';

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const NAV = [
  { to: '/', label: 'Visão geral', sub: 'ao vivo', icon: 'M3 12h4l3-8 4 16 3-8h4' },
  { to: '/qualidade', label: 'Qualidade dos dados', sub: 'what-if', icon: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z M9 12l2 2 4-4' },
  { to: '/referencias', label: 'Comportamento normal', sub: 'what-if', icon: 'M3 17c3-6 5-6 8-2s5 4 10-6 M3 21h18' },
  { to: '/condicao', label: 'Condição dos ativos', sub: 'what-if', icon: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M12 8a4 4 0 100 8 4 4 0 000-8z' },
  { to: '/investigacao', label: 'Investigação e decisão', sub: 'what-if', icon: 'M11 4a7 7 0 100 14 7 7 0 000-14z M21 21l-4.3-4.3' },
];

function Sidebar() {
  const machine = useStore((s) => s.machine);
  const asset = useStore((s) => s.asset);
  const period = useStore((s) => s.period);
  const setMachine = useStore((s) => s.setMachine);
  const setAsset = useStore((s) => s.setAsset);
  const setPeriod = useStore((s) => s.setPeriod);
  return (
    <aside className="sidebar">
      <div className="brand">IPMAN</div>
      <div className="brand-sub">Gêmeo digital · Usinagem</div>
      <nav className="nav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}>
            <Icon d={n.icon} />
            <span className="nav-txt">
              {n.label}
              <small>{n.sub}</small>
            </span>
          </NavLink>
        ))}
      </nav>
      <div className="side-section">Contexto</div>
      <label className="side-field">
        Máquina
        <select value={machine} onChange={(e) => setMachine(e.target.value)}>
          {MACHINES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id} · {m.cell.split(' · ')[0]}
            </option>
          ))}
        </select>
      </label>
      <label className="side-field">
        Ativo
        <select value={asset} onChange={(e) => setAsset(e.target.value as AssetKind)}>
          {ASSET_KINDS.map((a) => (
            <option key={a} value={a}>
              {ASSET_LABEL[a]}
            </option>
          ))}
        </select>
      </label>
      <label className="side-field">
        Histórico
        <select value={period} onChange={(e) => setPeriod(Number(e.target.value) as Period)}>
          <option value={24}>Últimas 24 h</option>
          <option value={168}>Últimos 7 dias</option>
          <option value={720}>Últimos 30 dias</option>
        </select>
      </label>
      <div className="side-foot">
        <span className="live-dot" /> 20 sensores · 4 máquinas
        <br />
        Linha de usinagem · 4 centros GROB G300
      </div>
    </aside>
  );
}

const CRUMB: Record<string, string> = {
  '/': 'Visão geral',
  '/qualidade': 'Qualidade dos dados',
  '/referencias': 'Comportamento normal',
  '/condicao': 'Condição dos ativos',
  '/investigacao': 'Investigação e decisão',
};

function LiveStatus() {
  useStore((s) => s.liveTick);
  const [lat] = useState(() => 70 + Math.round(Math.random() * 40));
  const now = new Date();
  const latency = lat + Math.round(Math.sin(now.getTime() / 7000) * 18);
  return (
    <div className="clock">
      <span className="conn">
        <span className="live-dot pulse" /> Ao vivo
      </span>
      <span>MQTT · {latency} ms</span>
      <span className="time">{now.toLocaleTimeString('pt-BR')}</span>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const machine = useStore((s) => s.machine);
  const bumpLive = useStore((s) => s.bumpLive);
  useEffect(() => {
    warmup();
    bumpLive();
    const id = setInterval(() => {
      tickLive();
      bumpLive();
    }, 1000);
    return () => clearInterval(id);
  }, [bumpLive]);
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            Linha de usinagem <span>/</span> {loc.pathname === '/' ? 'Visão geral' : `${machine} / ${CRUMB[loc.pathname] ?? ''}`}
          </div>
          <LiveStatus />
        </header>
        <main className="page">{children}</main>
      </div>
      <TwinStage />
    </div>
  );
}
