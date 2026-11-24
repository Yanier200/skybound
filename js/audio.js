// Tiny WebAudio synth: no audio files, no missing sounds.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.3;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.value = v;
  }

  tone({ freq = 440, to = null, dur = 0.12, type = 'sine', vol = 0.5, delay = 0, attack = 0.005 }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.2, vol = 0.25, delay = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, Math.floor(rate * dur), rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    src.buffer = buffer;
    gain.gain.value = vol;
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(this.ctx.currentTime + delay);
  }

  jump() { this.tone({ freq: 340, to: 620, dur: 0.14, type: 'triangle', vol: 0.3 }); }
  doubleJump() {
    this.tone({ freq: 520, to: 880, dur: 0.15, type: 'triangle', vol: 0.28 });
    this.tone({ freq: 880, to: 1180, dur: 0.1, type: 'sine', vol: 0.12, delay: 0.06 });
  }
  land() { this.tone({ freq: 180, to: 90, dur: 0.1, type: 'sine', vol: 0.22 }); }
  dash() {
    this.tone({ freq: 760, to: 180, dur: 0.2, type: 'sawtooth', vol: 0.16 });
    this.noise({ dur: 0.16, vol: 0.12 });
  }
  bounce() { this.tone({ freq: 220, to: 900, dur: 0.22, type: 'sine', vol: 0.32 }); }
  collect() {
    this.tone({ freq: 880, to: 1320, dur: 0.1, type: 'triangle', vol: 0.24 });
    this.tone({ freq: 1320, dur: 0.12, type: 'sine', vol: 0.14, delay: 0.07 });
  }
  switchOn() {
    this.tone({ freq: 280, to: 460, dur: 0.12, type: 'square', vol: 0.16 });
    this.tone({ freq: 620, dur: 0.16, type: 'sine', vol: 0.14, delay: 0.09 });
  }
  checkpoint() {
    this.tone({ freq: 520, dur: 0.12, type: 'sine', vol: 0.24 });
    this.tone({ freq: 780, dur: 0.16, type: 'sine', vol: 0.2, delay: 0.1 });
  }
  hurt() {
    this.tone({ freq: 200, to: 55, dur: 0.34, type: 'sawtooth', vol: 0.28 });
    this.noise({ dur: 0.2, vol: 0.18 });
  }
  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone({ freq: f, dur: 0.42, type: 'triangle', vol: 0.22, delay: i * 0.11 }));
    this.tone({ freq: 1567.98, dur: 0.6, type: 'sine', vol: 0.16, delay: 0.46 });
  }
  locked() {
    this.tone({ freq: 150, dur: 0.1, type: 'square', vol: 0.12 });
    this.tone({ freq: 110, dur: 0.13, type: 'square', vol: 0.1, delay: 0.1 });
  }
  ui() { this.tone({ freq: 620, to: 760, dur: 0.07, type: 'sine', vol: 0.12 }); }
}
