// Generates the SKYBOUND soundtrack: one long, seamless-looping WAV per world
// plus the menu and results cues. Everything is synthesised here — no samples,
// no dependencies — so the music can be regenerated or retuned at any time.
//
//   node tools/make-music.mjs              # every track
//   node tools/make-music.mjs --only=menu  # one track
//   node tools/make-music.mjs --seconds=20 # short previews
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'music');
const RATE = 44100;
// Loop length. Sized so the packaged APK lands on the 1.5 GB artifact target:
// the zip deflates PCM by ~5.7%, so 12 x 752 s at 44.1 kHz stereo comes to
// ~1.50 GB packed. Change this and both artifacts move.
const SECONDS = 752; // 12.5 minutes per track
const FADE = 3; // tail seconds blended into the head, so the loop point is silent
const TABLE = 4096;

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || fallback;
const only = flag('only', '');
const preview = Number(flag('seconds', 0)) || 0;

// Key, mode and mood per world, chosen against the palettes in levelgen.js.
const TRACKS = [
  { id: 'menu', root: 57, mode: 'ionian', bpm: 78, seed: 7, density: 0.5 },
  { id: 'gardens', root: 62, mode: 'lydian', bpm: 92, seed: 11, density: 0.7 },
  { id: 'dunes', root: 55, mode: 'dorian', bpm: 84, seed: 23, density: 0.6 },
  { id: 'frost', root: 60, mode: 'aeolian', bpm: 72, seed: 31, density: 0.45 },
  { id: 'neon', root: 59, mode: 'phrygian', bpm: 104, seed: 47, density: 0.85 },
  { id: 'ember', root: 53, mode: 'locrian', bpm: 96, seed: 59, density: 0.75 },
  { id: 'toxic', root: 58, mode: 'aeolian', bpm: 100, seed: 67, density: 0.8 },
  { id: 'void', root: 56, mode: 'phrygian', bpm: 88, seed: 73, density: 0.55 },
  { id: 'sunset', root: 61, mode: 'mixolydian', bpm: 90, seed: 83, density: 0.65 },
  { id: 'crystal', root: 63, mode: 'lydian', bpm: 80, seed: 97, density: 0.5 },
  { id: 'spire', root: 54, mode: 'aeolian', bpm: 112, seed: 101, density: 0.9 },
  { id: 'credits', root: 57, mode: 'ionian', bpm: 74, seed: 131, density: 0.4 },
];

const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

// Scale degrees, four bars each: the harmony drifts without ever resolving hard.
const CHORDS = [0, 5, 3, 4, 1, 5, 2, 4];

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Seeded PRNG for pitches, timing and levels, so a track renders the same every
// time; the hat noise is the one unseeded part, white noise by design.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Wavetables read through a phase accumulator, so the sample loops never call
// Math.sin.
function wave(fn) {
  const table = new Float32Array(TABLE);
  for (let i = 0; i < TABLE; i++) table[i] = fn(i / TABLE);
  return table;
}

const SINE = wave((p) => Math.sin(p * Math.PI * 2));
const TRIANGLE = wave((p) => (p < 0.5 ? -1 + 4 * p : 3 - 4 * p));
const SAW = wave((p) => Math.tanh((2 * p - 1) * 1.6) * 0.8);

function lookup(table, phase) {
  const x = (phase - Math.floor(phase)) * TABLE;
  const i = x | 0;
  const a = table[i & (TABLE - 1)];
  return a + (table[(i + 1) & (TABLE - 1)] - a) * (x - i);
}

// Each voice writes only into its own span, which keeps the render linear.
const span = (v, frames) => [Math.max(0, Math.floor(v.start * RATE)), Math.min(frames, Math.ceil(v.end * RATE))];

const VOICES = {
  pad(v, L, R, i0, i1) {
    const inc = v.hz / RATE;
    const lfoInc = (v.lfoHz * Math.PI * 2) / RATE;
    const attack = 1.8 * RATE;
    const release = 2.6 * RATE;
    const left = v.gain * (1 - Math.max(0, v.pan));
    const right = v.gain * (1 + Math.min(0, v.pan));
    let phase = v.phase;
    for (let i = i0; i < i1; i++) {
      const local = i - i0;
      const env = Math.min(1, local / attack, (i1 - i) / release);
      phase += inc * (1 + v.lfoDepth * Math.sin(local * lfoInc));
      const s = (lookup(SINE, phase) * 0.75 + lookup(TRIANGLE, phase * 0.5) * 0.25) * env;
      L[i] += s * left;
      R[i] += s * right;
    }
  },

  bass(v, L, R, i0, i1) {
    const inc = v.hz / RATE;
    const len = i1 - i0;
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const local = i - i0;
      const env = Math.min(1, local / (0.02 * RATE)) * Math.pow(1 - local / len, 2.2);
      phase += inc;
      const s = (lookup(SINE, phase) * 0.8 + lookup(TRIANGLE, phase) * 0.2) * env * v.gain;
      L[i] += s;
      R[i] += s;
    }
  },

  arp(v, L, R, i0, i1) {
    const inc = v.hz / RATE;
    const len = i1 - i0;
    const table = v.bright ? SAW : SINE;
    const left = 1 - Math.max(0, v.pan) * 0.7;
    const right = 1 + Math.min(0, v.pan) * 0.7;
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const local = i - i0;
      const env = Math.min(1, local / (0.008 * RATE)) * Math.pow(1 - local / len, 3.2);
      phase += inc;
      const s = lookup(table, phase) * env * v.gain;
      L[i] += s * left;
      R[i] += s * right;
    }
  },

  kick(v, L, R, i0, i1) {
    const len = i1 - i0;
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      phase += (46 + 90 * Math.pow(1 - (i - i0) / len, 5)) / RATE;
      const s = lookup(SINE, phase) * Math.pow(1 - (i - i0) / len, 4.5) * v.gain;
      L[i] += s;
      R[i] += s;
    }
  },

  hat(v, L, R, i0, i1) {
    const len = i1 - i0;
    let previous = 0;
    for (let i = i0; i < i1; i++) {
      const white = Math.random() * 2 - 1;
      const high = white - previous * 0.92; // crude high-pass
      previous = white;
      const s = high * Math.pow(1 - (i - i0) / len, 7) * v.gain;
      L[i] += s * 0.9;
      R[i] += s * 1.1;
    }
  },
};

function wav(L, R, frames, gain) {
  const data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + frames * 4, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); // fmt chunk size
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(2, 22); // stereo
  data.writeUInt32LE(RATE, 24);
  data.writeUInt32LE(RATE * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * 4, 40);

  const clamp = (s) => Math.max(-1, Math.min(1, s * gain)) * 32767;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(clamp(L[i]) | 0, o);
    data.writeInt16LE(clamp(R[i]) | 0, o + 2);
    o += 4;
  }
  return data;
}

function buildTrack(def) {
  const rand = rng(def.seed);
  const scale = MODES[def.mode] || MODES.aeolian;
  const loopSeconds = preview || SECONDS;
  const frames = Math.floor((loopSeconds + FADE) * RATE);
  const beat = 60 / def.bpm;
  const bar = beat * 4;
  const bars = Math.ceil((loopSeconds + FADE) / bar) + 2;

  const note = (step) => def.root + scale[step % 7] + 12 * Math.floor(step / 7);
  const chordAt = (b) => {
    const degree = CHORDS[Math.floor(b / 4) % CHORDS.length];
    return [0, 2, 4].map((step) => note(degree + step)); // root, third, fifth
  };

  const events = [];

  // Pad: three detuned voices per chord note, a new chord every four bars.
  for (let c = 0; c * 4 * bar < loopSeconds + FADE; c++) {
    const start = c * 4 * bar;
    const end = start + 4 * bar * 1.15;
    chordAt(c * 4).forEach((n, index) => {
      for (let d = 0; d < 3; d++) {
        events.push({
          type: 'pad',
          start,
          end,
          hz: midiToHz(n + 12) * (1 + (d - 1) * 0.0022),
          gain: 0.075 / (1 + index * 0.35),
          phase: rand() * TABLE,
          lfoHz: 0.05 + rand() * 0.09,
          lfoDepth: 0.0018 + rand() * 0.0025,
          pan: (d - 1) * 0.55,
        });
      }
    });
  }

  // Bass: the chord root each bar, with an octave-fifth answer on odd bars.
  for (let b = 0; b < bars; b++) {
    const root = chordAt(b)[0] - 12;
    events.push({ type: 'bass', start: b * bar, end: b * bar + bar * 0.9, hz: midiToHz(root), gain: 0.16 });
    if (b % 2 === 1) {
      events.push({ type: 'bass', start: b * bar + bar * 0.5, end: b * bar + bar * 0.9, hz: midiToHz(root + 7), gain: 0.1 });
    }
  }

  // Arpeggio: chord tones, sometimes an octave up, panned across the stereo field.
  const step = beat / 2;
  for (let s = 0; s * step < loopSeconds + FADE; s++) {
    if (rand() > 0.42 + def.density * 0.45) continue;
    const chord = chordAt(Math.floor((s * step) / bar));
    const pick = chord[(rand() * chord.length) | 0] + 12 + (rand() < 0.3 ? 12 : 0);
    events.push({
      type: 'arp',
      start: s * step + (rand() - 0.5) * 0.012,
      end: s * step + step * (1.4 + rand()),
      hz: midiToHz(pick),
      gain: 0.05 + rand() * 0.055,
      pan: rand() * 1.4 - 0.7,
      bright: rand() < 0.5,
    });
  }

  for (let b = 0; b < bars; b++) {
    const swing = b % 2 === 1 ? 0.012 : 0;
    if (def.density > 0.55 || b % 4 === 0) {
      events.push({ type: 'kick', start: b * bar, end: b * bar + 0.5, gain: 0.34 });
    }
    if (def.density > 0.7) {
      events.push({ type: 'kick', start: b * bar + beat * 2.5, end: b * bar + beat * 2.5 + 0.5, gain: 0.2 });
    }
    const perBar = def.density > 0.8 ? 8 : def.density > 0.6 ? 4 : 2;
    for (let h = 0; h < perBar; h++) {
      const at = b * bar + (h * bar) / perBar + swing;
      events.push({ type: 'hat', start: at, end: at + 0.09, gain: 0.05 + rand() * 0.035 });
    }
  }

  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (const v of events) VOICES[v.type](v, L, R, ...span(v, frames));

  // Master low-pass and saturation, for haze rather than raw table sound.
  const cut = 0.22 + def.density * 0.16;
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < frames; i++) {
    lpL += (L[i] - lpL) * cut;
    lpR += (R[i] - lpR) * cut;
    L[i] = Math.tanh(lpL * 1.4);
    R[i] = Math.tanh(lpR * 1.4);
  }

  // Crossfade the tail into the head so the loop is inaudible.
  const loopFrames = Math.floor(loopSeconds * RATE);
  const fadeFrames = Math.min(frames - loopFrames, Math.floor(FADE * RATE));
  for (let i = 0; i < fadeFrames; i++) {
    const w = i / fadeFrames;
    L[i] = L[i] * w + L[loopFrames + i] * (1 - w);
    R[i] = R[i] * w + R[loopFrames + i] * (1 - w);
  }

  // One level for every track, so switching worlds never jumps in volume.
  let peak = 0;
  for (let i = 0; i < loopFrames; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  return wav(L, R, loopFrames, peak > 0 ? 0.72 / peak : 1);
}

mkdirSync(OUT, { recursive: true });
let totalBytes = 0;
for (const def of TRACKS) {
  if (only && def.id !== only) continue;
  const started = Date.now();
  const data = buildTrack(def);
  writeFileSync(join(OUT, `${def.id}.wav`), data);
  totalBytes += statSync(join(OUT, `${def.id}.wav`)).size;
  console.log(`${def.id.padEnd(8)} ${(data.length / 1048576).toFixed(1).padStart(6)} MB  ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
console.log(`total ${(totalBytes / 1073741824).toFixed(2)} GB`);
