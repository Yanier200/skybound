// SKYBOUND's playable character: a tiny astronaut assembled from primitives.
//
// A joint group sits at every pivot the controller animates, so the walk cycle,
// the jump pose and the squash all work by rotating groups — no skinning and no
// asset to load. The boots rest on y = 0, and the figure stands about 1.05 units
// tall, so it reads small next to a level's platforms while the collision box
// stays exactly as it was.
import * as THREE from '../vendor/three.module.js';

const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const BALL = (r, seg = 12) => new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1));

export const ASTRONAUT_HEIGHT = 1.05;

export function buildAstronaut(parent, mats) {
  const joints = {};

  const part = (geo, mat, x, y, z, node) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    node.add(m);
    return m;
  };

  const joint = (name, node, x, y, z) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    node.add(g);
    joints[name] = g;
    return g;
  };

  // Hips: the torso, the pack and both limbs hang off this group.
  const body = joint('body', parent, 0, 0.46, 0);
  part(BOX(0.30, 0.26, 0.19), mats.suit, 0, 0.13, 0, body); // chest
  part(BOX(0.27, 0.055, 0.175), mats.suitDark, 0, 0.005, 0, body); // belt
  part(BOX(0.20, 0.21, 0.09), mats.pack, 0, 0.14, -0.15, body); // life-support pack
  part(BOX(0.075, 0.05, 0.02), mats.accent, 0, 0.18, 0.10, body); // chest light

  // Helmet: white shell, dark visor across the front, stubby antenna.
  const head = joint('head', body, 0, 0.34, 0);
  part(BALL(0.155, 16), mats.suit, 0, 0.10, 0, head);
  // The visor has to sit proud of the shell or the white sphere hides it.
  const visor = part(BALL(0.13, 16), mats.visor, 0, 0.10, 0.105, head);
  visor.scale.set(1, 0.72, 0.5);
  part(BOX(0.018, 0.10, 0.018), mats.suitDark, 0.105, 0.25, -0.02, head);

  for (const side of [-1, 1]) {
    const L = side < 0 ? 'L' : 'R';

    // Arm: shoulder -> elbow -> glove.
    const sh = joint(`shoulder${L}`, body, side * 0.18, 0.23, 0);
    part(BOX(0.075, 0.17, 0.08), mats.suit, 0, -0.085, 0, sh);
    const el = joint(`elbow${L}`, sh, 0, -0.17, 0);
    part(BOX(0.07, 0.15, 0.075), mats.suitDark, 0, -0.07, 0, el);
    const wr = joint(`wrist${L}`, el, 0, -0.15, 0);
    part(BALL(0.055, 10), mats.glove, 0, -0.03, 0, wr);

    // Leg: hip -> knee -> boot, with the sole landing on y = 0.
    const hip = joint(`hip${L}`, body, side * 0.082, 0, 0);
    part(BOX(0.095, 0.20, 0.10), mats.suit, 0, -0.10, 0, hip);
    const knee = joint(`knee${L}`, hip, 0, -0.20, 0);
    part(BOX(0.088, 0.17, 0.092), mats.suit, 0, -0.085, 0, knee);
    const ankle = joint(`ankle${L}`, knee, 0, -0.17, 0);
    part(BOX(0.11, 0.075, 0.17), mats.boot, 0, -0.0525, 0.02, ankle);
  }

  return { joints, height: ASTRONAUT_HEIGHT };
}
