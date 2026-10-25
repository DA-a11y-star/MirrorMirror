import * as THREE from 'three';
import { createAssembly, disposeAssembly } from './objects.js';
import { specOfObject } from './library.js';

// The object library panel (L) and the edits that act on whatever you are looking at: duplicate (F), delete
// (Delete/Backspace) and clear the scene. Adding goes through Objects.add, so the other laptop sees every change.
const THUMB = { width: 160, height: 120 };
const THUMBS_PER_FRAME = 3;

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, title, onClick, className = '') {
  const b = el('button', className, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// Small stills of each entry, rendered once with a dedicated offscreen renderer and cached by entry id.
class Thumbnails {
  constructor() {
    this.cache = new Map();
    this.queue = [];
    this.raf = 0;
  }

  setup() {
    if (this.renderer) return;
    const canvas = Object.assign(document.createElement('canvas'), THUMB);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(THUMB.width, THUMB.height, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b3a8, 1.6));
    const sun = new THREE.DirectionalLight(0xfff4e5, 2.2);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(32, THUMB.width / THUMB.height, .01, 50);
  }

  render(entry) {
    this.setup();
    const root = createAssembly(entry.spec);
    this.scene.add(root);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, .05);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    this.camera.position.copy(center).add(new THREE.Vector3(.75, .55, 1).normalize().multiplyScalar(distance));
    this.camera.lookAt(center);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    disposeAssembly(root);
    return url;
  }

  // Calls back with each image as it is ready, a few per frame, so opening the panel never stalls the scene.
  request(entry, done) {
    if (this.cache.has(entry.id)) return done(this.cache.get(entry.id));
    this.queue.push([entry, done]);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.drain());
  }

  drain() {
    this.raf = 0;
    for (let i = 0; i < THUMBS_PER_FRAME && this.queue.length; i++) {
      const [entry, done] = this.queue.shift();
      try {
        if (!this.cache.has(entry.id)) this.cache.set(entry.id, this.render(entry));
        done(this.cache.get(entry.id));
      } catch { /* an image is a nicety; the entry still works without one */ }
    }
    if (this.queue.length) this.raf = requestAnimationFrame(() => this.drain());
  }
}

export class LibraryUI {
  constructor(library, objects, interaction, { onChange } = {}) {
    this.library = library;
    this.objects = objects;
    this.interaction = interaction;
    this.onChange = onChange;
    this.thumbs = new Thumbnails();
    this.clearArmedUntil = 0;
    this.build();
    this.render();
  }

  build() {
    this.toggleButton = button('Library', 'Open the object library (L)', () => this.toggle());
    this.toggleButton.id = 'library-toggle';
    this.panel = el('section');
    this.panel.id = 'library';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'Object library');

    const head = el('div', 'library-head');
    head.append(el('strong', '', 'Library'), button('×', 'Close (L)', () => this.toggle(false), 'library-close'));
    this.search = el('input');
    this.search.type = 'search';
    this.search.placeholder = 'Search';
    this.search.setAttribute('aria-label', 'Search the library');
    this.search.addEventListener('input', () => this.render());
    this.grid = el('div', 'library-grid');

    const target = el('div', 'library-row');
    this.targetLabel = el('span', 'library-target', 'In EDIT mode (M), look at an object to copy or delete it');
    target.append(this.targetLabel,
      button('Duplicate', 'Copy the object you are looking at (F)', () => this.duplicateTarget()),
      button('Delete', 'Delete the object you are looking at (Delete)', () => this.deleteTarget()));

    const files = el('div', 'library-row');
    this.clearButton = button('Clear scene', 'Delete every created object (starter blocks stay)', () => this.clearScene());
    this.fileInput = el('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => this.importFile());
    files.append(button('Export', 'Download your saved objects as JSON', () => this.exportFile()),
      button('Import', 'Add objects from a library JSON file', () => this.fileInput.click()), this.clearButton, this.fileInput);

    this.status = el('div', 'library-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.panel.append(head, this.search, this.grid, target, files, this.status);
    const root = document.getElementById('workspace-ui') ?? document.body;
    root.append(this.toggleButton, this.panel);
  }

  toggle(open = this.panel.hidden) {
    this.panel.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
    if (open) this.render();
  }

  say(text) {
    this.status.textContent = text;
  }

  render() {
    const query = this.search.value.trim().toLowerCase();
    const entries = this.library.entries().filter(e => !query || e.name.toLowerCase().includes(query));
    this.grid.replaceChildren(...entries.map(entry => this.card(entry)));
    if (!entries.length) this.grid.append(el('p', 'library-empty', query ? 'Nothing matches.' : 'The library is empty.'));
  }

  card(entry) {
    const card = el('div', 'library-card');
    const add = el('button', 'library-add');
    add.type = 'button';
    add.title = `Add ${entry.name} to the scene`;
    const picture = el('img');
    picture.alt = '';
    picture.width = THUMB.width;
    picture.height = THUMB.height;
    if (!this.panel.hidden) this.thumbs.request(entry, url => { picture.src = url; });
    add.append(picture, el('span', 'library-name', entry.name));
    if (entry.source === 'voice') add.append(el('span', 'library-badge', 'saved'));
    add.addEventListener('click', () => this.add(entry));
    card.append(add);
    if (entry.source === 'voice') {
      const tools = el('div', 'library-tools');
      tools.append(button('Rename', `Rename ${entry.name}`, () => this.rename(entry)),
        button('Remove', `Remove ${entry.name} from the library`, () => this.remove(entry)));
      card.append(tools);
    }
    return card;
  }

  add(entry) {
    try {
      this.objects.add(this.library.instantiate(entry.id));
      this.say(`Added ${entry.name}. Look and pinch to move it.`);
    } catch (error) { this.say(error.message); }
    this.onChange?.();
  }

  rename(entry) {
    const name = prompt('New name', entry.name);
    if (name === null) return;
    if (this.library.rename(entry.id, name)) {
      this.say(`Renamed to ${name.trim()}.`);
      this.render();
    } else this.say('A name needs at least one character.');
  }

  remove(entry) {
    if (!this.library.remove(entry.id)) return;
    this.thumbs.cache.delete(entry.id);
    this.say(`Removed ${entry.name} from the library. Objects already in the scene stay.`);
    this.render();
  }

  duplicateTarget() {
    const target = this.interaction.target;
    if (!target) return this.say('Switch to EDIT mode (M), look at an object, then press F to copy it.');
    const spec = specOfObject(target);
    if (!spec) return this.say('That object cannot be copied.');
    try {
      const copy = this.objects.add({ ...spec, id: newId('copy'), quaternion: target.quaternion.toArray() },
        { near: [target.position.x, target.position.z] });
      this.say(`Copied ${copy.name}.`);
    } catch (error) { this.say(error.message); }
    this.onChange?.();
  }

  deleteTarget() {
    const target = this.interaction.target;
    if (!target) return this.say('Switch to EDIT mode (M), look at an object, then press Delete to remove it.');
    if (!target.userData.spec) return this.say('The starter blocks belong to the room and cannot be deleted.');
    const name = target.name || 'object';
    this.objects.remove(target.userData.id);
    this.say(`Deleted ${name}.`);
    this.onChange?.();
  }

  clearScene() {
    const created = this.objects.container.children.filter(root => root.userData.spec);
    if (!created.length) return this.say('There are no created objects to clear.');
    const now = performance.now();
    if (now > this.clearArmedUntil) { // a second click within 3 s confirms, so one stray click can't wipe the scene
      this.clearArmedUntil = now + 3000;
      this.clearButton.textContent = `Clear ${created.length}?`;
      setTimeout(() => { this.clearButton.textContent = 'Clear scene'; }, 3000);
      return this.say('Click again to delete every created object. Starter blocks stay.');
    }
    this.clearArmedUntil = 0;
    this.clearButton.textContent = 'Clear scene';
    for (const root of created) this.objects.remove(root.userData.id);
    this.say(`Cleared ${created.length} object${created.length === 1 ? '' : 's'}.`);
    this.onChange?.();
  }

  exportFile() {
    const blob = new Blob([this.library.exportJSON()], { type: 'application/json' });
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'mirror-mirror-library.json' });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    this.say(`Exported ${this.library.saved.length} saved object${this.library.saved.length === 1 ? '' : 's'}.`);
  }

  async importFile() {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    try {
      const { added, skipped } = this.library.importJSON(await file.text());
      this.say(`Imported ${added} object${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} (duplicate or invalid)` : ''}.`);
      this.render();
    } catch {
      this.say('That file is not a Mirror Mirror library.');
    }
  }

  // Once per frame: keep the "looking at" label current while the panel is open.
  update(target) {
    if (this.panel.hidden) return;
    const label = target ? `Looking at: ${target.name || target.userData.id}` : 'In EDIT mode (M), look at an object to copy or delete it';
    if (this.targetLabel.textContent !== label) this.targetLabel.textContent = label;
  }
}
