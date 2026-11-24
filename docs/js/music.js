// Streaming soundtrack: one looping track per world.
//
// The files are uncompressed PCM running to tens of megabytes, so they are
// streamed by an <audio> element rather than decoded into memory. That only
// works if the shells answer byte-range requests — see electron/main.cjs and
// android/src/com/skybound/game/MainActivity.java.
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

export class Music {
  constructor() {
    this.el = null;
    this.key = null;
    this.volume = 0.45;
    this.muted = false;
    this.fade = 0;
  }

  element() {
    if (this.el) return this.el;
    try {
      this.el = new Audio();
      this.el.loop = true;
      this.el.preload = 'none';
      this.el.volume = 0;
    } catch {
      this.el = null;
    }
    return this.el;
  }

  label() {
    if (this.muted || this.volume === 0) return 'Muted';
    const track = this.key && TRACKS[this.key];
    return track ? track.title : '—';
  }

  setMuted(muted) {
    this.muted = muted;
    this.aim();
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.aim();
  }

  // Themes carry an act suffix ("neon-Dusk", "gardens-i"); there is one track
  // per base world, so the suffix is dropped here rather than at every caller.
  play(theme) {
    const key = String(theme || '').split('-')[0];
    const track = TRACKS[key];
    const el = this.element();
    if (!track || !el) return;

    if (key !== this.key) {
      this.key = key;
      el.src = track.file;
      el.volume = 0;
    }
    el.play().catch(() => {}); // refused until a user gesture; retried next call
    this.aim();
  }

  stop() {
    this.key = null;
    if (this.el) this.el.pause();
  }

  // Slide to the target instead of jumping, so muting or changing world mid-run
  // never thumps.
  aim() {
    const el = this.element();
    if (!el) return;
    const target = this.muted ? 0 : this.volume;
    clearInterval(this.fade);
    this.fade = setInterval(() => {
      const next = el.volume + (target - el.volume) * 0.3;
      if (Math.abs(target - next) < 0.01) {
        el.volume = target;
        clearInterval(this.fade);
        return;
      }
      el.volume = next;
    }, 40);
  }
}
