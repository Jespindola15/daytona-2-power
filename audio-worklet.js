// Plays the interleaved stereo PCM that the emulated SCSP/DSB produce (sent
// from the worker every frame). Small queue; drops audio if it piles up.
class D2Audio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0; this.queued = 0; this.under = 0;
    this.port.onmessage = (e) => {
      const b = e.data; this.q.push(b); this.queued += b.length / 2;
      const max = sampleRate * 0.25;                 // > 250 ms queued: drop oldest
      while (this.queued > max && this.q.length > 1) { const d = this.q.shift(); this.queued -= (d.length - this.off) / 2; this.off = 0; }
    };
  }
  process(_, outputs) {
    const [L, R] = outputs[0];
    for (let i = 0; i < L.length; i++) {
      const b = this.q[0];
      if (!b) { L[i] = R[i] = 0; this.under++; continue; }
      L[i] = b[this.off]; R[i] = b[this.off + 1]; this.off += 2; this.queued--;
      if (this.off >= b.length) { this.q.shift(); this.off = 0; }
    }
    return true;
  }
}
registerProcessor('d2-audio', D2Audio);
