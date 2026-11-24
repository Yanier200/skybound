import * as THREE from '../vendor/three.module.js';
import { glowTexture, Particles } from './fx.js';
import { clamp, mulberry32 } from './rng.js';
import { PLAYER } from './player.js';
import { WORLD_SCALE } from './levelgen.js';

// Pickup and trigger radii are authored in the old metre scale.
const S = WORLD_SCALE;

const _v = new THREE.Vector3();

// Tapered block used for the rocky underside of each floating island.
function taperedBox(wTop, dTop, wBot, dBot, h) {
  const tx = wTop / 2, tz = dTop / 2, bx = wBot / 2, bz = dBot / 2, hy = h / 2;
  const verts = [];
  const quad = (a, b, c, d) => verts.push(a, b, c, a, c, d);

  const t1 = [-tx, hy, -tz], t2 = [-tx, hy, tz], t3 = [tx, hy, tz], t4 = [tx, hy, -tz];
  const b1 = [-bx, -hy, -bz], b2 = [-bx, -hy, bz], b3 = [bx, -hy, bz], b4 = [bx, -hy, -bz];

  quad(t1, t2, t3, t4);          // top (+y)
  quad(b1, b4, b3, b2);          // bottom (-y)
  quad(t2, b2, b3, t3);          // +z
  quad(t4, t1, b1, b4);          // -z
  quad(t3, t4, b4, b3);          // +x
  quad(t1, t2, b2, b1);          // -x

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts.flat(), 3));
  geo.computeVertexNormals();
  return geo;
}

export class World {
  constructor(scene, spec, quality = {}) {
    this.scene = scene;
    this.spec = spec;
    this.theme = spec.theme;
    // Graphics preset this level is built for: how many particles and stars to
    // draw, how much background decor to scatter, and how big the sun's shadow
    // map is. Everything else in the level is identical in every preset.
    this.q = { particles: 1, stars: 1, deco: 1, shadow: 2048, ...quality };
    this.time = 0;
    this.portalReady = false;
    this.root = new THREE.Group();
    this.root.name = `level-${spec.number}`;
    scene.add(this.root);

    this.solids = [];
    this.platformObjs = [];
    this.crystals = [];
    this.switches = [];
    this.checkpoints = [];
    this.hazards = [];
    this.deco = [];

    this.particles = new Particles(this.root, Math.max(64, Math.round(320 * this.q.particles)));
    this.respawnPoint = new THREE.Vector3(spec.spawn.x, spec.spawn.y + 0.05, spec.spawn.z);
    this.fallLimit = spec.bounds.minY - 16;

    const b = spec.bounds;
    this.center = new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    this.viewRadius = clamp(Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.85 + 16, 24, 78);

    this.makeMaterials();
    this.buildSky();
    this.buildLights();
    this.buildPlatforms();
    this.buildCrystals();
    this.buildSwitches();
    this.buildCheckpoints();
    this.buildHazards();
    this.buildPortal();
    this.buildDecor();

    this.scene.fog = new THREE.FogExp2(this.theme.fog, this.theme.fogDensity * 0.55);
    this.scene.background = new THREE.Color(this.theme.skyBottom);
  }

  // ------------------------------------------------------------- materials
  makeMaterials() {
    const t = this.theme;
    const std = (color, extra = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.04, flatShading: true, ...extra });
    const mix = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();

    this.mats = {
      slab: std(t.slab),
      slabDark: std(t.slabDark),
      deck: std(mix(t.slab, t.slabDark, 0.42)),
      rock: std(t.rock),
      rockDark: std(t.rockDark),
      rim: std(t.rim, { roughness: 0.62 }),
      accent: new THREE.MeshStandardMaterial({ color: t.accent, emissive: t.accent, emissiveIntensity: 1.5, roughness: 0.35 }),
      accent2: new THREE.MeshStandardMaterial({ color: t.accent2, emissive: t.accent2, emissiveIntensity: 1.2, roughness: 0.4 }),
      danger: new THREE.MeshStandardMaterial({ color: 0xff4d4d, emissive: 0xff2a10, emissiveIntensity: 1.25, roughness: 0.38, metalness: 0.25 }),
      metal: std(0x93a1b3, { roughness: 0.5, metalness: 0.45 }),
      deco: std(t.deco),
    };
    return this.mats;
  }

  // ------------------------------------------------------------------- sky
  buildSky() {
    const t = this.theme;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 24, 16),
      new THREE.ShaderMaterial({
        uniforms: {
          topColor: { value: new THREE.Color(t.skyTop) },
          bottomColor: { value: new THREE.Color(t.skyBottom) },
          glowColor: { value: new THREE.Color(t.sun) },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 topColor;
          uniform vec3 bottomColor;
          uniform vec3 glowColor;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y, -1.0, 1.0);
            float k = smoothstep(-0.34, 0.58, h);
            vec3 col = mix(bottomColor, topColor, k);
            // warm band just above the horizon
            float band = exp(-pow((h - 0.04) * 6.5, 2.0));
            col = mix(col, glowColor, band * 0.3);
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
    );
    sky.frustumCulled = false;
    this.root.add(sky);

    const starCount = Math.round(520 * this.q.stars);
    if (t.stars && starCount > 0) {
      const count = starCount;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const v = new THREE.Vector3().randomDirection().multiplyScalar(240);
        v.y = Math.abs(v.y) * 0.9 + 18;
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const stars = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ color: 0xdff2ff, size: 1.5, sizeAttenuation: true, transparent: true, opacity: 0.9, fog: false, depthWrite: false })
      );
      this.root.add(stars);
    }
  }

  // ---------------------------------------------------------------- lights
  buildLights() {
    const t = this.theme;
    const b = this.spec.bounds;

    const hemi = new THREE.HemisphereLight(t.hemiSky, t.hemiGround, 0.5);
    this.root.add(hemi);

    const sun = new THREE.DirectionalLight(t.sun, t.sunIntensity * 0.86);
    const spread = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.8 + 14;
    sun.position.set(this.center.x + spread * 0.8, this.center.y + spread * 0.72, this.center.z + spread * 0.5);
    sun.target.position.copy(this.center);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    sun.shadow.camera.left = -spread;
    sun.shadow.camera.right = spread;
    sun.shadow.camera.top = spread;
    sun.shadow.camera.bottom = -spread;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = spread * 4;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    this.root.add(sun);
    this.root.add(sun.target);
    this.sun = sun;

    const fill = new THREE.DirectionalLight(t.hemiSky, 0.22);
    fill.position.set(this.center.x - spread, this.center.y + spread * 0.4, this.center.z - spread);
    this.root.add(fill);
  }

  // ------------------------------------------------------------- platforms
  buildPlatforms() {
    for (const sp of this.spec.platforms) {
      const g = new THREE.Group();
      g.position.set(sp.x, sp.y, sp.z);

      let slabMat = this.mats.slab;
      if (sp.kind === 'crumble') {
        slabMat = this.mats.slab.clone();
        slabMat.color.setHex(this.theme.slabDark);
        slabMat.emissive = new THREE.Color(0xff5a1f);
        slabMat.emissiveIntensity = 0;
      }

      const slab = new THREE.Mesh(new THREE.BoxGeometry(sp.w, 0.5, sp.d), slabMat);
      slab.position.y = -0.25;
      slab.castShadow = true;
      slab.receiveShadow = true;
      g.add(slab);

      // Thin lip wrapped around the slab's side. It sits just below the top
      // face so the two surfaces never become coplanar (that caused z-fighting).
      const rim = new THREE.Mesh(new THREE.BoxGeometry(sp.w + 0.12, 0.18, sp.d + 0.12), this.mats.rim);
      rim.position.y = -0.22;
      rim.receiveShadow = true;
      g.add(rim);

      // Inset deck gives the top surface a second tone (and a sense of scale).
      if (sp.kind === 'static' || sp.kind === 'crumble') {
        const deck = new THREE.Mesh(new THREE.BoxGeometry(sp.w * 0.7, 0.05, sp.d * 0.7), this.mats.deck);
        deck.position.y = 0.005;
        deck.receiveShadow = true;
        g.add(deck);
      }

      const base = new THREE.Mesh(
        taperedBox(sp.w * 0.9, sp.d * 0.9, sp.w * 0.4, sp.d * 0.4, 1.25),
        this.mats.rock
      );
      base.position.y = -1.12;
      base.castShadow = true;
      base.receiveShadow = true;
      g.add(base);

      const obj = {
        spec: sp,
        kind: sp.kind,
        mesh: g,
        box: new THREE.Box3(),
        solid: true,
        state: 'idle',
        shakeTimer: 0,
        respawnTimer: 0,
        pos: new THREE.Vector3(sp.x, sp.y, sp.z),
        base: new THREE.Vector3(sp.x, sp.y, sp.z),
        delta: new THREE.Vector3(),
        push: sp.push,
        crumbleMat: sp.kind === 'crumble' ? slabMat : null,
        bouncePad: null,
        chevrons: [],
        convDir: null,
      };

      this.addPlatformDetails(g, sp, obj);

      this.setBox(obj, sp.x, sp.y, sp.z);
      this.root.add(g);
      this.platformObjs.push(obj);
      this.solids.push(obj);
    }
  }

  setBox(obj, x, y, z) {
    obj.box.min.set(x - obj.spec.w / 2, y - obj.spec.h, z - obj.spec.d / 2);
    obj.box.max.set(x + obj.spec.w / 2, y, z + obj.spec.d / 2);
  }

  addPlatformDetails(g, sp, obj) {
    if (sp.kind === 'move') {
      const geo = new THREE.BoxGeometry(0.17, 0.17, 0.17);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const light = new THREE.Mesh(geo, this.mats.accent);
          light.position.set(sx * (sp.w / 2 - 0.2), 0.06, sz * (sp.d / 2 - 0.2));
          g.add(light);
        }
      }
    }

    if (sp.kind === 'bounce') {
      const r = Math.min(sp.w, sp.d) * 0.32;
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.06, 0.13, 18), this.mats.accent);
      pad.position.y = 0.055;
      pad.receiveShadow = true;
      g.add(pad);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.12, 0.045, 8, 28), this.mats.accent);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.09;
      g.add(ring);
      obj.bouncePad = pad;
      obj.bounceRing = ring;
    }

    if (sp.kind === 'conveyor') {
      const dir = new THREE.Vector3(sp.push.x, 0, sp.push.z);
      if (dir.lengthSq() < 1e-5) dir.set(0, 0, 1);
      dir.normalize();
      obj.convDir = dir;
      const belt = new THREE.Mesh(new THREE.BoxGeometry(sp.w * 0.78, 0.06, sp.d * 0.78), this.mats.slabDark);
      belt.position.y = 0.035;
      belt.receiveShadow = true;
      g.add(belt);
      const barGeo = new THREE.BoxGeometry(0.16, 0.06, Math.min(sp.w, sp.d) * 0.5);
      for (let i = 0; i < 4; i++) {
        const bar = new THREE.Mesh(barGeo, this.mats.accent);
        bar.rotation.y = Math.atan2(dir.x, dir.z);
        bar.position.y = 0.075;
        g.add(bar);
        obj.chevrons.push(bar);
      }
    }
  }

  // -------------------------------------------------------------- crystals
  buildCrystals() {
    const geo = new THREE.OctahedronGeometry(0.44, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: this.theme.accent, emissive: this.theme.accent, emissiveIntensity: 1.25,
      roughness: 0.18, metalness: 0.25, flatShading: true,
    });
    const glowMat = new THREE.SpriteMaterial({
      map: glowTexture(), color: this.theme.accent, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    for (const c of this.spec.crystals) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(c.x, c.y, c.z);
      mesh.castShadow = true;
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(2.3, 2.3, 1);
      mesh.add(glow);
      this.root.add(mesh);
      this.crystals.push({ spec: c, mesh, collected: false, phase: Math.random() * Math.PI * 2 });
    }
  }

  // --------------------------------------------------------------- switches
  buildSwitches() {
    const plateMat = new THREE.MeshStandardMaterial({
      color: this.theme.accent2, emissive: this.theme.accent2, emissiveIntensity: 0.35,
      roughness: 0.45, metalness: 0.3, flatShading: true,
    });
    for (const s of this.spec.switches) {
      const g = new THREE.Group();
      g.position.set(s.x, s.y, s.z);
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.8, 0.14, 8), plateMat.clone());
      plate.position.y = 0.07;
      plate.receiveShadow = true;
      g.add(plate);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.05, 6, 24), this.mats.accent2);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.1;
      g.add(ring);
      this.root.add(g);
      this.switches.push({ spec: s, group: g, plate, ring, active: false, phase: Math.random() * 6.28 });
    }
  }

  // ------------------------------------------------------------ checkpoints
  buildCheckpoints() {
    for (const c of this.spec.checkpoints) {
      const g = new THREE.Group();
      g.position.set(c.x, c.y, c.z);
      const poleMat = this.mats.metal;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.7, 8), poleMat);
      pole.position.y = 0.85;
      pole.castShadow = true;
      g.add(pole);
      const flagMat = new THREE.MeshStandardMaterial({
        color: 0xdfe9f2, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.7, side: THREE.DoubleSide,
      });
      const flag = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.4, 0.05), flagMat);
      flag.position.set(0.34, 1.36, 0);
      flag.castShadow = true;
      g.add(flag);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.12, 10), this.mats.rim);
      base.position.y = 0.05;
      g.add(base);
      this.root.add(g);
      this.checkpoints.push({ spec: c, group: g, flag, flagMat, active: false, phase: Math.random() * 6.28 });
    }
  }

  // ---------------------------------------------------------------- hazards
  buildHazards() {
    for (const h of this.spec.hazards) {
      if (h.type === 'spikes') {
        const g = new THREE.Group();
        g.position.set(h.x, h.y, h.z);
        const basePlate = new THREE.Mesh(new THREE.BoxGeometry(h.w + 0.12, 0.1, h.d + 0.12), this.mats.rockDark);
        basePlate.position.y = 0.03;
        basePlate.receiveShadow = true;
        g.add(basePlate);
        const cols = Math.max(2, Math.round(h.w / 0.34));
        const rows = Math.max(2, Math.round(h.d / 0.34));
        const coneGeo = new THREE.ConeGeometry(0.15, h.h, 5);
        const inst = new THREE.InstancedMesh(coneGeo, this.mats.danger, cols * rows);
        const m = new THREE.Matrix4();
        let k = 0;
        for (let ix = 0; ix < cols; ix++) {
          for (let iz = 0; iz < rows; iz++) {
            const px = -h.w / 2 + (ix + 0.5) * (h.w / cols);
            const pz = -h.d / 2 + (iz + 0.5) * (h.d / rows);
            m.makeTranslation(px, h.h / 2 - 0.02, pz);
            inst.setMatrixAt(k++, m);
          }
        }
        inst.castShadow = true;
        inst.instanceMatrix.needsUpdate = true;
        g.add(inst);
        this.root.add(g);
        this.hazards.push({
          type: 'spikes',
          spec: h,
          box: new THREE.Box3(
            new THREE.Vector3(h.x - h.w / 2, h.y, h.z - h.d / 2),
            new THREE.Vector3(h.x + h.w / 2, h.y + h.h, h.z + h.d / 2)
          ),
        });
      }

      if (h.type === 'bar') {
        const g = new THREE.Group();
        g.position.set(h.x, h.y + h.height, h.z);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.36, 10), this.mats.metal);
        g.add(hub);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(h.len, 0.2, 0.2), this.mats.danger);
        bar.castShadow = true;
        g.add(bar);
        const capGeo = new THREE.SphereGeometry(0.14, 8, 6);
        for (const sx of [-1, 1]) {
          const cap = new THREE.Mesh(capGeo, this.mats.accent2);
          cap.position.x = sx * h.len / 2;
          g.add(cap);
        }
        this.root.add(g);
        this.hazards.push({ type: 'bar', spec: h, group: g });
      }

      if (h.type === 'laser') {
        const g = new THREE.Group();
        g.position.set(h.x, h.y, h.z);
        const core = new THREE.Mesh(
          new THREE.CylinderGeometry(0.11, 0.11, h.h, 8),
          new THREE.MeshBasicMaterial({ color: 0xffe6e6, transparent: true, opacity: 0.95, toneMapped: false })
        );
        core.position.y = h.h / 2;
        g.add(core);
        const glow = new THREE.Mesh(
          new THREE.CylinderGeometry(0.34, 0.34, h.h, 8, 1, true),
          new THREE.MeshBasicMaterial({
            color: 0xff3b30, transparent: true, opacity: 0.35,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
          })
        );
        glow.position.y = h.h / 2;
        g.add(glow);
        for (const y of [0.1, h.h - 0.1]) {
          const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.2, 10), this.mats.metal);
          cap.position.y = y;
          g.add(cap);
        }
        this.root.add(g);
        this.hazards.push({ type: 'laser', spec: h, group: g, curX: h.x, curZ: h.z });
      }
    }
  }

  // ----------------------------------------------------------------- portal
  buildPortal() {
    const p = this.spec.portal;
    const g = new THREE.Group();
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.facing || 0;

    const ringMat = new THREE.MeshStandardMaterial({
      color: this.theme.accent2, emissive: this.theme.accent2, emissiveIntensity: 0.9,
      roughness: 0.3, metalness: 0.4,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.16, 10, 40), ringMat);
    ring.castShadow = true;
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.62, 0.045, 6, 40), this.mats.accent2);
    const innerMat = new THREE.MeshBasicMaterial({
      color: this.theme.accent2, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const inner = new THREE.Mesh(new THREE.CircleGeometry(1.24, 40), innerMat);
    const haloMat = new THREE.SpriteMaterial({
      map: glowTexture(), color: this.theme.accent2, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.scale.set(3.8, 3.8, 1);

    g.add(ring, ring2, inner, halo);
    this.root.add(g);

    this.portal = {
      group: g, ring, ring2, inner, halo,
      ringMat, innerMat, haloMat,
      baseY: p.y,
      center: new THREE.Vector3(p.x, p.y, p.z),
    };
  }

  setPortalReady(ready) {
    if (this.portalReady === ready) return;
    this.portalReady = ready;
    if (!this.portal) return;
    const col = ready ? this.theme.accent : this.theme.accent2;
    this.portal.ringMat.color.setHex(col);
    this.portal.ringMat.emissive.setHex(col);
    this.portal.ringMat.emissiveIntensity = ready ? 2.4 : 0.7;
    this.portal.innerMat.color.setHex(col);
    this.portal.innerMat.opacity = ready ? 0.42 : 0.14;
    this.portal.haloMat.color.setHex(col);
    this.portal.haloMat.opacity = ready ? 0.8 : 0.32;
    this.portal.ring2.material = ready ? this.mats.accent : this.mats.accent2;
  }

  // -------------------------------------------------------------- decoration
  buildDecor() {
    const b = this.spec.bounds;
    const rng = mulberry32(this.spec.index * 7717 + 13);

    const rocks = Math.round(26 * this.q.deco);
    for (let i = 0; i < rocks; i++) {
      const geo = new THREE.IcosahedronGeometry(1, 0);
      const mesh = new THREE.Mesh(geo, i % 3 === 0 ? this.mats.deco : this.mats.rock);
      const ang = rng() * Math.PI * 2;
      const dist = 52 + rng() * 72;
      const s = 1.5 + rng() * 3.6;
      mesh.position.set(
        this.center.x + Math.cos(ang) * dist,
        b.minY - 20 + rng() * (b.maxY - b.minY + 8),
        this.center.z + Math.sin(ang) * dist
      );
      mesh.scale.set(s, s * (0.6 + rng() * 0.8), s);
      mesh.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.root.add(mesh);
      this.deco.push({ mesh, baseY: mesh.position.y, phase: rng() * 6.28, spin: (rng() - 0.5) * 0.12 });
    }

    const rings = Math.round(3 * this.q.deco);
    for (let i = 0; i < rings; i++) {
      const r = 10 + rng() * 8;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.5, 6, 48),
        new THREE.MeshStandardMaterial({
          color: this.theme.rim, emissive: this.theme.rim, emissiveIntensity: 0.15,
          roughness: 0.6, metalness: 0.4, transparent: true, opacity: 0.22,
        })
      );
      const ang = rng() * Math.PI * 2;
      const dist = 130 + rng() * 80;
      ring.position.set(this.center.x + Math.cos(ang) * dist, this.center.y + rng() * 30 - 8, this.center.z + Math.sin(ang) * dist);
      ring.rotation.set(rng() * 2, rng() * 2, rng() * 2);
      this.root.add(ring);
      this.deco.push({ mesh: ring, baseY: ring.position.y, phase: rng() * 6.28, spin: 0.02 + rng() * 0.05 });
    }
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    this.time += dt;
    const t = this.time;

    for (const p of this.platformObjs) {
      if (p.kind === 'move' && p.solid) {
        const sp = p.spec;
        const s = Math.sin(t * sp.speed + sp.phase) * sp.amp;
        const nx = p.base.x + (sp.axis === 'x' ? s : 0);
        const ny = p.base.y + (sp.axis === 'y' ? s : 0);
        const nz = p.base.z + (sp.axis === 'z' ? s : 0);
        p.delta.set(nx - p.pos.x, ny - p.pos.y, nz - p.pos.z);
        p.pos.set(nx, ny, nz);
        p.mesh.position.copy(p.pos);
        this.setBox(p, nx, ny, nz);
      }

      if (p.kind === 'crumble') {
        if (p.state === 'shaking') {
          p.shakeTimer -= dt;
          const k = 1 - Math.max(0, p.shakeTimer) / 0.85;
          p.mesh.position.set(
            p.base.x + (Math.random() - 0.5) * 0.1 * k,
            p.base.y + (Math.random() - 0.5) * 0.06 * k,
            p.base.z + (Math.random() - 0.5) * 0.1 * k
          );
          if (p.crumbleMat) p.crumbleMat.emissiveIntensity = 0.2 + k * 1.5;
          if (p.shakeTimer <= 0) {
            p.state = 'gone';
            p.solid = false;
            p.mesh.visible = false;
            p.respawnTimer = 3.0;
            this.particles.burst(p.base.x, p.base.y - 0.3, p.base.z, this.theme.slabDark, 16, { spread: 6, life: 0.8, size: 1.6, gravity: 14 });
          }
        } else if (p.state === 'gone') {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) {
            p.state = 'idle';
            p.solid = true;
            p.mesh.visible = true;
            p.mesh.position.copy(p.base);
            if (p.crumbleMat) p.crumbleMat.emissiveIntensity = 0;
            this.particles.burst(p.base.x, p.base.y, p.base.z, this.theme.rim, 10, { spread: 3, life: 0.5, size: 1.2 });
          }
        }
      }

      if (p.bouncePad) {
        const k = 1 + Math.sin(t * 3.2 + p.spec.idx) * 0.06;
        p.bouncePad.scale.set(k, 1, k);
        p.bounceRing.rotation.z = t * 1.2;
      }

      if (p.chevrons.length) {
        const span = Math.min(p.spec.w, p.spec.d) * 0.7;
        for (let i = 0; i < p.chevrons.length; i++) {
          const c = p.chevrons[i];
          const f = ((t * 0.55 + i / p.chevrons.length) % 1) * 2 - 1;
          c.position.x = p.convDir.x * f * span * 0.5;
          c.position.z = p.convDir.z * f * span * 0.5;
        }
      }
    }

    // crystals
    for (const c of this.crystals) {
      if (c.collected) continue;
      c.mesh.rotation.y += dt * 1.5;
      c.mesh.rotation.z = Math.sin(t * 1.1 + c.phase) * 0.16;
      c.mesh.position.y = c.spec.y + Math.sin(t * 2.1 + c.phase) * 0.14;
    }

    // switches
    for (const s of this.switches) {
      s.ring.rotation.z += dt * (s.active ? 2.4 : 0.6);
      const target = s.active ? 1.9 : 0.35;
      s.plate.material.emissiveIntensity += (target - s.plate.material.emissiveIntensity) * Math.min(1, dt * 6);
      if (s.active) s.group.position.y = s.spec.y + Math.sin(t * 4 + s.phase) * 0.03;
    }

    // checkpoint flags
    for (const c of this.checkpoints) {
      c.flag.rotation.y = Math.sin(t * 2.2 + c.phase) * 0.16;
      if (c.active) c.flagMat.emissiveIntensity = 0.7 + Math.sin(t * 4) * 0.25;
    }

    // hazards
    for (const h of this.hazards) {
      if (h.type === 'bar') {
        h.group.rotation.y = t * h.spec.speed + h.spec.phase;
      } else if (h.type === 'laser') {
        const off = Math.sin(t * h.spec.speed + h.spec.phase) * h.spec.amp;
        h.curX = h.spec.x + h.spec.axisX * off;
        h.curZ = h.spec.z + h.spec.axisZ * off;
        h.group.position.set(h.curX, h.spec.y, h.curZ);
      }
    }

    // portal
    if (this.portal) {
      const p = this.portal;
      p.group.rotation.z += dt * (this.portalReady ? 0.9 : 0.25);
      const pulse = 1 + Math.sin(t * (this.portalReady ? 3.4 : 1.4)) * (this.portalReady ? 0.05 : 0.02);
      p.group.scale.setScalar(pulse);
      p.group.position.y = p.baseY + Math.sin(t * 1.3) * 0.16;
      p.center.y = p.group.position.y;
      p.ring2.rotation.z -= dt * 1.6;
      if (this.portalReady) {
        p.haloMat.opacity = 0.68 + Math.sin(t * 4) * 0.14;
        if (Math.random() < dt * 12) {
          this.particles.emit(p.center.x, p.center.y, p.center.z, {
            color: this.theme.accent, spread: 3.2, life: 1.0, size: 1.2, gravity: -1.5, vy: 1.6,
          });
        }
      }
    }

    // decoration drift
    for (const d of this.deco) {
      d.mesh.position.y = d.baseY + Math.sin(t * 0.35 + d.phase) * 0.9;
      d.mesh.rotation.y += dt * d.spin;
    }

    this.particles.update(dt);
  }

  // -------------------------------------------------------------- gameplay
  onStand(p) {
    if (p.kind === 'crumble' && p.state === 'idle') {
      p.state = 'shaking';
      p.shakeTimer = 0.9;
    }
  }

  collectCrystals(px, py, pz) {
    let got = 0;
    const cy = py + PLAYER.height * 0.5;
    for (const c of this.crystals) {
      if (c.collected) continue;
      const dx = c.mesh.position.x - px;
      const dy = c.mesh.position.y - cy;
      const dz = c.mesh.position.z - pz;
      if (dx * dx + dy * dy * 0.55 + dz * dz < 1.55 * S * S) {
        c.collected = true;
        c.mesh.visible = false;
        got++;
        this.particles.burst(c.mesh.position.x, c.mesh.position.y, c.mesh.position.z, this.theme.accent, 14, {
          spread: 4.5, life: 0.7, size: 1.1, gravity: 4,
        });
      }
    }
    return got;
  }

  pressSwitch(px, py, pz) {
    for (let i = 0; i < this.switches.length; i++) {
      const s = this.switches[i];
      if (s.active) continue;
      const dx = s.spec.x - px, dz = s.spec.z - pz;
      if (dx * dx + dz * dz < 1.1 * S * S && py > s.spec.y - 0.6 * S && py < s.spec.y + 2 * S) {
        s.active = true;
        this.particles.burst(s.spec.x, s.spec.y + 0.4, s.spec.z, this.theme.accent2, 16, {
          spread: 4, life: 0.8, size: 1.2, gravity: 6,
        });
        return i;
      }
    }
    return -1;
  }

  touchCheckpoint(px, py, pz) {
    for (let i = 0; i < this.checkpoints.length; i++) {
      const c = this.checkpoints[i];
      if (c.active) continue;
      const dx = c.spec.x - px, dz = c.spec.z - pz;
      if (dx * dx + dz * dz < 1.6 * S * S && Math.abs(py - c.spec.y) < 1.6 * S) {
        c.active = true;
        c.flagMat.color.setHex(this.theme.accent);
        c.flagMat.emissive.setHex(this.theme.accent);
        c.flagMat.emissiveIntensity = 0.8;
        this.respawnPoint.set(c.spec.x, c.spec.y + 0.05, c.spec.z);
        this.particles.burst(c.spec.x, c.spec.y + 1.4, c.spec.z, this.theme.accent, 18, {
          spread: 3, life: 0.9, size: 1.1, gravity: 2,
        });
        return i;
      }
    }
    return -1;
  }

  checkHazards(px, py, pz) {
    const r = PLAYER.radius, top = py + PLAYER.height, low = py + 0.06 * S;
    for (const h of this.hazards) {
      if (h.type === 'spikes') {
        const b = h.box;
        if (
          px + r > b.min.x && px - r < b.max.x &&
          pz + r > b.min.z && pz - r < b.max.z &&
          top > b.min.y && low < b.max.y
        ) return true;
      } else if (h.type === 'bar') {
        const a = h.group.rotation.y;
        const hl = h.spec.len / 2;
        const ax = h.spec.x - Math.cos(a) * hl;
        const az = h.spec.z + Math.sin(a) * hl;
        const bx = h.spec.x + Math.cos(a) * hl;
        const bz = h.spec.z - Math.sin(a) * hl;
        const vx = bx - ax, vz = bz - az;
        const wx = px - ax, wz = pz - az;
        const len2 = vx * vx + vz * vz || 1;
        const k = clamp((wx * vx + wz * vz) / len2, 0, 1);
        const dx = px - (ax + vx * k), dz = pz - (az + vz * k);
        const barY = h.spec.y + h.spec.height;
        // bar is 0.2 thick (half-thickness 0.1) — use its drawn size so it only
        // hits once the bar actually overlaps the body, not 0.1 early
        if (dx * dx + dz * dz < (r + 0.1 * S) * (r + 0.1 * S) && top > barY - 0.28 * S && low < barY + 0.28 * S) return true;
      } else if (h.type === 'laser') {
        const dx = px - h.curX, dz = pz - h.curZ;
        const rad = r + 0.12 * S;
        if (dx * dx + dz * dz < rad * rad && top > h.spec.y - 0.2 * S && low < h.spec.y + h.spec.h) return true;
      }
    }
    return false;
  }

  atPortal(px, py, pz) {
    if (!this.portal) return false;
    const c = this.portal.center;
    const f = this.spec.portal.facing || 0;
    const dx = px - c.x, dz = pz - c.z;
    // Measure in the ring's own frame so the trigger matches the disc you can
    // see: `along` = how far in front of it, `side` = how far across it.
    // (The old sphere test fired more than a metre before touching the ring.)
    const along = dx * Math.sin(f) + dz * Math.cos(f);
    const side = dx * Math.cos(f) - dz * Math.sin(f);
    const up = py + PLAYER.height * 0.5 - c.y;
    return Math.abs(along) <= 0.55 * S && Math.abs(side) <= 1.2 * S && Math.abs(up) <= 1.45 * S;
  }

  crystalsCollected() {
    let n = 0;
    for (const c of this.crystals) if (c.collected) n++;
    return n;
  }

  switchesPressed() {
    let n = 0;
    for (const s of this.switches) if (s.active) n++;
    return n;
  }

  allCrystals() { return this.crystalsCollected() === this.crystals.length; }
  allSwitches() { return this.switchesPressed() === this.switches.length; }
  objectivesDone() { return this.allCrystals() && this.allSwitches(); }

  dispose() {
    this.scene.fog = null;
    // The sun's 2048² shadow map is a render target, not part of the scene
    // graph, so it has to be released by hand or every level leaks one.
    if (this.sun && this.sun.shadow && this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    const glow = glowTexture();
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map && m.map !== glow) m.map.dispose();
          m.dispose();
        }
      }
    });
    this.particles.dispose();
    this.root.removeFromParent();
    this.scene.background = null;
  }
}
