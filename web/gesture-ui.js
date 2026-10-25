import { GestureSettings } from './gesture-settings.js';

// Mode badge, two small joystick widgets, armed cue and the flash/beep on a successful toggle.

const ACCENT = { MOVE: '#4c6ef5', EDIT: '#e76f51' };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function stickHTML(id, label) {
  return `<div class="stick" id="${id}" data-label="${label}">
    <div class="joy-ring"></div><div class="joy-dead"></div><div class="joy-dot"></div>
  </div>`;
}

export class GestureUI {
  constructor(gestures) {
    this.gestures = gestures;
    this.root = document.createElement('div');
    this.root.id = 'gesture-hud';
    this.root.innerHTML = `
      <div id="mode-badge"><span id="mode-label">MOVE</span></div>
      <div id="toggle-cue" hidden>open to switch</div>
      <div id="joysticks" aria-hidden="true">${stickHTML('stick-look', 'look')}${stickHTML('stick-move', 'move')}</div>
      <div id="mode-flash" hidden></div>
    `;
    document.body.appendChild(this.root);
    this._injectStyle();
    this.settings = new GestureSettings(gestures.cfg);
    this.lastMode = gestures.mode;
    // Looked up once: this runs every frame, and only writes when a value actually changes (writes dirty layout).
    const q = sel => this.root.querySelector(sel);
    this.els = { badge: q('#mode-badge'), label: q('#mode-label'), cue: q('#toggle-cue'), flash: q('#mode-flash'), sticks: {} };
    this.shown = { mode: null, engaged: null, armed: null };
  }

  update() {
    const g = this.gestures;
    const { badge, label, cue } = this.els;
    if (g.mode !== this.shown.mode) {
      this.shown.mode = g.mode;
      document.documentElement.style.setProperty('--mode-accent', ACCENT[g.mode] ?? ACCENT.MOVE);
      label.textContent = g.mode;
      badge.dataset.mode = g.mode;
    }
    if (g.joy.engaged !== this.shown.engaged) badge.classList.toggle('engaged', this.shown.engaged = g.joy.engaged);
    const armed = g.toggle.state === 'ARMED';
    if (armed !== this.shown.armed) cue.hidden = !(this.shown.armed = armed);

    // Left widget: look (x = yaw, y = pitch). Right widget: move (x = strafe, y = forward, dot size = up/down).
    this._paint('stick-look', g.look.engaged, g.look.curved.lateral, g.look.curved.vertical);
    this._paint('stick-move', g.move.engaged, g.move.curved.lateral, g.move.curved.depth, g.move.curved.vertical);

    if (g.mode !== this.lastMode) {
      this._flash(g.mode);
      this._beep();
    }
    this.lastMode = g.mode;
  }

  _paint(id, on, x, y, z = 0) {
    const stick = this.els.sticks[id] ??= { el: this.root.querySelector(`#${id}`), on: null, transform: '' };
    stick.dot ??= stick.el.querySelector('.joy-dot');
    if (!!on !== stick.on) {
      stick.on = !!on;
      stick.el.classList.toggle('on', stick.on);
      stick.el.classList.toggle('off', !stick.on);
    }
    const dx = clamp(x || 0, -1, 1);
    const dy = clamp(y || 0, -1, 1);
    // Quantised to 0.1 px / 0.01 scale so a still hand writes nothing. Dot size = height (bigger = up).
    const transform = `translate(${(dx * 18).toFixed(1)}px, ${(-dy * 18).toFixed(1)}px) scale(${(1 + clamp(z, -1, 1) * 0.6).toFixed(2)})`;
    if (transform !== stick.transform) stick.dot.style.transform = stick.transform = transform;
  }

  _flash(mode) {
    const el = this.els.flash;
    el.textContent = mode;
    el.hidden = false;
    el.dataset.mode = mode;
    el.classList.remove('play');
    void el.offsetWidth;
    el.classList.add('play');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { el.hidden = true; el.classList.remove('play'); }, 700);
  }

  _beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = this.gestures.mode === 'EDIT' ? 523 : 659;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.07, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
      osc.start();
      osc.stop(ctx.currentTime + 0.16);
      osc.onended = () => ctx.close();
    } catch { /* click first if the browser blocks audio */ }
  }

  _injectStyle() {
    if (document.getElementById('gesture-hud-style')) return;
    const style = document.createElement('style');
    style.id = 'gesture-hud-style';
    style.textContent = `
      :root { --mode-accent: ${ACCENT.MOVE}; }
      #hud { box-shadow: inset 3px 0 0 var(--mode-accent); }
      #mode-badge {
        position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
        font: 700 13px/1 system-ui, sans-serif; letter-spacing: .08em;
        color: white; background: var(--mode-accent); padding: 6px 14px; border-radius: 999px;
        pointer-events: none; z-index: 4;
      }
      #mode-badge.engaged { box-shadow: 0 0 0 3px rgba(255,255,255,.7), 0 0 16px var(--mode-accent); }
      #toggle-cue {
        position: fixed; top: 44px; left: 50%; transform: translateX(-50%);
        font: 13px system-ui, sans-serif; color: #24334a; background: rgba(255,255,255,.92);
        padding: 4px 10px; border-radius: 8px; pointer-events: none; z-index: 4;
        animation: pulse 0.7s ease-in-out infinite;
      }
      @keyframes pulse { 50% { opacity: .45; } }
      #joysticks {
        position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 28px; pointer-events: none; z-index: 4;
      }
      .stick { position: relative; width: 56px; height: 56px; }
      .stick.off { opacity: .4; filter: grayscale(1); }
      .stick::after {
        content: attr(data-label); position: absolute; left: 50%; bottom: -14px;
        transform: translateX(-50%); font: 10px/1 system-ui, sans-serif; color: #617087; letter-spacing: .06em;
      }
      .joy-ring, .joy-dead, .joy-dot {
        position: absolute; left: 50%; top: 50%; border-radius: 50%; transform: translate(-50%, -50%);
      }
      .joy-ring { width: 52px; height: 52px; border: 2px solid var(--mode-accent); }
      .joy-dead { width: 14px; height: 14px; border: 1px dashed #8a93a3; }
      .joy-dot {
        width: 10px; height: 10px; margin: -5px 0 0 -5px; left: 50%; top: 50%;
        background: var(--mode-accent); box-shadow: 0 0 0 2px white;
      }
      #mode-flash {
        position: fixed; inset: 0; z-index: 6; display: grid; place-items: center;
        font: 800 64px/1 system-ui, sans-serif; letter-spacing: .12em; pointer-events: none;
        color: white; text-shadow: 0 4px 24px rgba(0,0,0,.25);
      }
      #mode-flash[data-mode="MOVE"] { background: rgba(76,110,245,.35); }
      #mode-flash[data-mode="EDIT"] { background: rgba(231,111,81,.35); }
      #mode-flash.play { animation: flash .65s ease-out; }
      @keyframes flash { from { opacity: 1; } to { opacity: 0; } }
    `;
    document.head.appendChild(style);
  }
}
