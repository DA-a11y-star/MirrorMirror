// OpenCV DICT_4X4_50 IDs 10..13, including their one-cell black border.
// Vendored bits: no network, image loading or browser camera permission needed.
export const MARKER_BITS = [
  ['000000', '011110', '010010', '010010', '000010', '000000'],
  ['000000', '000010', '000010', '010100', '001110', '000000'],
  ['000000', '000000', '011100', '010110', '001110', '000000'],
  ['000000', '000100', '010100', '000000', '011110', '000000'],
];

export function markerLayout(width, height) {
  if (!(width >= 160 && height >= 160 && Number.isFinite(width) && Number.isFinite(height))) return null;
  // Integer module sizes keep the rendered pattern crisp, including at different DPRs.
  const cell = Math.max(4, Math.floor(Math.min(width, height) * .15 / 6));
  const size = cell * 6, edge = 8, extent = size + 2 * cell + edge;
  const positions = [[edge + cell, edge + cell], [width - edge - cell - size, edge + cell],
    [width - edge - cell - size, height - edge - cell - size], [edge + cell, height - edge - cell - size]];
  return { version: 1, width, height, cell, size, edge, extent,
    markers: positions.map(([x, y], i) => ({ id: 10 + i,
      corners: [[x / width, y / height], [(x + size) / width, y / height],
        [(x + size) / width, (y + size) / height], [x / width, (y + size) / height]] })) };
}

export function markerSVG(index) {
  const rows = MARKER_BITS[index];
  const pixels = rows.flatMap((row, y) => [...row].flatMap((bit, x) => bit === '0'
    ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : []));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 6" shape-rendering="crispEdges" aria-hidden="true"><rect width="6" height="6" fill="white"/><g fill="black">${pixels.join('')}</g></svg>`;
}

export class ScreenMarkers {
  constructor(onChange) {
    this.onChange = onChange;
    this.enabled = false;
    this.layout = null;
    // randomUUID is unavailable on plain-HTTP LAN pages (the second laptop).
    // This is a revision identifier, not a security token.
    this.session = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.revision = 0;
    this.layer = document.createElement('div');
    this.layer.id = 'screen-markers';
    this.layer.setAttribute('aria-hidden', 'true');
    this.layer.hidden = true;
    document.body.append(this.layer);
    window.addEventListener('resize', () => this.refresh());
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.layer.hidden = !enabled;
    document.body.classList.toggle('glasses-markers', enabled);
    this.refresh();
  }

  refresh() {
    const geometry = this.enabled ? markerLayout(window.innerWidth, window.innerHeight) : null;
    this.layout = geometry ? { ...geometry, id: `${this.session}:${++this.revision}` } : null;
    this.layer.replaceChildren();
    if (geometry) {
      document.documentElement.style.setProperty('--marker-extent', `${geometry.extent}px`);
      geometry.markers.forEach((marker, index) => {
        const panel = document.createElement('div');
        panel.className = 'screen-marker';
        panel.style.cssText = `left:${marker.corners[0][0] * geometry.width - geometry.cell}px;top:${marker.corners[0][1] * geometry.height - geometry.cell}px;padding:${geometry.cell}px;width:${geometry.size}px;height:${geometry.size}px`;
        panel.innerHTML = markerSVG(index);
        this.layer.append(panel);
      });
    }
    this.onChange(this.layout);
  }
}
