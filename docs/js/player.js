import * as THREE from '../vendor/three.module.js';
import { clamp } from './rng.js';
import { WORLD_SCALE } from './levelgen.js';
import { buildAstronaut } from './astronaut.js';

// Every length and acceleration scales with the world, so the course plays
// exactly as it did while being 1.4x bigger on screen.
const S = WORLD_SCALE;

// The astronaut is drawn larger than its collision box on purpose: a purely
// visual size change, so the course, the speed and the reach all stay as they
// were. The boots sit at the model's origin, so scaling keeps them on the floor.
export const CHAR_SCALE = 1.16;

export const PLAYER = {
  radius: 0.34 * S,
  height: 1.5 * S,
  speed: 9.2 * S,
  accel: 64 * S,
  airAccel: 36 * S,
  gravity: 33 * S,
  maxFall: 30 * S,
  jump: 12.7 * S,
  doubleJump: 11.4 * S,
  dashSpeed: 25 * S,
  dashTime: 0.16,
  dashCooldown: 1.05,
};

const approach = (value, target, delta) => {
  if (value < target) return Math.min(value + delta, target);
  if (value > target) return Math.max(value - delta, target);
  return value;
};

const angleDelta = (a, b) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class Player {
  constructor(scene) {
    this.scene = scene;

    this.pos = new THREE.Vector3();
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.grounded = false;
    this.groundPlatform = null;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpsUsed = 0;
    this.dashTime = 0;
    this.dashCd = 0;
    this.dashLeft = 1;
    this.dashDirX = 0;
    this.dashDirZ = 1;
    this.dead = false;
    this.facing = 0;
    this.animTime = 0;
    this.squash = 0;

    this.group = new THREE.Group();
    this.model = new THREE.Group();
    this.group.add(this.model);
    scene.add(this.group);

    // A soft key light riding with the character keeps it readable when the
    // sun is behind it.
    const key = new THREE.PointLight(0xfff0dd, 14, 7 * WORLD_SCALE, 1.7);
    key.position.set(0.6, 3.2, 1.6);
    this.group.add(key);

    // Cool rim light behind it. Only the Quality preset lights it, which
    // separates the silhouette from the level behind.
    const rim = new THREE.PointLight(0xbfe8ff, 0, 6 * WORLD_SCALE, 2);
    rim.position.set(-0.6, 2.6, -1.6);
    this.group.add(rim);
    this.rim = rim;

    const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({
      color, roughness: 0.62, metalness: 0.0, ...extra,
    });
    this.mats = {
      suit: mat(0xe7eaf1, { roughness: 0.52 }), // white shell of the suit
      suitDark: mat(0x8e97a8, { roughness: 0.58 }), // joints, belt, plates
      pack: mat(0xb8bfcc, { roughness: 0.5, metalness: 0.25 }),
      glove: mat(0xd6dbe4, { roughness: 0.45 }),
      boot: mat(0x2b3140, { roughness: 0.4, metalness: 0.2 }),
      visor: mat(0x121b2c, { roughness: 0.12, metalness: 0.65 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x5ef2d0, emissive: 0x5ef2d0, emissiveIntensity: 1.6, roughness: 0.3 }),
      flame: new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, toneMapped: false }),
    };

    // Roughness as authored, so the graphics preset can gloss the model up or
    // flatten it back without losing the tuned look.
    this.baseRough = {};
    for (const [k, m] of Object.entries(this.mats)) {
      if (m && m.roughness != null) this.baseRough[k] = m.roughness;
    }

    this.buildModel();
    this.group.visible = false;
  }

  buildModel() {
    const rig = buildAstronaut(this.model, this.mats);
    this.joints = rig.joints;
    this.model.scale.setScalar(WORLD_SCALE * CHAR_SCALE);

    // Dash jets, trailing behind the pack.
    this.flames = [];
    for (const sx of [-1, 1]) {
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.42, 6), this.mats.flame);
      flame.position.set(sx * 0.09, 0.5, -0.2);
      flame.rotation.x = -Math.PI / 2;
      flame.visible = false;
      this.model.add(flame);
      this.flames.push(flame);
    }

    this.model.traverse((o) => {
      if (o.isMesh) o.frustumCulled = false;
    });
  }

  // Graphics preset: the character follows the same setting as the rest of the
  // scene. Quality gives it a rim light, glossier surfaces and a crisp
  // 4k shadow; Performance keeps it out of the shadow pass and
  // flattens the materials back.
  setQuality(q) {
    if (!q) return;
    const rough = q.rough ?? 1;
    for (const [k, base] of Object.entries(this.baseRough)) {
      const mat = this.mats[k];
      if (mat) mat.roughness = base * rough;
    }
    if (this.rim) this.rim.intensity = q.rim ?? 0;
    const cast = q.characterShadow !== false;
    this.model.traverse((o) => { if (o.isMesh) o.castShadow = cast; });
  }

  setAccent(hex) {
    this.mats.accent.color.setHex(hex);
    this.mats.accent.emissive.setHex(hex);
  }

  reset(spawn, facing = 0) {
    this.pos.set(spawn.x, spawn.y + 0.05, spawn.z);
    this.vx = this.vy = this.vz = 0;
    this.grounded = false;
    this.groundPlatform = null;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpsUsed = 0;
    this.dashTime = 0;
    this.dashCd = 0;
    this.dashLeft = 1;
    this.dead = false;
    this.squash = 0;
    this.facing = facing;
    this.group.visible = true;
    this.group.position.copy(this.pos);
    this.model.scale.setScalar(S * CHAR_SCALE);
    this.model.position.y = 0;
    this.model.rotation.set(0, 0, 0);
    this.flames.forEach((f) => (f.visible = false));
  }

  die() {
    this.dead = true;
    this.group.visible = false;
  }

  // ------------------------------------------------------------------ update
  update(dt, input, world, camYaw, game) {
    if (this.dead) return;
    this.animTime += dt;
    this.dashCd = Math.max(0, this.dashCd - dt);

    // Ride moving platforms.
    if (this.grounded && this.groundPlatform && this.groundPlatform.kind === 'move' && this.groundPlatform.solid) {
      const d = this.groundPlatform.delta;
      this.pos.x += d.x;
      this.pos.y += d.y;
      this.pos.z += d.z;
    }

    const wasGrounded = this.grounded;
    const prevPlatform = this.groundPlatform;
    if (wasGrounded) {
      this.jumpsUsed = 0;
      this.dashLeft = 1;
    }
    this.grounded = false;
    this.groundPlatform = null;

    // Camera-relative input.
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
    let dx = fx * input.forward + rx * input.right;
    let dz = fz * input.forward + rz * input.right;
    const mag = Math.hypot(dx, dz);
    if (mag > 1) { dx /= mag; dz /= mag; }

    // Dash.
    if (input.dashPressed && this.dashCd <= 0 && this.dashLeft > 0 && this.dashTime <= 0) {
      this.dashTime = PLAYER.dashTime;
      this.dashCd = PLAYER.dashCooldown;
      this.dashLeft = 0;
      const l = Math.hypot(dx, dz);
      if (l > 0.2) {
        this.dashDirX = dx / l;
        this.dashDirZ = dz / l;
      } else {
        this.dashDirX = Math.sin(this.facing);
        this.dashDirZ = Math.cos(this.facing);
      }
      this.facing = Math.atan2(this.dashDirX, this.dashDirZ);
      game.onDash(this);
    }

    if (this.dashTime > 0) {
      this.dashTime -= dt;
      this.vx = this.dashDirX * PLAYER.dashSpeed;
      this.vz = this.dashDirZ * PLAYER.dashSpeed;
      this.vy = Math.max(this.vy, 0) * 0.08;
      if (this.dashTime <= 0) { this.vx *= 0.7; this.vz *= 0.7; }
    } else {
      // Jump buffering + coyote time.
      if (input.jumpPressed) this.jumpBuffer = 0.14;
      this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
      if (this.jumpBuffer > 0) {
        if (wasGrounded || this.coyote > 0) {
          this.vy = PLAYER.jump;
          this.jumpsUsed = 1;
          this.jumpBuffer = 0;
          this.coyote = 0;
          this.squash = -0.8;
          game.onJump(this, false);
        } else if (this.jumpsUsed < 2) {
          this.vy = PLAYER.doubleJump;
          this.jumpsUsed = 2;
          this.jumpBuffer = 0;
          this.squash = -0.9;
          game.onJump(this, true);
        }
      }

      const accel = wasGrounded ? PLAYER.accel : PLAYER.airAccel;
      this.vx = approach(this.vx, dx * PLAYER.speed, accel * dt);
      this.vz = approach(this.vz, dz * PLAYER.speed, accel * dt);

      if (wasGrounded && prevPlatform && prevPlatform.kind === 'conveyor') {
        const push = prevPlatform.push;
        this.vx += push.x * dt * 2.4;
        this.vz += push.z * dt * 2.4;
      }

      this.vy -= PLAYER.gravity * dt;
      if (this.vy < -PLAYER.maxFall) this.vy = -PLAYER.maxFall;
    }

    // Integrate + resolve, axis by axis.
    this.moveAxis('x', this.vx * dt, world);
    this.moveAxis('z', this.vz * dt, world);
    this.moveAxis('y', this.vy * dt, world);

    // Landing / coyote bookkeeping.
    this.coyote = Math.max(0, this.coyote - dt);
    if (this.grounded) {
      this.coyote = 0.1;
      this.jumpsUsed = 0;
      this.dashLeft = 1;
      const gp = this.groundPlatform;
      if (gp) {
        if (gp.kind === 'bounce') {
          this.vy = 17.6 * S;
          this.pos.y += 0.02;
          this.grounded = false;
          this.groundPlatform = null;
          this.jumpsUsed = 0;
          this.dashLeft = 1;
          this.squash = -1;
          game.onBounce(this);
        } else {
          if (!wasGrounded) {
            this.squash = 1;
            game.onLand(this);
          }
          world.onStand(gp);
        }
      }
    }

    // visuals
    this.updateVisual(dt, dx, dz);

    if (this.pos.y < world.fallLimit) game.onFallOut();
  }

  moveAxis(axis, amount, world) {
    if (amount === 0) return;
    this.pos[axis] += amount;
    const r = PLAYER.radius, h = PLAYER.height;
    for (const s of world.solids) {
      if (!s.solid) continue;
      const b = s.box;
      if (
        this.pos.x + r <= b.min.x || this.pos.x - r >= b.max.x ||
        this.pos.z + r <= b.min.z || this.pos.z - r >= b.max.z ||
        this.pos.y + h <= b.min.y || this.pos.y >= b.max.y
      ) continue;

      if (axis === 'x') {
        if (amount > 0) this.pos.x = b.min.x - r - 0.001;
        else this.pos.x = b.max.x + r + 0.001;
        this.vx = 0;
      } else if (axis === 'z') {
        if (amount > 0) this.pos.z = b.min.z - r - 0.001;
        else this.pos.z = b.max.z + r + 0.001;
        this.vz = 0;
      } else {
        if (amount < 0) {
          this.pos.y = b.max.y + 0.001;
          this.vy = 0;
          this.grounded = true;
          this.groundPlatform = s;
        } else {
          this.pos.y = b.min.y - h - 0.001;
          if (this.vy > 0) this.vy = 0;
        }
      }
    }
  }

  updateVisual(dt, dx, dz) {
    const speed = Math.hypot(this.vx, this.vz);
    const moving = speed > 0.6;

    if (moving) {
      const target = Math.atan2(this.vx, this.vz);
      this.facing += angleDelta(target, this.facing) * Math.min(1, dt * 14);
    }
    this.group.rotation.y = this.facing;

    // squash & stretch (the model itself carries the world scale)
    this.squash += (0 - this.squash) * Math.min(1, dt * 9);
    const sy = 1 - this.squash * 0.22;
    const sxz = 1 + this.squash * 0.18;
    const scale = WORLD_SCALE * CHAR_SCALE;
    this.model.scale.set(scale * sxz, scale * sy, scale * sxz);

    const J = this.joints;
    const run = clamp(speed / PLAYER.speed, 0, 1);
    const t = this.animTime;
    const ph = t * (7.5 + 5.5 * run);

    if (this.grounded) {
      // Short, brisk strides: the legs swing from the hip, the knee lifts the
      // trailing boot, and the arms counter-swing like a moon walker's.
      const step = Math.sin(ph);
      const swing = step * 0.85 * run;

      J.hipL.rotation.x = swing;
      J.hipR.rotation.x = -swing;
      J.kneeL.rotation.x = Math.max(0, -step) * 0.9 * run;
      J.kneeR.rotation.x = Math.max(0, step) * 0.9 * run;
      J.ankleL.rotation.x = -step * 0.25 * run;
      J.ankleR.rotation.x = step * 0.25 * run;

      J.shoulderL.rotation.x = -swing * 0.8;
      J.shoulderR.rotation.x = swing * 0.8;
      J.shoulderL.rotation.z = 0.12;
      J.shoulderR.rotation.z = -0.12;
      J.elbowL.rotation.x = -0.35 - Math.max(0, -swing) * 0.5;
      J.elbowR.rotation.x = -0.35 - Math.max(0, swing) * 0.5;

      J.body.rotation.y = step * 0.10 * run;
      J.body.rotation.x = 0.05 * run;
      J.head.rotation.y = -step * 0.06 * run;
      J.head.rotation.x = 0;

      this.model.position.x = 0;
      this.model.position.y = Math.abs(step) * 0.035 * run;
      this.model.rotation.set(0, 0, 0);
    } else {
      // Tucked legs and open arms: a small figure falling through the sky.
      const rise = clamp(this.vy / (12 * WORLD_SCALE), -1, 1);
      J.hipL.rotation.x = -0.55;
      J.hipR.rotation.x = -0.25;
      J.kneeL.rotation.x = 0.95;
      J.kneeR.rotation.x = 0.65;
      J.ankleL.rotation.x = 0.25;
      J.ankleR.rotation.x = 0.25;
      J.shoulderL.rotation.x = -0.5 - rise * 0.2;
      J.shoulderR.rotation.x = -0.5 - rise * 0.2;
      J.shoulderL.rotation.z = 0.75;
      J.shoulderR.rotation.z = -0.75;
      J.elbowL.rotation.x = -0.5;
      J.elbowR.rotation.x = -0.5;
      J.body.rotation.set(-rise * 0.08, 0, 0);
      J.head.rotation.set(-rise * 0.05, 0, 0);

      this.model.position.x = 0;
      this.model.position.y = 0;
      this.model.rotation.x = clamp(-rise * 0.08, -0.12, 0.12);
    }

    const dashing = this.dashTime > 0;
    for (const f of this.flames) f.visible = dashing;
    if (dashing) {
      for (const f of this.flames) f.scale.setScalar(0.8 + Math.random() * 0.5);
      this.model.rotation.x = 0.3;
    }

    const bob = this.grounded ? Math.abs(Math.sin(t * 3)) * 0.012 : 0;
    this.group.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
  }

}
