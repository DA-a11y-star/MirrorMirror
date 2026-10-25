// Settings dropdown (top right): per-axis sensitivity and dead zone sliders that mutate the live GESTURE config.
// Sensitivity is a multiplier on the axis (FULL = base / sensitivity), so higher = less hand travel.

const AXES = [
  { group: 'Move hand', label: 'Left / right', full: 'FULL_LATERAL', dead: 'DEAD_LATERAL', deadMax: 0.6 },
  { group: 'Move hand', label: 'Forward / back', full: 'FULL_DEPTH', dead: 'DEAD_DEPTH', deadMax: 0.2 },
  { group: 'Move hand', label: 'Up / down', full: 'FULL_VERTICAL', dead: 'DEAD_VERTICAL', deadMax: 0.6 },
  { group: 'Look hand', label: 'Turn', full: 'FULL_LOOK_LATERAL', dead: 'DEAD_LOOK_LATERAL', deadMax: 0.6 },
  { group: 'Look hand', label: 'Pitch', full: 'FULL_LOOK_VERTICAL', dead: 'DEAD_LOOK_VERTICAL', deadMax: 0.6 },
];
import { GAZE_LOOK } from './gaze-look.js';
// The controls help: shown at the top of the Settings panel, not on the screen all the time.
const HELP = `
  <p><b>Gestures.</b> MOVE: right palm = move (forward/back, left/right, up/down). Left palm = look (up/down, left/right). One fist recenters that stick. Double-fist then both open switches to EDIT. In EDIT, pinch a block with both hands and spread them to resize it. Hold one fist to talk: “mirror mirror, make a …”.</p>
  <p><b>No camera?</b> Open with <code>?tracker=mouse</code>: the cursor is your gaze and hand, hold the left button to pinch, right-click to mouse-look.</p>
   <p><b>Keys.</b> ↑↓ forward · ←→ turn · A/D strafe · Space/Shift up/down · M mode · V view · C free cam · P depth · R respawn · \` dev · J presentation · L library · F copy looked-at · Del delete looked-at. Click the scene to mouse-look (Esc releases).</p>`;
const KEY = 'gestureSettings2'; // v2: defaults already include the tuned sensitivity, so old saved multipliers must not stack
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
    if (typeof saved.gaze?.enabled === 'boolean') GAZE_LOOK.ENABLED = saved.gaze.enabled;
    if (Number.isFinite(saved.gaze?.speed)) GAZE_LOOK.SPEED = saved.gaze.speed;
    for (const a of AXES) {
      if (Number.isFinite(saved.dead?.[a.dead])) this.cfg[a.dead] = saved.dead[a.dead];
      if (Number.isFinite(saved.sens?.[a.full])) this.sens[a.full] = saved.sens[a.full];
    }
    return {};
  }

  _save() {
    try {
      const dead = Object.fromEntries(AXES.map(a => [a.dead, this.cfg[a.dead]]));
      localStorage.setItem(KEY, JSON.stringify({ dead, sens: this.sens, gaze: { enabled: GAZE_LOOK.ENABLED, speed: GAZE_LOOK.SPEED } }));
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
    root.innerHTML = `<button id="gs-toggle" type="button" aria-expanded="false" aria-pressed="false" aria-controls="gs-panel workspace-debug" title="Show settings and diagnostics"><span aria-hidden="true">⚙</span> Settings <span class="settings-switch" aria-hidden="true"></span></button><div id="gs-panel" hidden><div class="panel-heading"><span class="eyebrow">FINE TUNE YOUR EXPERIENCE</span><h2>Settings</h2></div></div>`;
    const panel = root.querySelector('#gs-panel');
    const help = document.createElement('div');
    help.className = 'gs-help';
    help.innerHTML = HELP;
    panel.appendChild(help);
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
    // Gaze look: whether, and how fast, the view turns toward where the eyes rest near the screen edge.
    const gazeHeader = document.createElement('h4');
    gazeHeader.textContent = 'Eyes turn the view';
    const gazeRow = document.createElement('div');
    gazeRow.className = 'gs-row';
    gazeRow.innerHTML = `<label class="gs-check"><input type="checkbox" data-k="on"> Turn the view toward where I look</label>
      <label>Turn speed <input type="range" min="0.2" max="2" step="0.05" data-k="speed"><output></output></label>`;
    const on = gazeRow.querySelector('[data-k=on]'), speed = gazeRow.querySelector('[data-k=speed]');
    const showGaze = () => {
      on.checked = GAZE_LOOK.ENABLED;
      speed.value = GAZE_LOOK.SPEED;
      speed.disabled = !GAZE_LOOK.ENABLED;
      speed.nextElementSibling.textContent = `${(+speed.value).toFixed(2)}×`;
    };
    on.onchange = () => { GAZE_LOOK.ENABLED = on.checked; this._save(); showGaze(); };
    speed.oninput = () => { GAZE_LOOK.SPEED = +speed.value; this._save(); showGaze(); };
    showGaze();
    panel.append(gazeHeader, gazeRow);
    const reset = document.createElement('button');
    reset.textContent = 'Reset to defaults';
    reset.onclick = () => {
      for (const a of AXES) { this.sens[a.full] = 1; this.cfg[a.dead] = this.defaultDead[a.dead]; }
      GAZE_LOOK.ENABLED = true;
      GAZE_LOOK.SPEED = 1;
      this._apply();
      this._save();
      rows.forEach(r => r.show());
      showGaze();
    };
    panel.appendChild(reset);
    const toggle = root.querySelector('#gs-toggle');
    const debug = document.getElementById('workspace-debug');
    this.setOpen = open => {
      panel.hidden = !open;
      if (debug) debug.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-pressed', String(open));
    };
    toggle.onclick = () => this.setOpen(panel.hidden);
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) {
        this.setOpen(false);
        toggle.focus();
      }
    });
    document.body.appendChild(root);
    const style = document.createElement('style');
    style.textContent = `
      #gesture-settings { position: fixed; top: 10px; right: 12px; z-index: 5; font: 13px/1.4 system-ui, sans-serif; color: #24334a; text-align: right; }
      #gs-panel { margin-top: 6px; width: 320px; max-height: calc(100vh - 60px); overflow-y: auto; text-align: left; background: rgba(255,255,255,.95); border: 1px solid #cdd4df; border-radius: 12px; padding: 8px 14px 12px; }
      #gs-panel h4 { margin: 8px 0 2px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #617087; }
      .gs-help p { margin: 6px 0; font-size: 12px; color: #617087; }
      .gs-help code { font-size: 11px; }
      .gs-row { padding: 4px 0; border-bottom: 1px solid #e6eaf0; }
      .gs-name { font-weight: 600; }
      .gs-row label { display: grid; grid-template-columns: 78px 1fr 40px; align-items: center; gap: 6px; font-size: 12px; }
      .gs-check { grid-template-columns: auto 1fr !important; margin-bottom: 4px; }
      .gs-row output { text-align: right; font-variant-numeric: tabular-nums; }
      #gs-panel > button { margin-top: 10px; width: 100%; }
    `;
    document.head.appendChild(style);
  }
}
