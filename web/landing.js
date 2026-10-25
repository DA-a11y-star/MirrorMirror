// Front page. Pick a preset, then Play loads the workspace (main.js) with ?preset=<id> in the URL. Nothing that
// touches the camera, tracker or relay runs before that. A page opened with ?preset=... (a reload mid-demo, or a
// scripted test) skips straight to the workspace.
import { HOST_ID, USER_ID } from './config.js';
import { loadRegistry } from './presets.js';
import { Panorama } from './panorama.js';

const LEAVE_MS = 450; // matches the #landing.leaving transition
const landing = document.getElementById('landing');

if (new URLSearchParams(location.search).has('preset')) {
  landing.remove();
  startWorkspace();
} else {
  showLanding();
}

function startWorkspace() {
  document.getElementById('workspace-ui').hidden = false;
  return import('./main.js');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';

// The silver scrollwork crest on top of each oval mirror; the gem in its middle lights up in the set's tint when
// selected.
const CREST = '<svg class="crest-carving" viewBox="0 0 120 44" aria-hidden="true">' +
  '<path d="M60 2c-6 4-9 9-9 14-5-6-13-8-20-5 5 1 8 4 8 8-6-4-15-4-22 1 7 0 12 3 13 9-4-1-8 0-11 3h82c-3-3-7-4-11-3 1-6 6-9 13-9-7-5-16-5-22-1 0-4 3-7 8-8-7-3-15-1-20 5 0-5-3-10-9-14z" fill="url(#silver)"/>' +
  '<path d="M60 8c-3 3-4 6-4 10m4-10c3 3 4 6 4 10M38 20c4-1 8 1 9 5m35-5c-4-1-8 1-9 5M26 30c4-2 9-1 11 3m57-3c-4-2-9-1-11 3" stroke="#4f5866" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".75"/>' +
  '</svg>';

// One mirror. Built with DOM APIs, never innerHTML for preset data, because imported presets will be user-supplied.
// The glass shows the preset's own image if it has one, otherwise a still of its scene, filled in once rendered.
function presetCard(preset) {
  const card = el('button', 'preset-card');
  card.type = 'button';
  card.dataset.id = preset.id;
  card.setAttribute('aria-pressed', 'false');
  card.style.setProperty('--tint', preset.tint);
  const crest = el('span', 'mirror-crest');
  crest.innerHTML = CREST; // static markup, not preset data
  const gem = el('span', 'mirror-gem');
  gem.innerHTML = CHECK;
  crest.append(gem);
  const frame = el('span', 'mirror-frame');
  const glass = el('span', 'mirror-glass');
  const picture = el('img', 'preset-picture');
  picture.alt = '';
  picture.draggable = false;
  if (preset.thumbnail) picture.src = preset.thumbnail;
  else picture.hidden = true;
  glass.append(picture);
  frame.append(glass);
  const plate = el('span', 'mirror-plate');
  plate.append(el('span', 'preset-name', preset.name));
  card.append(crest, frame, plate);
  if (preset.description) card.append(el('span', 'preset-desc', preset.description));
  return card;
}

async function showLanding() {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const panorama = new Panorama(document.getElementById('landing-bg'), { reducedMotion });
  panorama.start();

  const who = document.getElementById('landing-who');
  who.replaceChildren(el('strong', '', `You are User ${USER_ID}`),
    el('span', '', USER_ID === HOST_ID ? 'Hosting the shared scene' : `Joining User ${HOST_ID}'s scene`));

  const grid = document.getElementById('preset-grid');
  const play = document.getElementById('play');
  const playSub = play.querySelector('.play-sub');
  const status = document.getElementById('preset-status');
  let presets = [];
  let background = null;
  let selected = null;

  const select = preset => {
    selected = preset && preset.id !== selected?.id ? preset : null;
    for (const card of grid.querySelectorAll('.preset-card')) {
      card.setAttribute('aria-pressed', String(card.dataset.id === selected?.id));
    }
    play.disabled = !selected;
    playSub.textContent = selected ? selected.name : 'Choose a set first';
    status.textContent = selected ? `${selected.name} selected. Press Play to start.` : 'No set selected.';
    panorama.show(selected ?? background ?? presets[0]);
  };

  const launch = () => {
    if (!selected) return;
    const url = new URL(location.href);
    url.searchParams.set('preset', selected.id);
    history.replaceState(null, '', url);
    play.disabled = true;
    landing.classList.add('leaving');
    setTimeout(() => {
      panorama.destroy();
      landing.remove();
      startWorkspace();
    }, reducedMotion ? 0 : LEAVE_MS);
  };

  play.addEventListener('click', launch);
  grid.addEventListener('click', event => {
    const card = event.target.closest('.preset-card');
    if (card) select(presets.find(p => p.id === card.dataset.id));
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selected) select(null);
  });

  try {
    const loaded = await loadRegistry();
    for (const error of loaded.errors) console.warn('Preset skipped:', error);
    ({ presets, background } = loaded);
  } catch (error) {
    console.error(error);
    grid.replaceChildren(el('p', 'preset-message',
      'Could not load the presets. Serve the web folder over HTTP (python -m http.server) and reload.'));
    return;
  }
  panorama.show(background ?? presets[0]);
  grid.replaceChildren(...presets.map(presetCard));
  if (!presets.length) grid.append(el('p', 'preset-message', 'No presets found in web/presets/index.json.'));
  // Render the card stills after the cards are on screen, so the menu never waits for them.
  setTimeout(() => {
    const shots = panorama.thumbnails(presets.filter(p => !p.thumbnail), 400, 480); // an upright oval, like the glass
    for (const card of grid.querySelectorAll('.preset-card')) {
      const shot = shots.get(card.dataset.id);
      const picture = card.querySelector('.preset-picture');
      if (!shot || !picture) continue;
      picture.src = shot;
      picture.hidden = false;
    }
  }, 60);
}
