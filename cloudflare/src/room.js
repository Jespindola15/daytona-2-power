// room.js — logic shared by the Cloudflare Durable Object and the local test server.
//
// A room is a lobby (names, ready flags, chat) that becomes a LINK: the
// replacement for the arcade's ring cable. Every frame each cabinet sends
// only its own Comm RAM segment; once all N have arrived for that frame, each
// cabinet k receives the other N-1 segments in ring order (slot j = cabinet
// k-j), exactly what the original cable would have handed it.
//
// Binary messages:  cabinet -> relay  [u8 1][u32 frame][segment]
//                   relay -> cabinet  [u8 2][u32 frame][N-1 segments]
export const MAX_PLAYERS = 8;
const FRAME_MS = 1000 / 57.524;

export class Room {
  constructor(code, { now = () => Date.now() } = {}) {
    this.code = code; this.now = now;
    this.players = [];          // { id, name, ready, rtt, send(msg), host }
    this.state = 'lobby';       // lobby | racing
    this.link = null;           // { num, delay, pending: Map(frame -> Array(N)) , order: [player] }
    this.seq = 0;
  }
  get publicInfo() {
    const host = this.players.find((p) => p.host);
    return { code: this.code, host: host?.name || '', players: this.players.length, max: MAX_PLAYERS, state: this.state };
  }
  join(name, send) {
    if (this.state !== 'lobby') return { error: 'La carrera ya empezó en esta sala.' };
    if (this.players.length >= MAX_PLAYERS) return { error: 'La sala está llena (8 jugadores).' };
    const p = { id: ++this.seq, name: String(name || 'Piloto').slice(0, 16), ready: false, rtt: 0, send, host: this.players.length === 0 };
    this.players.push(p);
    this.broadcastRoom(`${p.name} entró a la sala`);
    return { player: p };
  }
  leave(p) {
    const i = this.players.indexOf(p); if (i < 0) return;
    this.players.splice(i, 1);
    if (p.host && this.players[0]) this.players[0].host = true;
    if (this.state === 'racing') {
      // the cable is cut: the game shows its own "link broken" message
      for (const q of this.players) q.send(JSON.stringify({ t: 'drop', name: p.name }));
      if (this.players.length === 0) { this.state = 'lobby'; this.link = null; }
    } else this.broadcastRoom(`${p.name} salió de la sala`);
  }
  control(p, m) {
    if (m.t === 'ready' && this.state === 'lobby') { p.ready = !!m.v; this.broadcastRoom(); }
    else if (m.t === 'rtt') p.rtt = Math.max(0, Math.min(2000, +m.ms || 0));
    else if (m.t === 'ping') p.send(JSON.stringify({ t: 'pong', ts: m.ts }));
    else if (m.t === 'chat') { const text = String(m.text || '').slice(0, 200); if (text) this.broadcast({ t: 'chat', name: p.name, text }); }
    else if (m.t === 'start' && p.host && this.state === 'lobby') this.start(p);
  }
  start(p) {
    if (this.players.length < 2) return p.send(JSON.stringify({ t: 'error', msg: 'Hacen falta al menos 2 jugadores.' }));
    const notReady = this.players.filter((q) => !q.host && !q.ready);
    if (notReady.length) return p.send(JSON.stringify({ t: 'error', msg: `Falta que estén listos: ${notReady.map((q) => q.name).join(', ')}` }));
    // host = cabinet 1 (MASTER); the rest in join order
    const order = [p, ...this.players.filter((q) => q !== p)];
    const maxRtt = Math.max(...order.map((q) => q.rtt || 60));
    // remote data may be `delay` frames old: enough for the slowest round trip plus jitter
    const delay = Math.max(2, Math.min(15, Math.ceil((maxRtt * 1.25) / FRAME_MS) + 1));
    this.state = 'racing';
    this.link = { num: order.length, delay, pending: new Map(), order };
    order.forEach((q, i) => { q.index = i; });
    const roster = order.map((q) => q.name);
    for (const q of order) q.send(JSON.stringify({ t: 'start', index: q.index, num: order.length, delay, roster, maxRtt }));
  }
  frame(p, buf) {
    const L = this.link; if (!L || p.index === undefined) return;
    const u8 = new Uint8Array(buf);
    if (u8[0] !== 1 || u8.length < 5) return;
    const frame = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, true);
    let slot = L.pending.get(frame);
    if (!slot) { slot = new Array(L.num).fill(null); L.pending.set(frame, slot); }
    slot[p.index] = u8.subarray(5);
    if (slot.some((s) => !s)) return;
    L.pending.delete(frame);
    const seg = slot[0].length;
    for (let k = 0; k < L.num; k++) {
      const out = new Uint8Array(5 + (L.num - 1) * seg);
      out[0] = 2; new DataView(out.buffer).setUint32(1, frame, true);
      for (let j = 1; j < L.num; j++) out.set(slot[(k - j + L.num) % L.num].subarray(0, seg), 5 + (j - 1) * seg);
      L.order[k].send(out);
    }
  }
  broadcast(m) { const s = JSON.stringify(m); for (const q of this.players) q.send(s); }
  broadcastRoom(sys) {
    for (const q of this.players) q.send(JSON.stringify({ t: 'room', code: this.code, state: this.state, you: q.id, sys,
      players: this.players.map((x) => ({ id: x.id, name: x.name, ready: x.ready, host: x.host, rtt: x.rtt })) }));
  }
}

export function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
