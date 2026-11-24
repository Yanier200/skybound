// ============================================================================
// Headless playtest — drives the real Player controller (same physics as the
// game) across all 600 levels. tools/check-levels.mjs reuses these helpers.
//
//   gapPossible(): starts standing at the very edge of the source platform at
//   full run speed and tries several jump/dash/bounce strategies. If none
//   reaches the next platform, that jump is impossible even for a perfect
//   player.
//
//   playLevel(): a bot that walks to the edge, jumps, double-jumps, dashes and
//   rides bounce pads, chaining platforms from spawn to the portal.
//
// Moving platforms are evaluated at their closest phase (how a player waits
// for them). Crumbling tiles are solid (you get 0.9s to jump off).
// ============================================================================
import { pathToFileURL } from 'node:url';
import { Player, PLAYER } from '../js/player.js';
import { makeLevel, LEVEL_COUNT, WORLD_SCALE as S } from '../js/levelgen.js';

const DT = 1 / 120;
const stub = { onJump() {}, onLand() {}, onDash() {}, onBounce() {}, onFallOut() {} };
const player = new Player({ add() {} });

const RADIUS = PLAYER.radius;

export function posOf(p) {
  return { x: p.x, y: p.y, z: p.z };
}

export function closestPhase(p, toward) {
  if (p.kind !== 'move') return posOf(p);
  if (p.axis === 'y') {
    const sign = Math.sign(toward.y - p.y) || 1;
    return { x: p.x, y: p.y + sign * p.amp, z: p.z };
  }
  const sign = Math.sign((p.axis === 'x' ? toward.x - p.x : toward.z - p.z)) || 1;
  return {
    x: p.x + (p.axis === 'x' ? sign * p.amp : 0),
    y: p.y,
    z: p.z + (p.axis === 'z' ? sign * p.amp : 0),
  };
}

export function buildWorld(level, positions) {
  const solids = level.platforms.map((p, i) => {
    const q = positions[i];
    return {
      id: i,
      kind: p.kind,
      push: p.push || { x: 0, z: 0 },
      solid: true,
      delta: { x: 0, y: 0, z: 0 },
      spec: p,
      box: {
        min: { x: q.x - p.w / 2, y: q.y - p.h, z: q.z - p.d / 2 },
        max: { x: q.x + p.w / 2, y: q.y, z: q.z + p.d / 2 },
      },
    };
  });
  return { solids, fallLimit: level.bounds.minY - 40, onStand() {} };
}

// How far the player's centre can travel from (px,pz) along (nx,nz) before its
// AABB leaves the platform's safe footing.
function roomToRun(Ppos, P, px, pz, nx, nz) {
  const rx = P.w / 2 - RADIUS;
  const rz = P.d / 2 - RADIUS;
  const lx = px - Ppos.x;
  const lz = pz - Ppos.z;
  let t = Infinity;
  if (Math.abs(nx) > 1e-6) {
    const limit = nx > 0 ? rx - lx : lx + rx;
    t = Math.min(t, Math.max(0, limit / Math.abs(nx)));
  }
  if (Math.abs(nz) > 1e-6) {
    const limit = nz > 0 ? rz - lz : lz + rz;
    t = Math.min(t, Math.max(0, limit / Math.abs(nz)));
  }
  return t === Infinity ? 0 : t;
}

// True once the player has actually arrived on platform j: either the engine's
// own landing, a descent that crosses the stand height over its footprint, or a
// launcher throwing her up off it (a pad clears groundPlatform as it fires).
// pos.y is the body centre, so standing puts it RADIUS above the surface - the
// old band test accepted anything down to ~1m below the top, which credited
// jumps that only clipped the side of a platform.
function reached(solid, pos, prevY, vy) {
  if (!solid) return false;
  const b = solid.box;
  const stand = b.max.y + RADIUS;
  const over =
    pos.x + RADIUS > b.min.x && pos.x - RADIUS < b.max.x &&
    pos.z + RADIUS > b.min.z && pos.z - RADIUS < b.max.z;
  return over && ((vy <= 0 && prevY > stand && pos.y <= stand) ||
                  (prevY < stand && pos.y >= stand));
}

function startPlayer(x, y, z, facing) {
  player.reset({ x, y, z }, facing);
  player.vx = 0;
  player.vz = 0;
  player.vy = 0;
  player.jumpsUsed = 0;
  player.dashCd = 0;
  player.dashLeft = 1;
  player.coyote = 0.2;
  player.jumpBuffer = 0;
}

// ---------------------------------------------------------------- gap test
export function gapPossible(level, positions, world, i, j) {
  const A = level.platforms[i];
  const B = level.platforms[j];
  const Ap = positions[i];
  const Bp = positions[j];

  const dx = Bp.x - Ap.x;
  const dz = Bp.z - Ap.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len;
  const nz = dz / len;
  const camYaw = Math.atan2(-nx, -nz);

  // stand at the last safe spot before the edge
  const edge = roomToRun(Ap, A, Ap.x, Ap.z, nx, nz);
  const sx = Ap.x + nx * Math.max(0, edge - 0.05 * S);
  const sz = Ap.z + nz * Math.max(0, edge - 0.05 * S);

  // A human modulates how long they hold the stick: a full-speed jump clears a
  // wide gap, but on a short hop between two big platforms holding forward the
  // whole way sails clean over the target. Every mid-release below is a real
  // input, so the sweep only calls a gap impossible when no timing works.
  const strategies = [
    { name: 'walk', noJump: true },
    { name: 'single' },
    { name: 'single-short', release: 0.12 },
    { name: 'single-mid', release: 0.25 },
    { name: 'single-half', release: 0.4 },
    { name: 'single-late', release: 0.55 },
    { name: 'double-apex', double: 0.8 },
    { name: 'double-short', double: 0.8, release: 0.1 },
    { name: 'double-mid', double: 0.8, release: 0.3 },
    { name: 'dash-start', dash: 'start' },
    { name: 'double+dash', double: 0.8, dash: 'fall' },
  ];
  if (A.kind === 'bounce') {
    strategies.unshift(
      { name: 'bounce-horizontal', bounce: true },
      { name: 'bounce-vertical', bounce: true, vertical: true }
    );
    strategies.push({ name: 'bounce+double', bounce: true, vertical: true, double: 0.8 });
  }

  for (const strat of strategies) {
    startPlayer(sx, Ap.y + 0.02 * S, sz, Math.atan2(nx, nz));
    // A launcher is ridden standing still, then steered in the air; every other
    // takeoff is at full run speed.
    const launchSpeed = strat.vertical ? 0 : PLAYER.speed;
    player.vx = nx * launchSpeed;
    player.vz = nz * launchSpeed;
    player.grounded = true;

    const inp = { forward: 1, right: 0, jumpPressed: false, dashPressed: false };
    let jumped = false;
    let usedDouble = false;
    let usedDash = false;
    let ok = false;
    const releaseStep = strat.release ? Math.round(strat.release / DT) : Infinity;

    for (let step = 0; step < 4 * 120; step++) {
      inp.jumpPressed = false;
      inp.dashPressed = false;
      inp.forward = strat.vertical
        ? (player.vy < 0 && !player.grounded ? 1 : 0)
        : step > releaseStep ? 0 : 1;

      // A launcher fires on contact and a walk-off needs no jump at all, so
      // only the jumping strategies touch the jump button.
      if (!strat.bounce && !strat.noJump) {
        if (!jumped) {
          inp.jumpPressed = true;
          jumped = true;
        } else if (!player.grounded) {
          if (strat.double && !usedDouble && player.jumpsUsed < 2 && player.vy < strat.double) {
            inp.jumpPressed = true;
            usedDouble = true;
          }
          if (strat.dash && !usedDash && player.dashLeft > 0) {
            if (strat.dash === 'start' ? step > 2 : player.vy < -2.5) {
              inp.dashPressed = true;
              usedDash = true;
            }
          }
        }
      }

      const prevY = player.pos.y;
      player.update(DT, inp, world, camYaw, stub);

      if ((player.groundPlatform && player.groundPlatform.id === j) || reached(world.solids[j], player.pos, prevY, player.vy)) {
        ok = true;
      } else if (player.pos.y < Math.min(Ap.y, Bp.y) - 10 * S) {
        break;
      }
    }

    if (ok) return { ok: true, used: strat.name };
  }

  return { ok: false, used: null };
}

// ---------------------------------------------------------------- auto-play
export function playLevel(level, positions, plan) {
  const world = buildWorld(level, positions);
  const plats = level.platforms;
  startPlayer(level.spawn.x, level.spawn.y + 0.02 * S, level.spawn.z, level.spawnFacing);
  player.grounded = true;
  player.groundPlatform = world.solids[0];

  const inp = { forward: 1, right: 0, jumpPressed: false, dashPressed: false };
  let simTime = 0;
  let deaths = 0;
  let current = 0;
  let target = 1;
  let retries = 0;
  let jumpedThisGap = false;

  while (simTime < 120 && target < plats.length) {
    const P = plats[current];
    const Q = plats[target];
    const Pp = positions[current];
    const Qp = positions[target];
    const dx = Qp.x - Pp.x;
    const dz = Qp.z - Pp.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len;
    const nz = dz / len;
    const camYaw = Math.atan2(-nx, -nz);

    inp.forward = 1;
    inp.jumpPressed = false;
    inp.dashPressed = false;

    // Follow the verified solution for this specific gap instead of guessing:
    // that is what a player who has learned the jump would do.
    const used = plan[target - 1]?.used ?? 'single';

    const onSource = player.grounded && player.groundPlatform && player.groundPlatform.id === current;
    const room = roomToRun(Pp, P, player.pos.x, player.pos.z, nx, nz);
    const toTarget = Math.hypot(Qp.x - player.pos.x, Qp.z - player.pos.z);

    if (onSource && P.kind !== 'bounce' && used !== 'walk' && room < 0.45 * S && !jumpedThisGap) {
      inp.jumpPressed = true;
      jumpedThisGap = true;
    }
    if (!player.grounded) {
      if (used.includes('double') && player.jumpsUsed < 2 && player.vy < 0.8 && player.dashTime <= 0) {
        inp.jumpPressed = true;
      }
      if (used.includes('dash') && player.dashLeft > 0) {
        if (used.includes('start') ? player.vy > 0 : player.vy < -1.5) inp.dashPressed = true;
      }
    }

    const prevY = player.pos.y;
    player.update(DT, inp, world, camYaw, stub);
    simTime += DT;

    if ((player.groundPlatform && player.groundPlatform.id === target) || reached(world.solids[target], player.pos, prevY, player.vy)) {
      current = target;
      target++;
      retries = 0;
      jumpedThisGap = false;
      continue;
    }

    if (player.pos.y < level.bounds.minY - 12 * S) {
      deaths++;
      const Pp2 = positions[current];
      startPlayer(Pp2.x, Pp2.y + 0.02 * S, Pp2.z, Math.atan2(nx, nz));
      player.grounded = true;
      player.groundPlatform = world.solids[current];
      jumpedThisGap = false;
      retries++;
      if (retries > 3) return { completed: false, current, target, deaths, simTime };
    }
  }

  return { completed: target >= plats.length, current, target, deaths, simTime };
}

// ------------------------------------------------------------- run the sweep
export function sweep() {
let impossible = 0;
let needExtra = 0;
let totalGaps = 0;
const failures = [];
const botStuck = [];

for (let index = 0; index < LEVEL_COUNT; index++) {
  const level = makeLevel(index);
  const plats = level.platforms;
  const positions = plats.map(posOf);
  for (let k = 0; k < plats.length; k++) {
    if (plats[k].kind !== 'move') continue;
    const toward = k + 1 < plats.length ? positions[k + 1] : positions[k - 1];
    positions[k] = closestPhase(plats[k], toward);
  }

  const world = buildWorld(level, positions);
  let levelFail = 0;
  const gaps = [];

  for (let k = 1; k < plats.length; k++) {
    const res = gapPossible(level, positions, world, k - 1, k);
    gaps.push(res);
    totalGaps++;
    if (!res.ok) {
      levelFail++;
      impossible++;
      const A = plats[k - 1];
      const B = plats[k];
      const Ap = positions[k - 1];
      const Bp = positions[k];
      const ddx = Bp.x - Ap.x;
      const ddz = Bp.z - Ap.z;
      const dd = Math.hypot(ddx, ddz) || 1;
      const ux = ddx / dd;
      const uz = ddz / dd;
      const edgeGap = dd - (Math.abs(ux) * A.w + Math.abs(uz) * A.d) / 2 - (Math.abs(ux) * B.w + Math.abs(uz) * B.d) / 2;
      failures.push(
        `L${String(level.number).padStart(3)} ${level.name}: step ${k} edge ${edgeGap.toFixed(2)} rise ${(B.y - A.y).toFixed(2)} ` +
        `A=${A.kind}${A.kind === 'move' ? '/' + A.axis : ''} B=${B.kind}${B.kind === 'move' ? '/' + B.axis : ''}`
      );
    } else if (res.used !== 'single') {
      needExtra++;
    }
  }

  const bot = playLevel(level, positions, gaps);
  if (!bot.completed) {
    const gapOk = gaps[bot.target - 1] ? gaps[bot.target - 1].ok : null;
    botStuck.push(
      `L${String(level.number).padStart(3)} ${level.name}: stuck at step ${bot.target} (${bot.target + 1}/${plats.length}), ` +
      `deaths ${bot.deaths}, ${plats[bot.target - 1].kind}->${plats[bot.target].kind}, ` +
      `gap-test ${gapOk === null ? 'n/a' : gapOk ? 'PASS' : 'FAIL'}`
    );
  }

  if (level.number % 10 === 1 || level.number > 92) {
    console.log(
      `L${String(level.number).padStart(3)} ${level.name.padEnd(14)} plats=${String(plats.length).padStart(2)} ` +
      `impossible=${levelFail} bot=${bot.completed ? 'CLEAR' : 'STUCK@' + bot.target} ` +
      `deaths=${bot.deaths} t=${bot.simTime.toFixed(1)}s`
    );
  }
}

console.log('');
console.log(`gaps tested: ${totalGaps}`);
console.log(`impossible gaps: ${impossible}`);
console.log(`gaps needing more than a plain jump: ${needExtra}`);
console.log(`levels the bot could not finish: ${botStuck.length}`);
if (failures.length) {
  console.log('\nIMPOSSIBLE:');
  for (const f of failures) console.log('  ' + f);
}
if (botStuck.length) {
  console.log('\nBOT STUCK:');
  for (const b of botStuck) console.log('  ' + b);
}
return { totalGaps, impossible, needExtra, botStuck };
}

// Only sweep when run directly; importing this file must stay side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { impossible } = sweep();
  process.exit(impossible ? 1 : 0);
}
