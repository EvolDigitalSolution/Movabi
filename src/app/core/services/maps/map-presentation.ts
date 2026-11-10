// Vaydu map presentation: grey basemap.
// Applied to whatever style MapProviderService resolves — the provider/style
// mechanism is unchanged; this only rewrites color paint values on the loaded
// basemap layers. App-owned overlay layers (route, heatmap, tracking) are left
// untouched so their rendered colors survive the grey basemap.

interface PaintCarrier {
  getStyle(): { layers?: Array<{ id: string; type: string; source?: string }> } | undefined;
  getPaintProperty(layer: string, name: string): unknown;
  setPaintProperty(layer: string, name: string, value: unknown): void;
}

interface EventedMap extends PaintCarrier {
  isStyleLoaded?: () => boolean | void;
  once?: (event: string, cb: () => void) => unknown;
}

const COLOR_PAINT_PROPERTIES: Record<string, string[]> = {
  background: ['background-color'],
  fill: ['fill-color', 'fill-outline-color'],
  line: ['line-color', 'line-gradient'],
  symbol: ['icon-color', 'icon-halo-color', 'text-color', 'text-halo-color'],
  circle: ['circle-color', 'circle-stroke-color'],
  'fill-extrusion': ['fill-extrusion-color'],
  heatmap: ['heatmap-color'],
  hillshade: ['hillshade-shadow-color', 'hillshade-highlight-color', 'hillshade-accent-color'],
  raster: ['raster-color']
};

// Layers rendered by app code must keep their colors.
const APP_LAYER_IDS = new Set(['movabi-route-layer', 'heatmap-layer']);

// Expression operators whose output IS a runtime colour (only known at render
// time). A runtime colour is wrapped in a luminance desaturation expression.
// Structural expressions (match/case/interpolate/step/coalesce) with a runtime
// INPUT but STATIC colour outputs are NOT runtime colours: their literal colour
// outputs are greyed statically and the structure/inputs/stops are preserved.
const RUNTIME_COLOR_OPS = new Set(['get', 'var', 'feature-state', 'properties', 'to-color']);

const LUMA: [number, number, number] = [0.2126, 0.7152, 0.0722];

const NAMED_COLORS: Record<string, [number, number, number, number]> = {
  white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0],
  red: [255, 0, 0, 1], green: [0, 128, 0, 1], lime: [0, 255, 0, 1],
  blue: [0, 0, 255, 1], navy: [0, 0, 128, 1], teal: [0, 128, 128, 1],
  aqua: [0, 255, 255, 1], cyan: [0, 255, 255, 1], magenta: [255, 0, 255, 1],
  fuchsia: [255, 0, 255, 1], yellow: [255, 255, 0, 1], orange: [255, 165, 0, 1],
  purple: [128, 0, 128, 1], pink: [255, 192, 203, 1], brown: [165, 42, 42, 1],
  maroon: [128, 0, 0, 1], olive: [128, 128, 0, 1], gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1], silver: [192, 192, 192, 1],
  lightgray: [211, 211, 211, 1], lightgrey: [211, 211, 211, 1],
  darkgray: [169, 169, 169, 1], darkgrey: [169, 169, 169, 1],
  dimgray: [105, 105, 105, 1], dimgrey: [105, 105, 105, 1],
  gainsboro: [220, 220, 220, 1], whitesmoke: [245, 245, 245, 1],
  snow: [255, 250, 250, 1], ivory: [255, 255, 240, 1], beige: [245, 245, 220, 1],
  aliceblue: [240, 248, 255, 1], antiquewhite: [250, 235, 215, 1],
  slategray: [112, 128, 144, 1], slategrey: [112, 128, 144, 1],
  slateblue: [106, 90, 205, 1], steelblue: [70, 130, 180, 1],
  skyblue: [135, 206, 235, 1], royalblue: [65, 105, 225, 1],
  rebeccapurple: [102, 51, 153, 1], indigo: [75, 0, 130, 1],
  violet: [238, 130, 238, 1], lavender: [230, 230, 250, 1],
  khaki: [240, 230, 140, 1], gold: [255, 215, 0, 1], tan: [210, 180, 140, 1],
  wheat: [245, 222, 179, 1], salmon: [250, 128, 114, 1],
  coral: [255, 127, 80, 1], tomato: [255, 99, 71, 1],
  crimson: [220, 20, 60, 1], seagreen: [46, 139, 87, 1],
  forestgreen: [34, 139, 34, 1], darkgreen: [0, 100, 0, 1],
  darkblue: [0, 0, 139, 1], midnightblue: [25, 25, 112, 1],
  coralred: [255, 64, 64, 1]
};

function parseCssColor(raw: string): [number, number, number, number] | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const named = NAMED_COLORS[value];
  if (named) return named;

  let m = /^#([0-9a-f]{3,8})$/.exec(value);
  if (m) {
    const hex = m[1];
    const expand = (s: string) => (s.length === 1 ? parseInt(s + s, 16) : parseInt(s, 16));
    if (hex.length === 3 || hex.length === 4) {
      return [expand(hex[0]), expand(hex[1]), expand(hex[2]), hex.length === 4 ? expand(hex[3]) / 255 : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16),
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      ];
    }
    return null;
  }

  m = /^rgba?\((.+)\)$/.exec(value);
  if (m) {
    const parts = m[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const ch = parts.slice(0, 3).map(p => p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p));
    if (ch.some(v => !Number.isFinite(v))) return null;
    const a = parts.length === 4 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    if (!Number.isFinite(a)) return null;
    return [ch[0], ch[1], ch[2], a];
  }

  m = /^hsla?\((.+)\)$/.exec(value);
  if (m) {
    const parts = m[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]), s = parseFloat(parts[1]) / 100, l = parseFloat(parts[2]) / 100;
    if (![h, s, l].every(Number.isFinite)) return null;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const mm = l - c / 2;
    const seg = Math.floor(((h % 360) + 360) % 360 / 60) % 6;
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
    const a = parts.length === 4 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return [(r + mm) * 255, (g + mm) * 255, (b + mm) * 255, Number.isFinite(a) ? a : 1];
  }

  return null;
}

function greyCssColor(value: string): string {
  const rgba = parseCssColor(value);
  if (!rgba) return value;
  const l = Math.round(LUMA[0] * rgba[0] + LUMA[1] * rgba[1] + LUMA[2] * rgba[2]);
  return rgba[3] >= 1 ? `rgb(${l},${l},${l})` : `rgba(${l},${l},${l},${rgba[3]})`;
}

function wrapDesaturate(expr: unknown): unknown[] {
  const ch = ['var', 'channel'] as const;
  const lum = ['+',
    ['*', LUMA[0], ['at', 0, ch]],
    ['*', LUMA[1], ['at', 1, ch]],
    ['*', LUMA[2], ['at', 2, ch]]];
  return ['let', 'channel', ['to-rgba', expr], ['rgba', lum, lum, lum, ['at', 3, ch]]];
}

// Greys literal colour leaves recursively, WITHOUT wrapping runtime sub-
// expressions. A runtime expression like ['get', 'class'] is a match/input or a
// zoom value, not a colour; wrapping it in to-rgba would change its type and
// produce an invalid style expression.
function greyLeaves(value: unknown): unknown {
  if (typeof value === 'string') return greyCssColor(value);
  if (Array.isArray(value)) return value.map(greyLeaves);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = greyLeaves((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function desaturateStyleValue(value: unknown): unknown {
  // Only a top-level runtime-colour expression (['get','color'], ['feature-state',…],
  // ['to-color',…], ['var',…]) is wrapped. Structural expressions such as
  // match/interpolate/step keep their inputs/stops and only have their literal
  // colour outputs greyed.
  if (Array.isArray(value) && typeof value[0] === 'string' && RUNTIME_COLOR_OPS.has(value[0])) {
    return wrapDesaturate(greyLeaves(value));
  }
  return greyLeaves(value);
}

export function desaturateBasemapLayers(map: PaintCarrier): number {
  const layers = map.getStyle()?.layers ?? [];
  let applied = 0;
  for (const layer of layers) {
    if (APP_LAYER_IDS.has(layer.id)) continue;
    const props = COLOR_PAINT_PROPERTIES[layer.type];
    if (!props) continue;
    for (const prop of props) {
      let value: unknown;
      try { value = map.getPaintProperty(layer.id, prop); } catch { continue; }
      if (value == null) continue;
      const next = desaturateStyleValue(value);
      if (next !== value) {
        try {
          map.setPaintProperty(layer.id, prop, next);
          applied++;
        } catch (e) {
          console.warn(`[Vaydu] Could not desaturate ${prop} on layer ${layer.id}`, e);
        }
      }
    }
  }
  return applied;
}

/**
 * Desaturates the resolved basemap as soon as its layers exist. Runs once on
 * the initial style so later app-owned overlays are never touched; a second
 * run on 'load' covers styles whose layers were not yet parsed at styledata.
 */
export function installVayduGreyBasemap(map: EventedMap): void {
  const apply = () => {
    try { desaturateBasemapLayers(map); }
    catch (e) { console.warn('[Vaydu] Basemap desaturation failed', e); }
  };
  try {
    if (typeof map.isStyleLoaded === 'function' && map.isStyleLoaded()) { apply(); return; }
    if (typeof map.once === 'function') {
      map.once('styledata', apply);
      map.once('load', apply);
    }
  } catch (e) {
    console.warn('[Vaydu] Basemap desaturation could not be installed', e);
  }
}
