import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46: a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object: same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below: it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: GROB G300 Machining Center
// Sculpt build pass: material-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createGROBG300MachiningCenterModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "GROB G300 Machining Center";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["panel-grey"] = createSculptMaterial(
    "panel-grey",
    {"id": "panel-grey", "name": "Painted enclosure panel (light warm grey satin)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#E4E6E6", "color": "#E4E6E6", "albedo": {"dominant": "#FFFFFF", "secondary": ["#FEFEFC", "#FAFAF8", "#696969"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_albedo.png", "url": "/materials/panel-grey/panel-grey_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#FFFFFF", "#FEFEFC", "#FAFAF8", "#696969"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.308, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.244, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.109, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.685, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_roughness.png", "url": "/materials/panel-grey/panel-grey_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.183, "map": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_normal.png", "url": "/materials/panel-grey/panel-grey_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_height.png", "url": "/materials/panel-grey/panel-grey_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_height.png", "url": "/materials/panel-grey/panel-grey_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_ao.png", "url": "/materials/panel-grey/panel-grey_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/panel-grey.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.716, "estimatedFidelity": 0.716, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_albedo.png", "url": "/materials/panel-grey/panel-grey_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_roughness.png", "url": "/materials/panel-grey/panel-grey_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_height.png", "url": "/materials/panel-grey/panel-grey_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_normal.png", "url": "/materials/panel-grey/panel-grey_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/panel-grey/panel-grey_ao.png", "url": "/materials/panel-grey/panel-grey_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 128, "height": 128}, "mask": {"backgroundColor": "#FBFBF9", "backgroundNoise": 13.856, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.08, "heightP90Gradient": 0.02247, "roughnessBase": 0.685, "roughnessVariation": 0.05, "normalStrength": 0.183, "blurRadius": 21}, "palette": ["#FFFFFF", "#FEFEFC", "#FAFAF8", "#696969"]}, "warnings": ["foreground mask is tiny; material extraction is likely unreliable", "image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["panel-shadow"] = createSculptMaterial(
    "panel-shadow",
    {"id": "panel-shadow", "name": "Inner enclosure surfaces (mid grey)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B7BBBE", "color": "#B7BBBE", "albedo": {"dominant": "#90908E", "secondary": ["#838383", "#787878", "#6C6C6C"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_albedo.png", "url": "/materials/panel-shadow/panel-shadow_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#90908E", "#838383", "#787878", "#6C6C6C", "#B0B0AE"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.34, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.223, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.097, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.693, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_roughness.png", "url": "/materials/panel-shadow/panel-shadow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.177, "map": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_normal.png", "url": "/materials/panel-shadow/panel-shadow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_height.png", "url": "/materials/panel-shadow/panel-shadow_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_height.png", "url": "/materials/panel-shadow/panel-shadow_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_ao.png", "url": "/materials/panel-shadow/panel-shadow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/panel-shadow.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.702, "estimatedFidelity": 0.702, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_albedo.png", "url": "/materials/panel-shadow/panel-shadow_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_roughness.png", "url": "/materials/panel-shadow/panel-shadow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_height.png", "url": "/materials/panel-shadow/panel-shadow_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_normal.png", "url": "/materials/panel-shadow/panel-shadow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/panel-shadow/panel-shadow_ao.png", "url": "/materials/panel-shadow/panel-shadow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 128, "height": 128}, "mask": {"backgroundColor": "#979795", "backgroundNoise": 90.659, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.172, "heightP90Gradient": 0.01741, "roughnessBase": 0.693, "roughnessVariation": 0.05, "normalStrength": 0.177, "blurRadius": 21}, "palette": ["#90908E", "#838383", "#787878", "#6C6C6C", "#B0B0AE"]}, "warnings": ["foreground mask is tiny; material extraction is likely unreliable", "image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["grob-blue"] = createSculptMaterial(
    "grob-blue",
    {"id": "grob-blue", "name": "GROB blue band paint", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#2A5599", "color": "#2A5599", "albedo": {"dominant": "#2B5494", "secondary": ["#2A5292", "#2D5797", "#2B5796"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_albedo.png", "url": "/materials/grob-blue/grob-blue_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#2B5494", "#2A5292", "#2D5797", "#2B5796", "#2F435E"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.308, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.212, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.091, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.688, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_roughness.png", "url": "/materials/grob-blue/grob-blue_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.174, "map": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_normal.png", "url": "/materials/grob-blue/grob-blue_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_height.png", "url": "/materials/grob-blue/grob-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_height.png", "url": "/materials/grob-blue/grob-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_ao.png", "url": "/materials/grob-blue/grob-blue_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/grob-blue.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.715, "estimatedFidelity": 0.715, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_albedo.png", "url": "/materials/grob-blue/grob-blue_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_roughness.png", "url": "/materials/grob-blue/grob-blue_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_height.png", "url": "/materials/grob-blue/grob-blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_normal.png", "url": "/materials/grob-blue/grob-blue_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/grob-blue/grob-blue_ao.png", "url": "/materials/grob-blue/grob-blue_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 128, "height": 128}, "mask": {"backgroundColor": "#2B5695", "backgroundNoise": 137.772, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.9862}, "mapStats": {"valueRange": 0.08, "heightP90Gradient": 0.01488, "roughnessBase": 0.688, "roughnessVariation": 0.05, "normalStrength": 0.174, "blurRadius": 21}, "palette": ["#2B5494", "#2A5292", "#2D5797", "#2B5796", "#2F435E"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["steel"] = createSculptMaterial(
    "steel",
    {"id": "steel", "name": "Machined steel", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B9BEC3", "color": "#B9BEC3", "albedo": {"dominant": "#969696", "secondary": ["#A3A3A3", "#B8B8B8", "#D4D4D4"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/steel/steel_albedo.png", "url": "/materials/steel/steel_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#969696", "#A3A3A3", "#B8B8B8", "#D4D4D4", "#020202"], "pattern": "reference-derived pixel palette", "amplitude": 0.1, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.364, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.194, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.08, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/steel/steel_roughness.png", "url": "/materials/steel/steel_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 1.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.168, "map": {"path": "/home/claude/g300-work/material-evidence/steel/steel_normal.png", "url": "/materials/steel/steel_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/steel/steel_height.png", "url": "/materials/steel/steel_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/home/claude/g300-work/material-evidence/steel/steel_height.png", "url": "/materials/steel/steel_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/steel/steel_ao.png", "url": "/materials/steel/steel_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/steel.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.712, "estimatedFidelity": 0.712, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/steel/steel_albedo.png", "url": "/materials/steel/steel_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/steel/steel_roughness.png", "url": "/materials/steel/steel_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/steel/steel_height.png", "url": "/materials/steel/steel_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/steel/steel_normal.png", "url": "/materials/steel/steel_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/steel/steel_ao.png", "url": "/materials/steel/steel_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 10, "y": 43, "width": 118, "height": 82}, "mask": {"backgroundColor": "#4A4A4A", "backgroundNoise": 50.229, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.0779}, "mapStats": {"valueRange": 0.2392, "heightP90Gradient": 0.0104, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.168, "blurRadius": 21}, "palette": ["#969696", "#A3A3A3", "#B8B8B8", "#D4D4D4", "#020202"]}, "warnings": ["foreground mask is very small", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["dark-steel"] = createSculptMaterial(
    "dark-steel",
    {"id": "dark-steel", "name": "Dark steel / way covers", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#7A8086", "color": "#7A8086", "albedo": {"dominant": "#8A8A8A", "secondary": ["#858585", "#888887", "#8F8F8F"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_albedo.png", "url": "/materials/dark-steel/dark-steel_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#8A8A8A", "#858585", "#888887", "#8F8F8F", "#9A9A9A"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.308, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.24, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.106, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_roughness.png", "url": "/materials/dark-steel/dark-steel_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 1.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.181, "map": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_normal.png", "url": "/materials/dark-steel/dark-steel_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_height.png", "url": "/materials/dark-steel/dark-steel_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_height.png", "url": "/materials/dark-steel/dark-steel_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_ao.png", "url": "/materials/dark-steel/dark-steel_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/dark-steel.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.831, "estimatedFidelity": 0.831, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_albedo.png", "url": "/materials/dark-steel/dark-steel_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_roughness.png", "url": "/materials/dark-steel/dark-steel_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_height.png", "url": "/materials/dark-steel/dark-steel_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_normal.png", "url": "/materials/dark-steel/dark-steel_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/dark-steel/dark-steel_ao.png", "url": "/materials/dark-steel/dark-steel_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 112, "height": 122}, "mask": {"backgroundColor": "#515151", "backgroundNoise": 36.373, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.2249}, "mapStats": {"valueRange": 0.08, "heightP90Gradient": 0.02143, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.181, "blurRadius": 21}, "palette": ["#8A8A8A", "#858585", "#888887", "#8F8F8F", "#9A9A9A"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["glass"] = createSculptMaterial(
    "glass",
    {"id": "glass", "name": "Dark tinted glass", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#3A4046", "color": "#3A4046", "albedo": {"dominant": "#636363", "secondary": ["#565656", "#717171", "#464646"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/glass/glass_albedo.png", "url": "/materials/glass/glass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#636363", "#565656", "#717171", "#464646", "#F7F7F6"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.343, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.303, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.719, "variation": 0.064, "map": {"path": "/home/claude/g300-work/material-evidence/glass/glass_roughness.png", "url": "/materials/glass/glass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.199, "map": {"path": "/home/claude/g300-work/material-evidence/glass/glass_normal.png", "url": "/materials/glass/glass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/glass/glass_height.png", "url": "/materials/glass/glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.016, "map": {"path": "/home/claude/g300-work/material-evidence/glass/glass_height.png", "url": "/materials/glass/glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/glass/glass_ao.png", "url": "/materials/glass/glass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "clearcoat": 1.0, "opacity": {"base": 0.85}, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/glass.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.719, "estimatedFidelity": 0.719, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/glass/glass_albedo.png", "url": "/materials/glass/glass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/glass/glass_roughness.png", "url": "/materials/glass/glass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/glass/glass_height.png", "url": "/materials/glass/glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/glass/glass_normal.png", "url": "/materials/glass/glass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/glass/glass_ao.png", "url": "/materials/glass/glass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 128, "height": 128}, "mask": {"backgroundColor": "#70706F", "backgroundNoise": 54.854, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.181, "heightP90Gradient": 0.03652, "roughnessBase": 0.719, "roughnessVariation": 0.064, "normalStrength": 0.199, "blurRadius": 21}, "palette": ["#636363", "#565656", "#717171", "#464646", "#F7F7F6"]}, "warnings": ["foreground mask is tiny; material extraction is likely unreliable", "image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["frosted"] = createSculptMaterial(
    "frosted",
    {"id": "frosted", "name": "Frosted ribbed window", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#C9CED3", "color": "#C9CED3", "albedo": {"dominant": "#606060", "secondary": ["#555555", "#494949", "#393939"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_albedo.png", "url": "/materials/frosted/frosted_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#606060", "#555555", "#494949", "#393939", "#7C7C7B"], "pattern": "reference-derived pixel palette", "amplitude": 0.109, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.371, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.338, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.707, "variation": 0.075, "map": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_roughness.png", "url": "/materials/frosted/frosted_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.209, "map": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_normal.png", "url": "/materials/frosted/frosted_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_height.png", "url": "/materials/frosted/frosted_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.02, "map": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_height.png", "url": "/materials/frosted/frosted_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_ao.png", "url": "/materials/frosted/frosted_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "opacity": {"base": 0.75}, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/frosted.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.739, "estimatedFidelity": 0.739, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_albedo.png", "url": "/materials/frosted/frosted_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_roughness.png", "url": "/materials/frosted/frosted_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_height.png", "url": "/materials/frosted/frosted_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_normal.png", "url": "/materials/frosted/frosted_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/frosted/frosted_ao.png", "url": "/materials/frosted/frosted_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 128, "height": 128}, "mask": {"backgroundColor": "#545454", "backgroundNoise": 71.014, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.2588, "heightP90Gradient": 0.04485, "roughnessBase": 0.707, "roughnessVariation": 0.075, "normalStrength": 0.209, "blurRadius": 21}, "palette": ["#606060", "#555555", "#494949", "#393939", "#7C7C7B"]}, "warnings": ["foreground mask is tiny; material extraction is likely unreliable", "image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["black"] = createSculptMaterial(
    "black",
    {"id": "black", "name": "Black polymer / openings", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#1E2022", "color": "#1E2022", "albedo": {"dominant": "#131313", "secondary": ["#0E0E0E", "#0A0A0A", "#101010"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/black/black_albedo.png", "url": "/materials/black/black_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#131313", "#0E0E0E", "#0A0A0A", "#101010", "#141414"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.308, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.234, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.103, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.685, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/black/black_roughness.png", "url": "/materials/black/black_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.18, "map": {"path": "/home/claude/g300-work/material-evidence/black/black_normal.png", "url": "/materials/black/black_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/black/black_height.png", "url": "/materials/black/black_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/home/claude/g300-work/material-evidence/black/black_height.png", "url": "/materials/black/black_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/black/black_ao.png", "url": "/materials/black/black_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/black.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.831, "estimatedFidelity": 0.831, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/black/black_albedo.png", "url": "/materials/black/black_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/black/black_roughness.png", "url": "/materials/black/black_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/black/black_height.png", "url": "/materials/black/black_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/black/black_normal.png", "url": "/materials/black/black_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/black/black_ao.png", "url": "/materials/black/black_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 4, "y": 0, "width": 124, "height": 128}, "mask": {"backgroundColor": "#AEAEAE", "backgroundNoise": 110.851, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.4784}, "mapStats": {"valueRange": 0.08, "heightP90Gradient": 0.01996, "roughnessBase": 0.685, "roughnessVariation": 0.05, "normalStrength": 0.18, "blurRadius": 21}, "palette": ["#131313", "#0E0E0E", "#0A0A0A", "#101010", "#141414"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["motor-white"] = createSculptMaterial(
    "motor-white",
    {"id": "motor-white", "name": "Painted cast motor housing", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#E6E7E8", "color": "#E6E7E8", "albedo": {"dominant": "#797979", "secondary": ["#BCBCBC", "#9C9C9C", "#DADADA"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_albedo.png", "url": "/materials/motor-white/motor-white_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#797979", "#BCBCBC", "#9C9C9C", "#DADADA", "#565656"], "pattern": "reference-derived pixel palette", "amplitude": 0.212, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.457, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.262, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.119, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.686, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_roughness.png", "url": "/materials/motor-white/motor-white_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.187, "map": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_normal.png", "url": "/materials/motor-white/motor-white_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_height.png", "url": "/materials/motor-white/motor-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.012, "map": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_height.png", "url": "/materials/motor-white/motor-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_ao.png", "url": "/materials/motor-white/motor-white_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/motor-white.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_albedo.png", "url": "/materials/motor-white/motor-white_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_roughness.png", "url": "/materials/motor-white/motor-white_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_height.png", "url": "/materials/motor-white/motor-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_normal.png", "url": "/materials/motor-white/motor-white_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/motor-white/motor-white_ao.png", "url": "/materials/motor-white/motor-white_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 128, "height": 128}, "mask": {"backgroundColor": "#383838", "backgroundNoise": 25.981, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.5692}, "mapStats": {"valueRange": 0.5059, "heightP90Gradient": 0.02665, "roughnessBase": 0.686, "roughnessVariation": 0.05, "normalStrength": 0.187, "blurRadius": 21}, "palette": ["#797979", "#BCBCBC", "#9C9C9C", "#DADADA", "#565656"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["screen"] = createSculptMaterial(
    "screen",
    {"id": "screen", "name": "HMI screen", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#9EE0F5", "color": "#9EE0F5", "albedo": {"dominant": "#D0F1FB", "secondary": ["#1D1E27", "#7D8187", "#B8D2E7"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/screen/screen_albedo.png", "url": "/materials/screen/screen_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#D0F1FB", "#1D1E27", "#7D8187", "#B8D2E7", "#484F59"], "pattern": "reference-derived pixel palette", "amplitude": 0.35, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.249, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.111, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.687, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/screen/screen_roughness.png", "url": "/materials/screen/screen_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.184, "map": {"path": "/home/claude/g300-work/material-evidence/screen/screen_normal.png", "url": "/materials/screen/screen_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/screen/screen_height.png", "url": "/materials/screen/screen_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.011, "map": {"path": "/home/claude/g300-work/material-evidence/screen/screen_height.png", "url": "/materials/screen/screen_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/screen/screen_ao.png", "url": "/materials/screen/screen_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "emissive": "#4FB6DE", "emissiveIntensity": 0.8, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/screen.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/screen/screen_albedo.png", "url": "/materials/screen/screen_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/screen/screen_roughness.png", "url": "/materials/screen/screen_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/screen/screen_height.png", "url": "/materials/screen/screen_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/screen/screen_normal.png", "url": "/materials/screen/screen_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/screen/screen_ao.png", "url": "/materials/screen/screen_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 128, "height": 128}, "mask": {"backgroundColor": "#CCEDEE", "backgroundNoise": 63.443, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.4232}, "mapStats": {"valueRange": 0.8333, "heightP90Gradient": 0.02349, "roughnessBase": 0.687, "roughnessVariation": 0.05, "normalStrength": 0.184, "blurRadius": 21}, "palette": ["#D0F1FB", "#1D1E27", "#7D8187", "#B8D2E7", "#484F59"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["estop-red"] = createSculptMaterial(
    "estop-red",
    {"id": "estop-red", "name": "Emergency stop red", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#C62828", "color": "#C62828", "albedo": {"dominant": "#232329", "secondary": ["#8E3E3D", "#1A1C1F", "#553336"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_albedo.png", "url": "/materials/estop-red/estop-red_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#232329", "#8E3E3D", "#1A1C1F", "#553336", "#EFEFEE"], "pattern": "reference-derived pixel palette", "amplitude": 0.35, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.172, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.067, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.681, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_roughness.png", "url": "/materials/estop-red/estop-red_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.162, "map": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_normal.png", "url": "/materials/estop-red/estop-red_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_height.png", "url": "/materials/estop-red/estop-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_height.png", "url": "/materials/estop-red/estop-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_ao.png", "url": "/materials/estop-red/estop-red_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/estop-red.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.805, "estimatedFidelity": 0.805, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_albedo.png", "url": "/materials/estop-red/estop-red_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_roughness.png", "url": "/materials/estop-red/estop-red_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_height.png", "url": "/materials/estop-red/estop-red_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_normal.png", "url": "/materials/estop-red/estop-red_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/estop-red/estop-red_ao.png", "url": "/materials/estop-red/estop-red_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 127, "height": 128}, "mask": {"backgroundColor": "#585D68", "backgroundNoise": 104.657, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.5526}, "mapStats": {"valueRange": 0.8717, "heightP90Gradient": 0.00519, "roughnessBase": 0.681, "roughnessVariation": 0.05, "normalStrength": 0.162, "blurRadius": 21}, "palette": ["#232329", "#8E3E3D", "#1A1C1F", "#553336", "#EFEFEE"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low high-frequency detail weakens normal/roughness inference"]}},
    options
  );
  materialMap["cradle-white"] = createSculptMaterial(
    "cradle-white",
    {"id": "cradle-white", "name": "Trunnion cradle cast (off white)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#EEEEEB", "color": "#EEEEEB", "albedo": {"dominant": "#FCFDFA", "secondary": ["#FFFFFD", "#FBFBF9", "#FEFEFC"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_albedo.png", "url": "/materials/cradle-white/cradle-white_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#FCFDFA", "#FFFFFD", "#FBFBF9", "#FEFEFC"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.308, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.197, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.082, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.681, "variation": 0.05, "map": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_roughness.png", "url": "/materials/cradle-white/cradle-white_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.169, "map": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_normal.png", "url": "/materials/cradle-white/cradle-white_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_height.png", "url": "/materials/cradle-white/cradle-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_height.png", "url": "/materials/cradle-white/cradle-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_ao.png", "url": "/materials/cradle-white/cradle-white_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "envMapIntensity": 1.0, "referencePbr": {"version": "1.0", "sourceImage": "/home/claude/g300-work/crops/cradle-white.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.764, "estimatedFidelity": 0.764, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_albedo.png", "url": "/materials/cradle-white/cradle-white_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_roughness.png", "url": "/materials/cradle-white/cradle-white_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_height.png", "url": "/materials/cradle-white/cradle-white_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_normal.png", "url": "/materials/cradle-white/cradle-white_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/claude/g300-work/material-evidence/cradle-white/cradle-white_ao.png", "url": "/materials/cradle-white/cradle-white_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 128, "sourceHeight": 128, "mapSize": 1024, "cropBBoxPixels": {"x": 9, "y": 1, "width": 58, "height": 125}, "mask": {"backgroundColor": "#9A9A9A", "backgroundNoise": 69.282, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1555}, "mapStats": {"valueRange": 0.08, "heightP90Gradient": 0.01116, "roughnessBase": 0.681, "roughnessVariation": 0.05, "normalStrength": 0.169, "blurRadius": 21}, "palette": ["#FCFDFA", "#FFFFFD", "#FBFBF9", "#FEFEFC"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "G300 base frame__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.06, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "G300 base frame", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Flat steel base frame, genuinely box shaped.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 4.0, "height": 0.12, "depth": 1.75, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 0.06, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "plant-floor", "localPosition": [0, -0.06, 0], "purpose": "anchor on plant floor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.12, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "plant-floor", "localPosition": [0, -0.06, 0], "purpose": "anchor on plant floor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.12, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(4.0, 0.12, 1.75);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["dark-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "G300 base frame";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "G300 base frame", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Flat steel base frame, genuinely box shaped.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 4.0, "height": 0.12, "depth": 1.75, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 0.06, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "plant-floor", "localPosition": [0, -0.06, 0], "purpose": "anchor on plant floor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.12, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.12, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);
  const socket_root_plant_floor_0 = new THREE.Object3D();
  socket_root_plant_floor_0.name = "plant-floor";
  socket_root_plant_floor_0.position.set(0.0, -0.06, 0.0);
  socket_root_plant_floor_0.rotation.set(0, 0, 0);
  socket_root_plant_floor_0.userData.socket = {"id": "plant-floor", "localPosition": [0, -0.06, 0], "purpose": "anchor on plant floor", "axis": [0, 1, 0]};
  node_root_0.add(socket_root_plant_floor_0);
  sockets["root:plant-floor"] = socket_root_plant_floor_0;

  const endpoint_enclosure_1 = makeAttachmentEndpoint(null);
  const node_enclosure_1 = new THREE.Group();
  node_enclosure_1.name = "Enclosure body__pivot";
  node_enclosure_1.scale.set(1, 1, 1);
  if (endpoint_enclosure_1) {
    node_enclosure_1.position.copy(endpoint_enclosure_1.start);
    node_enclosure_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_enclosure_1.position.set(0.0, 0.06, 0.0);
    node_enclosure_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_enclosure_1.userData.sculptComponent = {"id": "enclosure", "name": "Enclosure body", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Grouping node carrying the enclosure panels.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [0, 0.06, 0], "localEnd": [0, 0.06, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.04, "height": 0.04, "depth": 0.04, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 0.06, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "enclosure", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_enclosure_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "enclosure", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_enclosure_1);
  nodes["enclosure"] = node_enclosure_1;
  const mesh_enclosure_1Geometry = endpoint_enclosure_1
    ? new THREE.CylinderGeometry(endpoint_enclosure_1.endRadius, endpoint_enclosure_1.baseRadius, endpoint_enclosure_1.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_enclosure_1) {
    mesh_enclosure_1Geometry.scale(0.04, 0.04, 0.04);
  }
  const mesh_enclosure_1 = new THREE.Mesh(
    mesh_enclosure_1Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_enclosure_1.name = "Enclosure body";
  if (endpoint_enclosure_1) {
    mesh_enclosure_1.position.copy(endpoint_enclosure_1.midpoint);
    mesh_enclosure_1.quaternion.copy(endpoint_enclosure_1.quaternion);
  }
  mesh_enclosure_1.castShadow = options.castShadow ?? true;
  mesh_enclosure_1.receiveShadow = options.receiveShadow ?? true;
  mesh_enclosure_1.userData.sculptComponent = {"id": "enclosure", "name": "Enclosure body", "level": "macro", "role": "body", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Grouping node carrying the enclosure panels.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [0, 0.06, 0], "localEnd": [0, 0.06, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.04, "height": 0.04, "depth": 0.04, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 0.06, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "enclosure", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_enclosure_1.add(mesh_enclosure_1);
  meshes["enclosure"] = mesh_enclosure_1;
  colliders["enclosure"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["enclosure"] ??= [];
  destructionGroups["enclosure"].push(node_enclosure_1);

  const endpoint_front_panel_2 = makeAttachmentEndpoint(null);
  const node_front_panel_2 = new THREE.Group();
  node_front_panel_2.name = "Front panel with G300 lettering__pivot";
  node_front_panel_2.scale.set(1, 1, 1);
  if (endpoint_front_panel_2) {
    node_front_panel_2.position.copy(endpoint_front_panel_2.start);
    node_front_panel_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_panel_2.position.set(-1.975, 1.18, -0.525);
    node_front_panel_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_panel_2.userData.sculptComponent = {"id": "front-panel", "name": "Front panel with G300 lettering", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.975, 1.18, -0.525], "localEnd": [-1.975, 1.18, -0.525], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 2.35, "depth": 0.7, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.975, 1.18, -0.525], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "g300-lettering", "type": "inscription", "note": "large italic G300, canvas decal"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_front_panel_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_front_panel_2);
  nodes["front-panel"] = node_front_panel_2;
  const mesh_front_panel_2Geometry = endpoint_front_panel_2
    ? new THREE.CylinderGeometry(endpoint_front_panel_2.endRadius, endpoint_front_panel_2.baseRadius, endpoint_front_panel_2.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_front_panel_2) {
    mesh_front_panel_2Geometry.scale(0.05, 2.35, 0.7);
  }
  const mesh_front_panel_2 = new THREE.Mesh(
    mesh_front_panel_2Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_panel_2.name = "Front panel with G300 lettering";
  if (endpoint_front_panel_2) {
    mesh_front_panel_2.position.copy(endpoint_front_panel_2.midpoint);
    mesh_front_panel_2.quaternion.copy(endpoint_front_panel_2.quaternion);
  }
  mesh_front_panel_2.castShadow = options.castShadow ?? true;
  mesh_front_panel_2.receiveShadow = options.receiveShadow ?? true;
  mesh_front_panel_2.userData.sculptComponent = {"id": "front-panel", "name": "Front panel with G300 lettering", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.975, 1.18, -0.525], "localEnd": [-1.975, 1.18, -0.525], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 2.35, "depth": 0.7, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.975, 1.18, -0.525], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "g300-lettering", "type": "inscription", "note": "large italic G300, canvas decal"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_front_panel_2.add(mesh_front_panel_2);
  meshes["front-panel"] = mesh_front_panel_2;
  colliders["front-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["front-panel"] ??= [];
  destructionGroups["front-panel"].push(node_front_panel_2);

  const endpoint_front_lower_block_3 = makeAttachmentEndpoint(null);
  const node_front_lower_block_3 = new THREE.Group();
  node_front_lower_block_3.name = "Chip outlet block (front, below work area)__pivot";
  node_front_lower_block_3.scale.set(1, 1, 1);
  if (endpoint_front_lower_block_3) {
    node_front_lower_block_3.position.copy(endpoint_front_lower_block_3.start);
    node_front_lower_block_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_lower_block_3.position.set(-1.575, 0.36, 0.35);
    node_front_lower_block_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_lower_block_3.userData.sculptComponent = {"id": "front-lower-block", "name": "Chip outlet block (front, below work area)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.575, 0.36, 0.35], "localEnd": [-1.575, 0.36, 0.35], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.85, "height": 0.72, "depth": 1.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.575, 0.36, 0.35], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.85, 0.72, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-lower-block", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arched-cutout", "type": "opening", "note": "black half-round chip outlet"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_front_lower_block_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.85, 0.72, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-lower-block", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_front_lower_block_3);
  nodes["front-lower-block"] = node_front_lower_block_3;
  const mesh_front_lower_block_3Geometry = endpoint_front_lower_block_3
    ? new THREE.CylinderGeometry(endpoint_front_lower_block_3.endRadius, endpoint_front_lower_block_3.baseRadius, endpoint_front_lower_block_3.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_front_lower_block_3) {
    mesh_front_lower_block_3Geometry.scale(0.85, 0.72, 1.05);
  }
  const mesh_front_lower_block_3 = new THREE.Mesh(
    mesh_front_lower_block_3Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_lower_block_3.name = "Chip outlet block (front, below work area)";
  if (endpoint_front_lower_block_3) {
    mesh_front_lower_block_3.position.copy(endpoint_front_lower_block_3.midpoint);
    mesh_front_lower_block_3.quaternion.copy(endpoint_front_lower_block_3.quaternion);
  }
  mesh_front_lower_block_3.castShadow = options.castShadow ?? true;
  mesh_front_lower_block_3.receiveShadow = options.receiveShadow ?? true;
  mesh_front_lower_block_3.userData.sculptComponent = {"id": "front-lower-block", "name": "Chip outlet block (front, below work area)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.575, 0.36, 0.35], "localEnd": [-1.575, 0.36, 0.35], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.85, "height": 0.72, "depth": 1.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.575, 0.36, 0.35], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.85, 0.72, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-lower-block", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arched-cutout", "type": "opening", "note": "black half-round chip outlet"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_front_lower_block_3.add(mesh_front_lower_block_3);
  meshes["front-lower-block"] = mesh_front_lower_block_3;
  colliders["front-lower-block"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.85, 0.72, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["front-lower-block"] ??= [];
  destructionGroups["front-lower-block"].push(node_front_lower_block_3);

  const attachment_chip_outlet_4 = {"parentSocket": "front-lower-block:mount", "contactType": "socket", "localStart": [-0.375, 0.07, 0.1], "localEnd": [-0.435, 0.07, 0.1], "baseRadius": 0.16, "endRadius": 0.16, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]};
  const endpoint_chip_outlet_4 = makeAttachmentEndpoint(attachment_chip_outlet_4);
  const node_chip_outlet_4 = new THREE.Group();
  node_chip_outlet_4.name = "Chip outlet opening__pivot";
  node_chip_outlet_4.scale.set(1, 1, 1);
  if (endpoint_chip_outlet_4) {
    node_chip_outlet_4.position.copy(endpoint_chip_outlet_4.start);
    node_chip_outlet_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chip_outlet_4.position.set(-0.375, 0.07, 0.1);
    node_chip_outlet_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_chip_outlet_4.userData.sculptComponent = {"id": "chip-outlet", "name": "Chip outlet opening", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "Recessed round opening, read as dark disc.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-lower-block", "attachment": {"parentSocket": "front-lower-block:mount", "contactType": "socket", "localStart": [-0.375, 0.07, 0.1], "localEnd": [-0.435, 0.07, 0.1], "baseRadius": 0.16, "endRadius": 0.16, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]}, "dimensions": {"width": 0.32, "height": 0.06, "depth": 0.32, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.375, 0.07, 0.1], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.32, 0.06, 0.32], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chip-outlet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "black", "materialLayers": ["black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 30, 32, 1.0)", "secondaryAlbedo": "rgba(28, 30, 32, 0.9)", "materialClass": "plastic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_chip_outlet_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.32, 0.06, 0.32], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chip-outlet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["front-lower-block"] ?? root).add(node_chip_outlet_4);
  nodes["chip-outlet"] = node_chip_outlet_4;
  const mesh_chip_outlet_4Geometry = endpoint_chip_outlet_4
    ? new THREE.CylinderGeometry(endpoint_chip_outlet_4.endRadius, endpoint_chip_outlet_4.baseRadius, endpoint_chip_outlet_4.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_chip_outlet_4) {
    mesh_chip_outlet_4Geometry.scale(0.32, 0.06, 0.32);
  }
  const mesh_chip_outlet_4 = new THREE.Mesh(
    mesh_chip_outlet_4Geometry,
    materialMap["black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chip_outlet_4.name = "Chip outlet opening";
  if (endpoint_chip_outlet_4) {
    mesh_chip_outlet_4.position.copy(endpoint_chip_outlet_4.midpoint);
    mesh_chip_outlet_4.quaternion.copy(endpoint_chip_outlet_4.quaternion);
  }
  mesh_chip_outlet_4.castShadow = options.castShadow ?? true;
  mesh_chip_outlet_4.receiveShadow = options.receiveShadow ?? true;
  mesh_chip_outlet_4.userData.sculptComponent = {"id": "chip-outlet", "name": "Chip outlet opening", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "Recessed round opening, read as dark disc.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-lower-block", "attachment": {"parentSocket": "front-lower-block:mount", "contactType": "socket", "localStart": [-0.375, 0.07, 0.1], "localEnd": [-0.435, 0.07, 0.1], "baseRadius": 0.16, "endRadius": 0.16, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]}, "dimensions": {"width": 0.32, "height": 0.06, "depth": 0.32, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.375, 0.07, 0.1], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.32, 0.06, 0.32], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chip-outlet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "black", "materialLayers": ["black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 30, 32, 1.0)", "secondaryAlbedo": "rgba(28, 30, 32, 0.9)", "materialClass": "plastic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_chip_outlet_4.add(mesh_chip_outlet_4);
  meshes["chip-outlet"] = mesh_chip_outlet_4;
  colliders["chip-outlet"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.32, 0.06, 0.32], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["chip-outlet"] ??= [];
  destructionGroups["chip-outlet"].push(node_chip_outlet_4);

  const endpoint_left_wall_work_5 = makeAttachmentEndpoint(null);
  const node_left_wall_work_5 = new THREE.Group();
  node_left_wall_work_5.name = "Work area side wall (far side)__pivot";
  node_left_wall_work_5.scale.set(1, 1, 1);
  if (endpoint_left_wall_work_5) {
    node_left_wall_work_5.position.copy(endpoint_left_wall_work_5.start);
    node_left_wall_work_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_left_wall_work_5.position.set(-1.45, 1.48, -0.2);
    node_left_wall_work_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_left_wall_work_5.userData.sculptComponent = {"id": "left-wall-work", "name": "Work area side wall (far side)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.45, 1.48, -0.2], "localEnd": [-1.45, 1.48, -0.2], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.1, "height": 1.7, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.45, 1.48, -0.2], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 1.7, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-wall-work", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_left_wall_work_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 1.7, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-wall-work", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_left_wall_work_5);
  nodes["left-wall-work"] = node_left_wall_work_5;
  const mesh_left_wall_work_5Geometry = endpoint_left_wall_work_5
    ? new THREE.CylinderGeometry(endpoint_left_wall_work_5.endRadius, endpoint_left_wall_work_5.baseRadius, endpoint_left_wall_work_5.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_left_wall_work_5) {
    mesh_left_wall_work_5Geometry.scale(1.1, 1.7, 0.05);
  }
  const mesh_left_wall_work_5 = new THREE.Mesh(
    mesh_left_wall_work_5Geometry,
    materialMap["panel-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_left_wall_work_5.name = "Work area side wall (far side)";
  if (endpoint_left_wall_work_5) {
    mesh_left_wall_work_5.position.copy(endpoint_left_wall_work_5.midpoint);
    mesh_left_wall_work_5.quaternion.copy(endpoint_left_wall_work_5.quaternion);
  }
  mesh_left_wall_work_5.castShadow = options.castShadow ?? true;
  mesh_left_wall_work_5.receiveShadow = options.receiveShadow ?? true;
  mesh_left_wall_work_5.userData.sculptComponent = {"id": "left-wall-work", "name": "Work area side wall (far side)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.45, 1.48, -0.2], "localEnd": [-1.45, 1.48, -0.2], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.1, "height": 1.7, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.45, 1.48, -0.2], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 1.7, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "left-wall-work", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_left_wall_work_5.add(mesh_left_wall_work_5);
  meshes["left-wall-work"] = mesh_left_wall_work_5;
  colliders["left-wall-work"] = {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 1.7, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["left-wall-work"] ??= [];
  destructionGroups["left-wall-work"].push(node_left_wall_work_5);

  const endpoint_work_floor_6 = makeAttachmentEndpoint(null);
  const node_work_floor_6 = new THREE.Group();
  node_work_floor_6.name = "Work area floor / chip trough__pivot";
  node_work_floor_6.scale.set(1, 1, 1);
  if (endpoint_work_floor_6) {
    node_work_floor_6.position.copy(endpoint_work_floor_6.start);
    node_work_floor_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_work_floor_6.position.set(-1.45, 0.73, 0.35);
    node_work_floor_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_work_floor_6.userData.sculptComponent = {"id": "work-floor", "name": "Work area floor / chip trough", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.45, 0.73, 0.35], "localEnd": [-1.45, 0.73, 0.35], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.1, "height": 0.05, "depth": 1.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.45, 0.73, 0.35], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 0.05, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "work-floor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_work_floor_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 0.05, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "work-floor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_work_floor_6);
  nodes["work-floor"] = node_work_floor_6;
  const mesh_work_floor_6Geometry = endpoint_work_floor_6
    ? new THREE.CylinderGeometry(endpoint_work_floor_6.endRadius, endpoint_work_floor_6.baseRadius, endpoint_work_floor_6.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_work_floor_6) {
    mesh_work_floor_6Geometry.scale(1.1, 0.05, 1.05);
  }
  const mesh_work_floor_6 = new THREE.Mesh(
    mesh_work_floor_6Geometry,
    materialMap["panel-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_work_floor_6.name = "Work area floor / chip trough";
  if (endpoint_work_floor_6) {
    mesh_work_floor_6.position.copy(endpoint_work_floor_6.midpoint);
    mesh_work_floor_6.quaternion.copy(endpoint_work_floor_6.quaternion);
  }
  mesh_work_floor_6.castShadow = options.castShadow ?? true;
  mesh_work_floor_6.receiveShadow = options.receiveShadow ?? true;
  mesh_work_floor_6.userData.sculptComponent = {"id": "work-floor", "name": "Work area floor / chip trough", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.45, 0.73, 0.35], "localEnd": [-1.45, 0.73, 0.35], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.1, "height": 0.05, "depth": 1.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.45, 0.73, 0.35], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 0.05, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "work-floor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_work_floor_6.add(mesh_work_floor_6);
  meshes["work-floor"] = mesh_work_floor_6;
  colliders["work-floor"] = {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 0.05, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["work-floor"] ??= [];
  destructionGroups["work-floor"].push(node_work_floor_6);

  const endpoint_column_wall_7 = makeAttachmentEndpoint(null);
  const node_column_wall_7 = new THREE.Group();
  node_column_wall_7.name = "Column wall facing work area__pivot";
  node_column_wall_7.scale.set(1, 1, 1);
  if (endpoint_column_wall_7) {
    node_column_wall_7.position.copy(endpoint_column_wall_7.start);
    node_column_wall_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_column_wall_7.position.set(-0.92, 1.48, 0.35);
    node_column_wall_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_column_wall_7.userData.sculptComponent = {"id": "column-wall", "name": "Column wall facing work area", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-0.92, 1.48, 0.35], "localEnd": [-0.92, 1.48, 0.35], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.06, "height": 1.7, "depth": 1.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.92, 1.48, 0.35], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 1.7, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "column-wall", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "way-cover", "type": "telescopic cover", "note": "steel ribbed cover around spindle"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_column_wall_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 1.7, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "column-wall", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_column_wall_7);
  nodes["column-wall"] = node_column_wall_7;
  const mesh_column_wall_7Geometry = endpoint_column_wall_7
    ? new THREE.CylinderGeometry(endpoint_column_wall_7.endRadius, endpoint_column_wall_7.baseRadius, endpoint_column_wall_7.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_column_wall_7) {
    mesh_column_wall_7Geometry.scale(0.06, 1.7, 1.05);
  }
  const mesh_column_wall_7 = new THREE.Mesh(
    mesh_column_wall_7Geometry,
    materialMap["panel-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_column_wall_7.name = "Column wall facing work area";
  if (endpoint_column_wall_7) {
    mesh_column_wall_7.position.copy(endpoint_column_wall_7.midpoint);
    mesh_column_wall_7.quaternion.copy(endpoint_column_wall_7.quaternion);
  }
  mesh_column_wall_7.castShadow = options.castShadow ?? true;
  mesh_column_wall_7.receiveShadow = options.receiveShadow ?? true;
  mesh_column_wall_7.userData.sculptComponent = {"id": "column-wall", "name": "Column wall facing work area", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-0.92, 1.48, 0.35], "localEnd": [-0.92, 1.48, 0.35], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.06, "height": 1.7, "depth": 1.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.92, 1.48, 0.35], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 1.7, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "column-wall", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "way-cover", "type": "telescopic cover", "note": "steel ribbed cover around spindle"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_column_wall_7.add(mesh_column_wall_7);
  meshes["column-wall"] = mesh_column_wall_7;
  colliders["column-wall"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 1.7, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["column-wall"] ??= [];
  destructionGroups["column-wall"].push(node_column_wall_7);

  const endpoint_way_cover_8 = makeAttachmentEndpoint(null);
  const node_way_cover_8 = new THREE.Group();
  node_way_cover_8.name = "Telescopic way cover around spindle__pivot";
  node_way_cover_8.scale.set(1, 1, 1);
  if (endpoint_way_cover_8) {
    node_way_cover_8.position.copy(endpoint_way_cover_8.start);
    node_way_cover_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_way_cover_8.position.set(-0.96, 1.58, 0.42);
    node_way_cover_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_way_cover_8.userData.sculptComponent = {"id": "way-cover", "name": "Telescopic way cover around spindle", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-0.96, 1.58, 0.42], "localEnd": [-0.96, 1.58, 0.42], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.04, "height": 1.0, "depth": 0.75, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.96, 1.58, 0.42], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 1.7, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "way-cover", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "way-cover-ribs", "type": "repetition"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_way_cover_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 1.7, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "way-cover", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_way_cover_8);
  nodes["way-cover"] = node_way_cover_8;
  const mesh_way_cover_8Geometry = endpoint_way_cover_8
    ? new THREE.CylinderGeometry(endpoint_way_cover_8.endRadius, endpoint_way_cover_8.baseRadius, endpoint_way_cover_8.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_way_cover_8) {
    mesh_way_cover_8Geometry.scale(0.04, 1.0, 0.75);
  }
  const mesh_way_cover_8 = new THREE.Mesh(
    mesh_way_cover_8Geometry,
    materialMap["dark-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_way_cover_8.name = "Telescopic way cover around spindle";
  if (endpoint_way_cover_8) {
    mesh_way_cover_8.position.copy(endpoint_way_cover_8.midpoint);
    mesh_way_cover_8.quaternion.copy(endpoint_way_cover_8.quaternion);
  }
  mesh_way_cover_8.castShadow = options.castShadow ?? true;
  mesh_way_cover_8.receiveShadow = options.receiveShadow ?? true;
  mesh_way_cover_8.userData.sculptComponent = {"id": "way-cover", "name": "Telescopic way cover around spindle", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-0.96, 1.58, 0.42], "localEnd": [-0.96, 1.58, 0.42], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.04, "height": 1.0, "depth": 0.75, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.96, 1.58, 0.42], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 1.7, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "way-cover", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "way-cover-ribs", "type": "repetition"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_way_cover_8.add(mesh_way_cover_8);
  meshes["way-cover"] = mesh_way_cover_8;
  colliders["way-cover"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.06, 1.7, 1.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["way-cover"] ??= [];
  destructionGroups["way-cover"].push(node_way_cover_8);

  const endpoint_long_side_9 = makeAttachmentEndpoint(null);
  const node_long_side_9 = new THREE.Group();
  node_long_side_9.name = "Long side panels (visible side)__pivot";
  node_long_side_9.scale.set(1, 1, 1);
  if (endpoint_long_side_9) {
    node_long_side_9.position.copy(endpoint_long_side_9.start);
    node_long_side_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_long_side_9.position.set(0.02, 1.18, 0.85);
    node_long_side_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_long_side_9.userData.sculptComponent = {"id": "long-side", "name": "Long side panels (visible side)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [0.02, 1.18, 0.85], "localEnd": [0.02, 1.18, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.85, "height": 2.35, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [0.02, 1.18, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.85, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "long-side", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "inspection-windows", "type": "panel"}, {"id": "arched-service-cutout", "type": "opening"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_long_side_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.85, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "long-side", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_long_side_9);
  nodes["long-side"] = node_long_side_9;
  const mesh_long_side_9Geometry = endpoint_long_side_9
    ? new THREE.CylinderGeometry(endpoint_long_side_9.endRadius, endpoint_long_side_9.baseRadius, endpoint_long_side_9.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_long_side_9) {
    mesh_long_side_9Geometry.scale(1.85, 2.35, 0.05);
  }
  const mesh_long_side_9 = new THREE.Mesh(
    mesh_long_side_9Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_long_side_9.name = "Long side panels (visible side)";
  if (endpoint_long_side_9) {
    mesh_long_side_9.position.copy(endpoint_long_side_9.midpoint);
    mesh_long_side_9.quaternion.copy(endpoint_long_side_9.quaternion);
  }
  mesh_long_side_9.castShadow = options.castShadow ?? true;
  mesh_long_side_9.receiveShadow = options.receiveShadow ?? true;
  mesh_long_side_9.userData.sculptComponent = {"id": "long-side", "name": "Long side panels (visible side)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [0.02, 1.18, 0.85], "localEnd": [0.02, 1.18, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.85, "height": 2.35, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [0.02, 1.18, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.85, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "long-side", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "inspection-windows", "type": "panel"}, {"id": "arched-service-cutout", "type": "opening"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_long_side_9.add(mesh_long_side_9);
  meshes["long-side"] = mesh_long_side_9;
  colliders["long-side"] = {"type": "box", "offset": [0, 0, 0], "scale": [1.85, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["long-side"] ??= [];
  destructionGroups["long-side"].push(node_long_side_9);

  const endpoint_long_side_front_10 = makeAttachmentEndpoint(null);
  const node_long_side_front_10 = new THREE.Group();
  node_long_side_front_10.name = "Long side panel beside work area__pivot";
  node_long_side_front_10.scale.set(1, 1, 1);
  if (endpoint_long_side_front_10) {
    node_long_side_front_10.position.copy(endpoint_long_side_front_10.start);
    node_long_side_front_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_long_side_front_10.position.set(-1.45, 1.18, 0.85);
    node_long_side_front_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_long_side_front_10.userData.sculptComponent = {"id": "long-side-front", "name": "Long side panel beside work area", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.45, 1.18, 0.85], "localEnd": [-1.45, 1.18, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.1, "height": 2.35, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.45, 1.18, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.85, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "long-side-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_long_side_front_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.85, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "long-side-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_long_side_front_10);
  nodes["long-side-front"] = node_long_side_front_10;
  const mesh_long_side_front_10Geometry = endpoint_long_side_front_10
    ? new THREE.CylinderGeometry(endpoint_long_side_front_10.endRadius, endpoint_long_side_front_10.baseRadius, endpoint_long_side_front_10.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_long_side_front_10) {
    mesh_long_side_front_10Geometry.scale(1.1, 2.35, 0.05);
  }
  const mesh_long_side_front_10 = new THREE.Mesh(
    mesh_long_side_front_10Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_long_side_front_10.name = "Long side panel beside work area";
  if (endpoint_long_side_front_10) {
    mesh_long_side_front_10.position.copy(endpoint_long_side_front_10.midpoint);
    mesh_long_side_front_10.quaternion.copy(endpoint_long_side_front_10.quaternion);
  }
  mesh_long_side_front_10.castShadow = options.castShadow ?? true;
  mesh_long_side_front_10.receiveShadow = options.receiveShadow ?? true;
  mesh_long_side_front_10.userData.sculptComponent = {"id": "long-side-front", "name": "Long side panel beside work area", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.45, 1.18, 0.85], "localEnd": [-1.45, 1.18, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.1, "height": 2.35, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.45, 1.18, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.85, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "long-side-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_long_side_front_10.add(mesh_long_side_front_10);
  meshes["long-side-front"] = mesh_long_side_front_10;
  colliders["long-side-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1.85, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["long-side-front"] ??= [];
  destructionGroups["long-side-front"].push(node_long_side_front_10);

  const endpoint_corner_post_11 = makeAttachmentEndpoint(null);
  const node_corner_post_11 = new THREE.Group();
  node_corner_post_11.name = "Front corner post__pivot";
  node_corner_post_11.scale.set(1, 1, 1);
  if (endpoint_corner_post_11) {
    node_corner_post_11.position.copy(endpoint_corner_post_11.start);
    node_corner_post_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_corner_post_11.position.set(-1.97, 1.18, 0.85);
    node_corner_post_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_corner_post_11.userData.sculptComponent = {"id": "corner-post", "name": "Front corner post", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.97, 1.18, 0.85], "localEnd": [-1.97, 1.18, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.08, "height": 2.35, "depth": 0.08, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.97, 1.18, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "corner-post", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_corner_post_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "corner-post", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_corner_post_11);
  nodes["corner-post"] = node_corner_post_11;
  const mesh_corner_post_11Geometry = endpoint_corner_post_11
    ? new THREE.CylinderGeometry(endpoint_corner_post_11.endRadius, endpoint_corner_post_11.baseRadius, endpoint_corner_post_11.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_corner_post_11) {
    mesh_corner_post_11Geometry.scale(0.08, 2.35, 0.08);
  }
  const mesh_corner_post_11 = new THREE.Mesh(
    mesh_corner_post_11Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_corner_post_11.name = "Front corner post";
  if (endpoint_corner_post_11) {
    mesh_corner_post_11.position.copy(endpoint_corner_post_11.midpoint);
    mesh_corner_post_11.quaternion.copy(endpoint_corner_post_11.quaternion);
  }
  mesh_corner_post_11.castShadow = options.castShadow ?? true;
  mesh_corner_post_11.receiveShadow = options.receiveShadow ?? true;
  mesh_corner_post_11.userData.sculptComponent = {"id": "corner-post", "name": "Front corner post", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [-1.97, 1.18, 0.85], "localEnd": [-1.97, 1.18, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.08, "height": 2.35, "depth": 0.08, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.97, 1.18, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "corner-post", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_corner_post_11.add(mesh_corner_post_11);
  meshes["corner-post"] = mesh_corner_post_11;
  colliders["corner-post"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["corner-post"] ??= [];
  destructionGroups["corner-post"].push(node_corner_post_11);

  const endpoint_window_1_12 = makeAttachmentEndpoint(null);
  const node_window_1_12 = new THREE.Group();
  node_window_1_12.name = "Inspection window 1__pivot";
  node_window_1_12.scale.set(1, 1, 1);
  if (endpoint_window_1_12) {
    node_window_1_12.position.copy(endpoint_window_1_12.start);
    node_window_1_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_1_12.position.set(0.0, 0.55, 0.03);
    node_window_1_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_1_12.userData.sculptComponent = {"id": "window-1", "name": "Inspection window 1", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Flush tinted glass pane.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "long-side", "attachment": {"parentSocket": "long-side:mount", "contactType": "butt", "localStart": [0.0, 0.55, 0.03], "localEnd": [0.0, 0.55, 0.03], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.42, "height": 0.62, "depth": 0.02, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.55, 0.03], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.42, 0.62, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "glass", "materialLayers": ["glass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 51, 56, 1.0)", "secondaryAlbedo": "rgba(46, 51, 56, 0.9)", "materialClass": "glass", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_window_1_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.42, 0.62, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["long-side"] ?? root).add(node_window_1_12);
  nodes["window-1"] = node_window_1_12;
  const mesh_window_1_12Geometry = endpoint_window_1_12
    ? new THREE.CylinderGeometry(endpoint_window_1_12.endRadius, endpoint_window_1_12.baseRadius, endpoint_window_1_12.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_1_12) {
    mesh_window_1_12Geometry.scale(0.42, 0.62, 0.02);
  }
  const mesh_window_1_12 = new THREE.Mesh(
    mesh_window_1_12Geometry,
    materialMap["glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_1_12.name = "Inspection window 1";
  if (endpoint_window_1_12) {
    mesh_window_1_12.position.copy(endpoint_window_1_12.midpoint);
    mesh_window_1_12.quaternion.copy(endpoint_window_1_12.quaternion);
  }
  mesh_window_1_12.castShadow = options.castShadow ?? true;
  mesh_window_1_12.receiveShadow = options.receiveShadow ?? true;
  mesh_window_1_12.userData.sculptComponent = {"id": "window-1", "name": "Inspection window 1", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Flush tinted glass pane.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "long-side", "attachment": {"parentSocket": "long-side:mount", "contactType": "butt", "localStart": [0.0, 0.55, 0.03], "localEnd": [0.0, 0.55, 0.03], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.42, "height": 0.62, "depth": 0.02, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.55, 0.03], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.42, 0.62, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "glass", "materialLayers": ["glass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 51, 56, 1.0)", "secondaryAlbedo": "rgba(46, 51, 56, 0.9)", "materialClass": "glass", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_window_1_12.add(mesh_window_1_12);
  meshes["window-1"] = mesh_window_1_12;
  colliders["window-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.42, 0.62, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["window-1"] ??= [];
  destructionGroups["window-1"].push(node_window_1_12);

  const endpoint_window_2_13 = makeAttachmentEndpoint(null);
  const node_window_2_13 = new THREE.Group();
  node_window_2_13.name = "Inspection window 2__pivot";
  node_window_2_13.scale.set(1, 1, 1);
  if (endpoint_window_2_13) {
    node_window_2_13.position.copy(endpoint_window_2_13.start);
    node_window_2_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_window_2_13.position.set(0.7, 0.25, 0.03);
    node_window_2_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_window_2_13.userData.sculptComponent = {"id": "window-2", "name": "Inspection window 2", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Flush tinted glass pane.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "long-side", "attachment": {"parentSocket": "long-side:mount", "contactType": "butt", "localStart": [0.7, 0.25, 0.03], "localEnd": [0.7, 0.25, 0.03], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.25, "height": 0.55, "depth": 0.02, "units": "m", "confidence": 0.75}, "transform": {"position": [0.7, 0.25, 0.03], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.25, 0.55, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "glass", "materialLayers": ["glass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 51, 56, 1.0)", "secondaryAlbedo": "rgba(46, 51, 56, 0.9)", "materialClass": "glass", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_window_2_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.25, 0.55, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["long-side"] ?? root).add(node_window_2_13);
  nodes["window-2"] = node_window_2_13;
  const mesh_window_2_13Geometry = endpoint_window_2_13
    ? new THREE.CylinderGeometry(endpoint_window_2_13.endRadius, endpoint_window_2_13.baseRadius, endpoint_window_2_13.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_window_2_13) {
    mesh_window_2_13Geometry.scale(0.25, 0.55, 0.02);
  }
  const mesh_window_2_13 = new THREE.Mesh(
    mesh_window_2_13Geometry,
    materialMap["glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_window_2_13.name = "Inspection window 2";
  if (endpoint_window_2_13) {
    mesh_window_2_13.position.copy(endpoint_window_2_13.midpoint);
    mesh_window_2_13.quaternion.copy(endpoint_window_2_13.quaternion);
  }
  mesh_window_2_13.castShadow = options.castShadow ?? true;
  mesh_window_2_13.receiveShadow = options.receiveShadow ?? true;
  mesh_window_2_13.userData.sculptComponent = {"id": "window-2", "name": "Inspection window 2", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Flush tinted glass pane.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "long-side", "attachment": {"parentSocket": "long-side:mount", "contactType": "butt", "localStart": [0.7, 0.25, 0.03], "localEnd": [0.7, 0.25, 0.03], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.25, "height": 0.55, "depth": 0.02, "units": "m", "confidence": 0.75}, "transform": {"position": [0.7, 0.25, 0.03], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.25, 0.55, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "window-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "glass", "materialLayers": ["glass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(46, 51, 56, 1.0)", "secondaryAlbedo": "rgba(46, 51, 56, 0.9)", "materialClass": "glass", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_window_2_13.add(mesh_window_2_13);
  meshes["window-2"] = mesh_window_2_13;
  colliders["window-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.25, 0.55, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["window-2"] ??= [];
  destructionGroups["window-2"].push(node_window_2_13);

  const endpoint_service_arch_14 = makeAttachmentEndpoint(null);
  const node_service_arch_14 = new THREE.Group();
  node_service_arch_14.name = "Arched service cut-out__pivot";
  node_service_arch_14.scale.set(1, 1, 1);
  if (endpoint_service_arch_14) {
    node_service_arch_14.position.copy(endpoint_service_arch_14.start);
    node_service_arch_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_service_arch_14.position.set(-0.42, 0.18, 0.03);
    node_service_arch_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_service_arch_14.userData.sculptComponent = {"id": "service-arch", "name": "Arched service cut-out", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Dark recessed opening.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "long-side", "attachment": {"parentSocket": "long-side:mount", "contactType": "butt", "localStart": [-0.42, 0.18, 0.03], "localEnd": [-0.42, 0.18, 0.03], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.18, "height": 0.22, "depth": 0.02, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.42, 0.18, 0.03], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.18, 0.22, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "service-arch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "black", "materialLayers": ["black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 30, 32, 1.0)", "secondaryAlbedo": "rgba(28, 30, 32, 0.9)", "materialClass": "plastic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_service_arch_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.18, 0.22, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "service-arch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["long-side"] ?? root).add(node_service_arch_14);
  nodes["service-arch"] = node_service_arch_14;
  const mesh_service_arch_14Geometry = endpoint_service_arch_14
    ? new THREE.CylinderGeometry(endpoint_service_arch_14.endRadius, endpoint_service_arch_14.baseRadius, endpoint_service_arch_14.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_service_arch_14) {
    mesh_service_arch_14Geometry.scale(0.18, 0.22, 0.02);
  }
  const mesh_service_arch_14 = new THREE.Mesh(
    mesh_service_arch_14Geometry,
    materialMap["black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_service_arch_14.name = "Arched service cut-out";
  if (endpoint_service_arch_14) {
    mesh_service_arch_14.position.copy(endpoint_service_arch_14.midpoint);
    mesh_service_arch_14.quaternion.copy(endpoint_service_arch_14.quaternion);
  }
  mesh_service_arch_14.castShadow = options.castShadow ?? true;
  mesh_service_arch_14.receiveShadow = options.receiveShadow ?? true;
  mesh_service_arch_14.userData.sculptComponent = {"id": "service-arch", "name": "Arched service cut-out", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Dark recessed opening.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "long-side", "attachment": {"parentSocket": "long-side:mount", "contactType": "butt", "localStart": [-0.42, 0.18, 0.03], "localEnd": [-0.42, 0.18, 0.03], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.18, "height": 0.22, "depth": 0.02, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.42, 0.18, 0.03], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.18, 0.22, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "service-arch", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "black", "materialLayers": ["black"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 30, 32, 1.0)", "secondaryAlbedo": "rgba(28, 30, 32, 0.9)", "materialClass": "plastic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_service_arch_14.add(mesh_service_arch_14);
  meshes["service-arch"] = mesh_service_arch_14;
  colliders["service-arch"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.18, 0.22, 0.02], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["service-arch"] ??= [];
  destructionGroups["service-arch"].push(node_service_arch_14);

  const endpoint_far_side_15 = makeAttachmentEndpoint(null);
  const node_far_side_15 = new THREE.Group();
  node_far_side_15.name = "Far long side (hidden, mirrored)__pivot";
  node_far_side_15.scale.set(1, 1, 1);
  if (endpoint_far_side_15) {
    node_far_side_15.position.copy(endpoint_far_side_15.start);
    node_far_side_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_far_side_15.position.set(0.0, 1.18, -0.85);
    node_far_side_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_far_side_15.userData.sculptComponent = {"id": "far-side", "name": "Far long side (hidden, mirrored)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.35, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [0, 1.18, -0.85], "localEnd": [0, 1.18, -0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 4.0, "height": 2.35, "depth": 0.05, "units": "m", "confidence": 0.35}, "transform": {"position": [0, 1.18, -0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "far-side", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_far_side_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "far-side", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_far_side_15);
  nodes["far-side"] = node_far_side_15;
  const mesh_far_side_15Geometry = endpoint_far_side_15
    ? new THREE.CylinderGeometry(endpoint_far_side_15.endRadius, endpoint_far_side_15.baseRadius, endpoint_far_side_15.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_far_side_15) {
    mesh_far_side_15Geometry.scale(4.0, 2.35, 0.05);
  }
  const mesh_far_side_15 = new THREE.Mesh(
    mesh_far_side_15Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_far_side_15.name = "Far long side (hidden, mirrored)";
  if (endpoint_far_side_15) {
    mesh_far_side_15.position.copy(endpoint_far_side_15.midpoint);
    mesh_far_side_15.quaternion.copy(endpoint_far_side_15.quaternion);
  }
  mesh_far_side_15.castShadow = options.castShadow ?? true;
  mesh_far_side_15.receiveShadow = options.receiveShadow ?? true;
  mesh_far_side_15.userData.sculptComponent = {"id": "far-side", "name": "Far long side (hidden, mirrored)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.35, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [0, 1.18, -0.85], "localEnd": [0, 1.18, -0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 4.0, "height": 2.35, "depth": 0.05, "units": "m", "confidence": 0.35}, "transform": {"position": [0, 1.18, -0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "far-side", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_far_side_15.add(mesh_far_side_15);
  meshes["far-side"] = mesh_far_side_15;
  colliders["far-side"] = {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["far-side"] ??= [];
  destructionGroups["far-side"].push(node_far_side_15);

  const endpoint_rear_face_16 = makeAttachmentEndpoint(null);
  const node_rear_face_16 = new THREE.Group();
  node_rear_face_16.name = "Rear face (hidden, mirrored)__pivot";
  node_rear_face_16.scale.set(1, 1, 1);
  if (endpoint_rear_face_16) {
    node_rear_face_16.position.copy(endpoint_rear_face_16.start);
    node_rear_face_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rear_face_16.position.set(1.975, 1.18, 0.0);
    node_rear_face_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_rear_face_16.userData.sculptComponent = {"id": "rear-face", "name": "Rear face (hidden, mirrored)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.35, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [1.975, 1.18, 0], "localEnd": [1.975, 1.18, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 2.35, "depth": 1.75, "units": "m", "confidence": 0.35}, "transform": {"position": [1.975, 1.18, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rear-face", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_rear_face_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rear-face", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_rear_face_16);
  nodes["rear-face"] = node_rear_face_16;
  const mesh_rear_face_16Geometry = endpoint_rear_face_16
    ? new THREE.CylinderGeometry(endpoint_rear_face_16.endRadius, endpoint_rear_face_16.baseRadius, endpoint_rear_face_16.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_rear_face_16) {
    mesh_rear_face_16Geometry.scale(0.05, 2.35, 1.75);
  }
  const mesh_rear_face_16 = new THREE.Mesh(
    mesh_rear_face_16Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rear_face_16.name = "Rear face (hidden, mirrored)";
  if (endpoint_rear_face_16) {
    mesh_rear_face_16.position.copy(endpoint_rear_face_16.midpoint);
    mesh_rear_face_16.quaternion.copy(endpoint_rear_face_16.quaternion);
  }
  mesh_rear_face_16.castShadow = options.castShadow ?? true;
  mesh_rear_face_16.receiveShadow = options.receiveShadow ?? true;
  mesh_rear_face_16.userData.sculptComponent = {"id": "rear-face", "name": "Rear face (hidden, mirrored)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.35, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [1.975, 1.18, 0], "localEnd": [1.975, 1.18, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 2.35, "depth": 1.75, "units": "m", "confidence": 0.35}, "transform": {"position": [1.975, 1.18, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rear-face", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_rear_face_16.add(mesh_rear_face_16);
  meshes["rear-face"] = mesh_rear_face_16;
  colliders["rear-face"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rear-face"] ??= [];
  destructionGroups["rear-face"].push(node_rear_face_16);

  const endpoint_bay_back_17 = makeAttachmentEndpoint(null);
  const node_bay_back_17 = new THREE.Group();
  node_bay_back_17.name = "Aggregate bay back wall__pivot";
  node_bay_back_17.scale.set(1, 1, 1);
  if (endpoint_bay_back_17) {
    node_bay_back_17.position.copy(endpoint_bay_back_17.start);
    node_bay_back_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bay_back_17.position.set(1.48, 1.28, 0.15);
    node_bay_back_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_bay_back_17.userData.sculptComponent = {"id": "bay-back", "name": "Aggregate bay back wall", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [1.48, 1.28, 0.15], "localEnd": [1.48, 1.28, 0.15], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.05, "height": 2.1, "depth": 0.04, "units": "m", "confidence": 0.75}, "transform": {"position": [1.48, 1.28, 0.15], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.05, 2.1, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_bay_back_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.05, 2.1, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_bay_back_17);
  nodes["bay-back"] = node_bay_back_17;
  const mesh_bay_back_17Geometry = endpoint_bay_back_17
    ? new THREE.CylinderGeometry(endpoint_bay_back_17.endRadius, endpoint_bay_back_17.baseRadius, endpoint_bay_back_17.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_bay_back_17) {
    mesh_bay_back_17Geometry.scale(1.05, 2.1, 0.04);
  }
  const mesh_bay_back_17 = new THREE.Mesh(
    mesh_bay_back_17Geometry,
    materialMap["panel-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bay_back_17.name = "Aggregate bay back wall";
  if (endpoint_bay_back_17) {
    mesh_bay_back_17.position.copy(endpoint_bay_back_17.midpoint);
    mesh_bay_back_17.quaternion.copy(endpoint_bay_back_17.quaternion);
  }
  mesh_bay_back_17.castShadow = options.castShadow ?? true;
  mesh_bay_back_17.receiveShadow = options.receiveShadow ?? true;
  mesh_bay_back_17.userData.sculptComponent = {"id": "bay-back", "name": "Aggregate bay back wall", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [1.48, 1.28, 0.15], "localEnd": [1.48, 1.28, 0.15], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.05, "height": 2.1, "depth": 0.04, "units": "m", "confidence": 0.75}, "transform": {"position": [1.48, 1.28, 0.15], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.05, 2.1, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_bay_back_17.add(mesh_bay_back_17);
  meshes["bay-back"] = mesh_bay_back_17;
  colliders["bay-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1.05, 2.1, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["bay-back"] ??= [];
  destructionGroups["bay-back"].push(node_bay_back_17);

  const endpoint_bay_shelf_18 = makeAttachmentEndpoint(null);
  const node_bay_shelf_18 = new THREE.Group();
  node_bay_shelf_18.name = "Aggregate bay shelf__pivot";
  node_bay_shelf_18.scale.set(1, 1, 1);
  if (endpoint_bay_shelf_18) {
    node_bay_shelf_18.position.copy(endpoint_bay_shelf_18.start);
    node_bay_shelf_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bay_shelf_18.position.set(1.48, 1.3, 0.5);
    node_bay_shelf_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_bay_shelf_18.userData.sculptComponent = {"id": "bay-shelf", "name": "Aggregate bay shelf", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [1.48, 1.3, 0.5], "localEnd": [1.48, 1.3, 0.5], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.0, "height": 0.04, "depth": 0.7, "units": "m", "confidence": 0.75}, "transform": {"position": [1.48, 1.3, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.0, 0.04, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-shelf", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_bay_shelf_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.0, 0.04, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-shelf", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_bay_shelf_18);
  nodes["bay-shelf"] = node_bay_shelf_18;
  const mesh_bay_shelf_18Geometry = endpoint_bay_shelf_18
    ? new THREE.CylinderGeometry(endpoint_bay_shelf_18.endRadius, endpoint_bay_shelf_18.baseRadius, endpoint_bay_shelf_18.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_bay_shelf_18) {
    mesh_bay_shelf_18Geometry.scale(1.0, 0.04, 0.7);
  }
  const mesh_bay_shelf_18 = new THREE.Mesh(
    mesh_bay_shelf_18Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bay_shelf_18.name = "Aggregate bay shelf";
  if (endpoint_bay_shelf_18) {
    mesh_bay_shelf_18.position.copy(endpoint_bay_shelf_18.midpoint);
    mesh_bay_shelf_18.quaternion.copy(endpoint_bay_shelf_18.quaternion);
  }
  mesh_bay_shelf_18.castShadow = options.castShadow ?? true;
  mesh_bay_shelf_18.receiveShadow = options.receiveShadow ?? true;
  mesh_bay_shelf_18.userData.sculptComponent = {"id": "bay-shelf", "name": "Aggregate bay shelf", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [1.48, 1.3, 0.5], "localEnd": [1.48, 1.3, 0.5], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 1.0, "height": 0.04, "depth": 0.7, "units": "m", "confidence": 0.75}, "transform": {"position": [1.48, 1.3, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.0, 0.04, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-shelf", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_bay_shelf_18.add(mesh_bay_shelf_18);
  meshes["bay-shelf"] = mesh_bay_shelf_18;
  colliders["bay-shelf"] = {"type": "box", "offset": [0, 0, 0], "scale": [1.0, 0.04, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["bay-shelf"] ??= [];
  destructionGroups["bay-shelf"].push(node_bay_shelf_18);

  const endpoint_bay_divider_19 = makeAttachmentEndpoint(null);
  const node_bay_divider_19 = new THREE.Group();
  node_bay_divider_19.name = "Aggregate bay divider post__pivot";
  node_bay_divider_19.scale.set(1, 1, 1);
  if (endpoint_bay_divider_19) {
    node_bay_divider_19.position.copy(endpoint_bay_divider_19.start);
    node_bay_divider_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_bay_divider_19.position.set(0.95, 1.18, 0.85);
    node_bay_divider_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_bay_divider_19.userData.sculptComponent = {"id": "bay-divider", "name": "Aggregate bay divider post", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [0.95, 1.18, 0.85], "localEnd": [0.95, 1.18, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 2.35, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [0.95, 1.18, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-divider", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_bay_divider_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-divider", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["enclosure"] ?? root).add(node_bay_divider_19);
  nodes["bay-divider"] = node_bay_divider_19;
  const mesh_bay_divider_19Geometry = endpoint_bay_divider_19
    ? new THREE.CylinderGeometry(endpoint_bay_divider_19.endRadius, endpoint_bay_divider_19.baseRadius, endpoint_bay_divider_19.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_bay_divider_19) {
    mesh_bay_divider_19Geometry.scale(0.05, 2.35, 0.05);
  }
  const mesh_bay_divider_19 = new THREE.Mesh(
    mesh_bay_divider_19Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bay_divider_19.name = "Aggregate bay divider post";
  if (endpoint_bay_divider_19) {
    mesh_bay_divider_19.position.copy(endpoint_bay_divider_19.midpoint);
    mesh_bay_divider_19.quaternion.copy(endpoint_bay_divider_19.quaternion);
  }
  mesh_bay_divider_19.castShadow = options.castShadow ?? true;
  mesh_bay_divider_19.receiveShadow = options.receiveShadow ?? true;
  mesh_bay_divider_19.userData.sculptComponent = {"id": "bay-divider", "name": "Aggregate bay divider post", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "enclosure", "attachment": {"parentSocket": "enclosure:mount", "contactType": "butt", "localStart": [0.95, 1.18, 0.85], "localEnd": [0.95, 1.18, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 2.35, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [0.95, 1.18, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bay-divider", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_bay_divider_19.add(mesh_bay_divider_19);
  meshes["bay-divider"] = mesh_bay_divider_19;
  colliders["bay-divider"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 2.35, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["bay-divider"] ??= [];
  destructionGroups["bay-divider"].push(node_bay_divider_19);

  const endpoint_top_band_20 = makeAttachmentEndpoint(null);
  const node_top_band_20 = new THREE.Group();
  node_top_band_20.name = "Blue top perimeter band__pivot";
  node_top_band_20.scale.set(1, 1, 1);
  if (endpoint_top_band_20) {
    node_top_band_20.position.copy(endpoint_top_band_20.start);
    node_top_band_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_top_band_20.position.set(0.0, 2.62, 0.0);
    node_top_band_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_top_band_20.userData.sculptComponent = {"id": "top-band", "name": "Blue top perimeter band", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Grouping node for band rails.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [0, 2.62, 0], "localEnd": [0, 2.62, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.04, "height": 0.04, "depth": 0.04, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 2.62, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "top-band", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "grob-badge", "type": "logo"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_top_band_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "top-band", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_top_band_20);
  nodes["top-band"] = node_top_band_20;
  const mesh_top_band_20Geometry = endpoint_top_band_20
    ? new THREE.CylinderGeometry(endpoint_top_band_20.endRadius, endpoint_top_band_20.baseRadius, endpoint_top_band_20.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_top_band_20) {
    mesh_top_band_20Geometry.scale(0.04, 0.04, 0.04);
  }
  const mesh_top_band_20 = new THREE.Mesh(
    mesh_top_band_20Geometry,
    materialMap["grob-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_top_band_20.name = "Blue top perimeter band";
  if (endpoint_top_band_20) {
    mesh_top_band_20.position.copy(endpoint_top_band_20.midpoint);
    mesh_top_band_20.quaternion.copy(endpoint_top_band_20.quaternion);
  }
  mesh_top_band_20.castShadow = options.castShadow ?? true;
  mesh_top_band_20.receiveShadow = options.receiveShadow ?? true;
  mesh_top_band_20.userData.sculptComponent = {"id": "top-band", "name": "Blue top perimeter band", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Grouping node for band rails.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [0, 2.62, 0], "localEnd": [0, 2.62, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.04, "height": 0.04, "depth": 0.04, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 2.62, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "top-band", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "grob-badge", "type": "logo"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_top_band_20.add(mesh_top_band_20);
  meshes["top-band"] = mesh_top_band_20;
  colliders["top-band"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 0.04, 0.04], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["top-band"] ??= [];
  destructionGroups["top-band"].push(node_top_band_20);

  const endpoint_band_front_21 = makeAttachmentEndpoint(null);
  const node_band_front_21 = new THREE.Group();
  node_band_front_21.name = "Band rail front__pivot";
  node_band_front_21.scale.set(1, 1, 1);
  if (endpoint_band_front_21) {
    node_band_front_21.position.copy(endpoint_band_front_21.start);
    node_band_front_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_band_front_21.position.set(-1.975, 0.0, 0.0);
    node_band_front_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_band_front_21.userData.sculptComponent = {"id": "band-front", "name": "Band rail front", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "top-band", "attachment": {"parentSocket": "top-band:mount", "contactType": "butt", "localStart": [-1.975, 0.0, 0], "localEnd": [-1.975, 0.0, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 0.42, "depth": 1.75, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.975, 0.0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.42, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_band_front_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.42, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["top-band"] ?? root).add(node_band_front_21);
  nodes["band-front"] = node_band_front_21;
  const mesh_band_front_21Geometry = endpoint_band_front_21
    ? new THREE.CylinderGeometry(endpoint_band_front_21.endRadius, endpoint_band_front_21.baseRadius, endpoint_band_front_21.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_band_front_21) {
    mesh_band_front_21Geometry.scale(0.05, 0.42, 1.75);
  }
  const mesh_band_front_21 = new THREE.Mesh(
    mesh_band_front_21Geometry,
    materialMap["grob-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_band_front_21.name = "Band rail front";
  if (endpoint_band_front_21) {
    mesh_band_front_21.position.copy(endpoint_band_front_21.midpoint);
    mesh_band_front_21.quaternion.copy(endpoint_band_front_21.quaternion);
  }
  mesh_band_front_21.castShadow = options.castShadow ?? true;
  mesh_band_front_21.receiveShadow = options.receiveShadow ?? true;
  mesh_band_front_21.userData.sculptComponent = {"id": "band-front", "name": "Band rail front", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "top-band", "attachment": {"parentSocket": "top-band:mount", "contactType": "butt", "localStart": [-1.975, 0.0, 0], "localEnd": [-1.975, 0.0, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 0.42, "depth": 1.75, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.975, 0.0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.42, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_band_front_21.add(mesh_band_front_21);
  meshes["band-front"] = mesh_band_front_21;
  colliders["band-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.42, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["band-front"] ??= [];
  destructionGroups["band-front"].push(node_band_front_21);

  const endpoint_band_rear_22 = makeAttachmentEndpoint(null);
  const node_band_rear_22 = new THREE.Group();
  node_band_rear_22.name = "Band rail rear__pivot";
  node_band_rear_22.scale.set(1, 1, 1);
  if (endpoint_band_rear_22) {
    node_band_rear_22.position.copy(endpoint_band_rear_22.start);
    node_band_rear_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_band_rear_22.position.set(1.975, 0.0, 0.0);
    node_band_rear_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_band_rear_22.userData.sculptComponent = {"id": "band-rear", "name": "Band rail rear", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "top-band", "attachment": {"parentSocket": "top-band:mount", "contactType": "butt", "localStart": [1.975, 0.0, 0], "localEnd": [1.975, 0.0, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 0.42, "depth": 1.75, "units": "m", "confidence": 0.75}, "transform": {"position": [1.975, 0.0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.42, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_band_rear_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.42, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["top-band"] ?? root).add(node_band_rear_22);
  nodes["band-rear"] = node_band_rear_22;
  const mesh_band_rear_22Geometry = endpoint_band_rear_22
    ? new THREE.CylinderGeometry(endpoint_band_rear_22.endRadius, endpoint_band_rear_22.baseRadius, endpoint_band_rear_22.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_band_rear_22) {
    mesh_band_rear_22Geometry.scale(0.05, 0.42, 1.75);
  }
  const mesh_band_rear_22 = new THREE.Mesh(
    mesh_band_rear_22Geometry,
    materialMap["grob-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_band_rear_22.name = "Band rail rear";
  if (endpoint_band_rear_22) {
    mesh_band_rear_22.position.copy(endpoint_band_rear_22.midpoint);
    mesh_band_rear_22.quaternion.copy(endpoint_band_rear_22.quaternion);
  }
  mesh_band_rear_22.castShadow = options.castShadow ?? true;
  mesh_band_rear_22.receiveShadow = options.receiveShadow ?? true;
  mesh_band_rear_22.userData.sculptComponent = {"id": "band-rear", "name": "Band rail rear", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "top-band", "attachment": {"parentSocket": "top-band:mount", "contactType": "butt", "localStart": [1.975, 0.0, 0], "localEnd": [1.975, 0.0, 0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 0.42, "depth": 1.75, "units": "m", "confidence": 0.75}, "transform": {"position": [1.975, 0.0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.42, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-rear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_band_rear_22.add(mesh_band_rear_22);
  meshes["band-rear"] = mesh_band_rear_22;
  colliders["band-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.42, 1.75], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["band-rear"] ??= [];
  destructionGroups["band-rear"].push(node_band_rear_22);

  const endpoint_band_near_23 = makeAttachmentEndpoint(null);
  const node_band_near_23 = new THREE.Group();
  node_band_near_23.name = "Band rail visible side__pivot";
  node_band_near_23.scale.set(1, 1, 1);
  if (endpoint_band_near_23) {
    node_band_near_23.position.copy(endpoint_band_near_23.start);
    node_band_near_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_band_near_23.position.set(0.0, 0.0, 0.85);
    node_band_near_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_band_near_23.userData.sculptComponent = {"id": "band-near", "name": "Band rail visible side", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "top-band", "attachment": {"parentSocket": "top-band:mount", "contactType": "butt", "localStart": [0, 0.0, 0.85], "localEnd": [0, 0.0, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 4.0, "height": 0.42, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 0.0, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.42, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_band_near_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.42, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["top-band"] ?? root).add(node_band_near_23);
  nodes["band-near"] = node_band_near_23;
  const mesh_band_near_23Geometry = endpoint_band_near_23
    ? new THREE.CylinderGeometry(endpoint_band_near_23.endRadius, endpoint_band_near_23.baseRadius, endpoint_band_near_23.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_band_near_23) {
    mesh_band_near_23Geometry.scale(4.0, 0.42, 0.05);
  }
  const mesh_band_near_23 = new THREE.Mesh(
    mesh_band_near_23Geometry,
    materialMap["grob-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_band_near_23.name = "Band rail visible side";
  if (endpoint_band_near_23) {
    mesh_band_near_23.position.copy(endpoint_band_near_23.midpoint);
    mesh_band_near_23.quaternion.copy(endpoint_band_near_23.quaternion);
  }
  mesh_band_near_23.castShadow = options.castShadow ?? true;
  mesh_band_near_23.receiveShadow = options.receiveShadow ?? true;
  mesh_band_near_23.userData.sculptComponent = {"id": "band-near", "name": "Band rail visible side", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "top-band", "attachment": {"parentSocket": "top-band:mount", "contactType": "butt", "localStart": [0, 0.0, 0.85], "localEnd": [0, 0.0, 0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 4.0, "height": 0.42, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 0.0, 0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.42, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_band_near_23.add(mesh_band_near_23);
  meshes["band-near"] = mesh_band_near_23;
  colliders["band-near"] = {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.42, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["band-near"] ??= [];
  destructionGroups["band-near"].push(node_band_near_23);

  const endpoint_band_far_24 = makeAttachmentEndpoint(null);
  const node_band_far_24 = new THREE.Group();
  node_band_far_24.name = "Band rail far side__pivot";
  node_band_far_24.scale.set(1, 1, 1);
  if (endpoint_band_far_24) {
    node_band_far_24.position.copy(endpoint_band_far_24.start);
    node_band_far_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_band_far_24.position.set(0.0, 0.0, -0.85);
    node_band_far_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_band_far_24.userData.sculptComponent = {"id": "band-far", "name": "Band rail far side", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "top-band", "attachment": {"parentSocket": "top-band:mount", "contactType": "butt", "localStart": [0, 0.0, -0.85], "localEnd": [0, 0.0, -0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 4.0, "height": 0.42, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 0.0, -0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.42, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_band_far_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.42, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["top-band"] ?? root).add(node_band_far_24);
  nodes["band-far"] = node_band_far_24;
  const mesh_band_far_24Geometry = endpoint_band_far_24
    ? new THREE.CylinderGeometry(endpoint_band_far_24.endRadius, endpoint_band_far_24.baseRadius, endpoint_band_far_24.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_band_far_24) {
    mesh_band_far_24Geometry.scale(4.0, 0.42, 0.05);
  }
  const mesh_band_far_24 = new THREE.Mesh(
    mesh_band_far_24Geometry,
    materialMap["grob-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_band_far_24.name = "Band rail far side";
  if (endpoint_band_far_24) {
    mesh_band_far_24.position.copy(endpoint_band_far_24.midpoint);
    mesh_band_far_24.quaternion.copy(endpoint_band_far_24.quaternion);
  }
  mesh_band_far_24.castShadow = options.castShadow ?? true;
  mesh_band_far_24.receiveShadow = options.receiveShadow ?? true;
  mesh_band_far_24.userData.sculptComponent = {"id": "band-far", "name": "Band rail far side", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "top-band", "attachment": {"parentSocket": "top-band:mount", "contactType": "butt", "localStart": [0, 0.0, -0.85], "localEnd": [0, 0.0, -0.85], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 4.0, "height": 0.42, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [0, 0.0, -0.85], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.42, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "band-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_band_far_24.add(mesh_band_far_24);
  meshes["band-far"] = mesh_band_far_24;
  colliders["band-far"] = {"type": "box", "offset": [0, 0, 0], "scale": [4.0, 0.42, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["band-far"] ??= [];
  destructionGroups["band-far"].push(node_band_far_24);

  const endpoint_grob_badge_25 = makeAttachmentEndpoint(null);
  const node_grob_badge_25 = new THREE.Group();
  node_grob_badge_25.name = "GROB badge__pivot";
  node_grob_badge_25.scale.set(1, 1, 1);
  if (endpoint_grob_badge_25) {
    node_grob_badge_25.position.copy(endpoint_grob_badge_25.start);
    node_grob_badge_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_grob_badge_25.position.set(1.25, 0.04, 0.03);
    node_grob_badge_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_grob_badge_25.userData.sculptComponent = {"id": "grob-badge", "name": "GROB badge", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Badge decal on band, canvas texture.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "band-near", "attachment": {"parentSocket": "band-near:mount", "contactType": "butt", "localStart": [1.25, 0.04, 0.03], "localEnd": [1.25, 0.04, 0.03], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.34, "height": 0.16, "depth": 0.01, "units": "m", "confidence": 0.75}, "transform": {"position": [1.25, 0.04, 0.03], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.34, 0.16, 0.01], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grob-badge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_grob_badge_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.34, 0.16, 0.01], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grob-badge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["band-near"] ?? root).add(node_grob_badge_25);
  nodes["grob-badge"] = node_grob_badge_25;
  const mesh_grob_badge_25Geometry = endpoint_grob_badge_25
    ? new THREE.CylinderGeometry(endpoint_grob_badge_25.endRadius, endpoint_grob_badge_25.baseRadius, endpoint_grob_badge_25.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_grob_badge_25) {
    mesh_grob_badge_25Geometry.scale(0.34, 0.16, 0.01);
  }
  const mesh_grob_badge_25 = new THREE.Mesh(
    mesh_grob_badge_25Geometry,
    materialMap["grob-blue"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grob_badge_25.name = "GROB badge";
  if (endpoint_grob_badge_25) {
    mesh_grob_badge_25.position.copy(endpoint_grob_badge_25.midpoint);
    mesh_grob_badge_25.quaternion.copy(endpoint_grob_badge_25.quaternion);
  }
  mesh_grob_badge_25.castShadow = options.castShadow ?? true;
  mesh_grob_badge_25.receiveShadow = options.receiveShadow ?? true;
  mesh_grob_badge_25.userData.sculptComponent = {"id": "grob-badge", "name": "GROB badge", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Badge decal on band, canvas texture.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "band-near", "attachment": {"parentSocket": "band-near:mount", "contactType": "butt", "localStart": [1.25, 0.04, 0.03], "localEnd": [1.25, 0.04, 0.03], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.34, "height": 0.16, "depth": 0.01, "units": "m", "confidence": 0.75}, "transform": {"position": [1.25, 0.04, 0.03], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.34, 0.16, 0.01], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grob-badge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grob-blue", "materialLayers": ["grob-blue"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(31, 78, 163, 1.0)", "secondaryAlbedo": "rgba(31, 78, 163, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_grob_badge_25.add(mesh_grob_badge_25);
  meshes["grob-badge"] = mesh_grob_badge_25;
  colliders["grob-badge"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.34, 0.16, 0.01], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["grob-badge"] ??= [];
  destructionGroups["grob-badge"].push(node_grob_badge_25);

  const endpoint_roof_26 = makeAttachmentEndpoint(null);
  const node_roof_26 = new THREE.Group();
  node_roof_26.name = "Roof housing over slides__pivot";
  node_roof_26.scale.set(1, 1, 1);
  if (endpoint_roof_26) {
    node_roof_26.position.copy(endpoint_roof_26.start);
    node_roof_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_26.position.set(-0.1, 2.66, -0.05);
    node_roof_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_26.userData.sculptComponent = {"id": "roof", "name": "Roof housing over slides", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-0.1, 2.66, -0.05], "localEnd": [-0.1, 2.66, -0.05], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 2.1, "height": 0.55, "depth": 1.0, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.1, 2.66, -0.05], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [2.1, 0.55, 1.0], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roof-segments", "type": "panel seams", "note": "5 stepped cover segments"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_roof_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [2.1, 0.55, 1.0], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_roof_26);
  nodes["roof"] = node_roof_26;
  const mesh_roof_26Geometry = endpoint_roof_26
    ? new THREE.CylinderGeometry(endpoint_roof_26.endRadius, endpoint_roof_26.baseRadius, endpoint_roof_26.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_roof_26) {
    mesh_roof_26Geometry.scale(2.1, 0.55, 1.0);
  }
  const mesh_roof_26 = new THREE.Mesh(
    mesh_roof_26Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_26.name = "Roof housing over slides";
  if (endpoint_roof_26) {
    mesh_roof_26.position.copy(endpoint_roof_26.midpoint);
    mesh_roof_26.quaternion.copy(endpoint_roof_26.quaternion);
  }
  mesh_roof_26.castShadow = options.castShadow ?? true;
  mesh_roof_26.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_26.userData.sculptComponent = {"id": "roof", "name": "Roof housing over slides", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-0.1, 2.66, -0.05], "localEnd": [-0.1, 2.66, -0.05], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 2.1, "height": 0.55, "depth": 1.0, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.1, 2.66, -0.05], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [2.1, 0.55, 1.0], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roof-segments", "type": "panel seams", "note": "5 stepped cover segments"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_roof_26.add(mesh_roof_26);
  meshes["roof"] = mesh_roof_26;
  colliders["roof"] = {"type": "box", "offset": [0, 0, 0], "scale": [2.1, 0.55, 1.0], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["roof"] ??= [];
  destructionGroups["roof"].push(node_roof_26);

  const endpoint_head_cover_27 = makeAttachmentEndpoint(null);
  const node_head_cover_27 = new THREE.Group();
  node_head_cover_27.name = "Spindle head cover (front step)__pivot";
  node_head_cover_27.scale.set(1, 1, 1);
  if (endpoint_head_cover_27) {
    node_head_cover_27.position.copy(endpoint_head_cover_27.start);
    node_head_cover_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_cover_27.position.set(-1.35, -0.22, 0.3);
    node_head_cover_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_cover_27.userData.sculptComponent = {"id": "head-cover", "name": "Spindle head cover (front step)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "roof", "attachment": {"parentSocket": "roof:mount", "contactType": "butt", "localStart": [-1.35, -0.22, 0.3], "localEnd": [-1.35, -0.22, 0.3], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.6, "height": 0.42, "depth": 0.85, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.35, -0.22, 0.3], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.6, 0.42, 0.85], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head-cover", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_head_cover_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.6, 0.42, 0.85], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head-cover", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["roof"] ?? root).add(node_head_cover_27);
  nodes["head-cover"] = node_head_cover_27;
  const mesh_head_cover_27Geometry = endpoint_head_cover_27
    ? new THREE.CylinderGeometry(endpoint_head_cover_27.endRadius, endpoint_head_cover_27.baseRadius, endpoint_head_cover_27.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_head_cover_27) {
    mesh_head_cover_27Geometry.scale(0.6, 0.42, 0.85);
  }
  const mesh_head_cover_27 = new THREE.Mesh(
    mesh_head_cover_27Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_cover_27.name = "Spindle head cover (front step)";
  if (endpoint_head_cover_27) {
    mesh_head_cover_27.position.copy(endpoint_head_cover_27.midpoint);
    mesh_head_cover_27.quaternion.copy(endpoint_head_cover_27.quaternion);
  }
  mesh_head_cover_27.castShadow = options.castShadow ?? true;
  mesh_head_cover_27.receiveShadow = options.receiveShadow ?? true;
  mesh_head_cover_27.userData.sculptComponent = {"id": "head-cover", "name": "Spindle head cover (front step)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "roof", "attachment": {"parentSocket": "roof:mount", "contactType": "butt", "localStart": [-1.35, -0.22, 0.3], "localEnd": [-1.35, -0.22, 0.3], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.6, "height": 0.42, "depth": 0.85, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.35, -0.22, 0.3], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.6, 0.42, 0.85], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head-cover", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_head_cover_27.add(mesh_head_cover_27);
  meshes["head-cover"] = mesh_head_cover_27;
  colliders["head-cover"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.6, 0.42, 0.85], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["head-cover"] ??= [];
  destructionGroups["head-cover"].push(node_head_cover_27);

  const endpoint_coolant_module_28 = makeAttachmentEndpoint(null);
  const node_coolant_module_28 = new THREE.Group();
  node_coolant_module_28.name = "Rear-top coolant / filter module frame__pivot";
  node_coolant_module_28.scale.set(1, 1, 1);
  if (endpoint_coolant_module_28) {
    node_coolant_module_28.position.copy(endpoint_coolant_module_28.start);
    node_coolant_module_28.rotation.set(0.0, 0.0, -0.25);
  } else {
    node_coolant_module_28.position.set(1.45, 2.89, -0.05);
    node_coolant_module_28.rotation.set(0.0, 0.0, -0.25);
  }
  node_coolant_module_28.userData.sculptComponent = {"id": "coolant-module", "name": "Rear-top coolant / filter module frame", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [1.45, 2.89, -0.05], "localEnd": [1.45, 2.89, -0.05], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.9, "height": 0.55, "depth": 0.9, "units": "m", "confidence": 0.75}, "transform": {"position": [1.45, 2.89, -0.05], "rotation": [0, 0, -0.25]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.9, 0.55, 0.9], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coolant-module", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_coolant_module_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.9, 0.55, 0.9], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coolant-module", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_coolant_module_28);
  nodes["coolant-module"] = node_coolant_module_28;
  const mesh_coolant_module_28Geometry = endpoint_coolant_module_28
    ? new THREE.CylinderGeometry(endpoint_coolant_module_28.endRadius, endpoint_coolant_module_28.baseRadius, endpoint_coolant_module_28.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_coolant_module_28) {
    mesh_coolant_module_28Geometry.scale(0.9, 0.55, 0.9);
  }
  const mesh_coolant_module_28 = new THREE.Mesh(
    mesh_coolant_module_28Geometry,
    materialMap["panel-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coolant_module_28.name = "Rear-top coolant / filter module frame";
  if (endpoint_coolant_module_28) {
    mesh_coolant_module_28.position.copy(endpoint_coolant_module_28.midpoint);
    mesh_coolant_module_28.quaternion.copy(endpoint_coolant_module_28.quaternion);
  }
  mesh_coolant_module_28.castShadow = options.castShadow ?? true;
  mesh_coolant_module_28.receiveShadow = options.receiveShadow ?? true;
  mesh_coolant_module_28.userData.sculptComponent = {"id": "coolant-module", "name": "Rear-top coolant / filter module frame", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [1.45, 2.89, -0.05], "localEnd": [1.45, 2.89, -0.05], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.9, "height": 0.55, "depth": 0.9, "units": "m", "confidence": 0.75}, "transform": {"position": [1.45, 2.89, -0.05], "rotation": [0, 0, -0.25]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.9, 0.55, 0.9], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coolant-module", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-shadow", "materialLayers": ["panel-shadow"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(169, 173, 176, 1.0)", "secondaryAlbedo": "rgba(169, 173, 176, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_coolant_module_28.add(mesh_coolant_module_28);
  meshes["coolant-module"] = mesh_coolant_module_28;
  colliders["coolant-module"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.9, 0.55, 0.9], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["coolant-module"] ??= [];
  destructionGroups["coolant-module"].push(node_coolant_module_28);

  const attachment_coolant_tank_29 = {"parentSocket": "coolant-module:mount", "contactType": "socket", "localStart": [-0.05, 0.2, -0.35], "localEnd": [-0.05, 0.2, 0.35], "baseRadius": 0.225, "endRadius": 0.225, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]};
  const endpoint_coolant_tank_29 = makeAttachmentEndpoint(attachment_coolant_tank_29);
  const node_coolant_tank_29 = new THREE.Group();
  node_coolant_tank_29.name = "Horizontal cylindrical tank__pivot";
  node_coolant_tank_29.scale.set(1, 1, 1);
  if (endpoint_coolant_tank_29) {
    node_coolant_tank_29.position.copy(endpoint_coolant_tank_29.start);
    node_coolant_tank_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coolant_tank_29.position.set(-0.05, 0.2, -0.35);
    node_coolant_tank_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_coolant_tank_29.userData.sculptComponent = {"id": "coolant-tank", "name": "Horizontal cylindrical tank", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "coolant-module", "attachment": {"parentSocket": "coolant-module:mount", "contactType": "socket", "localStart": [-0.05, 0.2, -0.35], "localEnd": [-0.05, 0.2, 0.35], "baseRadius": 0.225, "endRadius": 0.225, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 0.45, "height": 0.7, "depth": 0.45, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.05, 0.2, -0.35], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.45, 0.7, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coolant-tank", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "motor-white", "materialLayers": ["motor-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 234, 1.0)", "secondaryAlbedo": "rgba(232, 233, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_coolant_tank_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.45, 0.7, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coolant-tank", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["coolant-module"] ?? root).add(node_coolant_tank_29);
  nodes["coolant-tank"] = node_coolant_tank_29;
  const mesh_coolant_tank_29Geometry = endpoint_coolant_tank_29
    ? new THREE.CylinderGeometry(endpoint_coolant_tank_29.endRadius, endpoint_coolant_tank_29.baseRadius, endpoint_coolant_tank_29.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_coolant_tank_29) {
    mesh_coolant_tank_29Geometry.scale(0.45, 0.7, 0.45);
  }
  const mesh_coolant_tank_29 = new THREE.Mesh(
    mesh_coolant_tank_29Geometry,
    materialMap["motor-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coolant_tank_29.name = "Horizontal cylindrical tank";
  if (endpoint_coolant_tank_29) {
    mesh_coolant_tank_29.position.copy(endpoint_coolant_tank_29.midpoint);
    mesh_coolant_tank_29.quaternion.copy(endpoint_coolant_tank_29.quaternion);
  }
  mesh_coolant_tank_29.castShadow = options.castShadow ?? true;
  mesh_coolant_tank_29.receiveShadow = options.receiveShadow ?? true;
  mesh_coolant_tank_29.userData.sculptComponent = {"id": "coolant-tank", "name": "Horizontal cylindrical tank", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "coolant-module", "attachment": {"parentSocket": "coolant-module:mount", "contactType": "socket", "localStart": [-0.05, 0.2, -0.35], "localEnd": [-0.05, 0.2, 0.35], "baseRadius": 0.225, "endRadius": 0.225, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 0.45, "height": 0.7, "depth": 0.45, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.05, 0.2, -0.35], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.45, 0.7, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coolant-tank", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "motor-white", "materialLayers": ["motor-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 234, 1.0)", "secondaryAlbedo": "rgba(232, 233, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_coolant_tank_29.add(mesh_coolant_tank_29);
  meshes["coolant-tank"] = mesh_coolant_tank_29;
  colliders["coolant-tank"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.45, 0.7, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["coolant-tank"] ??= [];
  destructionGroups["coolant-tank"].push(node_coolant_tank_29);

  const endpoint_y_carriage_30 = makeAttachmentEndpoint(null);
  const node_y_carriage_30 = new THREE.Group();
  node_y_carriage_30.name = "Spindle carriage (Y axis, vertical)__pivot";
  node_y_carriage_30.scale.set(1, 1, 1);
  if (endpoint_y_carriage_30) {
    node_y_carriage_30.position.copy(endpoint_y_carriage_30.start);
    node_y_carriage_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_y_carriage_30.position.set(-0.98, 1.64, 0.42);
    node_y_carriage_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_y_carriage_30.userData.sculptComponent = {"id": "y-carriage", "name": "Spindle carriage (Y axis, vertical)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-0.98, 1.64, 0.42], "localEnd": [-0.98, 1.64, 0.42], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.14, "height": 0.7, "depth": 0.7, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.98, 1.64, 0.42], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-y", "localPosition": [0, 0, 0], "purpose": "linear Y travel 770 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.14, 0.7, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "y-carriage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_y_carriage_30.userData.actionProfile = {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-y", "localPosition": [0, 0, 0], "purpose": "linear Y travel 770 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.14, 0.7, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "y-carriage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_y_carriage_30);
  nodes["y-carriage"] = node_y_carriage_30;
  const mesh_y_carriage_30Geometry = endpoint_y_carriage_30
    ? new THREE.CylinderGeometry(endpoint_y_carriage_30.endRadius, endpoint_y_carriage_30.baseRadius, endpoint_y_carriage_30.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_y_carriage_30) {
    mesh_y_carriage_30Geometry.scale(0.14, 0.7, 0.7);
  }
  const mesh_y_carriage_30 = new THREE.Mesh(
    mesh_y_carriage_30Geometry,
    materialMap["dark-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_y_carriage_30.name = "Spindle carriage (Y axis, vertical)";
  if (endpoint_y_carriage_30) {
    mesh_y_carriage_30.position.copy(endpoint_y_carriage_30.midpoint);
    mesh_y_carriage_30.quaternion.copy(endpoint_y_carriage_30.quaternion);
  }
  mesh_y_carriage_30.castShadow = options.castShadow ?? true;
  mesh_y_carriage_30.receiveShadow = options.receiveShadow ?? true;
  mesh_y_carriage_30.userData.sculptComponent = {"id": "y-carriage", "name": "Spindle carriage (Y axis, vertical)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-0.98, 1.64, 0.42], "localEnd": [-0.98, 1.64, 0.42], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.14, "height": 0.7, "depth": 0.7, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.98, 1.64, 0.42], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-y", "localPosition": [0, 0, 0], "purpose": "linear Y travel 770 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.14, 0.7, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "y-carriage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_y_carriage_30.add(mesh_y_carriage_30);
  meshes["y-carriage"] = mesh_y_carriage_30;
  colliders["y-carriage"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.14, 0.7, 0.7], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["y-carriage"] ??= [];
  destructionGroups["y-carriage"].push(node_y_carriage_30);
  const socket_y_carriage_axis_y_0 = new THREE.Object3D();
  socket_y_carriage_axis_y_0.name = "axis-y";
  socket_y_carriage_axis_y_0.position.set(0.0, 0.0, 0.0);
  socket_y_carriage_axis_y_0.rotation.set(0, 0, 0);
  socket_y_carriage_axis_y_0.userData.socket = {"id": "axis-y", "localPosition": [0, 0, 0], "purpose": "linear Y travel 770 mm (scaled)", "axis": [0, 1, 0]};
  node_y_carriage_30.add(socket_y_carriage_axis_y_0);
  sockets["y-carriage:axis-y"] = socket_y_carriage_axis_y_0;

  const endpoint_x_slide_31 = makeAttachmentEndpoint(null);
  const node_x_slide_31 = new THREE.Group();
  node_x_slide_31.name = "Cross slide (X axis, lateral)__pivot";
  node_x_slide_31.scale.set(1, 1, 1);
  if (endpoint_x_slide_31) {
    node_x_slide_31.position.copy(endpoint_x_slide_31.start);
    node_x_slide_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_x_slide_31.position.set(-0.02, 0.0, 0.0);
    node_x_slide_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_x_slide_31.userData.sculptComponent = {"id": "x-slide", "name": "Cross slide (X axis, lateral)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "y-carriage", "attachment": {"parentSocket": "y-carriage:mount", "contactType": "butt", "localStart": [-0.02, 0.0, 0.0], "localEnd": [-0.02, 0.0, 0.0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.1, "height": 0.4, "depth": 0.4, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.02, 0.0, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-x", "localPosition": [0, 0, 0], "purpose": "linear X travel 600 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1, 0.4, 0.4], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "x-slide", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_x_slide_31.userData.actionProfile = {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-x", "localPosition": [0, 0, 0], "purpose": "linear X travel 600 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1, 0.4, 0.4], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "x-slide", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["y-carriage"] ?? root).add(node_x_slide_31);
  nodes["x-slide"] = node_x_slide_31;
  const mesh_x_slide_31Geometry = endpoint_x_slide_31
    ? new THREE.CylinderGeometry(endpoint_x_slide_31.endRadius, endpoint_x_slide_31.baseRadius, endpoint_x_slide_31.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_x_slide_31) {
    mesh_x_slide_31Geometry.scale(0.1, 0.4, 0.4);
  }
  const mesh_x_slide_31 = new THREE.Mesh(
    mesh_x_slide_31Geometry,
    materialMap["dark-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_x_slide_31.name = "Cross slide (X axis, lateral)";
  if (endpoint_x_slide_31) {
    mesh_x_slide_31.position.copy(endpoint_x_slide_31.midpoint);
    mesh_x_slide_31.quaternion.copy(endpoint_x_slide_31.quaternion);
  }
  mesh_x_slide_31.castShadow = options.castShadow ?? true;
  mesh_x_slide_31.receiveShadow = options.receiveShadow ?? true;
  mesh_x_slide_31.userData.sculptComponent = {"id": "x-slide", "name": "Cross slide (X axis, lateral)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "y-carriage", "attachment": {"parentSocket": "y-carriage:mount", "contactType": "butt", "localStart": [-0.02, 0.0, 0.0], "localEnd": [-0.02, 0.0, 0.0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.1, "height": 0.4, "depth": 0.4, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.02, 0.0, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-x", "localPosition": [0, 0, 0], "purpose": "linear X travel 600 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.1, 0.4, 0.4], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "x-slide", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_x_slide_31.add(mesh_x_slide_31);
  meshes["x-slide"] = mesh_x_slide_31;
  colliders["x-slide"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.1, 0.4, 0.4], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["x-slide"] ??= [];
  destructionGroups["x-slide"].push(node_x_slide_31);
  const socket_x_slide_axis_x_0 = new THREE.Object3D();
  socket_x_slide_axis_x_0.name = "axis-x";
  socket_x_slide_axis_x_0.position.set(0.0, 0.0, 0.0);
  socket_x_slide_axis_x_0.rotation.set(0, 0, 0);
  socket_x_slide_axis_x_0.userData.socket = {"id": "axis-x", "localPosition": [0, 0, 0], "purpose": "linear X travel 600 mm (scaled)", "axis": [0, 1, 0]};
  node_x_slide_31.add(socket_x_slide_axis_x_0);
  sockets["x-slide:axis-x"] = socket_x_slide_axis_x_0;

  const endpoint_z_ram_32 = makeAttachmentEndpoint(null);
  const node_z_ram_32 = new THREE.Group();
  node_z_ram_32.name = "Spindle ram (Z axis, towards table)__pivot";
  node_z_ram_32.scale.set(1, 1, 1);
  if (endpoint_z_ram_32) {
    node_z_ram_32.position.copy(endpoint_z_ram_32.start);
    node_z_ram_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_z_ram_32.position.set(-0.05, 0.0, 0.0);
    node_z_ram_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_z_ram_32.userData.sculptComponent = {"id": "z-ram", "name": "Spindle ram (Z axis, towards table)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Pivot node for the Z axis.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "x-slide", "attachment": {"parentSocket": "x-slide:mount", "contactType": "butt", "localStart": [-0.05, 0.0, 0.0], "localEnd": [-0.05, 0.0, 0.0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 0.05, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.05, 0.0, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [-1, 0, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-z", "localPosition": [0, 0, 0], "purpose": "linear Z travel 810 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.05, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "z-ram", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_z_ram_32.userData.actionProfile = {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [-1, 0, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-z", "localPosition": [0, 0, 0], "purpose": "linear Z travel 810 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.05, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "z-ram", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["x-slide"] ?? root).add(node_z_ram_32);
  nodes["z-ram"] = node_z_ram_32;
  const mesh_z_ram_32Geometry = endpoint_z_ram_32
    ? new THREE.CylinderGeometry(endpoint_z_ram_32.endRadius, endpoint_z_ram_32.baseRadius, endpoint_z_ram_32.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_z_ram_32) {
    mesh_z_ram_32Geometry.scale(0.05, 0.05, 0.05);
  }
  const mesh_z_ram_32 = new THREE.Mesh(
    mesh_z_ram_32Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_z_ram_32.name = "Spindle ram (Z axis, towards table)";
  if (endpoint_z_ram_32) {
    mesh_z_ram_32.position.copy(endpoint_z_ram_32.midpoint);
    mesh_z_ram_32.quaternion.copy(endpoint_z_ram_32.quaternion);
  }
  mesh_z_ram_32.castShadow = options.castShadow ?? true;
  mesh_z_ram_32.receiveShadow = options.receiveShadow ?? true;
  mesh_z_ram_32.userData.sculptComponent = {"id": "z-ram", "name": "Spindle ram (Z axis, towards table)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Pivot node for the Z axis.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "x-slide", "attachment": {"parentSocket": "x-slide:mount", "contactType": "butt", "localStart": [-0.05, 0.0, 0.0], "localEnd": [-0.05, 0.0, 0.0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.05, "height": 0.05, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.05, 0.0, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [-1, 0, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-z", "localPosition": [0, 0, 0], "purpose": "linear Z travel 810 mm (scaled)", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.05, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "z-ram", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_z_ram_32.add(mesh_z_ram_32);
  meshes["z-ram"] = mesh_z_ram_32;
  colliders["z-ram"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.05, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["z-ram"] ??= [];
  destructionGroups["z-ram"].push(node_z_ram_32);
  const socket_z_ram_axis_z_0 = new THREE.Object3D();
  socket_z_ram_axis_z_0.name = "axis-z";
  socket_z_ram_axis_z_0.position.set(0.0, 0.0, 0.0);
  socket_z_ram_axis_z_0.rotation.set(0, 0, 0);
  socket_z_ram_axis_z_0.userData.socket = {"id": "axis-z", "localPosition": [0, 0, 0], "purpose": "linear Z travel 810 mm (scaled)", "axis": [0, 1, 0]};
  node_z_ram_32.add(socket_z_ram_axis_z_0);
  sockets["z-ram:axis-z"] = socket_z_ram_axis_z_0;

  const attachment_spindle_housing_33 = {"parentSocket": "z-ram:mount", "contactType": "socket", "localStart": [0.11, 0.0, 0.0], "localEnd": [-0.31, 0.0, 0.0], "baseRadius": 0.15, "endRadius": 0.15, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]};
  const endpoint_spindle_housing_33 = makeAttachmentEndpoint(attachment_spindle_housing_33);
  const node_spindle_housing_33 = new THREE.Group();
  node_spindle_housing_33.name = "Motor spindle housing__pivot";
  node_spindle_housing_33.scale.set(1, 1, 1);
  if (endpoint_spindle_housing_33) {
    node_spindle_housing_33.position.copy(endpoint_spindle_housing_33.start);
    node_spindle_housing_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_spindle_housing_33.position.set(0.11, 0.0, 0.0);
    node_spindle_housing_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_spindle_housing_33.userData.sculptComponent = {"id": "spindle-housing", "name": "Motor spindle housing", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "z-ram", "attachment": {"parentSocket": "z-ram:mount", "contactType": "socket", "localStart": [0.11, 0.0, 0.0], "localEnd": [-0.31, 0.0, 0.0], "baseRadius": 0.15, "endRadius": 0.15, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]}, "dimensions": {"width": 0.3, "height": 0.42, "depth": 0.3, "units": "m", "confidence": 0.75}, "transform": {"position": [0.11, 0.0, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-spindle", "localPosition": [0, 0.05, 0.11], "purpose": "VSE004 vibration sensor: spindle", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3, 0.42, 0.3], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "spindle-housing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_spindle_housing_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-spindle", "localPosition": [0, 0.05, 0.11], "purpose": "VSE004 vibration sensor: spindle", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3, 0.42, 0.3], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "spindle-housing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["z-ram"] ?? root).add(node_spindle_housing_33);
  nodes["spindle-housing"] = node_spindle_housing_33;
  const mesh_spindle_housing_33Geometry = endpoint_spindle_housing_33
    ? new THREE.CylinderGeometry(endpoint_spindle_housing_33.endRadius, endpoint_spindle_housing_33.baseRadius, endpoint_spindle_housing_33.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_spindle_housing_33) {
    mesh_spindle_housing_33Geometry.scale(0.3, 0.42, 0.3);
  }
  const mesh_spindle_housing_33 = new THREE.Mesh(
    mesh_spindle_housing_33Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_spindle_housing_33.name = "Motor spindle housing";
  if (endpoint_spindle_housing_33) {
    mesh_spindle_housing_33.position.copy(endpoint_spindle_housing_33.midpoint);
    mesh_spindle_housing_33.quaternion.copy(endpoint_spindle_housing_33.quaternion);
  }
  mesh_spindle_housing_33.castShadow = options.castShadow ?? true;
  mesh_spindle_housing_33.receiveShadow = options.receiveShadow ?? true;
  mesh_spindle_housing_33.userData.sculptComponent = {"id": "spindle-housing", "name": "Motor spindle housing", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "z-ram", "attachment": {"parentSocket": "z-ram:mount", "contactType": "socket", "localStart": [0.11, 0.0, 0.0], "localEnd": [-0.31, 0.0, 0.0], "baseRadius": 0.15, "endRadius": 0.15, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]}, "dimensions": {"width": 0.3, "height": 0.42, "depth": 0.3, "units": "m", "confidence": 0.75}, "transform": {"position": [0.11, 0.0, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-spindle", "localPosition": [0, 0.05, 0.11], "purpose": "VSE004 vibration sensor: spindle", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.3, 0.42, 0.3], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "spindle-housing", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_spindle_housing_33.add(mesh_spindle_housing_33);
  meshes["spindle-housing"] = mesh_spindle_housing_33;
  colliders["spindle-housing"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.3, 0.42, 0.3], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["spindle-housing"] ??= [];
  destructionGroups["spindle-housing"].push(node_spindle_housing_33);
  const socket_spindle_housing_sensor_spindle_0 = new THREE.Object3D();
  socket_spindle_housing_sensor_spindle_0.name = "sensor-spindle";
  socket_spindle_housing_sensor_spindle_0.position.set(0.0, 0.05, 0.11);
  socket_spindle_housing_sensor_spindle_0.rotation.set(0, 0, 0);
  socket_spindle_housing_sensor_spindle_0.userData.socket = {"id": "sensor-spindle", "localPosition": [0, 0.05, 0.11], "purpose": "VSE004 vibration sensor: spindle", "axis": [0, 1, 0]};
  node_spindle_housing_33.add(socket_spindle_housing_sensor_spindle_0);
  sockets["spindle-housing:sensor-spindle"] = socket_spindle_housing_sensor_spindle_0;

  const attachment_spindle_rotor_34 = {"parentSocket": "spindle-housing:mount", "contactType": "socket", "localStart": [-0.42, 0.0, 0.0], "localEnd": [-0.68, 0.0, 0.0], "baseRadius": 0.065, "endRadius": 0.065, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]};
  const endpoint_spindle_rotor_34 = makeAttachmentEndpoint(attachment_spindle_rotor_34);
  const node_spindle_rotor_34 = new THREE.Group();
  node_spindle_rotor_34.name = "Spindle nose + HSK tool (rotating)__pivot";
  node_spindle_rotor_34.scale.set(1, 1, 1);
  if (endpoint_spindle_rotor_34) {
    node_spindle_rotor_34.position.copy(endpoint_spindle_rotor_34.start);
    node_spindle_rotor_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_spindle_rotor_34.position.set(-0.42, 0.0, 0.0);
    node_spindle_rotor_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_spindle_rotor_34.userData.sculptComponent = {"id": "spindle-rotor", "name": "Spindle nose + HSK tool (rotating)", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "spindle-housing", "attachment": {"parentSocket": "spindle-housing:mount", "contactType": "socket", "localStart": [-0.42, 0.0, 0.0], "localEnd": [-0.68, 0.0, 0.0], "baseRadius": 0.065, "endRadius": 0.065, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]}, "dimensions": {"width": 0.13, "height": 0.26, "depth": 0.13, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.42, 0.0, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tool-tip", "localPosition": [0, -0.11, 0], "purpose": "cutting point", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.13, 0.26, 0.13], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "spindle-rotor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_spindle_rotor_34.userData.actionProfile = {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tool-tip", "localPosition": [0, -0.11, 0], "purpose": "cutting point", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.13, 0.26, 0.13], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "spindle-rotor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["spindle-housing"] ?? root).add(node_spindle_rotor_34);
  nodes["spindle-rotor"] = node_spindle_rotor_34;
  const mesh_spindle_rotor_34Geometry = endpoint_spindle_rotor_34
    ? new THREE.CylinderGeometry(endpoint_spindle_rotor_34.endRadius, endpoint_spindle_rotor_34.baseRadius, endpoint_spindle_rotor_34.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_spindle_rotor_34) {
    mesh_spindle_rotor_34Geometry.scale(0.13, 0.26, 0.13);
  }
  const mesh_spindle_rotor_34 = new THREE.Mesh(
    mesh_spindle_rotor_34Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_spindle_rotor_34.name = "Spindle nose + HSK tool (rotating)";
  if (endpoint_spindle_rotor_34) {
    mesh_spindle_rotor_34.position.copy(endpoint_spindle_rotor_34.midpoint);
    mesh_spindle_rotor_34.quaternion.copy(endpoint_spindle_rotor_34.quaternion);
  }
  mesh_spindle_rotor_34.castShadow = options.castShadow ?? true;
  mesh_spindle_rotor_34.receiveShadow = options.receiveShadow ?? true;
  mesh_spindle_rotor_34.userData.sculptComponent = {"id": "spindle-rotor", "name": "Spindle nose + HSK tool (rotating)", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "spindle-housing", "attachment": {"parentSocket": "spindle-housing:mount", "contactType": "socket", "localStart": [-0.42, 0.0, 0.0], "localEnd": [-0.68, 0.0, 0.0], "baseRadius": 0.065, "endRadius": 0.065, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [-1.0, 0.0, 0.0]}, "dimensions": {"width": 0.13, "height": 0.26, "depth": 0.13, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.42, 0.0, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [1, 0, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tool-tip", "localPosition": [0, -0.11, 0], "purpose": "cutting point", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.13, 0.26, 0.13], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "spindle-rotor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_spindle_rotor_34.add(mesh_spindle_rotor_34);
  meshes["spindle-rotor"] = mesh_spindle_rotor_34;
  colliders["spindle-rotor"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.13, 0.26, 0.13], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["spindle-rotor"] ??= [];
  destructionGroups["spindle-rotor"].push(node_spindle_rotor_34);
  const socket_spindle_rotor_tool_tip_0 = new THREE.Object3D();
  socket_spindle_rotor_tool_tip_0.name = "tool-tip";
  socket_spindle_rotor_tool_tip_0.position.set(0.0, -0.11, 0.0);
  socket_spindle_rotor_tool_tip_0.rotation.set(0, 0, 0);
  socket_spindle_rotor_tool_tip_0.userData.socket = {"id": "tool-tip", "localPosition": [0, -0.11, 0], "purpose": "cutting point", "axis": [0, 1, 0]};
  node_spindle_rotor_34.add(socket_spindle_rotor_tool_tip_0);
  sockets["spindle-rotor:tool-tip"] = socket_spindle_rotor_tool_tip_0;

  const endpoint_trunnion_35 = makeAttachmentEndpoint(null);
  const node_trunnion_35 = new THREE.Group();
  node_trunnion_35.name = "Trunnion cradle (A axis tilt)__pivot";
  node_trunnion_35.scale.set(1, 1, 1);
  if (endpoint_trunnion_35) {
    node_trunnion_35.position.copy(endpoint_trunnion_35.start);
    node_trunnion_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_trunnion_35.position.set(-1.66, 1.1, 0.4);
    node_trunnion_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_trunnion_35.userData.sculptComponent = {"id": "trunnion", "name": "Trunnion cradle (A axis tilt)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-1.66, 1.1, 0.4], "localEnd": [-1.66, 1.1, 0.4], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.66, "height": 0.14, "depth": 0.72, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.66, 1.1, 0.4], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-a", "localPosition": [0, 0, 0], "purpose": "A axis tilt", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.66, 0.14, 0.8], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "trunnion", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cradle-white", "materialLayers": ["cradle-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 237, 234, 1.0)", "secondaryAlbedo": "rgba(237, 237, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_trunnion_35.userData.actionProfile = {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-a", "localPosition": [0, 0, 0], "purpose": "A axis tilt", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.66, 0.14, 0.8], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "trunnion", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_trunnion_35);
  nodes["trunnion"] = node_trunnion_35;
  const mesh_trunnion_35Geometry = endpoint_trunnion_35
    ? new THREE.CylinderGeometry(endpoint_trunnion_35.endRadius, endpoint_trunnion_35.baseRadius, endpoint_trunnion_35.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_trunnion_35) {
    mesh_trunnion_35Geometry.scale(0.66, 0.14, 0.72);
  }
  const mesh_trunnion_35 = new THREE.Mesh(
    mesh_trunnion_35Geometry,
    materialMap["cradle-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_trunnion_35.name = "Trunnion cradle (A axis tilt)";
  if (endpoint_trunnion_35) {
    mesh_trunnion_35.position.copy(endpoint_trunnion_35.midpoint);
    mesh_trunnion_35.quaternion.copy(endpoint_trunnion_35.quaternion);
  }
  mesh_trunnion_35.castShadow = options.castShadow ?? true;
  mesh_trunnion_35.receiveShadow = options.receiveShadow ?? true;
  mesh_trunnion_35.userData.sculptComponent = {"id": "trunnion", "name": "Trunnion cradle (A axis tilt)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-1.66, 1.1, 0.4], "localEnd": [-1.66, 1.1, 0.4], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.66, "height": 0.14, "depth": 0.72, "units": "m", "confidence": 0.75}, "transform": {"position": [-1.66, 1.1, 0.4], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-a", "localPosition": [0, 0, 0], "purpose": "A axis tilt", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.66, 0.14, 0.8], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "trunnion", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cradle-white", "materialLayers": ["cradle-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 237, 234, 1.0)", "secondaryAlbedo": "rgba(237, 237, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_trunnion_35.add(mesh_trunnion_35);
  meshes["trunnion"] = mesh_trunnion_35;
  colliders["trunnion"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.66, 0.14, 0.8], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["trunnion"] ??= [];
  destructionGroups["trunnion"].push(node_trunnion_35);
  const socket_trunnion_axis_a_0 = new THREE.Object3D();
  socket_trunnion_axis_a_0.name = "axis-a";
  socket_trunnion_axis_a_0.position.set(0.0, 0.0, 0.0);
  socket_trunnion_axis_a_0.rotation.set(0, 0, 0);
  socket_trunnion_axis_a_0.userData.socket = {"id": "axis-a", "localPosition": [0, 0, 0], "purpose": "A axis tilt", "axis": [0, 1, 0]};
  node_trunnion_35.add(socket_trunnion_axis_a_0);
  sockets["trunnion:axis-a"] = socket_trunnion_axis_a_0;

  const attachment_cheek_far_36 = {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.04, -0.4], "localEnd": [0.0, 0.04, -0.32], "baseRadius": 0.31, "endRadius": 0.31, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]};
  const endpoint_cheek_far_36 = makeAttachmentEndpoint(attachment_cheek_far_36);
  const node_cheek_far_36 = new THREE.Group();
  node_cheek_far_36.name = "Trunnion cheek (far)__pivot";
  node_cheek_far_36.scale.set(1, 1, 1);
  if (endpoint_cheek_far_36) {
    node_cheek_far_36.position.copy(endpoint_cheek_far_36.start);
    node_cheek_far_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cheek_far_36.position.set(0.0, 0.04, -0.4);
    node_cheek_far_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_cheek_far_36.userData.sculptComponent = {"id": "cheek-far", "name": "Trunnion cheek (far)", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "trunnion", "attachment": {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.04, -0.4], "localEnd": [0.0, 0.04, -0.32], "baseRadius": 0.31, "endRadius": 0.31, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 0.62, "height": 0.08, "depth": 0.62, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.04, -0.4], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cradle-white", "materialLayers": ["cradle-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 237, 234, 1.0)", "secondaryAlbedo": "rgba(237, 237, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_cheek_far_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["trunnion"] ?? root).add(node_cheek_far_36);
  nodes["cheek-far"] = node_cheek_far_36;
  const mesh_cheek_far_36Geometry = endpoint_cheek_far_36
    ? new THREE.CylinderGeometry(endpoint_cheek_far_36.endRadius, endpoint_cheek_far_36.baseRadius, endpoint_cheek_far_36.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_cheek_far_36) {
    mesh_cheek_far_36Geometry.scale(0.62, 0.08, 0.62);
  }
  const mesh_cheek_far_36 = new THREE.Mesh(
    mesh_cheek_far_36Geometry,
    materialMap["cradle-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_far_36.name = "Trunnion cheek (far)";
  if (endpoint_cheek_far_36) {
    mesh_cheek_far_36.position.copy(endpoint_cheek_far_36.midpoint);
    mesh_cheek_far_36.quaternion.copy(endpoint_cheek_far_36.quaternion);
  }
  mesh_cheek_far_36.castShadow = options.castShadow ?? true;
  mesh_cheek_far_36.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_far_36.userData.sculptComponent = {"id": "cheek-far", "name": "Trunnion cheek (far)", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "trunnion", "attachment": {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.04, -0.4], "localEnd": [0.0, 0.04, -0.32], "baseRadius": 0.31, "endRadius": 0.31, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 0.62, "height": 0.08, "depth": 0.62, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.04, -0.4], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-far", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cradle-white", "materialLayers": ["cradle-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 237, 234, 1.0)", "secondaryAlbedo": "rgba(237, 237, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_cheek_far_36.add(mesh_cheek_far_36);
  meshes["cheek-far"] = mesh_cheek_far_36;
  colliders["cheek-far"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["cheek-far"] ??= [];
  destructionGroups["cheek-far"].push(node_cheek_far_36);

  const attachment_cheek_near_37 = {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.04, 0.32], "localEnd": [0.0, 0.04, 0.4], "baseRadius": 0.31, "endRadius": 0.31, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]};
  const endpoint_cheek_near_37 = makeAttachmentEndpoint(attachment_cheek_near_37);
  const node_cheek_near_37 = new THREE.Group();
  node_cheek_near_37.name = "Trunnion cheek (near)__pivot";
  node_cheek_near_37.scale.set(1, 1, 1);
  if (endpoint_cheek_near_37) {
    node_cheek_near_37.position.copy(endpoint_cheek_near_37.start);
    node_cheek_near_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cheek_near_37.position.set(0.0, 0.04, 0.32);
    node_cheek_near_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_cheek_near_37.userData.sculptComponent = {"id": "cheek-near", "name": "Trunnion cheek (near)", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "trunnion", "attachment": {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.04, 0.32], "localEnd": [0.0, 0.04, 0.4], "baseRadius": 0.31, "endRadius": 0.31, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 0.62, "height": 0.08, "depth": 0.62, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.04, 0.32], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cradle-white", "materialLayers": ["cradle-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 237, 234, 1.0)", "secondaryAlbedo": "rgba(237, 237, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_cheek_near_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["trunnion"] ?? root).add(node_cheek_near_37);
  nodes["cheek-near"] = node_cheek_near_37;
  const mesh_cheek_near_37Geometry = endpoint_cheek_near_37
    ? new THREE.CylinderGeometry(endpoint_cheek_near_37.endRadius, endpoint_cheek_near_37.baseRadius, endpoint_cheek_near_37.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_cheek_near_37) {
    mesh_cheek_near_37Geometry.scale(0.62, 0.08, 0.62);
  }
  const mesh_cheek_near_37 = new THREE.Mesh(
    mesh_cheek_near_37Geometry,
    materialMap["cradle-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cheek_near_37.name = "Trunnion cheek (near)";
  if (endpoint_cheek_near_37) {
    mesh_cheek_near_37.position.copy(endpoint_cheek_near_37.midpoint);
    mesh_cheek_near_37.quaternion.copy(endpoint_cheek_near_37.quaternion);
  }
  mesh_cheek_near_37.castShadow = options.castShadow ?? true;
  mesh_cheek_near_37.receiveShadow = options.receiveShadow ?? true;
  mesh_cheek_near_37.userData.sculptComponent = {"id": "cheek-near", "name": "Trunnion cheek (near)", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "trunnion", "attachment": {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.04, 0.32], "localEnd": [0.0, 0.04, 0.4], "baseRadius": 0.31, "endRadius": 0.31, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 0.62, "height": 0.08, "depth": 0.62, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.04, 0.32], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cheek-near", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cradle-white", "materialLayers": ["cradle-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 237, 234, 1.0)", "secondaryAlbedo": "rgba(237, 237, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_cheek_near_37.add(mesh_cheek_near_37);
  meshes["cheek-near"] = mesh_cheek_near_37;
  colliders["cheek-near"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["cheek-near"] ??= [];
  destructionGroups["cheek-near"].push(node_cheek_near_37);

  const attachment_table_38 = {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.07, 0.0], "localEnd": [0.0, 0.15, 0.0], "baseRadius": 0.33, "endRadius": 0.33, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]};
  const endpoint_table_38 = makeAttachmentEndpoint(attachment_table_38);
  const node_table_38 = new THREE.Group();
  node_table_38.name = "Rotary pallet table (B axis)__pivot";
  node_table_38.scale.set(1, 1, 1);
  if (endpoint_table_38) {
    node_table_38.position.copy(endpoint_table_38.start);
    node_table_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_table_38.position.set(0.0, 0.07, 0.0);
    node_table_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_table_38.userData.sculptComponent = {"id": "table", "name": "Rotary pallet table (B axis)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "trunnion", "attachment": {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.07, 0.0], "localEnd": [0.0, 0.15, 0.0], "baseRadius": 0.33, "endRadius": 0.33, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.66, "height": 0.08, "depth": 0.66, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.07, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-b", "localPosition": [0, 0.04, 0], "purpose": "B axis rotation", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.66, 0.08, 0.66], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "table", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "table-hole-pattern", "type": "repetition", "note": "hole grid on table top"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_table_38.userData.actionProfile = {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-b", "localPosition": [0, 0.04, 0], "purpose": "B axis rotation", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.66, 0.08, 0.66], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "table", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["trunnion"] ?? root).add(node_table_38);
  nodes["table"] = node_table_38;
  const mesh_table_38Geometry = endpoint_table_38
    ? new THREE.CylinderGeometry(endpoint_table_38.endRadius, endpoint_table_38.baseRadius, endpoint_table_38.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_table_38) {
    mesh_table_38Geometry.scale(0.66, 0.08, 0.66);
  }
  const mesh_table_38 = new THREE.Mesh(
    mesh_table_38Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_table_38.name = "Rotary pallet table (B axis)";
  if (endpoint_table_38) {
    mesh_table_38.position.copy(endpoint_table_38.midpoint);
    mesh_table_38.quaternion.copy(endpoint_table_38.quaternion);
  }
  mesh_table_38.castShadow = options.castShadow ?? true;
  mesh_table_38.receiveShadow = options.receiveShadow ?? true;
  mesh_table_38.userData.sculptComponent = {"id": "table", "name": "Rotary pallet table (B axis)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "trunnion", "attachment": {"parentSocket": "trunnion:mount", "contactType": "socket", "localStart": [0.0, 0.07, 0.0], "localEnd": [0.0, 0.15, 0.0], "baseRadius": 0.33, "endRadius": 0.33, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.66, "height": 0.08, "depth": 0.66, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.07, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "axis-b", "localPosition": [0, 0.04, 0], "purpose": "B axis rotation", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.66, 0.08, 0.66], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "table", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "table-hole-pattern", "type": "repetition", "note": "hole grid on table top"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_table_38.add(mesh_table_38);
  meshes["table"] = mesh_table_38;
  colliders["table"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.66, 0.08, 0.66], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["table"] ??= [];
  destructionGroups["table"].push(node_table_38);
  const socket_table_axis_b_0 = new THREE.Object3D();
  socket_table_axis_b_0.name = "axis-b";
  socket_table_axis_b_0.position.set(0.0, 0.04, 0.0);
  socket_table_axis_b_0.rotation.set(0, 0, 0);
  socket_table_axis_b_0.userData.socket = {"id": "axis-b", "localPosition": [0, 0.04, 0], "purpose": "B axis rotation", "axis": [0, 1, 0]};
  node_table_38.add(socket_table_axis_b_0);
  sockets["table:axis-b"] = socket_table_axis_b_0;

  const endpoint_workpiece_39 = makeAttachmentEndpoint(null);
  const node_workpiece_39 = new THREE.Group();
  node_workpiece_39.name = "Workpiece (aluminium housing)__pivot";
  node_workpiece_39.scale.set(1, 1, 1);
  if (endpoint_workpiece_39) {
    node_workpiece_39.position.copy(endpoint_workpiece_39.start);
    node_workpiece_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_workpiece_39.position.set(0.0, 0.2, 0.0);
    node_workpiece_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_workpiece_39.userData.sculptComponent = {"id": "workpiece", "name": "Workpiece (aluminium housing)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.5, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "table", "attachment": {"parentSocket": "table:mount", "contactType": "butt", "localStart": [0.0, 0.2, 0.0], "localEnd": [0.0, 0.2, 0.0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.28, "height": 0.24, "depth": 0.3, "units": "m", "confidence": 0.5}, "transform": {"position": [0.0, 0.2, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.28, 0.24, 0.3], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "workpiece", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_workpiece_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.28, 0.24, 0.3], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "workpiece", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["table"] ?? root).add(node_workpiece_39);
  nodes["workpiece"] = node_workpiece_39;
  const mesh_workpiece_39Geometry = endpoint_workpiece_39
    ? new THREE.CylinderGeometry(endpoint_workpiece_39.endRadius, endpoint_workpiece_39.baseRadius, endpoint_workpiece_39.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_workpiece_39) {
    mesh_workpiece_39Geometry.scale(0.28, 0.24, 0.3);
  }
  const mesh_workpiece_39 = new THREE.Mesh(
    mesh_workpiece_39Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_workpiece_39.name = "Workpiece (aluminium housing)";
  if (endpoint_workpiece_39) {
    mesh_workpiece_39.position.copy(endpoint_workpiece_39.midpoint);
    mesh_workpiece_39.quaternion.copy(endpoint_workpiece_39.quaternion);
  }
  mesh_workpiece_39.castShadow = options.castShadow ?? true;
  mesh_workpiece_39.receiveShadow = options.receiveShadow ?? true;
  mesh_workpiece_39.userData.sculptComponent = {"id": "workpiece", "name": "Workpiece (aluminium housing)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.5, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "table", "attachment": {"parentSocket": "table:mount", "contactType": "butt", "localStart": [0.0, 0.2, 0.0], "localEnd": [0.0, 0.2, 0.0], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.28, "height": 0.24, "depth": 0.3, "units": "m", "confidence": 0.5}, "transform": {"position": [0.0, 0.2, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.28, 0.24, 0.3], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "workpiece", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_workpiece_39.add(mesh_workpiece_39);
  meshes["workpiece"] = mesh_workpiece_39;
  colliders["workpiece"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.28, 0.24, 0.3], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["workpiece"] ??= [];
  destructionGroups["workpiece"].push(node_workpiece_39);

  const endpoint_door_40 = makeAttachmentEndpoint(null);
  const node_door_40 = new THREE.Group();
  node_door_40.name = "Sliding work area door (frosted)__pivot";
  node_door_40.scale.set(1, 1, 1);
  if (endpoint_door_40) {
    node_door_40.position.copy(endpoint_door_40.start);
    node_door_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_40.position.set(-2.03, 1.54, 0.05);
    node_door_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_40.userData.sculptComponent = {"id": "door", "name": "Sliding work area door (frosted)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-2.03, 1.54, 0.05], "localEnd": [-2.03, 1.54, 0.05], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.04, "height": 1.45, "depth": 0.6, "units": "m", "confidence": 0.75}, "transform": {"position": [-2.03, 1.54, 0.05], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 1.45, 0.6], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "frosted", "materialLayers": ["frosted"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 206, 211, 1.0)", "secondaryAlbedo": "rgba(201, 206, 211, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_door_40.userData.actionProfile = {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 1.45, 0.6], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_door_40);
  nodes["door"] = node_door_40;
  const mesh_door_40Geometry = endpoint_door_40
    ? new THREE.CylinderGeometry(endpoint_door_40.endRadius, endpoint_door_40.baseRadius, endpoint_door_40.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_door_40) {
    mesh_door_40Geometry.scale(0.04, 1.45, 0.6);
  }
  const mesh_door_40 = new THREE.Mesh(
    mesh_door_40Geometry,
    materialMap["frosted"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_40.name = "Sliding work area door (frosted)";
  if (endpoint_door_40) {
    mesh_door_40.position.copy(endpoint_door_40.midpoint);
    mesh_door_40.quaternion.copy(endpoint_door_40.quaternion);
  }
  mesh_door_40.castShadow = options.castShadow ?? true;
  mesh_door_40.receiveShadow = options.receiveShadow ?? true;
  mesh_door_40.userData.sculptComponent = {"id": "door", "name": "Sliding work area door (frosted)", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-2.03, 1.54, 0.05], "localEnd": [-2.03, 1.54, 0.05], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.04, "height": 1.45, "depth": 0.6, "units": "m", "confidence": 0.75}, "transform": {"position": [-2.03, 1.54, 0.05], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "linear-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 1.45, 0.6], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "frosted", "materialLayers": ["frosted"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(201, 206, 211, 1.0)", "secondaryAlbedo": "rgba(201, 206, 211, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_door_40.add(mesh_door_40);
  meshes["door"] = mesh_door_40;
  colliders["door"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.04, 1.45, 0.6], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["door"] ??= [];
  destructionGroups["door"].push(node_door_40);

  const attachment_magazine_41 = {"parentSocket": "root:mount", "contactType": "socket", "localStart": [-0.35, 1.79, -0.51], "localEnd": [-0.35, 1.79, -0.39], "baseRadius": 0.55, "endRadius": 0.55, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]};
  const endpoint_magazine_41 = makeAttachmentEndpoint(attachment_magazine_41);
  const node_magazine_41 = new THREE.Group();
  node_magazine_41.name = "Disc tool magazine (hidden, inferred)__pivot";
  node_magazine_41.scale.set(1, 1, 1);
  if (endpoint_magazine_41) {
    node_magazine_41.position.copy(endpoint_magazine_41.start);
    node_magazine_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_magazine_41.position.set(-0.35, 1.79, -0.51);
    node_magazine_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_magazine_41.userData.sculptComponent = {"id": "magazine", "name": "Disc tool magazine (hidden, inferred)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.35, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "socket", "localStart": [-0.35, 1.79, -0.51], "localEnd": [-0.35, 1.79, -0.39], "baseRadius": 0.55, "endRadius": 0.55, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 1.1, "height": 0.12, "depth": 1.1, "units": "m", "confidence": 0.35}, "transform": {"position": [-0.35, 1.79, -0.51], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 0.12, 1.1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "magazine", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_magazine_41.userData.actionProfile = {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 0.12, 1.1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "magazine", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_magazine_41);
  nodes["magazine"] = node_magazine_41;
  const mesh_magazine_41Geometry = endpoint_magazine_41
    ? new THREE.CylinderGeometry(endpoint_magazine_41.endRadius, endpoint_magazine_41.baseRadius, endpoint_magazine_41.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_magazine_41) {
    mesh_magazine_41Geometry.scale(1.1, 0.12, 1.1);
  }
  const mesh_magazine_41 = new THREE.Mesh(
    mesh_magazine_41Geometry,
    materialMap["dark-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_magazine_41.name = "Disc tool magazine (hidden, inferred)";
  if (endpoint_magazine_41) {
    mesh_magazine_41.position.copy(endpoint_magazine_41.midpoint);
    mesh_magazine_41.quaternion.copy(endpoint_magazine_41.quaternion);
  }
  mesh_magazine_41.castShadow = options.castShadow ?? true;
  mesh_magazine_41.receiveShadow = options.receiveShadow ?? true;
  mesh_magazine_41.userData.sculptComponent = {"id": "magazine", "name": "Disc tool magazine (hidden, inferred)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.35, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "socket", "localStart": [-0.35, 1.79, -0.51], "localEnd": [-0.35, 1.79, -0.39], "baseRadius": 0.55, "endRadius": 0.55, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 1.1, "height": 0.12, "depth": 1.1, "units": "m", "confidence": 0.35}, "transform": {"position": [-0.35, 1.79, -0.51], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.35}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 0.12, 1.1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "magazine", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_magazine_41.add(mesh_magazine_41);
  meshes["magazine"] = mesh_magazine_41;
  colliders["magazine"] = {"type": "box", "offset": [0, 0, 0], "scale": [1.1, 0.12, 1.1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["magazine"] ??= [];
  destructionGroups["magazine"].push(node_magazine_41);

  const endpoint_conveyor_42 = makeAttachmentEndpoint(null);
  const node_conveyor_42 = new THREE.Group();
  node_conveyor_42.name = "Chip conveyor (inclined belt)__pivot";
  node_conveyor_42.scale.set(1, 1, 1);
  if (endpoint_conveyor_42) {
    node_conveyor_42.position.copy(endpoint_conveyor_42.start);
    node_conveyor_42.rotation.set(0.0, 0.0, 0.18);
  } else {
    node_conveyor_42.position.set(-0.6, 0.39, -0.35);
    node_conveyor_42.rotation.set(0.0, 0.0, 0.18);
  }
  node_conveyor_42.userData.sculptComponent = {"id": "conveyor", "name": "Chip conveyor (inclined belt)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.4, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-0.6, 0.39, -0.35], "localEnd": [-0.6, 0.39, -0.35], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 2.2, "height": 0.08, "depth": 0.4, "units": "m", "confidence": 0.4}, "transform": {"position": [-0.6, 0.39, -0.35], "rotation": [0, 0, 0.18]}, "actionProfile": {"animationRole": "conveyor", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.4}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [2.2, 0.08, 0.4], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "conveyor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_conveyor_42.userData.actionProfile = {"animationRole": "conveyor", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.4}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [2.2, 0.08, 0.4], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "conveyor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_conveyor_42);
  nodes["conveyor"] = node_conveyor_42;
  const mesh_conveyor_42Geometry = endpoint_conveyor_42
    ? new THREE.CylinderGeometry(endpoint_conveyor_42.endRadius, endpoint_conveyor_42.baseRadius, endpoint_conveyor_42.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_conveyor_42) {
    mesh_conveyor_42Geometry.scale(2.2, 0.08, 0.4);
  }
  const mesh_conveyor_42 = new THREE.Mesh(
    mesh_conveyor_42Geometry,
    materialMap["dark-steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_conveyor_42.name = "Chip conveyor (inclined belt)";
  if (endpoint_conveyor_42) {
    mesh_conveyor_42.position.copy(endpoint_conveyor_42.midpoint);
    mesh_conveyor_42.quaternion.copy(endpoint_conveyor_42.quaternion);
  }
  mesh_conveyor_42.castShadow = options.castShadow ?? true;
  mesh_conveyor_42.receiveShadow = options.receiveShadow ?? true;
  mesh_conveyor_42.userData.sculptComponent = {"id": "conveyor", "name": "Chip conveyor (inclined belt)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.4, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [-0.6, 0.39, -0.35], "localEnd": [-0.6, 0.39, -0.35], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 2.2, "height": 0.08, "depth": 0.4, "units": "m", "confidence": 0.4}, "transform": {"position": [-0.6, 0.39, -0.35], "rotation": [0, 0, 0.18]}, "actionProfile": {"animationRole": "conveyor", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.4}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [2.2, 0.08, 0.4], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "conveyor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-steel", "materialLayers": ["dark-steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(111, 118, 125, 1.0)", "secondaryAlbedo": "rgba(111, 118, 125, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_conveyor_42.add(mesh_conveyor_42);
  meshes["conveyor"] = mesh_conveyor_42;
  colliders["conveyor"] = {"type": "box", "offset": [0, 0, 0], "scale": [2.2, 0.08, 0.4], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["conveyor"] ??= [];
  destructionGroups["conveyor"].push(node_conveyor_42);

  const attachment_pump_coolant_43 = {"parentSocket": "root:mount", "contactType": "socket", "localStart": [1.72, 1.4, 0.55], "localEnd": [1.72, 1.82, 0.55], "baseRadius": 0.13, "endRadius": 0.13, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]};
  const endpoint_pump_coolant_43 = makeAttachmentEndpoint(attachment_pump_coolant_43);
  const node_pump_coolant_43 = new THREE.Group();
  node_pump_coolant_43.name = "Coolant pump motor (refrigera\u00e7\u00e3o)__pivot";
  node_pump_coolant_43.scale.set(1, 1, 1);
  if (endpoint_pump_coolant_43) {
    node_pump_coolant_43.position.copy(endpoint_pump_coolant_43.start);
    node_pump_coolant_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pump_coolant_43.position.set(1.72, 1.4, 0.55);
    node_pump_coolant_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_pump_coolant_43.userData.sculptComponent = {"id": "pump-coolant", "name": "Coolant pump motor (refrigeração)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "socket", "localStart": [1.72, 1.4, 0.55], "localEnd": [1.72, 1.82, 0.55], "baseRadius": 0.13, "endRadius": 0.13, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.26, "height": 0.42, "depth": 0.26, "units": "m", "confidence": 0.75}, "transform": {"position": [1.72, 1.4, 0.55], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-coolant", "localPosition": [0.13, 0, 0], "purpose": "VSE004: coolant pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.26, 0.42, 0.26], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-coolant", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "motor-white", "materialLayers": ["motor-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "motor-fins", "type": "repetition"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 234, 1.0)", "secondaryAlbedo": "rgba(232, 233, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_pump_coolant_43.userData.actionProfile = {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-coolant", "localPosition": [0.13, 0, 0], "purpose": "VSE004: coolant pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.26, 0.42, 0.26], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-coolant", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_pump_coolant_43);
  nodes["pump-coolant"] = node_pump_coolant_43;
  const mesh_pump_coolant_43Geometry = endpoint_pump_coolant_43
    ? new THREE.CylinderGeometry(endpoint_pump_coolant_43.endRadius, endpoint_pump_coolant_43.baseRadius, endpoint_pump_coolant_43.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_pump_coolant_43) {
    mesh_pump_coolant_43Geometry.scale(0.26, 0.42, 0.26);
  }
  const mesh_pump_coolant_43 = new THREE.Mesh(
    mesh_pump_coolant_43Geometry,
    materialMap["motor-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pump_coolant_43.name = "Coolant pump motor (refrigera\u00e7\u00e3o)";
  if (endpoint_pump_coolant_43) {
    mesh_pump_coolant_43.position.copy(endpoint_pump_coolant_43.midpoint);
    mesh_pump_coolant_43.quaternion.copy(endpoint_pump_coolant_43.quaternion);
  }
  mesh_pump_coolant_43.castShadow = options.castShadow ?? true;
  mesh_pump_coolant_43.receiveShadow = options.receiveShadow ?? true;
  mesh_pump_coolant_43.userData.sculptComponent = {"id": "pump-coolant", "name": "Coolant pump motor (refrigeração)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "socket", "localStart": [1.72, 1.4, 0.55], "localEnd": [1.72, 1.82, 0.55], "baseRadius": 0.13, "endRadius": 0.13, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.26, "height": 0.42, "depth": 0.26, "units": "m", "confidence": 0.75}, "transform": {"position": [1.72, 1.4, 0.55], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-coolant", "localPosition": [0.13, 0, 0], "purpose": "VSE004: coolant pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.26, 0.42, 0.26], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-coolant", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "motor-white", "materialLayers": ["motor-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "motor-fins", "type": "repetition"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 234, 1.0)", "secondaryAlbedo": "rgba(232, 233, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_pump_coolant_43.add(mesh_pump_coolant_43);
  meshes["pump-coolant"] = mesh_pump_coolant_43;
  colliders["pump-coolant"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.26, 0.42, 0.26], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["pump-coolant"] ??= [];
  destructionGroups["pump-coolant"].push(node_pump_coolant_43);
  const socket_pump_coolant_sensor_coolant_0 = new THREE.Object3D();
  socket_pump_coolant_sensor_coolant_0.name = "sensor-coolant";
  socket_pump_coolant_sensor_coolant_0.position.set(0.13, 0.0, 0.0);
  socket_pump_coolant_sensor_coolant_0.rotation.set(0, 0, 0);
  socket_pump_coolant_sensor_coolant_0.userData.socket = {"id": "sensor-coolant", "localPosition": [0.13, 0, 0], "purpose": "VSE004: coolant pump motor", "axis": [0, 1, 0]};
  node_pump_coolant_43.add(socket_pump_coolant_sensor_coolant_0);
  sockets["pump-coolant:sensor-coolant"] = socket_pump_coolant_sensor_coolant_0;

  const attachment_pump_coolant_body_44 = {"parentSocket": "pump-coolant:mount", "contactType": "socket", "localStart": [0.0, -0.2, 0.0], "localEnd": [0.0, 0.0, 0.0], "baseRadius": 0.09, "endRadius": 0.09, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]};
  const endpoint_pump_coolant_body_44 = makeAttachmentEndpoint(attachment_pump_coolant_body_44);
  const node_pump_coolant_body_44 = new THREE.Group();
  node_pump_coolant_body_44.name = "Coolant pump body__pivot";
  node_pump_coolant_body_44.scale.set(1, 1, 1);
  if (endpoint_pump_coolant_body_44) {
    node_pump_coolant_body_44.position.copy(endpoint_pump_coolant_body_44.start);
    node_pump_coolant_body_44.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pump_coolant_body_44.position.set(0.0, -0.2, 0.0);
    node_pump_coolant_body_44.rotation.set(0.0, 0.0, 0.0);
  }
  node_pump_coolant_body_44.userData.sculptComponent = {"id": "pump-coolant-body", "name": "Coolant pump body", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "pump-coolant", "attachment": {"parentSocket": "pump-coolant:mount", "contactType": "socket", "localStart": [0.0, -0.2, 0.0], "localEnd": [0.0, 0.0, 0.0], "baseRadius": 0.09, "endRadius": 0.09, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.18, "height": 0.2, "depth": 0.18, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, -0.2, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.18, 0.2, 0.18], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-coolant-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_pump_coolant_body_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.18, 0.2, 0.18], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-coolant-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["pump-coolant"] ?? root).add(node_pump_coolant_body_44);
  nodes["pump-coolant-body"] = node_pump_coolant_body_44;
  const mesh_pump_coolant_body_44Geometry = endpoint_pump_coolant_body_44
    ? new THREE.CylinderGeometry(endpoint_pump_coolant_body_44.endRadius, endpoint_pump_coolant_body_44.baseRadius, endpoint_pump_coolant_body_44.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_pump_coolant_body_44) {
    mesh_pump_coolant_body_44Geometry.scale(0.18, 0.2, 0.18);
  }
  const mesh_pump_coolant_body_44 = new THREE.Mesh(
    mesh_pump_coolant_body_44Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pump_coolant_body_44.name = "Coolant pump body";
  if (endpoint_pump_coolant_body_44) {
    mesh_pump_coolant_body_44.position.copy(endpoint_pump_coolant_body_44.midpoint);
    mesh_pump_coolant_body_44.quaternion.copy(endpoint_pump_coolant_body_44.quaternion);
  }
  mesh_pump_coolant_body_44.castShadow = options.castShadow ?? true;
  mesh_pump_coolant_body_44.receiveShadow = options.receiveShadow ?? true;
  mesh_pump_coolant_body_44.userData.sculptComponent = {"id": "pump-coolant-body", "name": "Coolant pump body", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "pump-coolant", "attachment": {"parentSocket": "pump-coolant:mount", "contactType": "socket", "localStart": [0.0, -0.2, 0.0], "localEnd": [0.0, 0.0, 0.0], "baseRadius": 0.09, "endRadius": 0.09, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.18, "height": 0.2, "depth": 0.18, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, -0.2, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.18, 0.2, 0.18], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-coolant-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_pump_coolant_body_44.add(mesh_pump_coolant_body_44);
  meshes["pump-coolant-body"] = mesh_pump_coolant_body_44;
  colliders["pump-coolant-body"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.18, 0.2, 0.18], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["pump-coolant-body"] ??= [];
  destructionGroups["pump-coolant-body"].push(node_pump_coolant_body_44);

  const endpoint_hyd_tank_45 = makeAttachmentEndpoint(null);
  const node_hyd_tank_45 = new THREE.Group();
  node_hyd_tank_45.name = "Hydraulic unit tank (finned)__pivot";
  node_hyd_tank_45.scale.set(1, 1, 1);
  if (endpoint_hyd_tank_45) {
    node_hyd_tank_45.position.copy(endpoint_hyd_tank_45.start);
    node_hyd_tank_45.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hyd_tank_45.position.set(1.32, 0.31, 0.55);
    node_hyd_tank_45.rotation.set(0.0, 0.0, 0.0);
  }
  node_hyd_tank_45.userData.sculptComponent = {"id": "hyd-tank", "name": "Hydraulic unit tank (finned)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [1.32, 0.31, 0.55], "localEnd": [1.32, 0.31, 0.55], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.55, "height": 0.45, "depth": 0.45, "units": "m", "confidence": 0.75}, "transform": {"position": [1.32, 0.31, 0.55], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.55, 0.45, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hyd-tank", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tank-fins", "type": "repetition"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_hyd_tank_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.55, 0.45, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hyd-tank", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_hyd_tank_45);
  nodes["hyd-tank"] = node_hyd_tank_45;
  const mesh_hyd_tank_45Geometry = endpoint_hyd_tank_45
    ? new THREE.CylinderGeometry(endpoint_hyd_tank_45.endRadius, endpoint_hyd_tank_45.baseRadius, endpoint_hyd_tank_45.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_hyd_tank_45) {
    mesh_hyd_tank_45Geometry.scale(0.55, 0.45, 0.45);
  }
  const mesh_hyd_tank_45 = new THREE.Mesh(
    mesh_hyd_tank_45Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hyd_tank_45.name = "Hydraulic unit tank (finned)";
  if (endpoint_hyd_tank_45) {
    mesh_hyd_tank_45.position.copy(endpoint_hyd_tank_45.midpoint);
    mesh_hyd_tank_45.quaternion.copy(endpoint_hyd_tank_45.quaternion);
  }
  mesh_hyd_tank_45.castShadow = options.castShadow ?? true;
  mesh_hyd_tank_45.receiveShadow = options.receiveShadow ?? true;
  mesh_hyd_tank_45.userData.sculptComponent = {"id": "hyd-tank", "name": "Hydraulic unit tank (finned)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [1.32, 0.31, 0.55], "localEnd": [1.32, 0.31, 0.55], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.55, "height": 0.45, "depth": 0.45, "units": "m", "confidence": 0.75}, "transform": {"position": [1.32, 0.31, 0.55], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.55, 0.45, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hyd-tank", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "tank-fins", "type": "repetition"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 190, 196, 1.0)", "secondaryAlbedo": "rgba(184, 190, 196, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_hyd_tank_45.add(mesh_hyd_tank_45);
  meshes["hyd-tank"] = mesh_hyd_tank_45;
  colliders["hyd-tank"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.55, 0.45, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["hyd-tank"] ??= [];
  destructionGroups["hyd-tank"].push(node_hyd_tank_45);

  const attachment_pump_hydraulic_46 = {"parentSocket": "hyd-tank:mount", "contactType": "socket", "localStart": [0.0, 0.24, 0.0], "localEnd": [0.0, 0.58, 0.0], "baseRadius": 0.1, "endRadius": 0.1, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]};
  const endpoint_pump_hydraulic_46 = makeAttachmentEndpoint(attachment_pump_hydraulic_46);
  const node_pump_hydraulic_46 = new THREE.Group();
  node_pump_hydraulic_46.name = "Hydraulic pump motor (hidr\u00e1ulica)__pivot";
  node_pump_hydraulic_46.scale.set(1, 1, 1);
  if (endpoint_pump_hydraulic_46) {
    node_pump_hydraulic_46.position.copy(endpoint_pump_hydraulic_46.start);
    node_pump_hydraulic_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pump_hydraulic_46.position.set(0.0, 0.24, 0.0);
    node_pump_hydraulic_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_pump_hydraulic_46.userData.sculptComponent = {"id": "pump-hydraulic", "name": "Hydraulic pump motor (hidráulica)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hyd-tank", "attachment": {"parentSocket": "hyd-tank:mount", "contactType": "socket", "localStart": [0.0, 0.24, 0.0], "localEnd": [0.0, 0.58, 0.0], "baseRadius": 0.1, "endRadius": 0.1, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.2, "height": 0.34, "depth": 0.2, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.24, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-hydraulic", "localPosition": [0.1, 0, 0], "purpose": "VSE004: hydraulic pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.2, 0.34, 0.2], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-hydraulic", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "motor-white", "materialLayers": ["motor-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 234, 1.0)", "secondaryAlbedo": "rgba(232, 233, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_pump_hydraulic_46.userData.actionProfile = {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-hydraulic", "localPosition": [0.1, 0, 0], "purpose": "VSE004: hydraulic pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.2, 0.34, 0.2], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-hydraulic", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["hyd-tank"] ?? root).add(node_pump_hydraulic_46);
  nodes["pump-hydraulic"] = node_pump_hydraulic_46;
  const mesh_pump_hydraulic_46Geometry = endpoint_pump_hydraulic_46
    ? new THREE.CylinderGeometry(endpoint_pump_hydraulic_46.endRadius, endpoint_pump_hydraulic_46.baseRadius, endpoint_pump_hydraulic_46.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_pump_hydraulic_46) {
    mesh_pump_hydraulic_46Geometry.scale(0.2, 0.34, 0.2);
  }
  const mesh_pump_hydraulic_46 = new THREE.Mesh(
    mesh_pump_hydraulic_46Geometry,
    materialMap["motor-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pump_hydraulic_46.name = "Hydraulic pump motor (hidr\u00e1ulica)";
  if (endpoint_pump_hydraulic_46) {
    mesh_pump_hydraulic_46.position.copy(endpoint_pump_hydraulic_46.midpoint);
    mesh_pump_hydraulic_46.quaternion.copy(endpoint_pump_hydraulic_46.quaternion);
  }
  mesh_pump_hydraulic_46.castShadow = options.castShadow ?? true;
  mesh_pump_hydraulic_46.receiveShadow = options.receiveShadow ?? true;
  mesh_pump_hydraulic_46.userData.sculptComponent = {"id": "pump-hydraulic", "name": "Hydraulic pump motor (hidráulica)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "hyd-tank", "attachment": {"parentSocket": "hyd-tank:mount", "contactType": "socket", "localStart": [0.0, 0.24, 0.0], "localEnd": [0.0, 0.58, 0.0], "baseRadius": 0.1, "endRadius": 0.1, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.2, "height": 0.34, "depth": 0.2, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.24, 0.0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-hydraulic", "localPosition": [0.1, 0, 0], "purpose": "VSE004: hydraulic pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.2, 0.34, 0.2], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-hydraulic", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "motor-white", "materialLayers": ["motor-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 234, 1.0)", "secondaryAlbedo": "rgba(232, 233, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_pump_hydraulic_46.add(mesh_pump_hydraulic_46);
  meshes["pump-hydraulic"] = mesh_pump_hydraulic_46;
  colliders["pump-hydraulic"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.2, 0.34, 0.2], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["pump-hydraulic"] ??= [];
  destructionGroups["pump-hydraulic"].push(node_pump_hydraulic_46);
  const socket_pump_hydraulic_sensor_hydraulic_0 = new THREE.Object3D();
  socket_pump_hydraulic_sensor_hydraulic_0.name = "sensor-hydraulic";
  socket_pump_hydraulic_sensor_hydraulic_0.position.set(0.1, 0.0, 0.0);
  socket_pump_hydraulic_sensor_hydraulic_0.rotation.set(0, 0, 0);
  socket_pump_hydraulic_sensor_hydraulic_0.userData.socket = {"id": "sensor-hydraulic", "localPosition": [0.1, 0, 0], "purpose": "VSE004: hydraulic pump motor", "axis": [0, 1, 0]};
  node_pump_hydraulic_46.add(socket_pump_hydraulic_sensor_hydraulic_0);
  sockets["pump-hydraulic:sensor-hydraulic"] = socket_pump_hydraulic_sensor_hydraulic_0;

  const attachment_pump_hp_47 = {"parentSocket": "root:mount", "contactType": "socket", "localStart": [1.75, 0.18, 0.6], "localEnd": [1.75, 0.54, 0.6], "baseRadius": 0.1, "endRadius": 0.1, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]};
  const endpoint_pump_hp_47 = makeAttachmentEndpoint(attachment_pump_hp_47);
  const node_pump_hp_47 = new THREE.Group();
  node_pump_hp_47.name = "High-pressure pump motor (alta press\u00e3o)__pivot";
  node_pump_hp_47.scale.set(1, 1, 1);
  if (endpoint_pump_hp_47) {
    node_pump_hp_47.position.copy(endpoint_pump_hp_47.start);
    node_pump_hp_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pump_hp_47.position.set(1.75, 0.18, 0.6);
    node_pump_hp_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_pump_hp_47.userData.sculptComponent = {"id": "pump-hp", "name": "High-pressure pump motor (alta pressão)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "socket", "localStart": [1.75, 0.18, 0.6], "localEnd": [1.75, 0.54, 0.6], "baseRadius": 0.1, "endRadius": 0.1, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.2, "height": 0.36, "depth": 0.2, "units": "m", "confidence": 0.75}, "transform": {"position": [1.75, 0.18, 0.6], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-hp", "localPosition": [0.1, 0, 0], "purpose": "VSE004: high-pressure pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.2, 0.36, 0.2], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-hp", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "motor-white", "materialLayers": ["motor-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 234, 1.0)", "secondaryAlbedo": "rgba(232, 233, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_pump_hp_47.userData.actionProfile = {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-hp", "localPosition": [0.1, 0, 0], "purpose": "VSE004: high-pressure pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.2, 0.36, 0.2], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-hp", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_pump_hp_47);
  nodes["pump-hp"] = node_pump_hp_47;
  const mesh_pump_hp_47Geometry = endpoint_pump_hp_47
    ? new THREE.CylinderGeometry(endpoint_pump_hp_47.endRadius, endpoint_pump_hp_47.baseRadius, endpoint_pump_hp_47.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_pump_hp_47) {
    mesh_pump_hp_47Geometry.scale(0.2, 0.36, 0.2);
  }
  const mesh_pump_hp_47 = new THREE.Mesh(
    mesh_pump_hp_47Geometry,
    materialMap["motor-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pump_hp_47.name = "High-pressure pump motor (alta press\u00e3o)";
  if (endpoint_pump_hp_47) {
    mesh_pump_hp_47.position.copy(endpoint_pump_hp_47.midpoint);
    mesh_pump_hp_47.quaternion.copy(endpoint_pump_hp_47.quaternion);
  }
  mesh_pump_hp_47.castShadow = options.castShadow ?? true;
  mesh_pump_hp_47.receiveShadow = options.receiveShadow ?? true;
  mesh_pump_hp_47.userData.sculptComponent = {"id": "pump-hp", "name": "High-pressure pump motor (alta pressão)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "socket", "localStart": [1.75, 0.18, 0.6], "localEnd": [1.75, 0.54, 0.6], "baseRadius": 0.1, "endRadius": 0.1, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.2, "height": 0.36, "depth": 0.2, "units": "m", "confidence": 0.75}, "transform": {"position": [1.75, 0.18, 0.6], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "rotary-axis", "pivot": {"mode": "authored", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-hp", "localPosition": [0.1, 0, 0], "purpose": "VSE004: high-pressure pump motor", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.2, 0.36, 0.2], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pump-hp", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "motor-white", "materialLayers": ["motor-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 233, 234, 1.0)", "secondaryAlbedo": "rgba(232, 233, 234, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_pump_hp_47.add(mesh_pump_hp_47);
  meshes["pump-hp"] = mesh_pump_hp_47;
  colliders["pump-hp"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.2, 0.36, 0.2], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["pump-hp"] ??= [];
  destructionGroups["pump-hp"].push(node_pump_hp_47);
  const socket_pump_hp_sensor_hp_0 = new THREE.Object3D();
  socket_pump_hp_sensor_hp_0.name = "sensor-hp";
  socket_pump_hp_sensor_hp_0.position.set(0.1, 0.0, 0.0);
  socket_pump_hp_sensor_hp_0.rotation.set(0, 0, 0);
  socket_pump_hp_sensor_hp_0.userData.socket = {"id": "sensor-hp", "localPosition": [0.1, 0, 0], "purpose": "VSE004: high-pressure pump motor", "axis": [0, 1, 0]};
  node_pump_hp_47.add(socket_pump_hp_sensor_hp_0);
  sockets["pump-hp:sensor-hp"] = socket_pump_hp_sensor_hp_0;

  const endpoint_electrical_cabinet_48 = makeAttachmentEndpoint(null);
  const node_electrical_cabinet_48 = new THREE.Group();
  node_electrical_cabinet_48.name = "Electrical cabinet (3-phase meter)__pivot";
  node_electrical_cabinet_48.scale.set(1, 1, 1);
  if (endpoint_electrical_cabinet_48) {
    node_electrical_cabinet_48.position.copy(endpoint_electrical_cabinet_48.start);
    node_electrical_cabinet_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_electrical_cabinet_48.position.set(0.55, 1.09, -0.55);
    node_electrical_cabinet_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_electrical_cabinet_48.userData.sculptComponent = {"id": "electrical-cabinet", "name": "Electrical cabinet (3-phase meter)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.3, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [0.55, 1.09, -0.55], "localEnd": [0.55, 1.09, -0.55], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.6, "height": 1.9, "depth": 0.45, "units": "m", "confidence": 0.3}, "transform": {"position": [0.55, 1.09, -0.55], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.3}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-power", "localPosition": [0, 0.4, 0.23], "purpose": "3-phase power meter", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.6, 1.9, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "electrical-cabinet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_electrical_cabinet_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.3}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-power", "localPosition": [0, 0.4, 0.23], "purpose": "3-phase power meter", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.6, 1.9, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "electrical-cabinet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_electrical_cabinet_48);
  nodes["electrical-cabinet"] = node_electrical_cabinet_48;
  const mesh_electrical_cabinet_48Geometry = endpoint_electrical_cabinet_48
    ? new THREE.CylinderGeometry(endpoint_electrical_cabinet_48.endRadius, endpoint_electrical_cabinet_48.baseRadius, endpoint_electrical_cabinet_48.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_electrical_cabinet_48) {
    mesh_electrical_cabinet_48Geometry.scale(0.6, 1.9, 0.45);
  }
  const mesh_electrical_cabinet_48 = new THREE.Mesh(
    mesh_electrical_cabinet_48Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_electrical_cabinet_48.name = "Electrical cabinet (3-phase meter)";
  if (endpoint_electrical_cabinet_48) {
    mesh_electrical_cabinet_48.position.copy(endpoint_electrical_cabinet_48.midpoint);
    mesh_electrical_cabinet_48.quaternion.copy(endpoint_electrical_cabinet_48.quaternion);
  }
  mesh_electrical_cabinet_48.castShadow = options.castShadow ?? true;
  mesh_electrical_cabinet_48.receiveShadow = options.receiveShadow ?? true;
  mesh_electrical_cabinet_48.userData.sculptComponent = {"id": "electrical-cabinet", "name": "Electrical cabinet (3-phase meter)", "level": "macro", "role": "structure", "importance": 0.8, "confidence": 0.3, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "butt", "localStart": [0.55, 1.09, -0.55], "localEnd": [0.55, 1.09, -0.55], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.6, "height": 1.9, "depth": 0.45, "units": "m", "confidence": 0.3}, "transform": {"position": [0.55, 1.09, -0.55], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.3}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "sensor-power", "localPosition": [0, 0.4, 0.23], "purpose": "3-phase power meter", "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.6, 1.9, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "electrical-cabinet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_electrical_cabinet_48.add(mesh_electrical_cabinet_48);
  meshes["electrical-cabinet"] = mesh_electrical_cabinet_48;
  colliders["electrical-cabinet"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.6, 1.9, 0.45], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["electrical-cabinet"] ??= [];
  destructionGroups["electrical-cabinet"].push(node_electrical_cabinet_48);
  const socket_electrical_cabinet_sensor_power_0 = new THREE.Object3D();
  socket_electrical_cabinet_sensor_power_0.name = "sensor-power";
  socket_electrical_cabinet_sensor_power_0.position.set(0.0, 0.4, 0.23);
  socket_electrical_cabinet_sensor_power_0.rotation.set(0, 0, 0);
  socket_electrical_cabinet_sensor_power_0.userData.socket = {"id": "sensor-power", "localPosition": [0, 0.4, 0.23], "purpose": "3-phase power meter", "axis": [0, 1, 0]};
  node_electrical_cabinet_48.add(socket_electrical_cabinet_sensor_power_0);
  sockets["electrical-cabinet:sensor-power"] = socket_electrical_cabinet_sensor_power_0;

  const attachment_op_arm_49 = {"parentSocket": "root:mount", "contactType": "socket", "localStart": [-0.55, 0.06, 1.02], "localEnd": [-0.55, 1.26, 1.02], "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]};
  const endpoint_op_arm_49 = makeAttachmentEndpoint(attachment_op_arm_49);
  const node_op_arm_49 = new THREE.Group();
  node_op_arm_49.name = "Operator panel swivel arm__pivot";
  node_op_arm_49.scale.set(1, 1, 1);
  if (endpoint_op_arm_49) {
    node_op_arm_49.position.copy(endpoint_op_arm_49.start);
    node_op_arm_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_op_arm_49.position.set(-0.55, 0.06, 1.02);
    node_op_arm_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_op_arm_49.userData.sculptComponent = {"id": "op-arm", "name": "Operator panel swivel arm", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "socket", "localStart": [-0.55, 0.06, 1.02], "localEnd": [-0.55, 1.26, 1.02], "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.08, "height": 1.2, "depth": 0.08, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.55, 0.06, 1.02], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.08, 1.2, 0.08], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-arm", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_op_arm_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.08, 1.2, 0.08], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-arm", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_op_arm_49);
  nodes["op-arm"] = node_op_arm_49;
  const mesh_op_arm_49Geometry = endpoint_op_arm_49
    ? new THREE.CylinderGeometry(endpoint_op_arm_49.endRadius, endpoint_op_arm_49.baseRadius, endpoint_op_arm_49.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_op_arm_49) {
    mesh_op_arm_49Geometry.scale(0.08, 1.2, 0.08);
  }
  const mesh_op_arm_49 = new THREE.Mesh(
    mesh_op_arm_49Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_op_arm_49.name = "Operator panel swivel arm";
  if (endpoint_op_arm_49) {
    mesh_op_arm_49.position.copy(endpoint_op_arm_49.midpoint);
    mesh_op_arm_49.quaternion.copy(endpoint_op_arm_49.quaternion);
  }
  mesh_op_arm_49.castShadow = options.castShadow ?? true;
  mesh_op_arm_49.receiveShadow = options.receiveShadow ?? true;
  mesh_op_arm_49.userData.sculptComponent = {"id": "op-arm", "name": "Operator panel swivel arm", "level": "meso", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root:mount", "contactType": "socket", "localStart": [-0.55, 0.06, 1.02], "localEnd": [-0.55, 1.26, 1.02], "baseRadius": 0.04, "endRadius": 0.04, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 1.0, 0.0]}, "dimensions": {"width": 0.08, "height": 1.2, "depth": 0.08, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.55, 0.06, 1.02], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.08, 1.2, 0.08], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-arm", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_op_arm_49.add(mesh_op_arm_49);
  meshes["op-arm"] = mesh_op_arm_49;
  colliders["op-arm"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.08, 1.2, 0.08], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["op-arm"] ??= [];
  destructionGroups["op-arm"].push(node_op_arm_49);

  const endpoint_op_panel_50 = makeAttachmentEndpoint(null);
  const node_op_panel_50 = new THREE.Group();
  node_op_panel_50.name = "Operator panel (HMI)__pivot";
  node_op_panel_50.scale.set(1, 1, 1);
  if (endpoint_op_panel_50) {
    node_op_panel_50.position.copy(endpoint_op_panel_50.start);
    node_op_panel_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_op_panel_50.position.set(0.0, 1.48, -0.02);
    node_op_panel_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_op_panel_50.userData.sculptComponent = {"id": "op-panel", "name": "Operator panel (HMI)", "level": "macro", "role": "hmi", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "op-arm", "attachment": {"parentSocket": "op-arm:mount", "contactType": "butt", "localStart": [0.0, 1.48, -0.02], "localEnd": [0.0, 1.48, -0.02], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.5, "height": 0.62, "depth": 0.1, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 1.48, -0.02], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.5, 0.62, 0.1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "screen", "type": "hmi"}, {"id": "keypad", "type": "repetition"}, {"id": "estop", "type": "hardware"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_op_panel_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.5, 0.62, 0.1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["op-arm"] ?? root).add(node_op_panel_50);
  nodes["op-panel"] = node_op_panel_50;
  const mesh_op_panel_50Geometry = endpoint_op_panel_50
    ? new THREE.CylinderGeometry(endpoint_op_panel_50.endRadius, endpoint_op_panel_50.baseRadius, endpoint_op_panel_50.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_op_panel_50) {
    mesh_op_panel_50Geometry.scale(0.5, 0.62, 0.1);
  }
  const mesh_op_panel_50 = new THREE.Mesh(
    mesh_op_panel_50Geometry,
    materialMap["panel-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_op_panel_50.name = "Operator panel (HMI)";
  if (endpoint_op_panel_50) {
    mesh_op_panel_50.position.copy(endpoint_op_panel_50.midpoint);
    mesh_op_panel_50.quaternion.copy(endpoint_op_panel_50.quaternion);
  }
  mesh_op_panel_50.castShadow = options.castShadow ?? true;
  mesh_op_panel_50.receiveShadow = options.receiveShadow ?? true;
  mesh_op_panel_50.userData.sculptComponent = {"id": "op-panel", "name": "Operator panel (HMI)", "level": "macro", "role": "hmi", "importance": 0.8, "confidence": 0.75, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "op-arm", "attachment": {"parentSocket": "op-arm:mount", "contactType": "butt", "localStart": [0.0, 1.48, -0.02], "localEnd": [0.0, 1.48, -0.02], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.5, "height": 0.62, "depth": 0.1, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 1.48, -0.02], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.5, 0.62, 0.1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "panel-grey", "materialLayers": ["panel-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "screen", "type": "hmi"}, {"id": "keypad", "type": "repetition"}, {"id": "estop", "type": "hardware"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(217, 219, 219, 1.0)", "secondaryAlbedo": "rgba(217, 219, 219, 0.9)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_op_panel_50.add(mesh_op_panel_50);
  meshes["op-panel"] = mesh_op_panel_50;
  colliders["op-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.5, 0.62, 0.1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["op-panel"] ??= [];
  destructionGroups["op-panel"].push(node_op_panel_50);

  const endpoint_op_screen_51 = makeAttachmentEndpoint(null);
  const node_op_screen_51 = new THREE.Group();
  node_op_screen_51.name = "HMI screen__pivot";
  node_op_screen_51.scale.set(1, 1, 1);
  if (endpoint_op_screen_51) {
    node_op_screen_51.position.copy(endpoint_op_screen_51.start);
    node_op_screen_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_op_screen_51.position.set(0.0, 0.13, 0.055);
    node_op_screen_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_op_screen_51.userData.sculptComponent = {"id": "op-screen", "name": "HMI screen", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Emissive screen decal.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "op-panel", "attachment": {"parentSocket": "op-panel:mount", "contactType": "butt", "localStart": [0.0, 0.13, 0.055], "localEnd": [0.0, 0.13, 0.055], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.34, "height": 0.24, "depth": 0.01, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.13, 0.055], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.34, 0.24, 0.01], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-screen", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "screen", "materialLayers": ["screen"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(127, 211, 240, 1.0)", "secondaryAlbedo": "rgba(127, 211, 240, 0.9)", "materialClass": "plastic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_op_screen_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.34, 0.24, 0.01], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-screen", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["op-panel"] ?? root).add(node_op_screen_51);
  nodes["op-screen"] = node_op_screen_51;
  const mesh_op_screen_51Geometry = endpoint_op_screen_51
    ? new THREE.CylinderGeometry(endpoint_op_screen_51.endRadius, endpoint_op_screen_51.baseRadius, endpoint_op_screen_51.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_op_screen_51) {
    mesh_op_screen_51Geometry.scale(0.34, 0.24, 0.01);
  }
  const mesh_op_screen_51 = new THREE.Mesh(
    mesh_op_screen_51Geometry,
    materialMap["screen"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_op_screen_51.name = "HMI screen";
  if (endpoint_op_screen_51) {
    mesh_op_screen_51.position.copy(endpoint_op_screen_51.midpoint);
    mesh_op_screen_51.quaternion.copy(endpoint_op_screen_51.quaternion);
  }
  mesh_op_screen_51.castShadow = options.castShadow ?? true;
  mesh_op_screen_51.receiveShadow = options.receiveShadow ?? true;
  mesh_op_screen_51.userData.sculptComponent = {"id": "op-screen", "name": "HMI screen", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Emissive screen decal.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "op-panel", "attachment": {"parentSocket": "op-panel:mount", "contactType": "butt", "localStart": [0.0, 0.13, 0.055], "localEnd": [0.0, 0.13, 0.055], "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005}, "dimensions": {"width": 0.34, "height": 0.24, "depth": 0.01, "units": "m", "confidence": 0.75}, "transform": {"position": [0.0, 0.13, 0.055], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.34, 0.24, 0.01], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-screen", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "screen", "materialLayers": ["screen"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(127, 211, 240, 1.0)", "secondaryAlbedo": "rgba(127, 211, 240, 0.9)", "materialClass": "plastic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_op_screen_51.add(mesh_op_screen_51);
  meshes["op-screen"] = mesh_op_screen_51;
  colliders["op-screen"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.34, 0.24, 0.01], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["op-screen"] ??= [];
  destructionGroups["op-screen"].push(node_op_screen_51);

  const attachment_op_estop_52 = {"parentSocket": "op-panel:mount", "contactType": "socket", "localStart": [-0.18, -0.2, 0.045], "localEnd": [-0.18, -0.2, 0.075], "baseRadius": 0.025, "endRadius": 0.025, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]};
  const endpoint_op_estop_52 = makeAttachmentEndpoint(attachment_op_estop_52);
  const node_op_estop_52 = new THREE.Group();
  node_op_estop_52.name = "Emergency stop__pivot";
  node_op_estop_52.scale.set(1, 1, 1);
  if (endpoint_op_estop_52) {
    node_op_estop_52.position.copy(endpoint_op_estop_52.start);
    node_op_estop_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_op_estop_52.position.set(-0.18, -0.2, 0.045);
    node_op_estop_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_op_estop_52.userData.sculptComponent = {"id": "op-estop", "name": "Emergency stop", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "op-panel", "attachment": {"parentSocket": "op-panel:mount", "contactType": "socket", "localStart": [-0.18, -0.2, 0.045], "localEnd": [-0.18, -0.2, 0.075], "baseRadius": 0.025, "endRadius": 0.025, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 0.05, "height": 0.03, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.18, -0.2, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-estop", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "estop-red", "materialLayers": ["estop-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198, 40, 40, 1.0)", "secondaryAlbedo": "rgba(198, 40, 40, 0.9)", "materialClass": "plastic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_op_estop_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-estop", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["op-panel"] ?? root).add(node_op_estop_52);
  nodes["op-estop"] = node_op_estop_52;
  const mesh_op_estop_52Geometry = endpoint_op_estop_52
    ? new THREE.CylinderGeometry(endpoint_op_estop_52.endRadius, endpoint_op_estop_52.baseRadius, endpoint_op_estop_52.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_op_estop_52) {
    mesh_op_estop_52Geometry.scale(0.05, 0.03, 0.05);
  }
  const mesh_op_estop_52 = new THREE.Mesh(
    mesh_op_estop_52Geometry,
    materialMap["estop-red"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_op_estop_52.name = "Emergency stop";
  if (endpoint_op_estop_52) {
    mesh_op_estop_52.position.copy(endpoint_op_estop_52.midpoint);
    mesh_op_estop_52.quaternion.copy(endpoint_op_estop_52.quaternion);
  }
  mesh_op_estop_52.castShadow = options.castShadow ?? true;
  mesh_op_estop_52.receiveShadow = options.receiveShadow ?? true;
  mesh_op_estop_52.userData.sculptComponent = {"id": "op-estop", "name": "Emergency stop", "level": "micro", "role": "structure", "importance": 0.55, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Rigid industrial part with flat or simply curved faces.", "geometryDescriptor": {"topologyIntent": "hard-surface industrial part, bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "op-panel", "attachment": {"parentSocket": "op-panel:mount", "contactType": "socket", "localStart": [-0.18, -0.2, 0.045], "localEnd": [-0.18, -0.2, 0.075], "baseRadius": 0.025, "endRadius": 0.025, "embedDepth": 0.01, "overlap": 0.02, "gapTolerance": 0.005, "axisWorld": [0.0, 0.0, 1.0]}, "dimensions": {"width": 0.05, "height": 0.03, "depth": 0.05, "units": "m", "confidence": 0.75}, "transform": {"position": [-0.18, -0.2, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "op-estop", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "estop-red", "materialLayers": ["estop-red"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198, 40, 40, 1.0)", "secondaryAlbedo": "rgba(198, 40, 40, 0.9)", "materialClass": "plastic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"]}};
  node_op_estop_52.add(mesh_op_estop_52);
  meshes["op-estop"] = mesh_op_estop_52;
  colliders["op-estop"] = {"type": "box", "offset": [0, 0, 0], "scale": [0.05, 0.03, 0.05], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["op-estop"] ??= [];
  destructionGroups["op-estop"].push(node_op_estop_52);

  // repetition system: table-holes (InstancedMesh, radial, count=24, level=meso)
  {
    const parent = nodes["table"] ?? root;
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
    const mat = materialMap["black"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 24);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 24; i++) {
      const ang = ((0.0) + (i * 360) / 24) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "table-holes";
    parent.add(cluster);
  }

  // repetition system: motor-fins (InstancedMesh, radial, count=12, level=meso)
  {
    const parent = nodes["pump-coolant"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["motor-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 12);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 12; i++) {
      const ang = ((0.0) + (i * 360) / 12) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "motor-fins";
    parent.add(cluster);
  }

  // repetition system: tank-fins (InstancedMesh, radial, count=10, level=meso)
  {
    const parent = nodes["hyd-tank"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
    const mat = materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 10);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 10; i++) {
      const ang = ((0.0) + (i * 360) / 10) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "tank-fins";
    parent.add(cluster);
  }

  // repetition system: magazine-pockets (InstancedMesh, radial, count=40, level=meso)
  {
    const parent = nodes["magazine"] ?? root;
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
    const mat = materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 40);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 40; i++) {
      const ang = ((0.0) + (i * 360) / 40) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "magazine-pockets";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createGROBG300MachiningCenterLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "GROB G300 Machining Center look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "direction": [-0.5, -1.0, 0.6], "color": "#FFFFFF", "intensity": 2.2, "castShadow": true, "evidence": "soft top-front studio light, short shadows to the rear-right"}, {"id": "fill", "type": "hemisphere", "skyColor": "#F4F7FA", "groundColor": "#C8CCD0", "intensity": 0.9, "evidence": "very light background bounce, low-contrast shadows"}, {"id": "rim", "type": "directional", "direction": [0.8, -0.3, -0.6], "color": "#E6EEF8", "intensity": 0.6, "evidence": "cool highlight on far edges of band and roof"}, {"id": "environment", "type": "environment", "preset": "studio white", "intensity": 0.8, "evidence": "neutral white sweep floor with reflection"}, {"id": "exposure", "toneMapping": "ACES filmic", "exposure": 1.0, "groundShadow": "soft contact shadow on white floor under base frame"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended: call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createGROBG300MachiningCenterEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2: auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameGROBG300MachiningCenterCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c: PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer: bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createGROBG300MachiningCenterPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureGROBG300MachiningCenterRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createGROBG300MachiningCenterInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits: their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
