/**
 * One persistent WebGL stage for the whole app.
 *
 * The canvas is created once (shaders compiled and textures uploaded once, behind a loading
 * overlay) and then floats over whichever <TwinSlot> the current screen renders. Switching
 * screens only moves the stage and changes what it shows: no context is recreated.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { createGROBG300MachiningCenterEnvironment } from './generated/createGrobG300Model';
import { getTemplate, MachineTwin, setXray, STATUS_COLOR, type TwinFrameState } from './MachineTwin';
import { AN, DS } from '../data/analytics';
import { key, MACHINES } from '../data/generator';
import { liveFrame, worstStatus } from '../data/helpers';
import { LIVE_H } from '../data/live';
import { ASSET_KINDS, ASSET_SHORT, REGIME_LABEL, type SensorKind } from '../data/types';
import { useStore, type CamPreset, type TwinScenario, type TwinView } from '../store';
import { phaseAt, PHASE_LABEL, programTime } from './program';

const PLANT_X = [-7.8, -2.6, 2.6, 7.8];
const LABEL_OFFSET: Record<string, [number, number]> = {
  spindle: [-50, -24],
  'bomba-refrigeracao': [58, -10],
  'bomba-hidraulica': [58, -4],
  'bomba-alta-pressao': [58, 30],
};

export const CAM_PRESETS: Record<CamPreset | 'plant', { label: string; pos: [number, number, number]; tgt: [number, number, number] }> = {
  plant: { label: 'Planta', pos: [-3.4, 6.6, 13.6], tgt: [0, 1.2, 0] },
  geral: { label: 'Máquina', pos: [-5.6, 4.4, 3.4], tgt: [-0.55, 1.35, 0.25] },
  trabalho: { label: 'Área de trabalho', pos: [-1.0, 2.35, 0.8], tgt: [-1.5, 1.45, 0.38] },
  agregados: { label: 'Bombas', pos: [0.6, 2.7, 4.6], tgt: [1.45, 1.15, 0.45] },
};

// ------------------------------------------------------------------ slot
export function TwinSlot({ height = 380, scenario }: { height?: number; scenario: TwinScenario }) {
  const ref = useRef<HTMLDivElement>(null);
  const setSlot = useStore((s) => s.setSlot);
  const setScenario = useStore((s) => s.setScenario);
  const json = JSON.stringify(scenario);
  useEffect(() => {
    setSlot(ref.current);
    return () => setSlot(null);
  }, [setSlot]);
  useEffect(() => {
    setScenario(JSON.parse(json));
  }, [json, setScenario]);
  const cam = scenario.camera;
  useEffect(() => {
    if (cam && useStore.getState().camPreset !== cam) useStore.getState().setCamPreset(cam);
  }, [cam]);
  return <div ref={ref} className="twin-slot" style={{ height }} />;
}

// ------------------------------------------------------------------ scene
type Boot = (stage: string, progress?: number) => void;

function frameFor(id: string, view: TwinView, selected: string, sc: TwinScenario): TwinFrameState {
  const f = liveFrame(id);
  if (view === 'machine' && id === selected) {
    if (sc.assets) for (const [a, v] of Object.entries(sc.assets)) if (v) f.assets[a as keyof typeof f.assets] = v;
    if (sc.quality) for (const [s, v] of Object.entries(sc.quality)) if (v) f.quality[s as SensorKind] = v;
    Object.assign(f, sc.frame ?? {});
    f.focusAsset = sc.focusAsset;
    f.focusSensor = sc.focusSensor;
    f.sensorHalos = sc.sensorHalos;
  }
  return f;
}

function Scene({ onBoot, anchors }: { onBoot: Boot; anchors: MutableRefObject<Map<string, THREE.Vector3>> }) {
  const { gl, scene, camera } = useThree();
  const [twins, setTwins] = useState<MachineTwin[]>([]);
  const lamp = useRef<THREE.PointLight>(null);
  const setTwinReady = useStore((s) => s.setTwinReady);
  const view = useStore((s) => s.scenario.view);
  const machine = useStore((s) => s.machine);
  const xray = useStore((s) => s.xray);

  // ---- boot: build after the loader has painted, wait for textures, precompile
  useEffect(() => {
    let cancelled = false;
    // production: never block the main thread waiting for link status; compileAsync polls it
    gl.debug.checkShaderErrors = import.meta.env.DEV;
    (window as unknown as { __gl: THREE.WebGLRenderer }).__gl = gl;
    gl.capabilities.getMaxAnisotropy(); // query once now, before GPU work is queued (avoids a later pipeline stall)
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 0.8;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.type = THREE.PCFShadowMap;
    scene.environment = createGROBG300MachiningCenterEnvironment(gl);
    scene.environmentIntensity = 0.45;
    (async () => {
      onBoot('Montando o gêmeo digital', 0.15);
      await new Promise((r) => setTimeout(r, 40));
      const tpl = getTemplate();
      const list = MACHINES.map((m) => new MachineTwin(m.id));
      if (cancelled) return;
      onBoot('Carregando materiais', 0.35);
      const t0 = performance.now();
      for (;;) {
        const pending = tpl.textures.filter((t) => !(t.image && (t.image as HTMLImageElement).complete !== false && (t.image as HTMLImageElement).width));
        onBoot(`Carregando materiais ${tpl.textures.length - pending.length}/${tpl.textures.length}`, 0.35 + 0.35 * (1 - pending.length / Math.max(1, tpl.textures.length)));
        if (!pending.length || performance.now() - t0 > 8000) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      for (const t of tpl.textures) {
        t.needsUpdate = true;
        gl.initTexture(t);
      }
      setTwins(list);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      onBoot('Preparando a renderização', 0.8);
      try {
        await gl.compileAsync(scene, camera);
      } catch {
        /* compileAsync not supported: shaders compile on first frame */
      }
      if (cancelled) return;
      gl.shadowMap.needsUpdate = true;
      onBoot('', 1);
      setTwinReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [gl, scene, camera, onBoot, setTwinReady]);

  // ---- layout per view
  useEffect(() => {
    if (!twins.length) return;
    twins.forEach((t, i) => {
      if (view === 'plant') {
        t.root.visible = true;
        t.root.position.set(PLANT_X[i], 0, 0);
      } else {
        t.root.visible = t.id === machine;
        t.root.position.set(0, 0, 0);
      }
    });
    const sel = twins.find((t) => t.id === machine);
    if (lamp.current && sel) lamp.current.position.set(sel.root.position.x - 1.5, 2.25, 0.5);
    const m = anchors.current;
    m.clear();
    if (view === 'plant') twins.forEach((t, i) => m.set(t.id, new THREE.Vector3(PLANT_X[i], 3.75, 0.4)));
    else if (sel) for (const a of ASSET_KINDS) m.set(a, sel.assetAnchor(a));
    gl.shadowMap.needsUpdate = true;
  }, [twins, view, machine, anchors, gl]);

  useEffect(() => {
    setXray(xray);
    gl.shadowMap.needsUpdate = true;
  }, [xray, gl, twins]);

  useFrame((_, dt) => {
    if (!twins.length) return;
    const d = Math.min(dt, 0.05);
    const st = useStore.getState();
    const sc = st.scenario;
    for (const t of twins) {
      if (!t.root.visible) continue;
      t.update(d, frameFor(t.id, sc.view, st.machine, sc));
    }
  });

  const onPointerDown = (e: any) => {
    e.stopPropagation();
    const st = useStore.getState();
    const twinId = e.object?.userData?.twinId as string | undefined;
    if (st.scenario.view === 'plant') {
      if (twinId) st.setMachine(twinId);
      return;
    }
    let o: THREE.Object3D | null = e.object;
    while (o) {
      if (o.userData?.sensor) {
        st.setSensor(o.userData.sensor);
        return;
      }
      o = o.parent;
    }
    const a = MachineTwin.assetOf(e.object);
    if (a) st.setAsset(a);
  };

  return (
    <>
      <pointLight ref={lamp} color="#fff6e8" intensity={5} distance={2.6} decay={1.2} position={[-1.5, 2.25, 0.5]} />
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.004, 2.4]} visible={view === 'plant'}>
        <planeGeometry args={[24, 0.12]} />
        <meshBasicMaterial color="#f2c230" />
      </mesh>
      <group onPointerDown={onPointerDown}>
        {twins.map((t) => (
          <primitive key={t.id} object={t.root} />
        ))}
      </group>
    </>
  );
}

function CameraRig() {
  const view = useStore((s) => s.scenario.view);
  const machine = useStore((s) => s.machine);
  const nonce = useStore((s) => s.camNonce);
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: any };
  const anim = useRef<{ t: number; from: THREE.Vector3; to: THREE.Vector3; tf: THREE.Vector3; tt: THREE.Vector3 } | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (!controls) return;
    const p = view === 'plant' ? CAM_PRESETS.plant : CAM_PRESETS[useStore.getState().camPreset];
    if (first.current) {
      first.current = false;
      camera.position.set(...p.pos);
      controls.target.set(...p.tgt);
      controls.update();
      return;
    }
    anim.current = { t: 0, from: camera.position.clone(), to: new THREE.Vector3(...p.pos), tf: controls.target.clone(), tt: new THREE.Vector3(...p.tgt) };
  }, [view, machine, nonce, camera, controls]);
  useFrame((_, dt) => {
    const a = anim.current;
    if (!a || !controls) return;
    a.t = Math.min(1, a.t + dt / 0.8);
    const k = a.t * a.t * (3 - 2 * a.t);
    camera.position.lerpVectors(a.from, a.to, k);
    controls.target.lerpVectors(a.tf, a.tt, k);
    controls.update();
    if (a.t >= 1) anim.current = null;
  });
  return null;
}

function Projector({ anchors, els }: { anchors: MutableRefObject<Map<string, THREE.Vector3>>; els: MutableRefObject<Map<string, HTMLElement>> }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const [id, el] of els.current) {
      const p = anchors.current.get(id);
      if (!p) {
        el.style.display = 'none';
        continue;
      }
      v.copy(p).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      const off = LABEL_OFFSET[id] ?? [0, 0];
      el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * size.width + off[0]}px, ${((1 - v.y) / 2) * size.height + off[1]}px)`;
    }
  });
  return null;
}

// ------------------------------------------------------------------ html overlays
function Labels({ els }: { els: MutableRefObject<Map<string, HTMLElement>> }) {
  useStore((s) => s.liveTick);
  const scenario = useStore((s) => s.scenario);
  const machine = useStore((s) => s.machine);
  const asset = useStore((s) => s.asset);
  const setMachine = useStore((s) => s.setMachine);
  const setAsset = useStore((s) => s.setAsset);
  const reg = (id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  };
  if (scenario.view === 'plant')
    return (
      <>
        {MACHINES.map((m) => {
          const st = worstStatus(m.id);
          const running = DS.regime[m.id][LIVE_H] !== 'parada';
          return (
            <button key={m.id} ref={reg(m.id)} className={`twin-tag float ${m.id === machine ? 'sel' : ''}`} style={{ display: 'none' }} onClick={() => setMachine(m.id)}>
              <span className="dot" style={{ background: STATUS_COLOR[st] }} />
              <b>{m.id}</b>
              <span className="muted">{running ? PHASE_LABEL[phaseAt(programTime(m.id))] : REGIME_LABEL.parada}</span>
            </button>
          );
        })}
      </>
    );
  return (
    <>
      {ASSET_KINDS.map((a) => {
        const an = AN[key(machine, a)];
        const ov = scenario.assets?.[a];
        const st = ov?.status ?? an.status[LIVE_H];
        const sc = ov?.score ?? an.ewma[LIVE_H];
        return (
          <button key={a} ref={reg(a)} className={`asset-tag float ${a === asset ? 'sel' : ''}`} style={{ display: 'none' }} onClick={() => setAsset(a)}>
            <span className="dot" style={{ background: ov?.color ?? STATUS_COLOR[st] }} />
            {ASSET_SHORT[a]}
            <span className="muted">{Number.isNaN(sc) ? 's/ dados' : `${Math.round(sc * 100)}`}</span>
          </button>
        );
      })}
    </>
  );
}

function Toolbar() {
  const view = useStore((s) => s.scenario.view);
  const preset = useStore((s) => s.camPreset);
  const xray = useStore((s) => s.xray);
  const setCamPreset = useStore((s) => s.setCamPreset);
  const setXray = useStore((s) => s.setXray);
  return (
    <div className="preset-bar">
      {view === 'machine' &&
        (['geral', 'trabalho', 'agregados'] as CamPreset[]).map((k) => (
          <button key={k} className={k === preset ? 'on' : ''} onClick={() => setCamPreset(k)}>
            {CAM_PRESETS[k].label}
          </button>
        ))}
      <button className={xray ? 'on' : ''} onClick={() => setXray(!xray)} title="Deixa a carcaça translúcida para ver os componentes internos">
        Raio-X
      </button>
    </div>
  );
}

function Loader({ stage, progress }: { stage: string; progress: number }) {
  return (
    <div className={`twin-loader ${progress >= 1 ? 'done' : ''}`}>
      <div className="spinner" />
      <b>Carregando gêmeo digital</b>
      <span>{stage || 'Pronto'}</span>
      <div className="bar" style={{ width: 220 }}>
        <i style={{ width: `${Math.round(progress * 100)}%`, background: 'var(--accent)' }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ stage
export function TwinStage() {
  const slot = useStore((s) => s.slot);
  const caption = useStore((s) => s.scenario.caption);
  const badge = useStore((s) => s.scenario.badge);
  const wrap = useRef<HTMLDivElement>(null);
  const anchors = useRef(new Map<string, THREE.Vector3>());
  const els = useRef(new Map<string, HTMLElement>());
  const [boot, setBoot] = useState({ stage: 'Inicializando', progress: 0.05 });
  const [active, setActive] = useState(false);
  const [dpr, setDpr] = useState(() => Math.min(1.5, window.devicePixelRatio || 1));
  const onBoot = useMemo<Boot>(() => (stage, progress) => setBoot((b) => ({ stage, progress: progress ?? b.progress })), []);

  // follow the slot rectangle, clipped to the scrollable page area
  useEffect(() => {
    let raf = 0;
    let lastVisible = false;
    const loop = () => {
      const el = wrap.current;
      const s = useStore.getState().slot;
      if (el) {
        if (!s || !s.isConnected) {
          el.style.visibility = 'hidden';
          if (lastVisible) setActive((lastVisible = false));
        } else {
          const r = s.getBoundingClientRect();
          const page = document.querySelector('.page')?.getBoundingClientRect();
          el.style.visibility = 'visible';
          el.style.transform = `translate(${r.left}px, ${r.top}px)`;
          if (el.style.width !== `${r.width}px`) el.style.width = `${r.width}px`;
          if (el.style.height !== `${r.height}px`) el.style.height = `${r.height}px`;
          let visible = true;
          if (page) {
            const top = Math.max(0, page.top - r.top);
            const bottom = Math.max(0, r.bottom - page.bottom);
            el.style.clipPath = `inset(${top}px 0 ${bottom}px 0 round 10px)`;
            visible = r.bottom > page.top + 4 && r.top < page.bottom - 4;
          }
          if (visible !== lastVisible) setActive((lastVisible = visible));
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={wrap} className="twin-stage" style={{ visibility: 'hidden' }}>
      <Canvas
        shadows
        dpr={dpr}
        frameloop={active && slot ? 'always' : 'never'}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ position: CAM_PRESETS.plant.pos, fov: 38, near: 0.1, far: 120 }}
        resize={{ debounce: { resize: 120, scroll: 0 }, scroll: false }}
      >
        <PerformanceMonitor flipflops={1} onDecline={() => setDpr(1)} onFallback={() => setDpr(1)} />
        <color attach="background" args={['#f2f4f6']} />
        <fog attach="fog" args={['#f2f4f6', 24, 52]} />
        <hemisphereLight args={['#f4f7fa', '#9aa3ad', 0.5]} />
        <directionalLight
          position={[-6, 11, 7]}
          intensity={2.6}
          castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-14}
          shadow-camera-right={14}
          shadow-camera-top={10}
          shadow-camera-bottom={-10}
          shadow-bias={-0.0005}
        />
        <directionalLight position={[8, 4, -6]} intensity={0.5} color="#e6eef8" />
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <planeGeometry args={[70, 70]} />
          <meshStandardMaterial color="#e9ecef" roughness={0.95} />
        </mesh>
        <gridHelper args={[60, 60, '#d3d8dd', '#dde1e5']} position={[0, 0.002, 0]} />
        <Scene onBoot={onBoot} anchors={anchors} />
        <CameraRig />
        <Projector anchors={anchors} els={els} />
        <OrbitControls makeDefault enableDamping minDistance={0.6} maxDistance={32} maxPolarAngle={Math.PI / 2.05} />
      </Canvas>
      <Labels els={els} />
      {(caption || badge) && (
        <div className="twin-overlay">
          {badge && <span className="chip whatif">{badge}</span>}
          {caption && <span className="chip">{caption}</span>}
        </div>
      )}
      <Toolbar />
      <Loader stage={boot.stage} progress={boot.progress} />
    </div>
  );
}
