// Streaming soundtrack. Each theme has its own long, seamless-looping track,
// streamed from disk through an <audio> element instead of decoded into memory:
// they are uncompressed PCM, so keeping a few in RAM is not an option, but the
// browser buffers only what it needs.
const TRACKS = {
  menu: { file: 'assets/music/menu.wav', title: 'Drifting In' },
  gardens: { file: 'assets/music/gardens.wav', title: 'Sky Gardens' },
  dunes: { file: 'assets/music/dunes.wav', title: 'Amber Dunes' },
  frost: { file: 'assets/music/frost.wav', title: 'Frost Hollow' },
  neon: { file: 'assets/music/neon.wav', title: 'Neon Grid' },
  ember: { file: 'assets/music/ember.wav', title: 'Ember Depths' },
  toxic: { file: 'assets/music/toxic.wav', title: 'Toxic Vault' },
  void: { file: 'assets/music/void.wav', title: 'Void Circuit' },
  sunset: { file: 'assets/music/sunset.wav', title: 'Sunset Rift' },
  crystal: { file: 'assets/music/crystal.wav', title: 'Crystal Reach' },
  spire: { file: 'assets/music/spire.wav', title: 'Final Spire' },
  credits: { file: 'assets/music/credits.wav', title: 'The Long Way Up' },
};

const FADE_MS = 900;

export class Music {
  constructor() {
    this.el = null;
    this.key = null;
    this.volume = 0.5;
    this.muted = false;
    this.timer = 0;
  }

  element() {
    if (this.el) return this.el;
    try {
      const el = new Audio();
      el.loop = true;
      el.preload = 'none';
      el.volume = 0;
      this.el = el;
    } catch {
      this.el = null;
    }
    return this.el;
  }

  label() {
    if (this.muted || this.volume <= 0) return 'Muted';
    const track = this.key && TRACKS[this.key];
    return track ? track.title : '—';
  }

  setMuted(m) {
    this.muted = m;
    this.aim();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.aim();
  }

  // Slide towards the target instead of jumping, so switching worlds or muting
  // mid-run does not thump.
  aim() {
    const el = this.element();
    if (!el) return;
    const target = this.muted ? 0 : this.volume;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const d = target - el.volume;
      if (Math.abs(d) < 0.02) {
        el.volume = target;
        clearInterval(this.timer);
        return;
      }
      el.volume = Math.max(0, Math.min(1, el.volume + d * 0.25));
    }, 40);
  }

  play(key) {
    // Themes carry an act suffix ("gardens-i", "neon-Dusk"); the soundtrack has
    // one track per base world, so fall back to the part before the hyphen.
    const base = String(key || '').split('-')[0];
    const resolved = TRACKS[key] ? key : TRACKS[base] ? base : null;
    const track = resolved && TRACKS[resolved];
    const el = this.element();
    if (!track || !el) return;
    key = resolved;
    if (this.key === key && !el.paused) {
      this.aim();
      return;
    }
    this.key = key;
    el.loop = true;
    if (!el.src.endsWith(track.file)) el.src = track.file;
    el.volume = 0;
    const started = el.play();
    if (started && typeof started.catch === 'function') started.catch(() => {});
    this.aim();
  }

  stop() {
    const el = this.element();
    if (!el) return;
    this.key = null;
    clearInterval(this.timer);
    el.pause();
    el.volume = 0;
  }
}
