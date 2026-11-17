// netlink.js — the browser side of the link cable (used by worker.js and the Node tests).
// The emulator never blocks: before each emulated frame, canRun() says whether the
// relay's data that frame needs has arrived; if not, the frame waits.
(function (root) {
  class D2Link {
    constructor(M, send) {
      this.M = M; this.send = send;           // send(Uint8Array | string)
      this.bundles = new Map();
      this.broken = false; this.waits = 0; this.waitMs = 0; this.recv = 0; this.sent = 0;
    }
    config(index, num, delay) { this.M._d2_net_config(index, num, delay); this.delay = delay; this.index = index; this.num = num; }
    onMessage(data) {
      const u8 = new Uint8Array(data);
      if (u8[0] !== 2 || u8.length < 5) return;
      const frame = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, true);
      this.bundles.set(frame, u8.slice(5)); this.recv++;
    }
    need() { return this.broken ? -1 : this.M._d2_net_need(); }
    canRun() { const n = this.need(); return n < 0 || this.bundles.has(n); }
    beforeRun() {
      const n = this.need(); if (n < 0) return;
      const b = this.bundles.get(n); if (!b) return;
      const M = this.M, p = M._malloc(b.length);
      M.HEAPU8.set(b, p); M._d2_net_push(n, p, b.length); M._free(p);
      this.bundles.delete(n);
    }
    afterRun() {
      const M = this.M, len = M._d2_net_out_len();
      if (len) {
        const seg = M._d2_net_seg(), p = M._d2_net_out_ptr();
        for (let o = 0; o + 4 + seg <= len; o += 4 + seg) {
          const msg = new Uint8Array(5 + seg);
          msg[0] = 1; msg.set(M.HEAPU8.subarray(p + o, p + o + 4 + seg), 1);
          this.send(msg); this.sent++;
        }
        M._d2_net_out_clear();
      }
      if (M._d2_net_reset_notice()) this.send(JSON.stringify({ t: 'reset' }));
    }
    breakLink() { this.broken = true; this.M._d2_net_break(); }
    stats() {
      const M = this.M;
      return { state: M._d2_net_state(), role: M._d2_net_role(), frame: M._d2_net_frame(), missing: M._d2_net_missing(),
        queued: this.bundles.size, waits: this.waits, waitMs: Math.round(this.waitMs), sent: this.sent, recv: this.recv, delay: this.delay };
    }
  }
  root.D2Link = D2Link;
  if (typeof module !== 'undefined') module.exports = { D2Link };
})(typeof self !== 'undefined' ? self : globalThis);
