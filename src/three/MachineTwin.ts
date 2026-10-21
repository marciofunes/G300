/**
 * Runtime wrapper around the img2threejs-generated G300 factory.
 *
 * Performance notes
 *  - The generated model is built ONCE into a template; every machine is a clone that shares
 *    geometry and materials. Only the plate text and the condition-tinted asset materials are
 *    per instance.
 *  - MeshPhysicalMaterial from the factory is converted to MeshStandardMaterial (cheaper shader).
 *  - Repeated small parts (motor fins) are merged into one geometry per pump.
 *  - Shell materials are always "transparent" with opacity 1, so toggling x-ray only changes
 *    opacity / depthWrite and never triggers a shader recompilation.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createGROBG300MachiningCenterModel } from './generated/createGrobG300Model';
import type { AssetKind, Regime, SensorKind, Status } from '../data/types';
import { CYCLE_S, machineOffset } from './program';

export const ASSET_COMPONENTS: Record<AssetKind, string[]> = {
  spindle: ['spindle-housing', 'spindle-rotor'],
  'bomba-refrigeracao': ['pump-coolant', 'pump-coolant-body'],
  'bomba-hidraulica': ['pump-hydraulic', 'hyd-tank'],
  'bomba-alta-pressao': ['pump-hp'],
};
const COMPONENT_TO_ASSET: Record<string, AssetKind> = Object.fromEntries(
  Object.entries(ASSET_COMPONENTS).flatMap(([a, ids]) => ids.map((id) => [id, a as AssetKind])),
);

/** Parts that surrounded the spindle and overlapped the work area: removed from the view. */
const HIDDEN = new Set(['y-carriage', 'x-slide', 'z-ram', 'way-cover', 'head-cover']);
/** Internal moving / monitored components: never affected by x-ray. */
const INTERIOR = new Set([
  'spindle-housing',
  'spindle-rotor',
  'trunnion',
  'cheek-near',
  'cheek-far',
  'table',
  'workpiece',
  'pump-coolant',
  'pump-coolant-body',
  'hyd-tank',
  'pump-hydraulic',
  'pump-hp',
  'magazine',
  'conveyor',
]);

const SENSOR_SOCKETS: Record<SensorKind, string> = {
  spindle: 'sensor-spindle',
  'bomba-refrigeracao': 'sensor-coolant',
  'bomba-hidraulica': 'sensor-hydraulic',
  'bomba-alta-pressao': 'sensor-hp',
  eletrica: 'sensor-power',
};

export const STATUS_COLOR: Record<Status, string> = {
  normal: '#1e8a5a',
  atencao: '#e38418',
  critico: '#d03b3b',
  'sem-referencia': '#8a96a3',
};
export type QualityState = 'ok' | 'gap' | 'frozen' | 'clip' | 'off';
export const QUALITY_COLOR: Record<QualityState, string> = { ok: '#22c55e', gap: '#f59e0b', frozen: '#9ca3af', clip: '#ef4444', off: '#475569' };

export type AssetVisual = { status: Status; score: number; color?: string };

export type TwinFrameState = {
  regime: Regime;
  assets: Record<AssetKind, AssetVisual>;
  quality: Record<SensorKind, QualityState>;
  focusAsset?: AssetKind;
  focusSensor?: SensorKind;
  sensorHalos?: boolean;
  /** program speed multiplier (feed) */
  speed: number;
  /** spindle speed multiplier (rpm) */
  rpm: number;
  stopped: boolean;
  maintenance?: AssetKind;
};

// ---------------------------------------------------------------- shared template
type Template = {
  root: THREE.Group;
  shellMaterials: THREE.Material[];
  textures: THREE.Texture[];
};
let TEMPLATE: Template | null = null;

function toStandard(src: THREE.Material, textures: Set<THREE.Texture>): THREE.MeshStandardMaterial {
  const p = src as THREE.MeshPhysicalMaterial;
  const m = new THREE.MeshStandardMaterial({
    color: p.color?.clone() ?? new THREE.Color('#cccccc'),
    roughness: p.roughness ?? 0.6,
    metalness: p.metalness ?? 0,
    map: p.map ?? null,
    roughnessMap: p.roughnessMap ?? null,
    emissive: p.emissive?.clone() ?? new THREE.Color('#000000'),
    emissiveIntensity: p.emissiveIntensity ?? 1,
    envMapIntensity: 0.9,
    opacity: p.opacity ?? 1,
    transparent: p.transparent ?? false,
  });
  if (m.map) textures.add(m.map);
  if (m.roughnessMap) textures.add(m.roughnessMap);
  m.name = p.name || (p.userData?.sculptMaterial?.id ?? '');
  return m;
}

function textTexture(text: string, font: string, color: string, w: number, h: number, bg?: string, rotate = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
  }
  if (rotate) {
    g.translate(w / 2, h / 2);
    g.rotate(-Math.PI / 2);
    g.translate(-h / 2, -w / 2);
  }
  g.font = font;
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, (rotate ? h : w) / 2, (rotate ? w : h) / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildTemplate(): Template {
  const model = createGROBG300MachiningCenterModel({ castShadow: false, receiveShadow: false, textureAnisotropy: 4 });
  const textures = new Set<THREE.Texture>();
  const converted = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const shell = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const solid = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const pivots = new Map<string, THREE.Object3D>();
  const meshes = new Map<string, THREE.Mesh>();

  model.traverse((o) => {
    const comp = (o.userData?.sculptComponent as { id?: string } | undefined)?.id;
    if (comp) {
      if ((o as THREE.Mesh).isMesh) meshes.set(comp, o as THREE.Mesh);
      else pivots.set(comp, o);
    }
  });

  for (const [id, mesh] of meshes) {
    const orig = mesh.material as THREE.Material;
    let base = converted.get(orig);
    if (!base) {
      base = toStandard(orig, textures);
      converted.set(orig, base);
    }
    if (HIDDEN.has(id)) {
      mesh.visible = false;
      continue;
    }
    if (INTERIOR.has(id)) {
      let m = solid.get(orig);
      if (!m) {
        m = base.clone();
        solid.set(orig, m);
      }
      mesh.material = m;
      mesh.castShadow = false;
    } else {
      let m = shell.get(orig);
      if (!m) {
        m = base.clone();
        m.transparent = true; // fixed for life: x-ray only changes opacity/depthWrite
        m.userData.baseOpacity = m.opacity;
        shell.set(orig, m);
      }
      mesh.material = m;
      mesh.castShadow = true;
      mesh.userData.shell = true;
    }
    mesh.receiveShadow = false;
    // static meshes do not need matrix recomputation every frame
    if (!INTERIOR.has(id)) mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }
  // geometry of hidden parts is not needed at all
  for (const id of HIDDEN) {
    const m = meshes.get(id);
    if (m) m.geometry = new THREE.BufferGeometry();
  }

  // ---- tool on the spindle nose (shared)
  const rotor = pivots.get('spindle-rotor');
  if (rotor) {
    const steel = new THREE.MeshStandardMaterial({ color: '#8f969d', metalness: 0.9, roughness: 0.3 });
    const gold = new THREE.MeshStandardMaterial({ color: '#d7b45a', metalness: 0.85, roughness: 0.25 });
    const g = new THREE.Group();
    g.name = 'tool';
    const holder = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 0.07, 20), steel);
    holder.rotation.z = Math.PI / 2;
    holder.position.x = -0.295;
    const cutter = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.12, 16), gold);
    cutter.rotation.z = Math.PI / 2;
    cutter.position.x = -0.39;
    const flute = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.008, 0.046), new THREE.MeshStandardMaterial({ color: '#3a3f45' }));
    flute.position.x = -0.39;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.135), new THREE.MeshStandardMaterial({ color: '#2a5599' }));
    stripe.position.x = -0.12;
    g.add(holder, cutter, flute, stripe);
    rotor.add(g);
  }

  // ---- pump fan cowls + merged fins (shared)
  const capMat = new THREE.MeshStandardMaterial({ color: '#cfd3d6', roughness: 0.6 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: '#1f4ea3' });
  for (const id of ['pump-coolant', 'pump-hydraulic', 'pump-hp']) {
    const p = pivots.get(id);
    const m = meshes.get(id);
    if (!p || !m) continue;
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox!;
    const h = bb.max.y - bb.min.y;
    const r = (bb.max.x - bb.min.x) / 2;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r * 0.92, 0.03, 20), capMat);
    cap.position.y = h + 0.01;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, 0.02, 0.04), bladeMat);
    blade.position.y = h + 0.035;
    blade.name = 'fan-blade';
    const fins: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 10; i++) {
      const fg = new THREE.BoxGeometry(0.012, h * 0.7, 0.03);
      const a = (i / 10) * Math.PI * 2;
      fg.rotateY(-a);
      fg.translate(Math.cos(a) * r, h * 0.5, Math.sin(a) * r);
      fins.push(fg);
    }
    const finMesh = new THREE.Mesh(mergeGeometries(fins), m.material as THREE.Material);
    finMesh.name = `${id}-fins`;
    p.add(cap, blade, finMesh);
  }

  // ---- decals (shared)
  const g300 = textTexture('G300', 'italic 900 210px Arial, sans-serif', '#c4c8cc', 256, 720, undefined, true);
  const letteringMat = new THREE.MeshStandardMaterial({ map: g300, transparent: true, roughness: 0.6 });
  letteringMat.userData.baseOpacity = 1;
  const lettering = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 1.18), letteringMat);
  lettering.position.set(-2.003, 1.45, -0.6);
  lettering.rotation.y = -Math.PI / 2;
  const badgeMat = new THREE.MeshStandardMaterial({ map: textTexture('GROB', 'bold 92px Arial, sans-serif', '#ffffff', 320, 128, '#1f4ea3'), roughness: 0.5, transparent: true });
  badgeMat.userData.baseOpacity = 1;
  const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.15), badgeMat);
  badge.position.set(1.25, 2.72, 0.882);
  model.add(lettering, badge);

  const shellMaterials = [...shell.values(), letteringMat, badgeMat];
  return { root: model, shellMaterials, textures: [...textures] };
}

export function getTemplate() {
  if (!TEMPLATE) TEMPLATE = buildTemplate();
  return TEMPLATE;
}

let XRAY = false;
/** X-ray: makes the whole external casing translucent, interior moving parts stay solid. */
export function setXray(on: boolean) {
  if (XRAY === on || !TEMPLATE) return;
  XRAY = on;
  for (const m of TEMPLATE.shellMaterials) {
    m.opacity = on ? 0.1 : (m.userData.baseOpacity ?? 1);
    m.depthWrite = !on;
  }
}

// ---------------------------------------------------------------- instance
const smooth = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const seg = (t: number, a: number, b: number) => smooth(Math.min(1, Math.max(0, (t - a) / (b - a))));
const TMP = new THREE.Vector3();

export class MachineTwin {
  readonly root = new THREE.Group();
  readonly id: string;
  private pivots = new Map<string, THREE.Object3D>();
  private meshes = new Map<string, THREE.Mesh>();
  private basePos = new Map<string, THREE.Vector3>();
  private tinted = new Map<string, THREE.MeshStandardMaterial>();
  private sensorMarkers = new Map<SensorKind, { group: THREE.Group; led: THREE.Mesh; halo: THREE.Mesh }>();
  private chips: THREE.Points;
  private chipVel: Float32Array;
  private chipLife: Float32Array;
  private coolant: THREE.Points;
  private coolantLife: Float32Array;
  private t: number;
  private clock = 0;
  private spin = 0;
  private spinSpeed = 0;
  private magazineAngle = 0;
  private bAngle = 0;
  private doorOpen = 0;

  constructor(id: string) {
    this.id = id;
    const tpl = getTemplate();
    const model = tpl.root.clone(true);
    this.root.add(model);
    this.root.name = id;
    this.t = (Date.now() / 1000 + machineOffset(id)) % CYCLE_S;
    model.traverse((o) => {
      const comp = (o.userData?.sculptComponent as { id?: string } | undefined)?.id;
      if (!comp) return;
      if ((o as THREE.Mesh).isMesh) this.meshes.set(comp, o as THREE.Mesh);
      else this.pivots.set(comp, o);
    });
    for (const [cid, p] of this.pivots) this.basePos.set(cid, p.position.clone());
    for (const ids of Object.values(ASSET_COMPONENTS))
      for (const cid of ids) {
        const m = this.meshes.get(cid);
        if (!m) continue;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        m.material = mat;
        this.tinted.set(cid, mat);
      }
    const wp = this.meshes.get('workpiece');
    if (wp) wp.scale.setScalar(0.82);

    // machine id plate (per instance)
    const plateMat = new THREE.MeshStandardMaterial({ map: textTexture(id, 'bold 64px Arial, sans-serif', '#1f2d3a', 320, 96, '#f3f4f5'), roughness: 0.5 });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.13), plateMat);
    plate.position.set(-1.2, 2.72, 0.882);
    model.add(plate);

    this.addSensors(model);
    const c = this.makeParticles(110, '#c9ced6', 0.018);
    this.chips = c.points;
    this.chipVel = c.vel;
    this.chipLife = new Float32Array(110);
    const cl = this.makeParticles(80, '#7cc4f0', 0.022);
    this.coolant = cl.points;
    this.coolantLife = new Float32Array(80);
    (this.coolant.material as THREE.PointsMaterial).opacity = 0.55;
    this.root.add(this.chips, this.coolant);
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.userData.twinId = id;
    });
  }

  private addSensors(model: THREE.Object3D) {
    model.updateMatrixWorld(true);
    const bodyGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#23324a', roughness: 0.5 });
    const ledGeo = new THREE.SphereGeometry(0.014, 10, 8);
    const haloGeo = new THREE.SphereGeometry(0.075, 16, 12);
    for (const [sensor, socketName] of Object.entries(SENSOR_SOCKETS) as [SensorKind, string][]) {
      let socket: THREE.Object3D | undefined;
      model.traverse((o) => {
        if (o.name === socketName) socket = o;
      });
      if (!socket) continue;
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      const led = new THREE.Mesh(ledGeo, new THREE.MeshStandardMaterial({ color: '#22c55e', emissive: '#22c55e', emissiveIntensity: 1.6 }));
      led.position.set(0, 0.033, 0);
      const halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ color: '#22c55e', transparent: true, opacity: 0, depthWrite: false }));
      halo.visible = false;
      g.add(body, led, halo);
      body.userData.sensor = sensor;
      const parent = socket.parent!;
      const rotating = ['pump-coolant', 'pump-hydraulic', 'pump-hp'].some((id) => this.pivots.get(id) === parent);
      if (sensor === 'eletrica') {
        g.position.set(1.05, 2.0, 0.19);
        model.add(g);
      } else if (sensor === 'spindle') {
        parent.add(g);
        g.position.set(-0.2, 0.17, 0);
      } else if (rotating) {
        parent.parent!.add(g);
        g.position.copy(parent.position).add(socket.position).add(new THREE.Vector3(0.02, 0.12, 0));
      } else {
        socket.add(g);
      }
      this.sensorMarkers.set(sensor, { group: g, led, halo });
    }
  }

  private makeParticles(n: number, color: string, size: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3).fill(-100), 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, transparent: true, depthWrite: false }));
    points.frustumCulled = false;
    return { points, vel: new Float32Array(n * 3) };
  }

  static assetOf(obj: THREE.Object3D): AssetKind | null {
    let o: THREE.Object3D | null = obj;
    while (o) {
      const comp = (o.userData?.sculptComponent as { id?: string } | undefined)?.id;
      if (comp && COMPONENT_TO_ASSET[comp]) return COMPONENT_TO_ASSET[comp];
      o = o.parent;
    }
    return null;
  }

  /** Anchor of an asset in the twin's local frame, for HTML labels. */
  assetAnchor(asset: AssetKind): THREE.Vector3 {
    const m = this.meshes.get(ASSET_COMPONENTS[asset][0]);
    const v = new THREE.Vector3();
    if (m) {
      this.root.updateMatrixWorld(true);
      new THREE.Box3().setFromObject(m).getCenter(v);
      this.root.worldToLocal(v);
    }
    v.y += asset === 'spindle' ? 0.3 : 0.35;
    return v;
  }

  update(dt: number, s: TwinFrameState) {
    this.clock += dt;
    const idle = s.regime === 'parada' || s.stopped;
    const finishing = s.regime === 'acabamento';
    if (!idle) {
      // stay phase-locked to the wall clock (and to the live telemetry) at nominal speed
      if (Math.abs(s.speed - 1) < 1e-3) this.t = (Date.now() / 1000 + machineOffset(this.id)) % CYCLE_S;
      else this.t = (this.t + dt * s.speed) % CYCLE_S;
    }
    const t = this.t;
    let yOff = 0;
    let zOff = 0.45;
    let xOff = 0;
    let aTilt = 0;
    let targetSpin = 0;
    let cutting = false;
    if (!idle) {
      const tc = seg(t, 0, 1.2) * (1 - seg(t, 2.2, 3.0));
      yOff = lerp(0, 0.32, tc);
      if (t >= 3) yOff = lerp(0, -0.27, seg(t, 3, 4.5));
      if (t >= 3.6) zOff = lerp(0.45, 0.235, seg(t, 3.6, 4.5));
      if (t >= 4.5 && t < 13) {
        const p = (t - 4.5) / 8.5;
        const r = finishing ? 0.045 : 0.065;
        const ang = p * Math.PI * 4;
        yOff = -0.27 + Math.sin(ang) * r;
        xOff = Math.cos(ang) * r - r;
        zOff = 0.235 - 0.012 * Math.sin(p * Math.PI);
        cutting = true;
      }
      if (t >= 13 && t < 15) {
        zOff = lerp(0.235, 0.45, seg(t, 13, 13.6));
        yOff = -0.27;
        aTilt = -0.45 * seg(t, 13.6, 14.6);
      }
      if (t >= 15 && t < 23) {
        aTilt = -0.45;
        const p = (t - 15) / 8;
        zOff = lerp(0.45, 0.25, seg(t, 15, 15.8));
        const ang = p * Math.PI * 6;
        yOff = -0.25 + Math.sin(ang) * 0.035;
        xOff = Math.cos(ang) * 0.035 - 0.035;
        cutting = t > 15.8 && t < 22.5;
      }
      if (t >= 23) {
        aTilt = -0.45 * (1 - seg(t, 23.5, 25));
        zOff = lerp(0.25, 0.45, seg(t, 23, 23.6));
        yOff = lerp(-0.25, 0, seg(t, 24, 26));
      }
      targetSpin = (t < 3 ? 0 : cutting ? (finishing ? 64 : 46) : 24) * s.rpm;
      if (t < 3) this.magazineAngle += dt * 1.2 * tc * Math.max(0.3, s.speed);
      if ((t > 13.2 && t < 14.8) || (t > 23 && t < 25)) this.bAngle += dt * ((Math.PI / 2) / 1.6) * s.speed;
    }
    this.spinSpeed += (targetSpin - this.spinSpeed) * Math.min(1, dt * 2.5);
    this.spin += this.spinSpeed * dt;

    // the spindle unit (housing + nose) carries the X/Y/Z motion now that the slides are hidden
    const housing = this.pivots.get('spindle-housing');
    const hb = this.basePos.get('spindle-housing');
    if (housing && hb) housing.position.set(hb.x + zOff, hb.y + yOff, hb.z + xOff);
    const rotor = this.pivots.get('spindle-rotor');
    if (rotor) rotor.rotation.x = this.spin;
    const trunnion = this.pivots.get('trunnion');
    if (trunnion) trunnion.rotation.z = aTilt;
    const table = this.pivots.get('table');
    if (table) table.rotation.y = this.bAngle;
    const mag = this.pivots.get('magazine');
    if (mag) mag.rotation.z = this.magazineAngle;
    // door: opens when the machine is stopped for maintenance
    this.doorOpen += ((s.stopped ? 1 : 0.92) - this.doorOpen) * Math.min(1, dt * 2);
    const door = this.pivots.get('door');
    const db = this.basePos.get('door');
    if (door && db) door.position.set(db.x, db.y, db.z - 0.56 * this.doorOpen);
    const pumpSpeed: Record<string, number> = {
      'pump-coolant': idle ? 0 : 22,
      'pump-hydraulic': s.stopped ? 0 : idle ? 9 : 14,
      'pump-hp': idle ? 0 : (cutting ? 26 : 8) * Math.min(1.6, Math.max(0.5, s.speed)),
    };
    for (const [id, sp] of Object.entries(pumpSpeed)) {
      const p = this.pivots.get(id);
      if (p) p.rotation.y += sp * dt;
    }

    // particles
    const tip = TMP.set(-0.45, 0, 0);
    if (rotor) {
      rotor.updateWorldMatrix(true, false);
      rotor.localToWorld(tip);
      this.root.worldToLocal(tip);
    }
    this.updateChips(dt, cutting && !idle, tip, finishing);
    this.updateCoolant(dt, cutting && !idle, tip);

    // condition overlays
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 5);
    for (const [asset, ids] of Object.entries(ASSET_COMPONENTS) as [AssetKind, string[]][]) {
      const v = s.assets[asset];
      let color = '#000000';
      let intensity = 0;
      if (s.maintenance === asset) {
        color = '#2a78d6';
        intensity = 0.35 + 0.35 * pulse;
      } else if (v.color) {
        color = v.color;
        intensity = 0.3 + 0.45 * pulse;
      } else if (v.status === 'atencao') {
        color = STATUS_COLOR.atencao;
        intensity = 0.25 + 0.45 * pulse;
      } else if (v.status === 'critico') {
        color = STATUS_COLOR.critico;
        intensity = 0.35 + 0.6 * pulse;
      } else if (s.focusAsset === asset) {
        color = '#2a78d6';
        intensity = 0.22;
      }
      for (const id of ids) {
        const mat = this.tinted.get(id);
        if (mat) {
          mat.emissive.set(color);
          mat.emissiveIntensity = intensity;
        }
        if (id === 'spindle-rotor' || id === 'spindle-housing') continue;
        const p = this.pivots.get(id);
        const b = this.basePos.get(id);
        if (p && b) {
          const amp = v.score > 0.3 && !idle ? 0.007 * v.score : 0;
          p.position.set(b.x + Math.sin(this.clock * 61) * amp, b.y + Math.sin(this.clock * 47) * amp * 0.5, b.z + Math.cos(this.clock * 53) * amp);
        }
      }
    }

    for (const [sensor, m] of this.sensorMarkers) {
      const col = QUALITY_COLOR[s.quality[sensor]];
      const ledMat = m.led.material as THREE.MeshStandardMaterial;
      ledMat.color.set(col);
      ledMat.emissive.set(col);
      const bad = s.quality[sensor] === 'frozen' || s.quality[sensor] === 'gap' || s.quality[sensor] === 'clip';
      ledMat.emissiveIntensity = bad ? (Math.sin(this.clock * 8) > 0 ? 1.8 : 0.1) : 1.4;
      const show = !!s.sensorHalos || s.focusSensor === sensor;
      m.halo.visible = show;
      if (show) {
        (m.halo.material as THREE.MeshBasicMaterial).color.set(col);
        (m.halo.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.25 * pulse;
        m.halo.scale.setScalar(1 + 0.5 * pulse);
      }
      m.group.scale.setScalar(s.sensorHalos ? 1.6 : 1.2);
    }
  }

  private updateChips(dt: number, active: boolean, tip: THREE.Vector3, finishing: boolean) {
    const pos = this.chips.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const n = this.chipLife.length;
    let spawn = active ? (finishing ? 2 : 4) : 0;
    let any = false;
    for (let i = 0; i < n; i++) {
      if (this.chipLife[i] <= 0) {
        if (spawn > 0) {
          spawn--;
          this.chipLife[i] = 1.2 + Math.random() * 0.5;
          arr[i * 3] = tip.x;
          arr[i * 3 + 1] = tip.y;
          arr[i * 3 + 2] = tip.z;
          this.chipVel[i * 3] = 0.3 + Math.random() * 0.6;
          this.chipVel[i * 3 + 1] = Math.random();
          this.chipVel[i * 3 + 2] = (Math.random() - 0.5) * 1.4;
          any = true;
        } else if (arr[i * 3 + 1] !== -100) {
          arr[i * 3 + 1] = -100;
          any = true;
        }
        continue;
      }
      any = true;
      this.chipLife[i] -= dt;
      this.chipVel[i * 3 + 1] -= 3.4 * dt;
      arr[i * 3] += this.chipVel[i * 3] * dt;
      arr[i * 3 + 1] += this.chipVel[i * 3 + 1] * dt;
      arr[i * 3 + 2] += this.chipVel[i * 3 + 2] * dt;
      if (arr[i * 3 + 1] < 0.88) {
        arr[i * 3 + 1] = 0.88;
        this.chipVel[i * 3] *= 0.2;
        this.chipVel[i * 3 + 2] *= 0.2;
      }
    }
    if (any) pos.needsUpdate = true;
  }

  private updateCoolant(dt: number, active: boolean, tip: THREE.Vector3) {
    const pos = this.coolant.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const nx = tip.x + 0.25;
    const ny = tip.y + 0.16;
    const nz = tip.z + 0.05;
    let spawn = active ? 3 : 0;
    let any = false;
    for (let i = 0; i < this.coolantLife.length; i++) {
      if (this.coolantLife[i] <= 0) {
        if (spawn > 0) {
          spawn--;
          this.coolantLife[i] = 0.35;
        } else {
          if (arr[i * 3 + 1] !== -100) {
            arr[i * 3 + 1] = -100;
            any = true;
          }
          continue;
        }
      }
      any = true;
      this.coolantLife[i] -= dt;
      const k = 1 - this.coolantLife[i] / 0.35;
      arr[i * 3] = lerp(nx, tip.x, k) + (Math.random() - 0.5) * 0.01;
      arr[i * 3 + 1] = lerp(ny, tip.y, k) + (Math.random() - 0.5) * 0.01;
      arr[i * 3 + 2] = lerp(nz, tip.z, k) + (Math.random() - 0.5) * 0.01;
    }
    if (any) pos.needsUpdate = true;
  }
}
