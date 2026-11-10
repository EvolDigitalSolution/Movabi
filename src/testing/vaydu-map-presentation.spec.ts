import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { desaturateStyleValue, desaturateBasemapLayers, installVayduGreyBasemap } from '../app/core/services/maps/map-presentation';
import { MarkerFactoryService } from '../app/core/services/maps/marker-factory.service';

describe('grey basemap desaturation', () => {
  it('greys literal css colors and preserves alpha', () => {
    expect(desaturateStyleValue('#2563eb')).toBe('rgb(96,96,96)');
    expect(desaturateStyleValue('#ffffff')).toBe('rgb(255,255,255)');
    expect(desaturateStyleValue('#000')).toBe('rgb(0,0,0)');
    expect(desaturateStyleValue('rgba(255,0,0,0.5)')).toBe('rgba(54,54,54,0.5)');
    expect(desaturateStyleValue('hsl(0,100%,50%)')).toBe('rgb(54,54,54)');
    expect(desaturateStyleValue('white')).toBe('rgb(255,255,255)');
    expect(desaturateStyleValue('transparent')).toBe('rgba(0,0,0,0)');
  });

  it('leaves non-color strings untouched', () => {
    expect(desaturateStyleValue('water')).toBe('water');
    expect(desaturateStyleValue('acct_123')).toBe('acct_123');
    expect(desaturateStyleValue('not-a-color')).toBe('not-a-color');
  });

  it('is idempotent on already grey values', () => {
    const once = desaturateStyleValue('#2563eb');
    expect(desaturateStyleValue(once)).toBe(once);
  });

  it('greys literal colors inside expressions without wrapping', () => {
    const out = desaturateStyleValue(['interpolate', ['linear'], ['zoom'], 5, '#ff0000', 15, '#0000ff']) as any[];
    expect(out[0]).toBe('interpolate');
    expect(out).toContain('rgb(54,54,54)');
    expect(out).toContain('rgb(18,18,18)');
    expect(JSON.stringify(out)).not.toContain('to-rgba');
  });

  it('greys match colour outputs without wrapping the match structure', () => {
    const out = desaturateStyleValue(['match', ['get', 'class'], 'park', '#00ff00', '#ffffff']) as any[];
    expect(out[0]).toBe('match');
    expect(out[1]).toEqual(['get', 'class']);        // input untouched
    expect(out).toContain('rgb(182,182,182)');       // #00ff00 leaf statically greyed
    expect(out).toContain('rgb(255,255,255)');       // #ffffff leaf greyed
    expect(JSON.stringify(out)).not.toContain('to-rgba');
    expect(JSON.stringify(out)).not.toContain('"let"');
  });

  it('wraps a top-level runtime colour expression in a luminance desaturation', () => {
    const out = desaturateStyleValue(['get', 'color']) as any[];
    expect(out[0]).toBe('let');
    expect(JSON.stringify(out)).toContain('to-rgba');
  });

  it('greys legacy stops objects', () => {
    const out = desaturateStyleValue({ stops: [[6, '#ff0000'], [14, '#0000ff']] }) as any;
    expect(out.stops[0][1]).toBe('rgb(54,54,54)');
    expect(out.stops[1][1]).toBe('rgb(18,18,18)');
  });

  it('preserves the Industrial layer zoom interpolate/step structure and greys outputs', () => {
    const fillColor = [
      'interpolate', ['linear'], ['zoom'],
      9, ['match', ['get', 'class'], ['industrial'], 'hsl(40,67%,90%)', 'quarry', 'hsla(32, 47%, 87%, 0.2)', 'hsl(60, 31%, 87%)'],
      16, ['match', ['get', 'class'], ['industrial'], 'hsl(49,54%,90%)', 'quarry', 'hsla(32, 47%, 87%, 0.5)', 'hsl(60, 31%, 87%)']
    ] as any[];
    const out = desaturateStyleValue(fillColor) as any[];
    expect(out[0]).toBe('interpolate');
    expect(out[1]).toEqual(['linear']);
    expect(out[2]).toEqual(['zoom']);              // zoom input preserved
    expect(out[3]).toBe(9);
    expect(out[5]).toBe(16);                       // stop positions preserved
    expect(out[4][0]).toBe('match');
    expect(out[4][1]).toEqual(['get', 'class']);   // match input preserved
    expect(JSON.stringify(out)).not.toContain('hsl');
    expect(JSON.stringify(out)).not.toContain('hsla');
    expect(JSON.stringify(out)).not.toContain('"let"');
    expect(JSON.stringify(out)).not.toContain('to-rgba');

    const fillOpacity = ['step', ['zoom'], 1, 9, ['match', ['get', 'class'], 'quarry', 0, 1], 10, 1] as any[];
    const op = desaturateStyleValue(fillOpacity) as any[];
    expect(op[0]).toBe('step');
    expect(op[1]).toEqual(['zoom']);
    expect(JSON.stringify(op)).not.toContain('to-rgba');
  });

  it('validates the desaturated Industrial expressions with the MapLibre style validator', () => {
    const fillColor = [
      'interpolate', ['linear'], ['zoom'],
      9, ['match', ['get', 'class'], ['industrial'], 'hsl(40,67%,90%)', 'quarry', 'hsla(32, 47%, 87%, 0.2)', 'hsl(60, 31%, 87%)'],
      16, ['match', ['get', 'class'], ['industrial'], 'hsl(49,54%,90%)', 'quarry', 'hsla(32, 47%, 87%, 0.5)', 'hsl(60, 31%, 87%)']
    ];
    const color = createExpression(desaturateStyleValue(fillColor), { type: 'color' } as any) as any;
    expect(color.result, JSON.stringify(color.value)).toBe('success');

    const fillOpacity = ['step', ['zoom'], 1, 9, ['match', ['get', 'class'], 'quarry', 0, 1], 10, 1];
    const opacity = createExpression(desaturateStyleValue(fillOpacity), { type: 'number' } as any) as any;
    expect(opacity.result, JSON.stringify(opacity.value)).toBe('success');

    // The wrapped runtime-colour form must also validate.
    const runtime = createExpression(desaturateStyleValue(['get', 'color']), { type: 'color' } as any) as any;
    expect(runtime.result, JSON.stringify(runtime.value)).toBe('success');
  });
});

describe('desaturateBasemapLayers', () => {
  const makeMap = (layers: any[]) => {
    const calls: any[] = [];
    const paint: Record<string, any> = {};
    for (const l of layers) Object.assign(paint, Object.fromEntries(Object.entries(l.paint || {}).map(([k, v]) => [`${l.id}|${k}`, v])));
    return {
      calls,
      getStyle: () => ({ layers }),
      getPaintProperty: (id: string, name: string) => paint[`${id}|${name}`],
      setPaintProperty: (id: string, name: string, v: unknown) => { calls.push([id, name, v]); }
    };
  };

  it('rewrites basemap color props and skips app-owned layers', () => {
    const map = makeMap([
      { id: 'background', type: 'background', paint: { 'background-color': '#2563eb' } },
      { id: 'road', type: 'line', paint: { 'line-color': '#f97316', 'line-width': 4 } },
      { id: 'label', type: 'symbol', paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff' } },
      { id: 'movabi-route-layer', type: 'line', paint: { 'line-color': '#2563eb' } }
    ]);
    const applied = desaturateBasemapLayers(map);
    expect(applied).toBe(4);
    expect(map.calls).toContainEqual(['background', 'background-color', 'rgb(96,96,96)']);
    expect(map.calls).toContainEqual(['road', 'line-color', 'rgb(137,137,137)']);
    expect(map.calls).toContainEqual(['label', 'text-color', 'rgb(23,23,23)']);
    expect(map.calls).toContainEqual(['label', 'text-halo-color', 'rgb(255,255,255)']);
    expect(map.calls.find(c => c[0] === 'movabi-route-layer')).toBeUndefined();
  });

  it('returns zero on an empty or unloaded style', () => {
    expect(desaturateBasemapLayers(makeMap([]))).toBe(0);
    expect(desaturateBasemapLayers({ getStyle: () => undefined, getPaintProperty: () => undefined, setPaintProperty: () => {} })).toBe(0);
  });
});

describe('installVayduGreyBasemap', () => {
  it('applies on first styledata when style is still loading', () => {
    const applied: any[] = [];
    const handlers: Record<string, () => void> = {};
    const map = {
      isStyleLoaded: () => false,
      once: (e: string, cb: () => void) => { handlers[e] = cb; },
      getStyle: () => ({ layers: [{ id: 'bg', type: 'background' }] }),
      getPaintProperty: () => '#ff0000',
      setPaintProperty: (_l: string, _p: string, v: unknown) => { applied.push(v); }
    };
    installVayduGreyBasemap(map as any);
    expect(handlers['styledata']).toBeTypeOf('function');
    expect(handlers['load']).toBeTypeOf('function');
    handlers['styledata']();
    expect(applied).toEqual(['rgb(54,54,54)']);
  });

  it('applies immediately when the style is already loaded', () => {
    const applied: any[] = [];
    const map = {
      isStyleLoaded: () => true,
      once: () => { throw new Error('should not register'); },
      getStyle: () => ({ layers: [{ id: 'bg', type: 'background' }] }),
      getPaintProperty: () => '#ff0000',
      setPaintProperty: (_l: string, _p: string, v: unknown) => { applied.push(v); }
    };
    installVayduGreyBasemap(map as any);
    expect(applied).toEqual(['rgb(54,54,54)']);
  });
});

class FakeElement {
  className = '';
  innerHTML = '';
  attrs: Record<string, string> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
}

describe('marker factory behavior', () => {
  const factory = new MarkerFactoryService();
  beforeAll(() => { (globalThis as any).document = { createElement: () => new FakeElement() }; });
  afterAll(() => { delete (globalThis as any).document; });
  const make = (kind: any, service: any, label?: string) => factory.createMarkerElement(kind, service, label) as unknown as FakeElement;

  it('pickup gets a labelled teardrop-class marker with pulse and a11y label', () => {
    const el = make('pickup', 'ride');
    expect(el.className).toContain('movabi-marker--pickup');
    expect(el.className).toContain('movabi-marker--ride');
    expect(el.className).not.toContain('movabi-marker--destination');
    expect(el.innerHTML).toContain('Pickup');
    expect(el.innerHTML).toContain('movabi-marker__pulse');
    expect(el.attrs['role']).toBe('img');
    expect(el.attrs['aria-label']).toBe('Pickup');
  });

  it('destination is distinguishable without relying on colour', () => {
    const el = make('destination', 'ride');
    expect(el.className).toContain('movabi-marker--destination');
    expect(el.className).not.toContain('movabi-marker--pickup');
    expect(el.innerHTML).toContain('Drop-off');
    expect(el.innerHTML).not.toContain('movabi-marker__pulse');
    expect(el.attrs['aria-label']).toBe('Drop-off');
  });

  it('explicit caller labels override the kind default', () => {
    const el = make('pickup', 'ride', '£12.40');
    expect(el.innerHTML).toContain('£12.40');
    expect(el.innerHTML).not.toContain('>Pickup<');
    expect(el.attrs['aria-label']).toBe('£12.40');
  });

  it('driver marker keeps its own affordance', () => {
    const el = make('driver', 'ride');
    expect(el.className).toContain('movabi-marker--driver');
    expect(el.innerHTML).toContain('movabi-marker__pulse');
    expect(el.attrs['aria-label']).toBe('Driver');
  });
});
