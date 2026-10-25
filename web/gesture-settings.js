// Settings dropdown (top right): per-axis sensitivity and dead zone sliders that mutate the live GESTURE config.
// Sensitivity is a multiplier on the axis (FULL = base / sensitivity), so higher = less hand travel.

const AXES = [
  { group: 'Move hand', label: 'Left / right', full: 'FULL_LATERAL', dead: 'DEAD_LATERAL', deadMax: 0.6 },
  { group: 'Move hand', label: 'Forward / back', full: 'FULL_DEPTH', dead: 'DEAD_DEPTH', deadMax: 0.2 },
  { group: 'Move hand', label: 'Up / down', full: 'FULL_VERTICAL', dead: 'DEAD_VERTICAL', deadMax: 0.6 },
  { group: 'Look hand', label: 'Turn', full: 'FULL_LOOK_LATERAL', dead: 'DEAD_LOOK_LATERAL', deadMax: 0.6 },
  { group: 'Look hand', label: 'Pitch', full: 'FULL_LOOK_VERTICAL', dead: 'DEAD_LOOK_VERTICAL', deadMax: 0.6 },
];
const KEY = 'gestureSettings';
const MIN_SPAN = 0.05; // FULL stays at least this far above DEAD so the axis can still reach full speed

export class GestureSettings {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = Object.fromEntries(AXES.map(a => [a.full, cfg[a.full]]));
    this.defaultDead = Object.fromEntries(AXES.map(a => [a.dead, cfg[a.dead]]));
    this.sens = Object.fromEntries(AXES.map(a => [a.full, 1]));
    try { Object.assign(this, this._load()); } catch { /* storage may be blocked */ }
    this._apply();
    this._build();
  }

  _load() {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!saved) return {};
    for (const a of AXES) {
      if (Number.isFinite(saved.dead?.[a.dead])) this.cfg[a.dead] = saved.dead[a.dead];
      if (Number.isFinite(saved.sens?.[a.full])) this.sens[a.full] = saved.sens[a.full];
    }
    return {};
  }

  _save() {
    try {
      const dead = Object.fromEntries(AXES.map(a => [a.dead, this.cfg[a.dead]]));
      localStorage.setItem(KEY, JSON.stringify({ dead, sens: this.sens }));
    } catch { /* ignore */ }
  }

  _apply() {
    for (const a of AXES) {
      this.cfg[a.full] = Math.max(this.base[a.full] / this.sens[a.full], this.cfg[a.dead] + MIN_SPAN);
    }
  }

  _row(a) {
    const row = document.createElement('div');
    row.className = 'gs-row';
    row.innerHTML = `<span class="gs-name">${a.label}</span>
      <label>Sensitivity <input type="range" min="0.1" max="2.5" step="0.05" data-k="sens"><output></output></label>
      <label>Dead zone <input type="range" min="0" max="${a.deadMax}" step="0.01" data-k="dead"><output></output></label>`;
    const sens = row.querySelector('[data-k=sens]');
    const dead = row.querySelector('[data-k=dead]');
    const show = () => {
      sens.value = this.sens[a.full];
      dead.value = this.cfg[a.dead];
      sens.nextElementSibling.textContent = `${(+sens.value).toFixed(2)}×`;
      dead.nextElementSibling.textContent = (+dead.value).toFixed(2);
    };
    sens.oninput = () => { this.sens[a.full] = +sens.value; this._apply(); this._save(); show(); };
    dead.oninput = () => { this.cfg[a.dead] = +dead.value; this._apply(); this._save(); show(); };
    row.show = show;
    show();
    return row;
  }

  _build() {
    const root = document.createElement('div');
    root.id = 'gesture-settings';
    root.innerHTML = `<button id="gs-toggle" aria-expanded="false" title="Gesture settings">⚙ Settings ▾</button><div id="gs-panel" hidden></div>`;
    const panel = root.querySelector('#gs-panel');
    const rows = [];
    let group = null;
    for (const a of AXES) {
      if (a.group !== group) {
        group = a.group;
        const h = document.createElement('h4');
        h.textContent = group;
        panel.appendChild(h);
      }
      const row = this._row(a);
      rows.push(row);
      panel.appendChild(row);
    }
    const reset = document.createElement('button');
    reset.textContent = 'Reset to defaults';
    reset.onclick = () => {
      for (const a of AXES) { this.sens[a.full] = 1; this.cfg[a.dead] = this.defaultDead[a.dead]; }
      this._apply();
      this._save();
      rows.forEach(r => r.show());
    };
    panel.appendChild(reset);
    const toggle = root.querySelector('#gs-toggle');
    toggle.onclick = () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      toggle.textContent = panel.hidden ? '⚙ Settings ▾' : '⚙ Settings ▴';
    };
    document.body.appendChild(root);
    const style = document.createElement('style');
    style.textContent = `
      #gesture-settings { position: fixed; top: 10px; right: 12px; z-index: 5; font: 13px/1.4 system-ui, sans-serif; color: #24334a; text-align: right; }
      #gs-panel { margin-top: 6px; width: 280px; text-align: left; background: rgba(255,255,255,.95); border: 1px solid #cdd4df; border-radius: 12px; padding: 8px 14px 12px; }
      #gs-panel h4 { margin: 8px 0 2px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #617087; }
      .gs-row { padding: 4px 0; border-bottom: 1px solid #e6eaf0; }
      .gs-name { font-weight: 600; }
      .gs-row label { display: grid; grid-template-columns: 78px 1fr 40px; align-items: center; gap: 6px; font-size: 12px; }
      .gs-row output { text-align: right; font-variant-numeric: tabular-nums; }
      #gs-panel > button { margin-top: 10px; width: 100%; }
    `;
    document.head.appendChild(style);
  }
}
