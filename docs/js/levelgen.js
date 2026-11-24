// ============================================================================
// Level generation — 600 procedural levels across 60 worlds.
// Everything is deterministic: level N always looks and plays exactly the same.
// ----------------------------------------------------------------------------
// The ten original worlds are the palette; six "acts" re-tint them so the climb
// keeps changing look without sixty hand-picked palettes. Levels 1-100 keep the
// exact difficulty tuning they shipped with (the curve is pinned to 100).
// ============================================================================
import { mulberry32, clamp } from './rng.js';

export const LEVEL_COUNT = 600;
// The whole course is built 1.4x bigger so the full-size character fits on the
// platforms. Every length and every acceleration in the player scales with it,
// so jumps, gaps and timings are unchanged.
export const WORLD_SCALE = 1.4;
const TAU = Math.PI * 2;

const BASE_THEMES = [
  {
    id: 'gardens', label: 'Sky Gardens',
    skyTop: 0x041a22, skyBottom: 0x2f8f96, fog: 0x2f8f96, fogDensity: 0.0105,
    sun: 0xfff3d6, sunIntensity: 2.5, hemiSky: 0xc8f0ff, hemiGround: 0x2b5f52, ambient: 0.55,
    slab: 0x5fd6a9, slabDark: 0x3d9c7c, rock: 0x2f6f5e, rockDark: 0x214f45,
    rim: 0xc4ffe8, accent: 0xffd166, accent2: 0xff7f50,
    deco: 0x3f8271, cloud: 0xe6fff8, stars: 0,
  },
  {
    id: 'dunes', label: 'Amber Dunes',
    skyTop: 0x2b0b28, skyBottom: 0xd9683f, fog: 0x9c5a45, fogDensity: 0.011,
    sun: 0xffdcb0, sunIntensity: 2.6, hemiSky: 0xffd9b8, hemiGround: 0x6b4227, ambient: 0.55,
    slab: 0xe8b06a, slabDark: 0xb47a3e, rock: 0x7d4f2c, rockDark: 0x543521,
    rim: 0xffe6c0, accent: 0x6de0ff, accent2: 0xff5c7a,
    deco: 0x9b6b40, cloud: 0xffe6c9, stars: 0,
  },
  {
    id: 'frost', label: 'Frost Hollow',
    skyTop: 0x051a30, skyBottom: 0x3f7fa6, fog: 0x4a86a8, fogDensity: 0.0095,
    sun: 0xf2fbff, sunIntensity: 2.3, hemiSky: 0xd8f4ff, hemiGround: 0x33566b, ambient: 0.6,
    slab: 0xbfe6f7, slabDark: 0x7db4cf, rock: 0x4f7c99, rockDark: 0x33566b,
    rim: 0xffffff, accent: 0x7cf6ff, accent2: 0xff9ad5,
    deco: 0x6d9db8, cloud: 0xffffff, stars: 0,
  },
  {
    id: 'neon', label: 'Neon Grid',
    skyTop: 0x06010f, skyBottom: 0x2a0a4a, fog: 0x1d0733, fogDensity: 0.0135,
    sun: 0xd8b4ff, sunIntensity: 1.9, hemiSky: 0x7c3aed, hemiGround: 0x120726, ambient: 0.45,
    slab: 0x8b5cf6, slabDark: 0x6d28d9, rock: 0x2b1050, rockDark: 0x1a0932,
    rim: 0xf0abfc, accent: 0x22d3ee, accent2: 0xf472b6,
    deco: 0x4c1d95, cloud: 0x9d6bff, stars: 1,
  },
  {
    id: 'ember', label: 'Ember Depths',
    skyTop: 0x140303, skyBottom: 0x5c1a12, fog: 0x3a1009, fogDensity: 0.0145,
    sun: 0xffb59a, sunIntensity: 1.9, hemiSky: 0xff8a6b, hemiGround: 0x2a0b08, ambient: 0.42,
    slab: 0xd9534f, slabDark: 0x9b2f2b, rock: 0x3f1b18, rockDark: 0x260f0d,
    rim: 0xffb3a0, accent: 0xffb703, accent2: 0xff6b35,
    deco: 0x5a2620, cloud: 0xff9d7a, stars: 1,
  },
  {
    id: 'toxic', label: 'Toxic Vault',
    skyTop: 0x03110a, skyBottom: 0x24521f, fog: 0x1a3d1c, fogDensity: 0.013,
    sun: 0xdcffb0, sunIntensity: 2.0, hemiSky: 0xa6f27a, hemiGround: 0x14260f, ambient: 0.46,
    slab: 0x76c043, slabDark: 0x4c8a2c, rock: 0x2c4a24, rockDark: 0x1a2f16,
    rim: 0xd9ff9e, accent: 0xd4ff3f, accent2: 0x36f1cd,
    deco: 0x3f6b32, cloud: 0x9fe07a, stars: 0,
  },
  {
    id: 'void', label: 'Void Circuit',
    skyTop: 0x01040b, skyBottom: 0x0b2740, fog: 0x081c2d, fogDensity: 0.0125,
    sun: 0x9ce8ff, sunIntensity: 2.0, hemiSky: 0x2f7ca5, hemiGround: 0x050b13, ambient: 0.4,
    slab: 0x3a7ca5, slabDark: 0x255069, rock: 0x101f2e, rockDark: 0x0a1520,
    rim: 0x9ce8ff, accent: 0x00f5d4, accent2: 0x7b61ff,
    deco: 0x1b3448, cloud: 0x2f6d8f, stars: 1,
  },
  {
    id: 'sunset', label: 'Sunset Rift',
    skyTop: 0x1e072e, skyBottom: 0xb03f5e, fog: 0x8f3a55, fogDensity: 0.0115,
    sun: 0xffd9c2, sunIntensity: 2.4, hemiSky: 0xffc2b8, hemiGround: 0x451a2b, ambient: 0.55,
    slab: 0xff8a6b, slabDark: 0xc95b47, rock: 0x6b2a3f, rockDark: 0x451a2b,
    rim: 0xffd6c2, accent: 0x5eead4, accent2: 0xffe066,
    deco: 0x8a3f52, cloud: 0xffd0c2, stars: 0,
  },
  {
    id: 'crystal', label: 'Crystal Reach',
    skyTop: 0x0a2436, skyBottom: 0x5d93ad, fog: 0x6a9ab0, fogDensity: 0.0085,
    sun: 0xffffff, sunIntensity: 2.6, hemiSky: 0xeaffff, hemiGround: 0x3d6478, ambient: 0.62,
    slab: 0xd7f4ff, slabDark: 0x9fd0e4, rock: 0x5d8ea3, rockDark: 0x3d6478,
    rim: 0xffffff, accent: 0x66e0ff, accent2: 0xc4b5fd,
    deco: 0x86b4c8, cloud: 0xffffff, stars: 0,
  },
  {
    id: 'spire', label: 'Final Spire',
    skyTop: 0x050509, skyBottom: 0x362a17, fog: 0x1f1810, fogDensity: 0.0135,
    sun: 0xffe6a8, sunIntensity: 2.3, hemiSky: 0x6b5a30, hemiGround: 0x0a0806, ambient: 0.42,
    slab: 0xe8c46a, slabDark: 0xb08a3a, rock: 0x3a3226, rockDark: 0x241f18,
    rim: 0xfff3c4, accent: 0xffd166, accent2: 0xff4d6d,
    deco: 0x4a3f2a, cloud: 0x8a7550, stars: 1,
  },
];

// ---------------------------------------------------------------------- themes
// HSL round-trip so a palette can be re-tinted without losing its contrast.
function shiftHex(hex, deg) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  h = (h + deg / 360 + 1) % 1;
  const hue2rgb = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let rr = l;
  let gg = l;
  let bb = l;
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rr = hue2rgb(p, q, h + 1 / 3);
    gg = hue2rgb(p, q, h);
    bb = hue2rgb(p, q, h - 1 / 3);
  }
  const to = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (to(rr) << 16) | (to(gg) << 8) | to(bb);
}

const HUE_KEYS = [
  'skyTop', 'skyBottom', 'fog', 'sun', 'hemiSky', 'hemiGround',
  'slab', 'slabDark', 'rock', 'rockDark', 'rim', 'accent', 'accent2', 'deco', 'cloud',
];

const ACTS = [
  { tag: '', hue: 0 },
  { tag: 'Dusk', hue: 22 },
  { tag: 'Ember', hue: -28 },
  { tag: 'Neon', hue: 145 },
  { tag: 'Void', hue: 205 },
  { tag: 'Gilded', hue: 300 },
];

export const THEMES = [];
for (const act of ACTS) {
  for (const base of BASE_THEMES) {
    const theme = { ...base, id: `${base.id}-${act.tag || 'i'}` };
    theme.label = act.tag ? `${base.label} ${act.tag}` : base.label;
    if (act.hue) for (const key of HUE_KEYS) theme[key] = shiftHex(base[key], act.hue);
    THEMES.push(theme);
  }
}

// ----------------------------------------------------------------------- names
const NAMES = [
  ['First Light', 'Windward', 'Twin Arches', 'Petal Leap', 'Sunspill', 'Vine Run', 'Butterfly Gap', 'High Terrace', 'Glassbrook', 'The Canopy'],
  ['Dust Devil', 'Scarab', 'Mirage', 'Sunbaked', 'Oasis Run', 'Barchan', 'Red Mesa', "Nomad's Rest", 'Heat Haze', 'Dune Crest'],
  ['Thin Ice', 'Snowblind', 'Icicle Row', 'Frostbite', 'Glacier Step', 'Whiteout', 'Permafrost', 'Shiver', 'Avalanche', 'Crystal Cold'],
  ['Grid Zero', 'Circuit Break', 'Pulse Wave', 'Synth Run', 'Nightdrive', 'Datafall', 'Voltage', 'Arc Light', 'Overclock', 'Neon Rain'],
  ['Cinder', 'Magma Drop', 'Ashen Sky', 'Fireline', 'Furnace', 'Ember Fall', 'Scorched', 'Lava Bloom', 'Smoulder', 'The Forge'],
  ['Sludge', 'Acid Rain', 'Spore', 'Mire', 'Verdant Rot', 'Biohazard', 'Greenhouse', 'Toxin', 'Overgrowth', 'The Vat'],
  ['Null Point', 'Deep Field', 'Signal Lost', 'Dark Matter', 'Event Horizon', 'Starless', 'Quiet Void', 'Gravity Well', 'Static', 'The Beyond'],
  ['Rose Gold', 'Horizon', 'Dusk Run', 'Coral Sky', 'Last Light', 'Warm Front', 'Skyfall', 'Amber Hour', 'Twilight', 'Sundown'],
  ['Prism', 'Facet', 'Glacier Glass', 'Clear Sky', 'Refraction', 'Shard', 'Crystalline', 'Kaleido', 'Pure Light', 'Diamond Dust'],
  ['Threshold', 'Ascension', 'Gold Rush', 'The Climb', 'Finale', 'Apex', 'Summit', 'Hourglass', 'Coronation', 'The Spire'],
];

// Beyond the original 100 hand-named levels, names come from adjective/noun
// pairs chosen so no two of the 500 repeats.
const NAME_ADJ = [
  'Silent', 'Golden', 'Broken', 'Hollow', 'Bright', 'Crimson', 'Frozen', 'Restless', 'Hidden', 'Distant',
  'Quiet', 'Burning', 'Pale', 'Wild', 'Silver', 'Iron', 'Glass', 'Amber', 'Velvet', 'Storm',
  'Scarlet', 'Wandering', 'Lost', 'Waking', 'Shattered', 'Gentle', 'Bitter', 'Radiant', 'Fading', 'Ancient',
];
const NAME_NOUN = [
  'Ascent', 'Crossing', 'Ledge', 'Span', 'Reach', 'Hollow', 'Path', 'Ridge', 'Pinnacle', 'Drift',
  'Stair', 'Orbit', 'Garden', 'Circuit', 'Cascade', 'Terrace', 'Spiral', 'Gate', 'Vault', 'Run',
];

function levelName(n) {
  if (n < 100) return NAMES[Math.floor(n / 10)][n % 10];
  const i = n - 100;
  return `${NAME_ADJ[i % NAME_ADJ.length]} ${NAME_NOUN[Math.floor(i / NAME_ADJ.length) % NAME_NOUN.length]}`;
}

export function levelIndexMeta(index) {
  const n = clamp(index | 0, 0, LEVEL_COUNT - 1);
  const theme = THEMES[Math.min(THEMES.length - 1, Math.floor(n / 10))];
  return { index: n, name: levelName(n), theme };
}

/**
 * Multiply every length in a level by k. With the player's speeds and
 * accelerations scaled by the same factor the trajectories are identical, so
 * the course simply gets bigger.
 */
function scaleLevel(level, k) {
  const s = (v) => v * k;
  for (const p of level.platforms) {
    p.x = s(p.x); p.y = s(p.y); p.z = s(p.z);
    p.w = s(p.w); p.d = s(p.d); p.h = s(p.h);
    p.amp = s(p.amp);
    p.push = { x: s(p.push.x), z: s(p.push.z) };
  }
  for (const list of [level.crystals, level.switches, level.checkpoints]) {
    for (const c of list) { c.x = s(c.x); c.y = s(c.y); c.z = s(c.z); }
  }
  for (const h of level.hazards) {
    h.x = s(h.x); h.y = s(h.y); h.z = s(h.z);
    if (h.w != null) h.w = s(h.w);
    if (h.d != null) h.d = s(h.d);
    if (h.h != null) h.h = s(h.h);
    if (h.len != null) h.len = s(h.len);
    if (h.amp != null) h.amp = s(h.amp);
    if (h.height != null) h.height = s(h.height);
  }
  for (const key of ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ']) {
    level.bounds[key] = s(level.bounds[key]);
  }
  level.spawn = { x: s(level.spawn.x), y: s(level.spawn.y), z: s(level.spawn.z) };
  level.portal = { ...level.portal, x: s(level.portal.x), y: s(level.portal.y), z: s(level.portal.z) };
  return level;
}

/**
 * Build the data description of one level. No three.js here — pure data, so it
 * can be unit-checked in Node.
 *
 * Platform: { x, y (top surface), z, w, h, d, kind, axis, amp, speed, phase, push }
 * kind: static | move | crumble | bounce | conveyor
 */
export function makeLevel(index) {
  const n = clamp(index | 0, 0, LEVEL_COUNT - 1);
  const rng = mulberry32((0x9e3779b1 ^ Math.imul(n + 7, 0x85ebca6b)) >>> 0);
  // 0 → 1 across the original hundred, then pinned: levels 101-600 are all at
  // full difficulty, so the first campaign keeps the tuning it shipped with.
  const d = Math.min(1, n / 99);
  const meta = levelIndexMeta(n);

  const platforms = [];
  const crystals = [];
  const switches = [];
  const hazards = [];
  const checkpoints = [];

  const startSize = 6.6;
  platforms.push({
    x: 0, y: 0, z: 0, w: startSize, h: 1.5, d: startSize,
    kind: 'static', axis: 'x', amp: 0, speed: 1, phase: 0, push: { x: 0, z: 0 }, idx: 0,
  });

  const steps = Math.min(22, 6 + Math.floor(n / 5));
  let cx = 0, cy = 0, cz = 0;
  let dir = rng() * TAU;
  let prev = platforms[0];

  for (let i = 1; i <= steps; i++) {
    dir += (rng() - 0.5) * (0.5 + d * 1.0);

    let size = clamp((5.4 - d * 2.3) + rng() * 1.3, 2.5, 6.2);

    // Vertical step, biased gently upward, with occasional big climbs.
    let dy = (rng() - 0.4) * 2.6;
    let bigClimb = false;
    if (rng() < 0.09 && i > 2) { dy = 2.7 + rng() * 1.3; bigClimb = true; }
    // Hitting the ceiling/floor flips the step direction: drop the climb flag
    // too, or the pad below still becomes a launcher and shoots you upward at
    // a platform that is now *lower* than the pad.
    if (cy + dy > 16) { dy = -Math.abs(dy); bigClimb = false; }
    if (cy + dy < -9) { dy = Math.abs(dy); bigClimb = false; }

    // Horizontal gap measured between platform *edges*.
    let edge = 2.2 + rng() * 2.0 + d * 1.2;
    if (bigClimb) edge = Math.min(edge, 2.4);
    if (dy > 2) edge = Math.min(edge, 3.0);

    // Choose a platform personality.
    const roll = rng();
    let kind = 'static';
    let axis = 'x', amp = 0, speed = 1, phase = 0;
    let push = { x: 0, z: 0 };

    if (i >= 3 && roll < 0.13 + d * 0.13) {
      kind = 'move';
      const horizontal = rng() < 0.76;
      if (horizontal) {
        axis = rng() < 0.5 ? 'x' : 'z';
        amp = 1.1 + rng() * 0.6;
        if (bigClimb) dy = Math.min(dy, 0.4);
      } else {
        axis = 'y';
        amp = 0.8 + rng() * 0.6;
        dy = Math.min(dy, 0.6);
      }
      speed = 0.5 + rng() * 0.55;
      phase = rng() * TAU;
      edge = Math.min(edge, 2.4);
    } else if (i >= 4 && roll < 0.29) {
      kind = 'crumble';
      edge = Math.min(edge, 2.8);
    } else if (i >= 7 && roll < 0.37) {
      kind = 'conveyor';
      push = { x: Math.cos(dir) * (rng() < 0.5 ? -3.4 : 3.4), z: Math.sin(dir) * 3.4 };
    }

    // A big climb off a normal pad turns that pad into a launcher; otherwise
    // the step is clamped to a height a double jump can actually clear.
    if (bigClimb) {
      if (prev.kind === 'static') {
        prev.kind = 'bounce';
        // A launcher throws you straight up, so the landing platform needs
        // real horizontal clearance: without it you rise into the underside
        // of a platform hanging directly overhead and can never get over it.
        // It also has to be wide, because you touch down somewhere in the
        // middle of the pad and only get to steer from the top of the arc.
        edge = Math.max(edge, 1.9);
        dy = Math.min(dy, 3.2);
        size = Math.max(size, 5.0);
      } else {
        dy = Math.min(dy, 1.9);
      }
    }

    const gap = (prev.w + size) * 0.5 + edge;
    cx += Math.cos(dir) * gap;
    cz += Math.sin(dir) * gap;
    cy += dy;

    const p = {
      x: cx, y: cy, z: cz, w: size, h: 1.5, d: size,
      kind, axis, amp, speed, phase, push, idx: i,
    };
    platforms.push(p);
    prev = p;
  }

  // Moving platforms must never sweep into a neighbour — shrink their travel
  // until every extreme of the motion clears the surrounding geometry.
  for (const p of platforms) {
    if (p.kind !== 'move' || p.amp <= 0) continue;
    for (let guard = 0; guard < 12; guard++) {
      let clash = false;
      for (const sign of [1, -1]) {
        if (clash) break;
        const mx = p.x + (p.axis === 'x' ? p.amp * sign : 0);
        const my = p.y + (p.axis === 'y' ? p.amp * sign : 0);
        const mz = p.z + (p.axis === 'z' ? p.amp * sign : 0);
        for (const q of platforms) {
          if (q === p) continue;
          const bx = Math.abs(mx - q.x) - (p.w + q.w) / 2 - 0.3;
          const bz = Math.abs(mz - q.z) - (p.d + q.d) / 2 - 0.3;
          const by = my - p.h < q.y && q.y - q.h < my;
          if (bx < 0 && bz < 0 && by) { clash = true; break; }
        }
      }
      if (!clash) break;
      p.amp = Math.max(0.3, p.amp - 0.25);
    }
  }

  // The goal platform must always be stable.
  const last = platforms[platforms.length - 1];
  last.kind = 'static';
  last.amp = 0;
  last.push = { x: 0, z: 0 };

  // ---------------------------------------------------------------- crystals
  const hostable = [];
  for (let i = 1; i < platforms.length - 1; i++) {
    const p = platforms[i];
    if (p.kind === 'static' || p.kind === 'bounce' || p.kind === 'conveyor') hostable.push(i);
  }
  const used = new Set();
  const crystalCount = Math.min(8, 3 + Math.floor(n / 13));
  for (let k = 0; k < crystalCount && hostable.length; k++) {
    const slot = Math.min(hostable.length - 1, Math.floor(((k + 0.5) / crystalCount) * hostable.length));
    let idx = hostable[slot];
    let guard = 0;
    while (used.has(idx) && guard++ < hostable.length) idx = hostable[(slot + guard) % hostable.length];
    used.add(idx);
    const p = platforms[idx];
    crystals.push({
      x: p.x + (rng() - 0.5) * p.w * 0.3,
      y: p.y + 1.5,
      z: p.z + (rng() - 0.5) * p.d * 0.3,
    });
  }

  // ---------------------------------------------------------------- switches
  const switchCount = n >= 70 ? 3 : n >= 40 ? 2 : n >= 8 ? 1 : 0;
  for (let k = 0; k < switchCount && hostable.length; k++) {
    const slot = Math.min(hostable.length - 1, Math.floor(((k + 1) / (switchCount + 1)) * hostable.length));
    let idx = hostable[slot];
    let guard = 0;
    while (used.has(idx) && guard++ < hostable.length) idx = hostable[(slot + guard) % hostable.length];
    used.add(idx);
    const p = platforms[idx];
    switches.push({ x: p.x, y: p.y, z: p.z });
  }

  // -------------------------------------------------------------- checkpoint
  if (steps >= 8) {
    const mid = platforms.length / 2;
    const candidates = platforms
      .map((_, i) => i)
      .filter((i) => i > 0 && i < platforms.length - 1 && !used.has(i))
      .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));

    let chosen = -1;
    for (const i of candidates) {
      const kind = platforms[i].kind;
      if (kind === 'static' || kind === 'bounce' || kind === 'conveyor') { chosen = i; break; }
    }
    if (chosen < 0 && candidates.length) chosen = candidates[0];

    if (chosen >= 0) {
      const p = platforms[chosen];
      // A checkpoint needs solid footing. Movers and crumbling tiles are pinned;
      // bounce pads and conveyor belts are already solid, so they keep their role.
      if (p.kind === 'move' || p.kind === 'crumble') {
        p.kind = 'static';
        p.amp = 0;
        p.speed = 1;
        p.push = { x: 0, z: 0 };
      }
      checkpoints.push({ x: p.x, y: p.y, z: p.z });
      used.add(chosen);
    }
  }

  // ----------------------------------------------------------------- hazards
  const spikeChance = 0.16 + d * 0.26;
  const barChance = n >= 11 ? 0.1 + d * 0.16 : 0;
  for (let i = 2; i < platforms.length - 1; i++) {
    const p = platforms[i];
    if (p.kind !== 'static') continue;
    if (p.w * p.d < 14) continue;
    if (used.has(i)) continue;

    if (barChance > 0 && p.w >= 3.4 && rng() < barChance) {
      hazards.push({
        type: 'bar', x: p.x, y: p.y, z: p.z,
        len: Math.min(p.w, p.d) * 0.72,
        speed: (1.0 + rng() * 1.1) * (rng() < 0.5 ? 1 : -1),
        phase: rng() * TAU,
        height: 0.85,
      });
      continue;
    }

    if (n >= 4 && rng() < spikeChance) {
      // Corner patch, always at least 0.7 away from the platform centre so the
      // landing spot stays fair.
      const pw = Math.min(1.9, p.w * 0.46, p.w / 2 - 0.7);
      const pd = Math.min(1.9, p.d * 0.46, p.d / 2 - 0.7);
      if (pw >= 0.8 && pd >= 0.8) {
        const ox = (p.w / 2 - pw / 2) * (rng() < 0.5 ? -1 : 1);
        const oz = (p.d / 2 - pd / 2) * (rng() < 0.5 ? -1 : 1);
        hazards.push({
          type: 'spikes', x: p.x + ox, y: p.y, z: p.z + oz,
          w: pw, d: pd, h: 0.55,
        });
      }
    }
  }

  // Lasers sweep the gaps between platforms.
  if (n >= 13) {
    let lasers = 0;
    const maxLasers = 1 + (n >= 35 ? 1 : 0) + (n >= 75 ? 1 : 0);
    for (let i = 1; i < platforms.length - 2 && lasers < maxLasers; i++) {
      if (rng() > 0.24) continue;
      const a = platforms[i];
      const b = platforms[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const dist = Math.hypot(dx, dz) || 1;
      const perpX = -dz / dist, perpZ = dx / dist;
      hazards.push({
        type: 'laser',
        x: (a.x + b.x) * 0.5,
        y: Math.min(a.y, b.y) - 1.4,
        z: (a.z + b.z) * 0.5,
        h: 6.2,
        axisX: perpX, axisZ: perpZ,
        amp: 1.7 + rng() * 1.1,
        speed: 0.7 + rng() * 0.6,
        phase: rng() * TAU,
      });
      lasers++;
    }
  }

  // ------------------------------------------------------------------ bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of platforms) {
    minX = Math.min(minX, p.x - p.w / 2); maxX = Math.max(maxX, p.x + p.w / 2);
    minY = Math.min(minY, p.y - 3);       maxY = Math.max(maxY, p.y + 3);
    minZ = Math.min(minZ, p.z - p.d / 2); maxZ = Math.max(maxZ, p.z + p.d / 2);
  }
  const bounds = { minX, maxX, minY, maxY, minZ, maxZ };

  // Face the player down the course on spawn: the model and camera both use it.
  const first = platforms[0];
  const next = platforms[1];
  const spawnFacing = Math.atan2(next.x - first.x, next.z - first.z);
  // The portal turns its face back down the path you arrive from.
  const beforeGoal = platforms[platforms.length - 2] || first;
  const portalFacing = Math.atan2(beforeGoal.x - last.x, beforeGoal.z - last.z);

  const level = {
    index: n,
    number: n + 1,
    name: meta.name,
    theme: meta.theme,
    platforms,
    crystals,
    switches,
    checkpoints,
    hazards,
    spawn: { x: platforms[0].x, y: platforms[0].y + 0.02, z: platforms[0].z },
    spawnFacing,
    portal: { x: last.x, y: last.y + 1.6, z: last.z, facing: portalFacing },
    bounds,
    steps,
    parTime: Math.round(8 + steps * 2.9 + crystals.length * 1.6 + switches.length * 3),
  };
  return scaleLevel(level, WORLD_SCALE);
}
