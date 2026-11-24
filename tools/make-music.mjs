// Generates the SKYBOUND soundtrack: one long, seamless-looping WAV track per
// theme plus a menu cue. Everything is synthesised here — no samples, no
// dependencies — so the music can be regenerated or retuned at any time.
//
//   node tools/make-music.mjs              # every track
//   node tools/make-music.mjs --only=menu  # one track
//   node tools/make-music.mjs --seconds=20 # short previews
//
// Tracks are 44.1 kHz, 16-bit stereo PCM, looped by the game with HTMLAudio, so
// the tail is crossfaded into the head to make the loop point inaudible.
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'music');
const RATE = 44100;

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const secondsArg = Number((args.find((a) => a.startsWith('--seconds=')) || '').split('=')[1]) || 0;

// ---------------------------------------------------------------------------
// Track definitions. Each theme gets a key, a mode and a mood; the numbers are
// picked against the palette in js/levelgen.js so the music matches the world.
// ---------------------------------------------------------------------------
const TRACKS = [
  { id: 'menu',      title: 'Drifting In',     root: 57, mode: 'ionian',   bpm: 78,  minutes: 11.4, seed: 7,  density: 0.5 },
  { id: 'gardens',   title: 'Sky Gardens',     root: 62, mode: 'lydian',   bpm: 92,  minutes: 11.4, seed: 11, density: 0.7 },
  { id: 'dunes',     title: 'Amber Dunes',     root: 55, mode: 'dorian',   bpm: 84,  minutes: 11.4, seed: 23, density: 0.6 },
  { id: 'frost',     title: 'Frost Hollow',    root: 60, mode: 'aeolian',  bpm: 72,  minutes: 11.4, seed: 31, density: 0.45 },
  { id: 'neon',      title: 'Neon Grid',       root: 59, mode: 'phrygian', bpm: 104, minutes: 11.4, seed: 47, density: 0.85 },
  { id: 'ember',     title: 'Ember Depths',    root: 53, mode: 'locrian',  bpm: 96,  minutes: 11.4, seed: 59, density: 0.75 },
  { id: 'toxic',     title: 'Toxic Vault',     root: 58, mode: 'aeolian',  bpm: 100, minutes: 11.4, seed: 67, density: 0.8 },
  { id: 'void',      title: 'Void Circuit',    root: 56, mode: 'phrygian', bpm: 88,  minutes: 11.4, seed: 73, density: 0.55 },
  { id: 'sunset',    title: 'Sunset Rift',     root: 61, mode: 'mixolydian', bpm: 90, minutes: 11.4, seed: 83, density: 0.65 },
  { id: 'crystal',   title: 'Crystal Reach',   root: 63, mode: 'lydian',   bpm: 80,  minutes: 11.4, seed: 97, density: 0.5 },
  { id: 'spire',     title: 'Final Spire',     root: 54, mode: 'aeolian',  bpm: 112, minutes: 11.4, seed: 101, density: 0.9 },
  { id: 'credits',   title: 'The Long Way Up',  root: 57, mode: 'ionian',   bpm: 74,  minutes: 11.4, seed: 131, density: 0.4 },
];

const MODES = {
  ionian:     [0, 2, 4, 5, 7, 9, 11],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
  locrian:    [0, 1, 3, 5, 6, 8, 10],
};

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Deterministic PRNG, so a track is identical every time it is generated.
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

// Wavetable oscillators: a sine table plus a few shaped ones, all read with a
// phase accumulator. Millions of samples go through these, so no Math.sin in
// the inner loop.
const TABLE = 4096;
const SINE = new Float32Array(TABLE);
for (let i = 0; i < TABLE; i++) SINE[i] = Math.sin((i / TABLE) * Math.PI * 2);

function lookup(table, phase) {
  const p = phase - Math.floor(phase);
  const x = p * TABLE;
  const i = x | 0;
  const f = x - i;
  const a = table[i & (TABLE - 1)];
  const b = table[(i + 1) & (TABLE - 1)];
  return a + (b - a) * f;
}

const SINE_T = SINE;
const TRI_T = new Float32Array(TABLE);
for (let i = 0; i < TABLE; i++) {
  const p = i / TABLE;
  TRI_T[i] = p < 0.5 ? -1 + 4 * p : 3 - 4 * p;
}
const SOFT_SAW = new Float32Array(TABLE);
for (let i = 0; i < TABLE; i++) {
  const p = i / TABLE;
  SOFT_SAW[i] = 2 * p - 1;
  // Round the hard edge so it does not buzz.
  SOFT_SAW[i] = Math.tanh(SOFT_SAW[i] * 1.6) * 0.8;
}

function buildTrack(def) {
  const rand = rng(def.seed);
  const scale = MODES[def.mode] || MODES.aeolian;
  const minutes = secondsArg ? secondsArg / 60 : def.minutes;
  const loopSeconds = Math.round(minutes * 60);
  const fade = 3; // seconds crossfaded into the head for a clean loop
  const total = loopSeconds + fade;
  const frames = Math.floor(total * RATE);

  // Left/right accumulators in float, mixed down at the end.
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);

  const beat = 60 / def.bpm;
  const bar = beat * 4;
  const bars = Math.ceil(total / bar) + 2;

  // Chord plan: a slow four-chord cycle through the mode, refreshed every four
  // bars so the harmony drifts without ever resolving hard.
  const chordDegrees = [0, 5, 3, 4, 1, 5, 2, 4];
  const chordAt = (barIndex) => {
    const deg = chordDegrees[Math.floor(barIndex / 4) % chordDegrees.length];
    const base = def.root + scale[deg % 7];
    return [base, base + scale[(deg + 2) % 7] - scale[deg % 7] + 3 || base + 3, base + 7, base + 12];
  };

  // --- pad -----------------------------------------------------------------
  const padVoices = [];
  for (let c = 0; c < bars / 4 + 1; c++) {
    const chord = chordAt(c * 4);
    const start = c * 4 * bar;
    const len = 4 * bar * 1.15;
    chord.slice(0, 3).forEach((note, vi) => {
      for (let d = 0; d < 3; d++) {
        padVoices.push({
          hz: midiToHz(note + 12) * (1 + (d - 1) * 0.0022),
          t0: start,
          t1: start + len,
          gain: 0.075 / (1 + vi * 0.35),
          phase: rand() * TABLE,
          lfoHz: 0.05 + rand() * 0.09,
          lfoDepth: 0.0018 + rand() * 0.0025,
          pan: (d - 1) * 0.55,
        });
      }
    });
  }

  // --- bass ----------------------------------------------------------------
  const bassNotes = [];
  for (let b = 0; b < bars; b++) {
    const chord = chordAt(b);
    const note = chord[0] - 12;
    bassNotes.push({ hz: midiToHz(note), t0: b * bar, dur: bar * 0.9, gain: 0.16 });
    if (b % 2 === 1) bassNotes.push({ hz: midiToHz(note + 7), t0: b * bar + bar * 0.5, dur: bar * 0.4, gain: 0.1 });
  }

  // --- arpeggio / melody ---------------------------------------------------
  const arpNotes = [];
  const step = beat / 2;
  for (let s = 0; s * step < total; s++) {
    if (rand() > 0.42 + def.density * 0.45) continue;
    const chord = chordAt(Math.floor((s * step) / bar));
    const pick = chord[(rand() * chord.length) | 0] + 12 + (rand() < 0.3 ? 12 : 0);
    arpNotes.push({
      hz: midiToHz(pick),
      t0: s * step + (rand() - 0.5) * 0.012,
      dur: step * (1.4 + rand()),
      gain: 0.05 + rand() * 0.055,
      pan: rand() * 1.4 - 0.7,
      bright: rand() < 0.5,
    });
  }

  // --- percussion ----------------------------------------------------------
  const kicks = [];
  const hats = [];
  for (let b = 0; b < bars; b++) {
    const swing = b % 2 === 1 ? 0.012 : 0;
    if (def.density > 0.55 || b % 4 === 0) kicks.push({ t0: b * bar, gain: 0.34 });
    if (def.density > 0.7) kicks.push({ t0: b * bar + beat * 2.5, gain: 0.2 });
    const hatsPerBar = def.density > 0.8 ? 8 : def.density > 0.6 ? 4 : 2;
    for (let h = 0; h < hatsPerBar; h++) {
      hats.push({ t0: b * bar + (h * bar) / hatsPerBar + swing, gain: 0.05 + rand() * 0.035 });
    }
  }

  // Cheap one-pole lowpass on the master, plus a soft saturation stage. Gives
  // the pads an analogue haze instead of the raw table sound.
  let lpL = 0;
  let lpR = 0;
  const cut = 0.22 + def.density * 0.16;

  const voices = [];
  for (const v of padVoices) voices.push({ ...v, type: 'pad' });
  for (const v of bassNotes) voices.push({ ...v, type: 'bass' });
  for (const v of arpNotes) voices.push({ ...v, type: 'arp' });
  for (const k of kicks) voices.push({ ...k, type: 'kick', t1: k.t0 + 0.5 });
  for (const h of hats) voices.push({ ...h, type: 'hat', t1: h.t0 + 0.09 });

  // Render voice by voice: each one only writes to its own span, which keeps
  // this linear instead of looping every voice over every frame.
  for (const v of voices) {
    const i0 = Math.max(0, Math.floor(v.t0 * RATE));
    const i1 = Math.min(frames, Math.ceil((v.t1 ?? v.t0 + v.dur) * RATE));
    if (i1 <= i0) continue;

    if (v.type === 'pad') {
      let phase = v.phase;
      const inc = v.hz / RATE;
      const len = i1 - i0;
      const attack = 1.8 * RATE;
      const release = 2.6 * RATE;
      const lfoInc = (v.lfoHz * Math.PI * 2) / RATE;
      const gl = v.gain * (1 - Math.max(0, v.pan));
      const gr = v.gain * (1 + Math.min(0, v.pan));
      for (let i = i0; i < i1; i++) {
        const local = i - i0;
        let env = 1;
        if (local < attack) env = local / attack;
        const tail = len - local;
        if (tail < release) env = Math.min(env, tail / release);
        const lfo = 1 + v.lfoDepth * Math.sin(local * lfoInc);
        phase += inc * lfo;
        const s = (lookup(SINE_T, phase) * 0.75 + lookup(TRI_T, phase * 0.5) * 0.25) * env;
        L[i] += s * gl;
        R[i] += s * gr;
      }
    } else if (v.type === 'bass') {
      let phase = 0;
      const inc = v.hz / RATE;
      const len = i1 - i0;
      for (let i = i0; i < i1; i++) {
        const local = i - i0;
        const p = local / len;
        const env = Math.min(1, local / (0.02 * RATE)) * Math.pow(1 - p, 2.2);
        phase += inc;
        const s = (lookup(SINE_T, phase) * 0.8 + lookup(TRI_T, phase) * 0.2) * env * v.gain;
        L[i] += s;
        R[i] += s;
      }
    } else if (v.type === 'arp') {
      let phase = 0;
      const inc = v.hz / RATE;
      const len = i1 - i0;
      const gl = 1 - Math.max(0, v.pan) * 0.7;
      const gr = 1 + Math.min(0, v.pan) * 0.7;
      for (let i = i0; i < i1; i++) {
        const local = i - i0;
        const p = local / len;
        const env = Math.min(1, local / (0.008 * RATE)) * Math.pow(1 - p, 3.2);
        phase += inc;
        const table = v.bright ? SOFT_SAW : SINE_T;
        const s = lookup(table, phase) * env * v.gain;
        L[i] += s * gl;
        R[i] += s * gr;
      }
    } else if (v.type === 'kick') {
      let phase = 0;
      const len = i1 - i0;
      for (let i = i0; i < i1; i++) {
        const p = (i - i0) / len;
        const hz = 46 + 90 * Math.pow(1 - p, 5);
        phase += hz / RATE;
        const s = lookup(SINE_T, phase) * Math.pow(1 - p, 4.5) * v.gain;
        L[i] += s;
        R[i] += s;
      }
    } else if (v.type === 'hat') {
      const len = i1 - i0;
      let prev = 0;
      for (let i = i0; i < i1; i++) {
        const p = (i - i0) / len;
        const white = rand() * 2 - 1;
        const hp = white - prev * 0.92; // crude high-pass
        prev = white;
        const s = hp * Math.pow(1 - p, 7) * v.gain;
        L[i] += s * 0.9;
        R[i] += s * 1.1;
      }
    }
  }

  // Filter, saturate, then crossfade the tail into the head.
  for (let i = 0; i < frames; i++) {
    lpL += (L[i] - lpL) * cut;
    lpR += (R[i] - lpR) * cut;
    L[i] = Math.tanh(lpL * 1.4);
    R[i] = Math.tanh(lpR * 1.4);
  }

  const loopFrames = Math.floor(loopSeconds * RATE);
  const fadeFrames = Math.min(frames - loopFrames, Math.floor(fade * RATE));
  for (let i = 0; i < fadeFrames; i++) {
    const w = i / fadeFrames;
    L[i] = L[i] * w + L[loopFrames + i] * (1 - w);
    R[i] = R[i] * w + R[loopFrames + i] * (1 - w);
  }

  // Normalise to a consistent level so tracks do not jump in volume.
  let peak = 0;
  for (let i = 0; i < loopFrames; i++) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const gain = peak > 0 ? 0.72 / peak : 1;

  const data = Buffer.alloc(44 + loopFrames * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + loopFrames * 4, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(2, 22); // stereo
  data.writeUInt32LE(RATE, 24);
  data.writeUInt32LE(RATE * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(loopFrames * 4, 40);

  let o = 44;
  for (let i = 0; i < loopFrames; i++) {
    const l = Math.max(-1, Math.min(1, L[i] * gain));
    const r = Math.max(-1, Math.min(1, R[i] * gain));
    data.writeInt16LE((l * 32767) | 0, o);
    data.writeInt16LE((r * 32767) | 0, o + 2);
    o += 4;
  }

  return { data, seconds: loopSeconds };
}

mkdirSync(OUT, { recursive: true });
let totalBytes = 0;
for (const def of TRACKS) {
  if (only && def.id !== only) continue;
  const started = Date.now();
  const { data, seconds } = buildTrack(def);
  const file = join(OUT, `${def.id}.wav`);
  writeFileSync(file, data);
  totalBytes += statSync(file).size;
  console.log(
    `${def.id.padEnd(8)} ${String(seconds).padStart(4)}s  ${(data.length / 1048576).toFixed(1).padStart(6)} MB  ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
console.log(`total ${(totalBytes / 1048576).toFixed(0)} MB`);
