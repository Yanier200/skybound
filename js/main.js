import * as THREE from '../vendor/three.module.js';
import { makeLevel, LEVEL_COUNT, THEMES } from './levelgen.js';
import { World } from './world.js';
import { Player, PLAYER } from './player.js';
import { GameAudio } from './audio.js';
import { Music } from './music.js';
import { clamp } from './rng.js';
import { initTouchControls } from './mobile.js';

const $ = (id) => document.getElementById(id);

// ============================================================================
// Renderer / scene
// ============================================================================
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, window.innerWidth / window.innerHeight, 0.1, 420);

const audio = new GameAudio();
const music = new Music();
const player = new Player(scene);

const clearedCount = () => Object.keys(save.best).length;
// ============================================================================
// Save data
// ============================================================================
const SAVE_KEY = 'skybound.save.v1';
const MUTE_KEY = 'skybound.muted';
const defaultSave = () => ({ unlocked: 0, best: {} });
let save = defaultSave();

try {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      save.unlocked = clamp(Number(parsed.unlocked) || 0, 0, LEVEL_COUNT - 1);
      if (parsed.best && typeof parsed.best === 'object') {
        for (const [k, v] of Object.entries(parsed.best)) {
          const idx = Number(k);
          if (!Number.isInteger(idx) || idx < 0 || idx >= LEVEL_COUNT || !v) continue;
          const stars = clamp(Number(v.stars) || 1, 1, 3);
          const time = Number(v.time);
          save.best[idx] = { stars, time: Number.isFinite(time) && time > 0 ? time : 0 };
        }
      }
    }
  }
} catch {
  save = defaultSave();
}

function persist() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* private mode */ }
}

audio.setMuted(localStorage.getItem(MUTE_KEY) === '1');

// ============================================================================
// Game state
// ============================================================================
const game = {
  mode: 'menu', // menu | levels | controls | playing | paused | complete
  level: 0,
  world: null,
  timer: 0,
  deaths: 0,
  respawnIn: 0,
  portalHint: 0,
  showcaseAngle: Math.random() * 6.28,
  yaw: 0,
  pitch: 0.30,
  zoom: 8.8,
  lastVy: 0, // fall speed recorded before each physics step, for the landing buzz

  onJump(p, isDouble) {
    audio[isDouble ? 'doubleJump' : 'jump']();
    rumble('jump', isDouble ? 0.85 : 1);
    const w = game.world;
    if (!w) return;
    w.particles.burst(p.pos.x, p.pos.y + 0.1, p.pos.z, w.theme.rim, isDouble ? 12 : 7, {
      spread: 3.4, life: 0.42, size: 0.9, gravity: 6, vy: 0.8,
    });
  },

  onLand(p) {
    audio.land();
    rumble('land', 0.45 + clamp(Math.abs(game.lastVy) / PLAYER.maxFall, 0, 1) * 0.55);
    const w = game.world;
    if (!w) return;
    w.particles.burst(p.pos.x, p.pos.y + 0.05, p.pos.z, w.theme.rim, 6, {
      spread: 2.8, life: 0.35, size: 0.8, gravity: 4, vy: 0.4,
    });
  },

  onDash(p) {
    audio.dash();
    rumble('dash');
    const w = game.world;
    if (!w) return;
    for (let i = 0; i < 10; i++) {
      w.particles.emit(p.pos.x + (Math.random() - 0.5) * 0.4, p.pos.y + 0.4 + Math.random() * 0.8, p.pos.z + (Math.random() - 0.5) * 0.4, {
        color: w.theme.accent, spread: 1.2, life: 0.35, size: 0.75, gravity: 0, drag: 5,
      });
    }
  },

  onBounce(p) {
    audio.bounce();
    const w = game.world;
    if (!w) return;
    w.particles.burst(p.pos.x, p.pos.y + 0.2, p.pos.z, w.theme.accent, 14, {
      spread: 4, life: 0.5, size: 1.1, gravity: 3, vy: 3,
    });
  },

  onFallOut() {
    killPlayer();
  },
};

const keys = new Set();
const input = { forward: 0, right: 0, jumpPressed: false, dashPressed: false };

// ============================================================================
// Gamepad (Xbox layout through the standard mapping)
// ============================================================================
const CAM_STICK_SPEED = 2.4; // radians/second at full deflection
const PITCH_STICK_SPEED = 1.5;

const pad = {
  gp: null, // this frame's snapshot, also what rumble talks to
  active: false,
  index: -1, // slot, so a swap between pads can be spotted
  moveX: 0,
  moveY: 0,
  camX: 0,
  camY: 0,
  jump: false, // one-frame edges
  dash: false,
  start: false,
  back: false,
  prevJump: false,
  prevDash: false,
  prevStart: false,
  prevBack: false,
  lost: false, // one-frame edges for a pad dropping out or coming back
  found: false,
};

// Radial deadzone. Returns the factor that takes a stick vector from just
// outside the deadzone (0) to the rim (1), so full travel still means full speed.
function stickScale(x, y) {
  const mag = Math.hypot(x, y);
  const dz = deadzone();
  if (mag <= dz) return 0;
  return (mag - dz) / ((1 - dz) * mag);
}

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (const p of pads) if (p && p.connected) { gp = p; break; }

  // A pad that is not the one from last frame was just plugged in, swapped or
  // reconnected. Whatever it is already holding counts as held, not pressed, so
  // starting the game with a button down cannot fire an action.
  const index = gp ? gp.index | 0 : -1;
  const swapped = index !== pad.index;
  const wasActive = pad.active;
  pad.gp = gp;
  pad.active = !!gp;
  pad.index = index;
  pad.jump = pad.dash = pad.start = pad.back = false;
  // One-frame edges for a pad appearing or dropping out, so a mid-run unplug
  // can be caught exactly once.
  pad.lost = wasActive && !gp;
  pad.found = !wasActive && !!gp;

  if (!gp) {
    pad.moveX = pad.moveY = pad.camX = pad.camY = 0;
    pad.prevJump = pad.prevDash = pad.prevStart = pad.prevBack = false;
    return;
  }

  const b = gp.buttons;
  const down = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.4));

  // A jumps, B backs out of menus, X / RB / RT dash, Menu pauses.
  const jumpNow = down(0);
  const backNow = down(1);
  const dashNow = down(2) || down(5) || down(7);
  const startNow = down(9);

  if (swapped) {
    pad.prevJump = jumpNow;
    pad.prevDash = dashNow;
    pad.prevStart = startNow;
    pad.prevBack = backNow;
  }

  pad.jump = jumpNow && !pad.prevJump;
  pad.dash = dashNow && !pad.prevDash;
  pad.start = startNow && !pad.prevStart;
  pad.back = backNow && !pad.prevBack;
  pad.prevJump = jumpNow;
  pad.prevDash = dashNow;
  pad.prevStart = startNow;
  pad.prevBack = backNow;

  const ax = gp.axes[0] || 0;
  const ay = gp.axes[1] || 0;
  const rx = gp.axes[2] || 0;
  const ry = gp.axes[3] || 0;
  const l = stickScale(ax, ay);
  const r = stickScale(rx, ry);

  // The d-pad is digital, so it overrides the stick rather than blending in.
  pad.moveX = ((down(15) ? 1 : 0) - (down(14) ? 1 : 0)) || ax * l;
  pad.moveY = ((down(12) ? 1 : 0) - (down(13) ? 1 : 0)) || -ay * l; // stick up is negative
  pad.camX = rx * r;
  pad.camY = ry * r;
}

// ============================================================================
// Controller rumble
// ============================================================================
// Short, gentle buzzes through the pad's vibration actuator. Every effect is
// rate limited, because the physics loop can report several landings, jumps or
// dashes within a few frames and a motor spinning up and down every frame feels
// like a fault rather than feedback.
const RUMBLE = {
  minGap: 80, // ms between any two effects
  lastAt: -1e9,
  lastType: '',
  lastTypeAt: -1e9,
  gaps: { jump: 140, land: 160, dash: 140, death: 300 },
  effects: {
    jump: { duration: 70, strong: 0.10, weak: 0.20 },
    land: { duration: 90, strong: 0.20, weak: 0.12 },
    dash: { duration: 110, strong: 0.14, weak: 0.30 },
    death: { duration: 240, strong: 0.34, weak: 0.26 },
  },
};

function actuator() {
  const act = pad.gp && pad.gp.vibrationActuator;
  return act && typeof act.playEffect === 'function' ? act : null;
}

function rumble(type, scale = 1, force = false) {
  if (settings.rumble !== 'on' || !pad.active) return false;
  const effect = RUMBLE.effects[type];
  if (!effect) return false;

  const now = performance.now();
  if (!force) {
    if (now - RUMBLE.lastAt < RUMBLE.minGap) return false;
    if (type === RUMBLE.lastType && now - RUMBLE.lastTypeAt < RUMBLE.gaps[type]) return false;
  }

  const act = actuator();
  if (!act) return false;

  RUMBLE.lastAt = now;
  RUMBLE.lastType = type;
  RUMBLE.lastTypeAt = now;
  try {
    const played = act.playEffect('dual-rumble', {
      startDelay: 0,
      duration: effect.duration,
      strongMagnitude: clamp(effect.strong * scale, 0, 1),
      weakMagnitude: clamp(effect.weak * scale, 0, 1),
    });
    if (played && typeof played.catch === 'function') played.catch(() => {});
    return true;
  } catch {
    return false; // pad without a usable actuator, or a window without focus
  }
}

function stopRumble() {
  const act = actuator();
  if (!act) return;
  try {
    if (act.reset) act.reset();
  } catch { /* nothing running */ }
}

function updateRumbleUi() {
  $('btn-rumble2').textContent = `Rumble: ${settings.rumble === 'on' ? 'On' : 'Off'}`;
}

function toggleRumble() {
  settings.rumble = settings.rumble === 'on' ? 'off' : 'on';
  saveSettings();
  applySettings();
  if (settings.rumble === 'on') rumble('dash', 0.8, true);
  else stopRumble();
  updateRumbleUi();
}

// ============================================================================
// Settings
// ============================================================================
const SETTINGS_KEY = 'skybound.settings.v1';

const DEFAULTS = {
  rumble: 'on',
  pauseOnDisconnect: 'on',
  deadzone: 'normal',
  camSpeed: 'normal',
  invertY: 'off',
  hudScale: 'normal',
  fps: 'off',
  quality: 'balanced',
  volume: 'normal',
  music: 'normal',
};

const settings = { ...DEFAULTS };
try {
  const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
  if (stored && typeof stored === 'object') Object.assign(settings, stored);
  // Import the rumble switch from before Options existed, then forget the old
  // key so there is only ever one copy of this setting.
  const legacyRumble = localStorage.getItem('skybound.rumble');
  if (legacyRumble !== null) {
    if (!stored || !('rumble' in stored)) settings.rumble = legacyRumble === '0' ? 'off' : 'on';
    localStorage.removeItem('skybound.rumble');
  }
} catch { /* keep defaults */ }

const DEADZONE_PRESETS = { small: 0.12, normal: 0.18, large: 0.26 };
const CAM_SPEED_PRESETS = { slow: 0.6, normal: 1, fast: 1.5 };
const HUD_SCALES = { normal: 1, large: 1.18, huge: 1.4 };
const VOLUME_PRESETS = { off: 0, low: 0.14, normal: 0.3, loud: 0.62 };
const MUSIC_PRESETS = { off: 0, low: 0.2, normal: 0.45, loud: 0.8 };

// Settings are the only source of truth; these read the preset the rest of the
// game wants without keeping a second copy of it in a module-level variable.
const deadzone = () => DEADZONE_PRESETS[settings.deadzone] ?? DEADZONE_PRESETS.normal;
const camSpeed = () => CAM_SPEED_PRESETS[settings.camSpeed] ?? CAM_SPEED_PRESETS.normal;
const invertSign = () => (settings.invertY === 'on' ? -1 : 1);

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

function applySettings() {
  audio.setVolume(VOLUME_PRESETS[settings.volume] ?? 0.3);
  music.setVolume(MUSIC_PRESETS[settings.music] ?? 0.45);
  music.setMuted(audio.muted);
  document.documentElement.style.setProperty('--ui-scale', String(HUD_SCALES[settings.hudScale] ?? 1));
  $('fps').classList.toggle('hidden', settings.fps !== 'on');
  applyQuality();
}

// Graphics quality: the drawing buffer is rendered at a fraction of the screen
// resolution (or above it, supersampled) and the sun's shadow map is resized to
// match. Both only change what the picture costs to draw, never the game.
// Each preset drives the whole scene, not just the framebuffer: render
// resolution, shadow map size and filtering, how many level particles, stars
// and background rocks are drawn, and how the character herself is lit and
// shaded.
const QUALITY_PRESETS = {
  performance: {
    scale: 0.75, shadow: 1024, soft: false,
    particles: 0.35, stars: 0.4, deco: 0.45,
    rough: 1.16, rim: 0, characterShadow: false,
  },
  balanced: {
    scale: 1.0, shadow: 2048, soft: true,
    particles: 1.0, stars: 1.0, deco: 1.0,
    rough: 1.0, rim: 0, characterShadow: true,
  },
  quality: {
    scale: 1.5, shadow: 4096, soft: true,
    particles: 1.8, stars: 1.9, deco: 1.7,
    rough: 0.82, rim: 10, characterShadow: true,
  },
};

function qualityPreset() {
  return QUALITY_PRESETS[settings.quality] || QUALITY_PRESETS.balanced;
}

// Pixel ratio for the current quality: the screen's own ratio, scaled.
function renderScale() {
  return clamp(Math.min(window.devicePixelRatio || 1, 2) * qualityPreset().scale, 0.5, 2.5);
}

function applyQuality() {
  const preset = qualityPreset();
  renderer.setPixelRatio(renderScale());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  applyShadowFilter(preset.soft);
  applyShadowSize(preset.shadow);
  player.setQuality(preset);
}

// Hard shadows for Performance, soft PCF for the other two. The filter is
// baked into the shader programs, so they have to be rebuilt once.
function applyShadowFilter(soft) {
  const type = soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  if (renderer.shadowMap.type === type) return;
  renderer.shadowMap.type = type;
  scene.traverse((o) => {
    const mat = o.material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) m.needsUpdate = true;
  });
}

// Resize the live sun shadow map; three reallocates it on the next frame.
function applyShadowSize(size) {
  const sun = game && game.world && game.world.sun;
  if (!sun || sun.shadow.mapSize.x === size) return;
  sun.shadow.mapSize.set(size, size);
  if (sun.shadow.map) {
    sun.shadow.map.dispose();
    sun.shadow.map = null;
  }
}

// ============================================================================
// UI helpers
// ============================================================================
let toastTimer = 0;
function toast(message, ms = 1700) {
  const el = $('toast');
  $('toast-text').textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Show exactly one screen (or none, when passed null).
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

function showHud() { $('hud').classList.remove('hidden'); }
function hideHud() { $('hud').classList.add('hidden'); }

function fmtTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

function updateMuteUi() {
  $('btn-mute').textContent = audio.muted ? '🔇' : '🔊';
  $('btn-mute2').textContent = `Sound: ${audio.muted ? 'Off' : 'On'}`;
}

function toggleMute() {
  audio.setMuted(!audio.muted);
  music.setMuted(audio.muted);
  try { localStorage.setItem(MUTE_KEY, audio.muted ? '1' : '0'); } catch { /* ignore */ }
  updateMuteUi();
  if (!audio.muted) audio.ui();
}

// ============================================================================
// World mounting
// ============================================================================
function mountWorld(spec) {
  if (game.world) {
    game.world.dispose();
    game.world = null;
  }
  game.world = new World(scene, spec, qualityPreset());
  // A fresh world builds its sun at the default shadow size, so re-apply the
  // chosen quality to the new map.
  applyShadowSize(qualityPreset().shadow);
}

function loadShowcase(index) {
  const i = clamp(index, 0, LEVEL_COUNT - 1);
  game.level = i;
  const spec = makeLevel(i);
  mountWorld(spec);
  player.group.visible = false;
}

// ============================================================================
// Level flow
// ============================================================================
function startLevel(index) {
  const i = clamp(index | 0, 0, LEVEL_COUNT - 1);
  audio.resume();
  const spec = makeLevel(i);
  mountWorld(spec);
  music.play(spec.theme.id);
  game.level = i;
  game.timer = 0;
  game.deaths = 0;
  game.respawnIn = 0;
  game.portalHint = 0;
  game.pitch = 0.30;
  game.zoom = 8.8;
  game.mode = 'playing';
  input.jumpPressed = input.dashPressed = false;

  player.setAccent(spec.theme.accent);
  player.reset(spec.spawn, spec.spawnFacing);
  // Point the camera down the course instead of at a random compass bearing.
  const dirX = Math.sin(spec.spawnFacing);
  const dirZ = Math.cos(spec.spawnFacing);
  game.yaw = Math.atan2(-dirX, -dirZ);
  updatePortalState();

  showScreen(null);
  clearFocus();
  showHud();
  updateHud(true);
  updateMuteUi();
  toast(`LEVEL ${i + 1} · ${spec.name}`, 1500);

  const fade = $('fade');
  fade.style.transition = 'none';
  fade.classList.add('on');
  requestAnimationFrame(() => {
    fade.style.transition = 'opacity 0.3s ease';
    fade.classList.remove('on');
  });

  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  requestLock();
}

function restartLevel() {
  startLevel(game.level);
}

function respawnPlayer() {
  game.respawnIn = 0;
  // A jump pressed during the death pause must not fire on respawn.
  input.jumpPressed = input.dashPressed = false;
  if (!game.world) return;
  player.reset(game.world.respawnPoint, player.facing);
}

function killPlayer() {
  if (game.mode !== 'playing' || player.dead) return;
  const w = game.world;
  player.die();
  game.deaths++;
  audio.hurt();
  rumble('death');
  if (w) {
    w.particles.burst(player.pos.x, player.pos.y + 0.7, player.pos.z, 0xff5a48, 22, {
      spread: 6.5, life: 0.75, size: 1.4, gravity: 13, vy: 2,
    });
  }
  game.respawnIn = 0.55;
  updateHud();
}

function updatePortalState() {
  if (!game.world) return;
  game.world.setPortalReady(game.world.objectivesDone());
}

function completeLevel() {
  const w = game.world;
  if (!w || game.mode !== 'playing') return;

  // The portal ends the level outright: the results screen is the reward.
  w.particles.burst(w.portal.center.x, w.portal.center.y, w.portal.center.z, w.theme.accent, 34, {
    spread: 7, life: 1.1, size: 1.5, gravity: 2, vy: 3,
  });
  audio.win();
  if (document.pointerLockElement) document.exitPointerLock();
  hideHud();
  finishLevel();
}

function finishLevel() {
  const w = game.world;
  if (!w) return;
  game.mode = 'complete';

  const par = w.spec.parTime;
  let stars = 1;
  if (game.timer <= par * 1.5 && game.deaths <= 2) stars = 2;
  if (game.timer <= par && game.deaths === 0) stars = 3;

  const prev = save.best[game.level];
  if (!prev || stars > prev.stars || (stars === prev.stars && (!prev.time || game.timer < prev.time))) {
    save.best[game.level] = { stars, time: Math.round(game.timer * 10) / 10 };
  }
  if (game.level + 1 < LEVEL_COUNT) save.unlocked = Math.max(save.unlocked, game.level + 1);
  persist();

  $('complete-name').textContent = `${game.level + 1}. ${w.spec.name}`;
  $('complete-time').textContent = fmtTime(game.timer);
  $('complete-deaths').textContent = String(game.deaths);
  $('complete-par').textContent = fmtTime(par);

  const starEls = $('complete-stars').children;
  for (let i = 0; i < starEls.length; i++) starEls[i].classList.remove('on');
  for (let i = 0; i < stars; i++) setTimeout(() => starEls[i].classList.add('on'), 180 + i * 130);

  $('btn-next').textContent = game.level >= LEVEL_COUNT - 1 ? 'Level Select' : 'Next Level →';

  hideHud();
  music.play('credits');
  showScreen('screen-complete');
  focusItems([$('btn-next'), $('btn-replay'), $('btn-menu2')], 0, 3);
  updateMenuUi();
}

function nextLevel() {
  if (game.level >= LEVEL_COUNT - 1) openLevels();
  else startLevel(game.level + 1);
}

// ============================================================================
// Menus
// ============================================================================
function showMenu() {
  showPadLost(false);
  game.mode = 'menu';
  if (document.pointerLockElement) document.exitPointerLock();
  hideHud();
  loadShowcase(Math.min(save.unlocked, LEVEL_COUNT - 1));
  updateMenuUi();
  music.play('menu');
  showScreen('screen-menu');
  focusItems([$('btn-continue'), $('btn-levels'), $('btn-options'), $('btn-controls')]);
}

function updateMenuUi() {
  const cleared = Object.keys(save.best).length;
  let stars = 0;
  for (const v of Object.values(save.best)) stars += v.stars || 0;
  $('menu-cleared').textContent = String(cleared);
  $('menu-stars').textContent = String(stars);
  $('menu-progress').textContent = `${Math.round((cleared / LEVEL_COUNT) * 100)}%`;
  $('continue-label').textContent = `LEVEL ${Math.min(LEVEL_COUNT - 1, save.unlocked) + 1}`;
  $('levels-summary').textContent = `${cleared} / ${LEVEL_COUNT} cleared`;
}

function buildLevelSelect() {
  const list = $('level-list');
  list.innerHTML = '';
  const buttons = [];
  for (let t = 0; t < THEMES.length; t++) {
    const theme = THEMES[t];
    const row = document.createElement('div');
    row.className = 'theme-row';

    const label = document.createElement('div');
    label.className = 'theme-label';
    const color = `#${theme.slab.toString(16).padStart(6, '0')}`;
    label.innerHTML = `<div><span class="dot" style="background:${color}"></span>${theme.label}</div><small>LEVELS ${t * 10 + 1}–${t * 10 + 10}</small>`;

    const grid = document.createElement('div');
    grid.className = 'level-grid';

    for (let k = 0; k < 10; k++) {
      const i = t * 10 + k;
      const btn = document.createElement('button');
      btn.className = 'lvl';
      btn.innerHTML = `<span>${i + 1}</span>`;
      const best = save.best[i];
      if (best) {
        btn.classList.add('cleared');
        btn.innerHTML += `<div class="pips">${'<i></i>'.repeat(clamp(best.stars, 1, 3))}</div>`;
        btn.title = `${theme.label} · best ${fmtTime(best.time || 0)}`;
      }
      if (i > save.unlocked) btn.classList.add('locked');
      else if (i === save.unlocked) btn.classList.add('current');
      btn.addEventListener('click', () => {
        audio.resume();
        audio.ui();
        if (i > save.unlocked) { toast('FINISH THE PREVIOUS LEVEL FIRST', 1300); return; }
        startLevel(i);
      });
      grid.appendChild(btn);
      buttons.push(btn);
    }

    row.appendChild(label);
    row.appendChild(grid);
    list.appendChild(row);
  }
  updateMenuUi();
  // Start on the level you would continue from, ten keys across. Back is part
  // of the list so the pad can reach the button as well as pressing B.
  focusItems([...buttons, $('btn-levels-back')], save.unlocked, 10);
}

function openLevels() {
  game.mode = 'levels';
  if (document.pointerLockElement) document.exitPointerLock();
  hideHud();
  loadShowcase(Math.min(save.unlocked, LEVEL_COUNT - 1));
  buildLevelSelect();
  music.play('menu');
  showScreen('screen-levels');
}

// ============================================================================
// Options
// ============================================================================
const OPTION_SECTIONS = [
  {
    title: 'Controls',
    rows: [
      { key: 'rumble', title: 'Rumble', choices: [['on', 'On'], ['off', 'Off']] },
      { key: 'pauseOnDisconnect', title: 'Pause on disconnect', choices: [['on', 'On'], ['off', 'Off']] },
      { key: 'deadzone', title: 'Stick deadzone', choices: [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']] },
      { key: 'camSpeed', title: 'Camera speed', choices: [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']] },
      { key: 'invertY', title: 'Invert camera Y', choices: [['off', 'Off'], ['on', 'On']] },
    ],
  },
  {
    title: 'Display',
    rows: [
      { key: 'quality', title: 'Graphics', choices: [['performance', 'Performance'], ['balanced', 'Balanced'], ['quality', 'Quality']] },
      { key: 'hudScale', title: 'HUD size', choices: [['normal', 'Normal'], ['large', 'Large'], ['huge', 'TV']] },
      { key: 'fps', title: 'Frame counter', choices: [['off', 'Off'], ['on', 'On']] },
      { action: 'fullscreen', title: 'Fullscreen', text: fullscreenLabel },
    ],
  },
  {
    title: 'Audio',
    rows: [
      { key: 'volume', title: 'Effects', choices: [['off', 'Off'], ['low', 'Low'], ['normal', 'Normal'], ['loud', 'Loud']] },
      { key: 'music', title: 'Music', choices: [['off', 'Off'], ['low', 'Low'], ['normal', 'Normal'], ['loud', 'Loud']] },
      { action: 'sound', title: 'Sound', text: () => (audio.muted ? 'Muted' : 'On') },
      { action: 'track', title: 'Track', text: () => music.label() },
    ],
  },
  {
    title: 'Data',
    rows: [
      { action: 'resetProgress', title: 'Reset all progress', text: () => 'Clear' },
      { action: 'resetSettings', title: 'Reset options', text: () => 'Defaults' },
    ],
  },
];

let optionRows = [];

const OPTION_ACTIONS = {
  fullscreen: toggleFullscreen,
  sound: toggleMute,
  // Restart the current track from the top instead of doing nothing.
  track: () => { if (music.key) { const k = music.key; music.stop(); music.play(k); } },
  resetSettings: () => {
    Object.assign(settings, DEFAULTS);
    saveSettings();
    applySettings();
    buildOptions();
    toast('OPTIONS RESET', 1600);
  },
  resetProgress(btn) {
    const now = performance.now();
    if (btn._armedUntil && now < btn._armedUntil) {
      btn._armedUntil = 0;
      save = defaultSave();
      persist();
      updateMenuUi();
      toast('ALL PROGRESS CLEARED', 2000);
      return;
    }
    btn._armedUntil = now + 4000;
    toast('PRESS AGAIN TO WIPE PROGRESS', 2400);
  },
};

function optionValue(row) {
  if (!row.choices) return row.text();
  const found = row.choices.find(([v]) => v === settings[row.key]);
  return found ? found[1] : '—';
}

function cycleOption(index, dir) {
  const row = optionRows[index];
  if (!row || !row.choices) return false;
  const values = row.choices.map(([v]) => v);
  const at = Math.max(0, values.indexOf(settings[row.key]));
  settings[row.key] = values[(at + dir + values.length) % values.length];
  saveSettings();
  applySettings();
  audio.ui();
  return true;
}

function buildOptions() {
  const host = $('options-list');
  host.innerHTML = '';
  optionRows = [];
  const buttons = [];

  for (const section of OPTION_SECTIONS) {
    const head = document.createElement('h3');
    head.className = 'opt-section';
    head.textContent = section.title;
    host.appendChild(head);

    for (const row of section.rows) {
      const index = optionRows.length;
      const btn = document.createElement('button');
      btn.className = 'opt';
      const label = document.createElement('span');
      label.className = 'opt-label';
      label.textContent = row.title;
      const value = document.createElement('span');
      value.className = 'opt-value';
      btn.append(label, value);
      btn._paint = () => { value.textContent = optionValue(row); };
      btn._paint();
      btn.addEventListener('click', () => {
        if (row.choices) cycleOption(index, 1);
        else OPTION_ACTIONS[row.action](btn);
        btn._paint();
      });
      host.appendChild(btn);
      optionRows.push(row);
      buttons.push(btn);
    }
  }

  const head = document.createElement('h3');
  head.className = 'opt-section';
  head.textContent = 'About';
  host.appendChild(head);
  const about = document.createElement('div');
  about.className = 'opt-about';
  about.innerHTML = '<span>SKYBOUND · 600 levels across six themes</span><span>Progress and these options are saved on this PC</span><span>Version 1.1.0</span>';
  host.appendChild(about);

  focusItems([...buttons, $('btn-options-back')], 0);
  // Left/right nudges the highlighted value instead of moving the highlight.
  nav.adjust = (dir) => {
    if (cycleOption(nav.index, dir)) nav.items[nav.index]._paint();
  };
}

function repaintOptions() {
  if (game.mode !== 'options') return;
  document.querySelectorAll('#options-list .opt').forEach((btn) => btn._paint && btn._paint());
}

// Fullscreen can change from the keyboard or the OS, so keep the row honest.
document.addEventListener('fullscreenchange', repaintOptions);

function openOptions() {
  game.mode = 'options';
  if (document.pointerLockElement) document.exitPointerLock();
  hideHud();
  loadShowcase(Math.min(save.unlocked, LEVEL_COUNT - 1));
  music.play('menu');
  showScreen('screen-options');
  buildOptions();
}

function openControls() {
  game.mode = 'controls';
  if (document.pointerLockElement) document.exitPointerLock();
  hideHud();
  loadShowcase(Math.min(save.unlocked, LEVEL_COUNT - 1));
  music.play('menu');
  showScreen('screen-controls');
  focusItems([$('btn-controls-back')]);
}

function pauseGame() {
  if (game.mode !== 'playing') return;
  game.mode = 'paused';
  if (document.pointerLockElement) document.exitPointerLock();
  updateMuteUi();
  updateRumbleUi();
  showScreen('screen-pause');
  // The panel's own buttons are the focus list, in the order they are drawn, so
  // the ring cannot drift out of step with the markup.
  focusItems([...document.querySelectorAll('#screen-pause .panel-actions .btn')]);
}

function resumeGame() {
  if (game.mode !== 'paused') return;
  showPadLost(false);
  showScreen(null);
  clearFocus();
  game.mode = 'playing';
  lastTime = performance.now() / 1000;
  audio.resume();
  requestLock();
}

// The desktop shell quits when its window closes (window-all-closed -> app.quit).
// A page in a plain browser or the Android WebView cannot close its own tab, so
// there the button says how to leave instead of doing nothing.
function quitToDesktop() {
  if (desktopShell) {
    window.close();
    return;
  }
  toast('CLOSE THE WINDOW TO QUIT', 2400);
}

// ============================================================================
// Controller dropout
// ============================================================================
// If the pad drops out mid-run she would keep running blind, so the run pauses
// and the reason goes over the top of the screen. Reconnecting, or the overlay's
// own buttons, gets you out of it.
let padLostPaused = false;

function showPadLost(on) {
  $('pad-lost').classList.toggle('on', !!on);
  if (on) {
    focusItems([$('btn-pad-lost-resume'), $('btn-pad-lost-menu')]);
  } else {
    padLostPaused = false;
  }
}

function handleControllerLink() {
  if (pad.lost && game.mode === 'playing' && settings.pauseOnDisconnect !== 'off') {
    padLostPaused = true;
    pauseGame();
    showPadLost(true);
    return;
  }
  if (pad.found && padLostPaused) {
    // Plug it back in and carry on where the run stopped.
    showPadLost(false);
    resumeGame();
  }
}

function anyPadConnected() {
  if (!navigator.getGamepads) return false;
  for (const p of navigator.getGamepads()) if (p && p.connected) return true;
  return false;
}

// The browser reports the link itself as well. That fires the moment the cable
// goes - no waiting for the next poll, and it still works when the frame loop
// is running slowly.
window.addEventListener('gamepaddisconnected', () => {
  if (anyPadConnected()) return; // another pad is still live
  pad.gp = null;
  pad.active = false;
  pad.index = -1;
  if (game.mode !== 'playing' || settings.pauseOnDisconnect === 'off') return;
  padLostPaused = true;
  pauseGame();
  showPadLost(true);
});

window.addEventListener('gamepadconnected', () => {
  if (!padLostPaused) return;
  showPadLost(false);
  resumeGame();
});

// ============================================================================
// Controller menu navigation
// ============================================================================
// Every screen hands the pad a flat list of buttons. Left/right walk the list,
// up/down hop a row (ten across in level select), A clicks the highlighted
// button and B backs out. The mouse keeps working everywhere.
const NAV_REPEAT_DELAY = 0.42; // seconds held before the highlight starts repeating
const NAV_REPEAT_RATE = 0.13;
const NAV_MODES = new Set(['menu', 'levels', 'paused', 'complete', 'controls', 'options']);

const nav = {
  items: [],
  index: 0,
  cols: 0,
  axisX: { dir: 0, hold: 0, repeat: 0 },
  axisY: { dir: 0, hold: 0, repeat: 0 },
  padWasActive: false,
  armedAt: 0,
  adjust: null, // set by screens where left/right changes a value
};

function focusItems(items, index = 0, cols = 0) {
  nav.items = items.filter(Boolean);
  nav.cols = cols;
  nav.adjust = null;
  nav.index = clamp(index, 0, Math.max(0, nav.items.length - 1));
  nav.axisX.dir = nav.axisY.dir = 0;
  nav.axisX.hold = nav.axisY.hold = 0;
  nav.axisX.repeat = nav.axisY.repeat = 0;
  // Swallow the button press that opened this screen so it cannot also confirm.
  nav.armedAt = performance.now() + 220;
  paintFocus();
}

function clearFocus() {
  nav.items = [];
  nav.index = 0;
  nav.cols = 0;
  nav.adjust = null;
  paintFocus();
}

function paintFocus() {
  // Drop the highlight everywhere first: the list may have just been replaced by
  // another screen's, and hidden buttons must not keep a stale ring.
  document.querySelectorAll('.pad-focus').forEach((el) => el.classList.remove('pad-focus'));
  const on = pad.active;
  const el = on ? nav.items[nav.index] : null;
  if (el) {
    el.classList.add('pad-focus');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// One step on press, then a steady repeat while the stick or d-pad is held.
function stepAxis(state, dir, dt) {
  if (dir !== state.dir) {
    state.dir = dir;
    state.hold = 0;
    state.repeat = 0;
    return dir;
  }
  if (dir === 0) return 0;
  state.hold += dt;
  if (state.hold < NAV_REPEAT_DELAY) return 0;
  state.repeat += dt;
  if (state.repeat < NAV_REPEAT_RATE) return 0;
  state.repeat -= NAV_REPEAT_RATE;
  return dir;
}

function moveFocus(dx, dy) {
  const n = nav.items.length;
  if (!n) return;
  let i = nav.index;
  if (dy) i += dy * (nav.cols || 1);
  else if (dx) i += dx;
  i = clamp(i, 0, n - 1);
  if (i === nav.index) return;
  nav.index = i;
  audio.ui();
  paintFocus();
}

function goBack() {
  if (game.mode === 'levels' || game.mode === 'controls' || game.mode === 'complete' || game.mode === 'options') {
    audio.ui();
    showMenu();
  } else if (game.mode === 'paused') {
    audio.ui();
    resumeGame();
  }
}

function updatePadNav(dt) {
  if (pad.active !== nav.padWasActive) {
    nav.padWasActive = pad.active;
    paintFocus();
  }
  if (!NAV_MODES.has(game.mode)) return;

  if (pad.jump && performance.now() >= nav.armedAt) {
    // The press belongs to the menu: spend it here, or a level started from it
    // would also read it as a jump on the very first frame.
    pad.jump = false;
    const el = nav.items[nav.index];
    if (el) el.click();
    return;
  }
  if (pad.back) {
    goBack();
    return;
  }

  const ax = Math.abs(pad.moveX) > 0.5 ? Math.sign(pad.moveX) : 0;
  const ay = Math.abs(pad.moveY) > 0.5 ? Math.sign(pad.moveY) : 0; // +1 is up
  const sx = stepAxis(nav.axisX, ax, dt);
  const sy = stepAxis(nav.axisY, ay, dt);
  if (sy) moveFocus(0, -sy);
  else if (sx && nav.adjust) nav.adjust(sx);
  else if (sx) moveFocus(sx, 0);
}

// ============================================================================
// HUD
// ============================================================================
const jumpKeyLabel = $('abil-jump').querySelector('kbd');
const dashKeyLabel = $('abil-dash').querySelector('kbd');

function updateHud(force = false) {
  const w = game.world;
  if (!w) return;

  // Show the bindings for whatever the player is actually holding.
  const jumpLabel = pad.active ? 'A' : 'SPACE';
  const dashLabel = pad.active ? 'X' : 'SHIFT';
  if (jumpKeyLabel.textContent !== jumpLabel) jumpKeyLabel.textContent = jumpLabel;
  if (dashKeyLabel.textContent !== dashLabel) dashKeyLabel.textContent = dashLabel;

  $('hud-level').textContent = `LEVEL ${String(game.level + 1).padStart(2, '0')} / ${LEVEL_COUNT}`;
  if (force) $('hud-name').textContent = w.spec.name;
  $('hud-time').textContent = fmtTime(game.timer);
  $('hud-deaths').textContent = String(game.deaths);

  const gotC = w.crystalsCollected();
  const totC = w.crystals.length;
  $('obj-crystals-text').textContent = `Crystals ${gotC} / ${totC}`;
  $('obj-crystals').classList.toggle('done', gotC === totC);

  const totS = w.switches.length;
  $('obj-switches').classList.toggle('hidden', totS === 0);
  if (totS > 0) {
    const gotS = w.switchesPressed();
    $('obj-switches-text').textContent = `Switches ${gotS} / ${totS}`;
    $('obj-switches').classList.toggle('done', gotS === totS);
  }

  const ready = w.objectivesDone();
  $('obj-portal').classList.toggle('ready', ready);
  $('obj-portal').classList.toggle('locked', !ready);

  const ratio = 1 - player.dashCd / PLAYER.dashCooldown;
  $('dash-fill').style.width = `${clamp(ratio, 0, 1) * 100}%`;
  $('abil-dash').classList.toggle('cooling', player.dashCd > 0.01);
}

// ============================================================================
// Input
// ============================================================================
function readInput() {
  const kbForward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const kbRight = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  // Keyboard wins while held; otherwise the left stick drives movement.
  input.forward = kbForward || pad.moveY;
  input.right = kbRight || pad.moveX;
  return input;
}

window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();

  if (e.code === 'Escape') {
    if (game.mode === 'playing') { pauseGame(); return; }
    if (game.mode === 'paused') { resumeGame(); return; }
  }

  if (e.repeat) return;

  keys.add(e.code);

  if (game.mode !== 'playing') return;
  if (e.code === 'Space') input.jumpPressed = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.dashPressed = true;
  if (e.code === 'KeyR') restartLevel();
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyF') toggleFullscreen();
});

window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let dragging = false;
const lastMouse = { x: 0, y: 0 };

canvas.addEventListener('click', () => {
  if (game.mode === 'playing') requestLock();
});

canvas.addEventListener('mousedown', (e) => {
  if (game.mode !== 'playing' || document.pointerLockElement === canvas) return;
  dragging = true;
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;
});

window.addEventListener('mouseup', () => { dragging = false; });

window.addEventListener('mousemove', (e) => {
  if (game.mode !== 'playing') return;
  if (document.pointerLockElement === canvas) {
    game.yaw -= e.movementX * 0.0024;
    game.pitch = clamp(game.pitch + e.movementY * 0.0021 * invertSign(), -0.08, 1.12);
  } else if (dragging) {
    game.yaw -= (e.clientX - lastMouse.x) * 0.005;
    game.pitch = clamp(game.pitch + (e.clientY - lastMouse.y) * 0.004, -0.08, 1.12);
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
  }
});

window.addEventListener('wheel', (e) => {
  if (game.mode !== 'playing') return;
  game.zoom = clamp(game.zoom + Math.sign(e.deltaY) * 0.8, 5, 20);
}, { passive: true });

function requestLock() {
  if (game.mode !== 'playing') return;
  try {
    if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
      // Newer browsers return a promise that rejects when the embedder blocks
      // pointer lock; swallow it because drag-look is a working fallback.
      const result = canvas.requestPointerLock();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
  } catch { /* user gesture required — drag-look still works */ }
}

document.addEventListener('pointerlockchange', () => {
  if (game.mode === 'playing' && document.pointerLockElement !== canvas) pauseGame();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.mode === 'playing') pauseGame();
});

// In the desktop build the window itself is fullscreen (it launches that way and
// F11 toggles it), which the browser Fullscreen API cannot see: no element is
// fullscreen and document.fullscreenElement stays null. Where the shell bridge
// exists, the row reports the window instead of the page.
const desktopShell = window.desktopShell || null;
let shellFullscreen = false;
if (desktopShell) {
  desktopShell.isFullscreen().then((on) => {
    shellFullscreen = on;
    repaintOptions();
  });
  desktopShell.onFullscreenChange((on) => {
    shellFullscreen = on;
    repaintOptions();
  });
}

function fullscreenLabel() {
  return (desktopShell ? shellFullscreen : !!document.fullscreenElement) ? 'On' : 'Off';
}

function toggleFullscreen() {
  if (desktopShell) {
    const on = !shellFullscreen;
    shellFullscreen = on; // the shell's change event confirms or corrects this
    desktopShell.setFullscreen(on);
    return;
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// ============================================================================
// Simulation
// ============================================================================
function interact() {
  const w = game.world;
  if (!w) return;
  const px = player.pos.x, py = player.pos.y, pz = player.pos.z;

  if (w.collectCrystals(px, py, pz) > 0) audio.collect();
  if (w.pressSwitch(px, py, pz) !== -1) { audio.switchOn(); toast('SWITCH PRESSED'); }
  if (w.touchCheckpoint(px, py, pz) !== -1) { audio.checkpoint(); toast('CHECKPOINT SAVED'); }

  if (w.checkHazards(px, py, pz)) { killPlayer(); return; }

  if (w.atPortal(px, py, pz)) {
    if (w.objectivesDone()) {
      completeLevel();
    } else if (game.portalHint <= 0) {
      game.portalHint = 2.4;
      audio.locked();
      toast(w.allCrystals() ? 'PORTAL SEALED — FIND THE SWITCHES' : 'PORTAL SEALED — COLLECT ALL CRYSTALS', 1900);
    }
  }
}

function updatePlaying(dt) {
  const w = game.world;
  if (!w) return;

  w.update(dt);
  game.timer += dt;
  game.portalHint = Math.max(0, game.portalHint - dt);

  if (keys.has('ArrowLeft')) game.yaw += dt * 2.0;
  if (keys.has('ArrowRight')) game.yaw -= dt * 2.0;
  if (pad.camX || pad.camY) {
    game.yaw -= pad.camX * dt * CAM_STICK_SPEED * camSpeed();
    game.pitch = clamp(game.pitch + pad.camY * dt * PITCH_STICK_SPEED * camSpeed() * invertSign(), -0.08, 1.12);
  }

  if (game.respawnIn > 0) {
    game.respawnIn -= dt;
    if (game.respawnIn <= 0) {
      respawnPlayer();
      updateHud();
    }
    return;
  }

  if (player.dead) return;

  const inp = readInput();
  if (pad.jump) inp.jumpPressed = true;
  if (pad.dash) inp.dashPressed = true;
  const steps = dt > 0.021 ? 2 : 1;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    game.lastVy = player.vy;
    player.update(h, inp, w, game.yaw, game);
    inp.jumpPressed = false;
    inp.dashPressed = false;
    if (player.dead) break;
    // Check pickups, hazards and the portal per physics step: at low frame
    // rates a dash covers enough ground to skip a laser or the portal plane.
    interact();
    if (game.mode !== 'playing') break;
  }

  updatePortalState();
  updateHud();
}

// ============================================================================
// Camera
// ============================================================================
window.addEventListener('gamepadconnected', () => toast('CONTROLLER CONNECTED', 1600));
window.addEventListener('gamepaddisconnected', () => toast('CONTROLLER DISCONNECTED', 1600));

const camTarget = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const camClamped = new THREE.Vector3();

// Where along the segment does it first enter this box? null if it misses.
function segmentBoxHit(from, to, b, pad) {
  let tmin = 0;
  let tmax = 1;
  const axes = [
    [from.x, to.x - from.x, b.min.x - pad, b.max.x + pad],
    [from.y, to.y - from.y, b.min.y - pad, b.max.y + pad],
    [from.z, to.z - from.z, b.min.z - pad, b.max.z + pad],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-6) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

// Keep the view in front of any platform between it and the player, so the
// camera stops clipping into geometry when you jump past a ledge.
function resolveCameraCollision(from, to) {
  const solids = game.world && game.world.solids;
  if (!solids) return to;
  let best = 1;
  for (const s of solids) {
    if (!s.solid || !s.box) continue;
    const t = segmentBoxHit(from, to, s.box, 0.3);
    if (t !== null && t > 0.001 && t < best) best = t;
  }
  if (best >= 1) return to;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const t = Math.max(0.12, best - 0.05);
  camClamped.set(from.x + dx * t, from.y + dy * t, from.z + dz * t);
  return camClamped;
}

function updateCamera(dt) {
  if (game.mode === 'menu' || game.mode === 'levels' || game.mode === 'controls') {
    if (!game.world) return;
    game.showcaseAngle += dt * 0.055;
    const c = game.world.center;
    const r = game.world.viewRadius * 0.76;
    camera.position.set(
      c.x + Math.cos(game.showcaseAngle) * r,
      c.y + r * 0.26,
      c.z + Math.sin(game.showcaseAngle) * r
    );
    camera.lookAt(c.x, c.y + 2.8, c.z);
    return;
  }

  if (!game.world || !player.group.visible) return;

  camTarget.set(player.pos.x, player.pos.y + 1.75, player.pos.z);
  const cp = Math.cos(game.pitch);
  const sp = Math.sin(game.pitch);
  // Narrow windows get a wider framing so the character is not cropped.
  const dist = game.zoom * clamp(1.45 / Math.max(camera.aspect, 0.62), 1, 1.4);
  camDesired.set(
    camTarget.x + Math.sin(game.yaw) * cp * dist,
    camTarget.y + sp * dist + 0.35,
    camTarget.z + Math.cos(game.yaw) * cp * dist
  );

  const minY = game.world.spec.bounds.minY - 22;
  if (camDesired.y < minY) camDesired.y = minY;

  const k = 1 - Math.exp(-dt * (game.mode === 'paused' ? 20 : 11));
  camera.position.lerp(camDesired, k);
  camera.position.copy(resolveCameraCollision(camTarget, camera.position));
  camera.lookAt(camTarget);

  const wantFov = 66 + (player.dashTime > 0 ? 7 : 0);
  if (Math.abs(camera.fov - wantFov) > 0.05) {
    camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 9);
    camera.updateProjectionMatrix();
  }
}

// ============================================================================
// Main loop
// ============================================================================
let lastTime = performance.now() / 1000;
let fpsFrames = 0;
let fpsTime = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  let dt = t - lastTime;
  lastTime = t;
  if (!Number.isFinite(dt) || dt < 0) dt = 1 / 60;
  dt = Math.min(dt, 0.05);

  if (settings.fps === 'on') {
    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      $('fps').textContent = `${Math.round(fpsFrames / fpsTime)} FPS`;
      fpsFrames = 0;
      fpsTime = 0;
    }
  }

  pollGamepad();
  handleControllerLink();
  if (touch) touch.update(dt);
  if (pad.start) {
    if (game.mode === 'playing') pauseGame();
    else if (game.mode === 'paused') resumeGame();
  }
  updatePadNav(dt);

  if (game.mode === 'playing') {
    updatePlaying(dt);
  } else if (game.mode !== 'paused' && game.world) {
    game.world.update(dt * 0.7);
  }

  updateCamera(dt);
  renderer.render(scene, camera);
}

// ============================================================================
// Wiring
// ============================================================================
$('btn-continue').addEventListener('click', () => {
  audio.resume();
  audio.ui();
  startLevel(Math.min(save.unlocked, LEVEL_COUNT - 1));
});
$('btn-levels').addEventListener('click', () => { audio.resume(); audio.ui(); openLevels(); });
$('btn-controls').addEventListener('click', () => { audio.resume(); audio.ui(); openControls(); });
$('btn-options').addEventListener('click', () => { audio.resume(); audio.ui(); openOptions(); });
$('btn-options-back').addEventListener('click', () => { audio.ui(); showMenu(); });
$('btn-levels-back').addEventListener('click', () => { audio.ui(); showMenu(); });
$('btn-controls-back').addEventListener('click', () => { audio.ui(); showMenu(); });
$('btn-resume').addEventListener('click', () => { audio.ui(); resumeGame(); });
$('btn-pad-lost-resume').addEventListener('click', () => { audio.ui(); resumeGame(); });
$('btn-pad-lost-menu').addEventListener('click', () => { audio.ui(); showMenu(); });
$('btn-restart').addEventListener('click', () => { audio.ui(); restartLevel(); });
$('btn-levels2').addEventListener('click', () => { audio.ui(); openLevels(); });
$('btn-mute2').addEventListener('click', toggleMute);
$('btn-rumble2').addEventListener('click', toggleRumble);
$('btn-quit').addEventListener('click', () => { audio.ui(); quitToDesktop(); });
$('btn-next').addEventListener('click', () => { audio.ui(); nextLevel(); });
$('btn-replay').addEventListener('click', () => { audio.ui(); restartLevel(); });
$('btn-menu2').addEventListener('click', () => { audio.ui(); showMenu(); });
$('btn-pause').addEventListener('click', () => pauseGame());
$('btn-mute').addEventListener('click', toggleMute);

// Moving the mouse onto another option takes the highlight with it, so the pad
// picks up where the pointer left off.
document.addEventListener('click', (e) => {
  const el = e.target && e.target.closest ? e.target.closest('button') : null;
  const i = el ? nav.items.indexOf(el) : -1;
  if (i >= 0 && i !== nav.index) {
    nav.index = i;
    paintFocus();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(renderScale());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

// Boot
updateMuteUi();
applySettings();
updateRumbleUi();
save.unlocked = clamp(save.unlocked, 0, LEVEL_COUNT - 1);
showMenu();
// On-screen controls exist only in the Android build (?mobile=1); null elsewhere.
const touch = initTouchControls({ pad, game });
requestAnimationFrame(frame);

// Handy for debugging in the console.
window.SKYBOUND = { game, player, save, settings, applySettings, startLevel, makeLevel, camera, renderer, scene, touch, audio, music };
