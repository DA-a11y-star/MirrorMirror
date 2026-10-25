import * as THREE from 'three';

// Dev overlay (backtick): a corner readout plus scene helpers. Local only, independent of free cam.
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const vec = v => `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`;
const deg = r => `${f((r * 180) / Math.PI, 0)}°`;

export class Dev {
  constructor(scene, blocks) {
    this.enabled = false;
    this.blocks = blocks;

    this.panel = document.createElement('pre');
    this.panel.id = 'dev';
    Object.assign(this.panel.style, {
      position: 'fixed', top: '10px', right: '12px', margin: '0', padding: '8px 10px', maxWidth: '46ch',
      font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e8edf5',
      background: 'rgba(26,33,46,0.82)', borderRadius: '8px', pointerEvents: 'none', whiteSpace: 'pre', zIndex: 3,
    });
    this.panel.hidden = true;
    document.body.appendChild(this.panel);

    this.helpers = new THREE.Group();
    this.helpers.name = 'dev-helpers';
    this.helpers.visible = false;
    this.helpers.add(new THREE.AxesHelper(1));
    this.springMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2d95, depthTest: false }),
    );
    this.springMarker.renderOrder = 10;
    this.aimMarker = this.springMarker.clone();
    this.aimMarker.material = new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false });
    this.gazeLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xe0245e, depthTest: false }),
    );
    this.gazeLine.frustumCulled = false;
    this.gazeLine.renderOrder = 10;
    this.helpers.add(this.springMarker, this.aimMarker, this.gazeLine);
    scene.add(this.helpers);

    this.labels = new Map();
    for (const block of blocks.children) {
      const el = document.createElement('div');
      el.textContent = block.userData.id;
      Object.assign(el.style, {
        position: 'fixed', transform: 'translate(-50%, -100%)', font: '11px ui-monospace, Menlo, monospace',
        color: '#24334a', background: 'rgba(255,255,255,0.8)', padding: '0 4px', borderRadius: '4px',
        pointerEvents: 'none', display: 'none',
      });
      document.body.appendChild(el);
      this.labels.set(block, el);
    }

    this._ray = new THREE.Raycaster();
    this._v = new THREE.Vector3();
    this._o = new THREE.Vector3();
  }

  toggle() {
    this.enabled = !this.enabled;
    this.panel.hidden = !this.enabled;
    this.helpers.visible = this.enabled;
    if (!this.enabled) for (const el of this.labels.values()) el.style.display = 'none';
  }

  // info: { fps, frameMs, rig, locomotion, intents, camera, view, tracker, gaze, gazeTargetId, gazeTargetObject, now }
  update(info) {
    if (!this.enabled) return;
    const { rig, locomotion: loco, intents, camera, tracker, now } = info;
    const age = tracker.at ? Math.round(now - tracker.at) : null;
    const tint = [intents.move.forward, intents.move.strafe, intents.move.vertical, intents.turn].map(v => f(v, 0)).join(' ');
    const toggled = Object.entries(intents.toggles).filter(([, on]) => on).map(([name]) => name).join(',') || '-';
    this.panel.textContent = [
      `fps ${info.fps}   frame ${f(info.frameMs, 1)} ms`,
      `mode  ${info.gestures?.mode ?? '-'} · ${rig.mode}`,
      `avatar  ${vec(loco.pos)}  yaw ${deg(loco.yaw)}  pitch ${deg(loco.pitch)}`,
      `camera  ${vec(camera.position)}`,
      `intents  move(f s v) ${tint}  turn ${f(intents.turn, 0)}`,
      `         look ${f(intents.look.dYaw, 3)}, ${f(intents.look.dPitch, 3)}  zoom ${f(intents.zoom, 1)}  toggles ${toggled}`,
      `tracker  ${tracker.status}${age === null ? '' : `, last frame ${age} ms ago`}`,
      `relay  ${info.net ? `${info.net.status} peers ${info.net.open ? 1 : 0}` : '—'}`,
      `gaze target  ${info.gazeTargetId ?? '-'}`,
      ...(info.gestures ? [
        `toggle  ${info.gestures.toggle.state}${info.gestures.joy.engaged ? '  joystick ON' : ''}`,
        `hands   ${info.gestures.debug().hands}`,
        `center  ${info.gestures.debug().center}`,
        `raw     Δ ${f(info.gestures.joy.raw.lateral, 2)} ${f(info.gestures.joy.raw.vertical, 2)} ${f(info.gestures.joy.raw.depth, 2)}`,
        `curve   ${f(info.gestures.joy.curved.lateral, 2)} ${f(info.gestures.joy.curved.vertical, 2)} ${f(info.gestures.joy.curved.depth, 2)}`,
      ] : []),
    ].join('\n');

    this.springMarker.position.copy(rig.tpWant);
    this.aimMarker.position.copy(rig.tpAim);
    this._updateGazeRay(info);
    this._updateLabels(info.view);
  }

  _updateGazeRay({ gaze, view, gazeTargetObject }) {
    const line = this.gazeLine;
    line.visible = !!gaze && Number.isFinite(gaze.x) && Number.isFinite(gaze.y);
    if (!line.visible) return;
    this._ray.setFromCamera({ x: gaze.x * 2 - 1, y: -(gaze.y * 2 - 1) }, view);
    const { origin, direction } = this._ray.ray;
    const reach = gazeTargetObject ? Math.max(0.5, origin.distanceTo(gazeTargetObject.position)) : 8;
    // Start a little below and ahead of the eye, otherwise the line is edge-on and invisible.
    const start = view.localToWorld(this._o.set(0, -0.12, -0.5));
    const end = this._v.copy(origin).addScaledVector(direction, reach);
    line.geometry.setFromPoints([start, end]);
  }

  _updateLabels(view) {
    for (const [block, el] of this.labels) {
      this._v.copy(block.position).project(view);
      const onScreen = this._v.z < 1 && Math.abs(this._v.x) < 1.1 && Math.abs(this._v.y) < 1.1;
      el.style.display = onScreen ? 'block' : 'none';
      if (onScreen) {
        el.style.left = `${(this._v.x * 0.5 + 0.5) * window.innerWidth}px`;
        el.style.top = `${(-this._v.y * 0.5 + 0.5) * window.innerHeight}px`;
      }
    }
  }
}
