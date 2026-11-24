import * as THREE from '../vendor/three.module.js';

// ============================================================================
// Shared procedural texture: a soft radial glow used by crystals, the portal
// and pads. Nothing is loaded from disk, so there are no missing textures.
// ============================================================================
let _glow = null;
export function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.65, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c);
  _glow.colorSpace = THREE.SRGBColorSpace;
  return _glow;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();

// ============================================================================
// Pooled instanced particles — every effect is a burst of these.
// ============================================================================
export class Particles {
  constructor(parent, capacity = 300) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.1, 0),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      capacity
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    parent.add(this.mesh);

    this.parts = [];
    for (let i = 0; i < capacity; i++) {
      this.parts.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 1, grav: 0, drag: 1 });
      this.mesh.setColorAt(i, _col.setRGB(1, 1, 1));
    }
    this.cursor = 0;
    this._hideAll();
  }

  _hideAll() {
    _scale.set(0, 0, 0);
    _q.identity();
    _pos.set(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) {
      this.mesh.setMatrixAt(i, _m.compose(_pos, _q, _scale));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  emit(x, y, z, opts = {}) {
    const p = this.parts[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    const spread = opts.spread ?? 3.2;
    p.life = p.max = opts.life ?? 0.6;
    p.x = x; p.y = y; p.z = z;
    p.vx = (opts.vx ?? 0) + (Math.random() - 0.5) * spread;
    p.vy = (opts.vy ?? 0) + Math.random() * spread * 0.8;
    p.vz = (opts.vz ?? 0) + (Math.random() - 0.5) * spread;
    p.size = opts.size ?? 1;
    p.grav = opts.gravity ?? 9;
    p.drag = opts.drag ?? 2.2;
    this.mesh.setColorAt(this.cursor === 0 ? this.capacity - 1 : this.cursor - 1, _col.set(opts.color ?? 0xffffff));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  burst(x, y, z, color, count = 10, opts = {}) {
    for (let i = 0; i < count; i++) {
      this.emit(x, y, z, {
        color,
        spread: opts.spread ?? 4,
        life: (opts.life ?? 0.6) * (0.6 + Math.random() * 0.7),
        size: (opts.size ?? 1) * (0.6 + Math.random() * 0.8),
        vy: opts.vy ?? 2,
        gravity: opts.gravity ?? 10,
      });
    }
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.parts[i];
      if (p.life <= 0) continue;
      any = true;
      p.life -= dt;
      if (p.life <= 0) {
        _scale.set(0, 0, 0);
        this.mesh.setMatrixAt(i, _m.compose(_pos.set(0, -9999, 0), _q.identity(), _scale));
        continue;
      }
      p.vy -= p.grav * dt;
      const drag = Math.max(0, 1 - p.drag * dt);
      p.vx *= drag; p.vy *= drag; p.vz *= drag;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      const t = p.life / p.max;
      const s = p.size * Math.min(1, t * 1.8) * 0.75;
      _scale.set(s, s, s);
      this.mesh.setMatrixAt(i, _m.compose(_pos.set(p.x, p.y, p.z), _q.identity(), _scale));
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
