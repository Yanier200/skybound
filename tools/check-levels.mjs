// ============================================================================
// Level check — runs every one of the 600 generated levels through the real
// Player physics and fails if any of them is broken.
//
//   node tools/check-levels.mjs            # all 600, ~1 minute
//   node tools/check-levels.mjs --only=42  # one level, while debugging
//   node tools/check-levels.mjs --no-bot   # skip the auto-player (gaps only)
//
// What is a hard failure:
//   unbeatable   a jump between two consecutive platforms that no input clears
//                (tools/playtest.mjs tries every jump, double-jump, dash and
//                bounce-pad timing from the last safe spot on the platform)
//   crystals     fewer than 3 crystals, a crystal not above any platform, or a
//                crystal buried inside other geometry so it cannot be touched
//   geometry     platforms intersecting each other, a spawn or portal off its
//                platform, non-finite coordinates, degenerate sizes
//   determinism  two generations of the same index disagree, which would mean
//                level N no longer matches what players have already cleared
//
// The auto-player is reported but not fatal: it proves a route exists end to
// end, but its steering is a heuristic, so a stall is not evidence of an
// unbeatable level the way a failed gap test is.
// ============================================================================
import { LEVEL_COUNT, WORLD_SCALE, makeLevel } from '../js/levelgen.js';
import { buildWorld, closestPhase, gapPossible, playLevel, posOf } from './playtest.mjs';

const args = process.argv.slice(2);
const only = Number((args.find((a) => a.startsWith('--only=')) || '').split('=')[1]);
const skipBot = args.includes('--no-bot');
const single = Number.isInteger(only);

const problems = [];
const stalls = [];
const fail = (kind, tag, message) => problems.push({ kind, tag, message });

const EPS = 1e-6;
const finite = (...values) => values.every(Number.isFinite);

const onFootprint = (p, x, z, margin = 0) =>
  Math.abs(x - p.x) <= p.w / 2 + margin && Math.abs(z - p.z) <= p.d / 2 + margin;

const insideBox = (p, x, y, z, margin = 0) =>
  x > p.x - p.w / 2 - margin && x < p.x + p.w / 2 + margin &&
  z > p.z - p.d / 2 - margin && z < p.z + p.d / 2 + margin &&
  y > p.y - p.h - margin && y < p.y + margin;

let gapCount = 0;
let crystalCount = 0;
let botCleared = 0;
let levels = 0;

for (let index = 0; index < LEVEL_COUNT; index++) {
  if (single && index !== only) continue;
  levels++;

  const level = makeLevel(index);
  const tag = `L${String(level.number).padStart(3)} ${level.name}`;
  const plats = level.platforms;

  // ---------------------------------------------------------------- structure
  if (!level.name || !level.theme) fail('geometry', tag, 'missing name or theme');
  if (plats.length < 3) fail('geometry', tag, `only ${plats.length} platforms`);
  if (level.steps < 6 || level.steps > 22) fail('geometry', tag, `steps ${level.steps} outside 6..22`);
  if (!Number.isFinite(level.parTime) || level.parTime <= 0) fail('geometry', tag, `par time ${level.parTime}`);

  for (const [i, p] of plats.entries()) {
    if (!finite(p.x, p.y, p.z, p.w, p.d, p.h, p.amp)) fail('geometry', tag, `platform ${i} has a non-finite field`);
    if (p.w <= 0 || p.d <= 0 || p.h <= 0) fail('geometry', tag, `platform ${i} has a degenerate size`);
  }

  // Overlapping platforms mean a surface you cannot stand on or land past.
  for (let a = 0; a < plats.length; a++) {
    for (let b = a + 1; b < plats.length; b++) {
      const A = plats[a];
      const B = plats[b];
      if (A.kind === 'move' || B.kind === 'move') continue; // movers guard their own sweep
      const overlapXZ =
        Math.abs(A.x - B.x) < (A.w + B.w) / 2 - EPS &&
        Math.abs(A.z - B.z) < (A.d + B.d) / 2 - EPS;
      const overlapY = A.y - A.h < B.y - EPS && B.y - B.h < A.y - EPS;
      if (overlapXZ && overlapY) fail('geometry', tag, `platforms ${a} and ${b} intersect`);
    }
  }

  // Spawn and portal have to sit on their platforms.
  const first = plats[0];
  if (!onFootprint(first, level.spawn.x, level.spawn.z, 0.01)) fail('geometry', tag, 'spawn is off the first platform');
  if (!finite(level.spawn.x, level.spawn.y, level.spawn.z)) fail('geometry', tag, 'spawn has a non-finite field');
  const last = plats[plats.length - 1];
  if (!onFootprint(last, level.portal.x, level.portal.z, 0.01)) fail('geometry', tag, 'portal is off the last platform');
  if (!finite(level.portal.x, level.portal.y, level.portal.z)) fail('geometry', tag, 'portal has a non-finite field');

  // ----------------------------------------------------------------- crystals
  if (level.crystals.length < 3) fail('crystals', tag, `only ${level.crystals.length} crystals`);
  for (const c of level.crystals) {
    crystalCount++;
    if (!finite(c.x, c.y, c.z)) {
      fail('crystals', tag, 'crystal has a non-finite position');
      continue;
    }
    // Crystals sit 1.5 above their platform in generator space, so 1.5 ×
    // WORLD_SCALE once the whole course is scaled up.
    const hostIndex = plats.findIndex((p) => onFootprint(p, c.x, c.z) && Math.abs(c.y - (p.y + 1.5 * WORLD_SCALE)) < 0.05);
    if (hostIndex < 0) {
      fail('crystals', tag, `crystal at ${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)} is above no platform`);
      continue;
    }
    const buried = plats.some((p, i) => i !== hostIndex && insideBox(p, c.x, c.y, c.z, 0.15));
    if (buried) fail('crystals', tag, 'crystal is buried inside another platform');
  }

  // -------------------------------------------------------------- determinism
  if (JSON.stringify(makeLevel(index)) !== JSON.stringify(level)) {
    fail('determinism', tag, 'two generations of this index disagree');
  }

  // --------------------------------------------------------------- playability
  // Movers are evaluated at the phase that brings them closest, the way a
  // player waits for one.
  const positions = plats.map(posOf);
  for (let k = 0; k < plats.length; k++) {
    if (plats[k].kind !== 'move') continue;
    const toward = k + 1 < plats.length ? positions[k + 1] : positions[k - 1];
    positions[k] = closestPhase(plats[k], toward);
  }
  const world = buildWorld(level, positions);

  const plan = [];
  for (let k = 1; k < plats.length; k++) {
    const res = gapPossible(level, positions, world, k - 1, k);
    plan.push(res);
    gapCount++;
    if (res.ok) continue;
    const A = plats[k - 1];
    const B = plats[k];
    const edge = Math.hypot(positions[k].x - positions[k - 1].x, positions[k].z - positions[k - 1].z) -
      (A.w + B.w) / 4 - (A.d + B.d) / 4;
    fail('unbeatable', tag, `step ${k}: ${A.kind}->${B.kind} edge ${edge.toFixed(1)} rise ${(B.y - A.y).toFixed(1)}`);
  }

  if (!skipBot) {
    const bot = playLevel(level, positions, plan);
    if (bot.completed) botCleared++;
    else stalls.push(`${tag}: stuck at step ${bot.target}/${plats.length}, deaths ${bot.deaths}`);
  }
}

// ------------------------------------------------------------------- report
const count = (kind) => problems.filter((p) => p.kind === kind).length;
const line = (label, value) => console.log(`  ${label.padEnd(16)}${value}`);

console.log(`\nSKYBOUND level check — ${levels} level${levels === 1 ? '' : 's'}\n`);
line('playability', `${gapCount - count('unbeatable')} / ${gapCount} gaps crossable`);
line('crystals', `${crystalCount} placed, ${count('crystals')} broken`);
line('geometry', `${count('geometry')} problems`);
line('determinism', `${levels - count('determinism')} / ${levels} identical on regeneration`);
if (!skipBot) line('auto-player', `${botCleared} / ${levels} cleared end to end`);

if (problems.length) {
  console.log('\nFAILURES');
  for (const p of problems) console.log(`  [${p.kind}] ${p.tag}: ${p.message}`);
}
if (stalls.length) {
  console.log('\nauto-player stalls (route still proven by the gap tests):');
  for (const s of stalls.slice(0, 10)) console.log(`  ${s}`);
  if (stalls.length > 10) console.log(`  … ${stalls.length - 10} more`);
}

console.log(problems.length ? `\nFAILED — ${problems.length} problem(s)` : '\nOK — every level is playable with its crystals in reach');
process.exit(problems.length ? 1 : 0);
