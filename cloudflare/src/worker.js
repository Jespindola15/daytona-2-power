// worker.js — salas online de Daytona USA 2 web en Cloudflare.
//
//   GET  /api/salas                    lista de salas abiertas
//   POST /api/salas {nombre}            crea una sala (2 a 8 jugadores) -> {codigo}
//   GET  /api/salas/:codigo/ws?name=    WebSocket de la sala (Durable Object «Sala»)
//
// Cada sala es un Durable Object que hace de CABLE DE RED del arcade: en cada cuadro recibe el segmento de
// memoria de comunicación de cada cabina y le devuelve a cada una los de las demás (ver room.js).
// El juego original es el que sincroniza la carrera; la sala no interpreta los datos.
import { DurableObject } from 'cloudflare:workers';
import { Room, MAX_PLAYERS } from './room.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const CODE_RE = /^[A-Z2-9]{4,6}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!url.pathname.startsWith('/api/')) return new Response('Daytona USA 2 web — salas online', { status: 200, headers: CORS });
    const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
    const parts = url.pathname.split('/').filter(Boolean);   // api, salas, codigo, ws
    if (parts[1] !== 'salas') return json({ error: 'ruta desconocida' }, 404);
    if (parts.length === 2) {
      if (req.method === 'GET') return json(await lobby.listar());
      if (req.method === 'POST') {
        let body = {}; try { body = await req.json(); } catch {}
        const nombre = clean(body.nombre, 32) || 'Sala';
        const codigo = await lobby.reservar();
        await env.SALA.get(env.SALA.idFromName(codigo)).iniciar({ codigo, nombre });
        await lobby.actualizar({ codigo, nombre, jugadores: 0, max: MAX_PLAYERS, estado: 'sala', host: '' });
        return json({ codigo, nombre });
      }
      return json({ error: 'método no permitido' }, 405);
    }
    const codigo = String(parts[2] || '').toUpperCase();
    if (!CODE_RE.test(codigo)) return json({ error: 'código de sala inválido' }, 400);
    const sala = env.SALA.get(env.SALA.idFromName(codigo));
    if (parts[3] === 'ws') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'se esperaba WebSocket' }, 426);
      return sala.fetch(req);
    }
    const info = await sala.info();
    return info ? json(info) : json({ error: 'la sala no existe' }, 404);
  },
};

// Índice de salas (un único Durable Object).
export class Lobby extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.salas = new Map(); }
  async reservar() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) { let c = ''; for (let i = 0; i < 5; i++) c += abc[Math.floor(Math.random() * abc.length)]; if (!this.salas.has(c)) { this.salas.set(c, { codigo: c, t: Date.now() }); return c; } }
  }
  async actualizar(info) { this.salas.set(info.codigo, { ...this.salas.get(info.codigo), ...info, t: Date.now() }); }
  async borrar(codigo) { this.salas.delete(codigo); }
  async listar() {
    const now = Date.now();
    for (const [c, s] of this.salas) if (now - s.t > 30 * 60 * 1000 || (!s.jugadores && now - s.t > 5 * 60 * 1000)) this.salas.delete(c);
    return [...this.salas.values()].filter((s) => s.nombre && s.estado === 'sala' && s.jugadores > 0 && s.jugadores < MAX_PLAYERS)
      .map(({ codigo, nombre, jugadores, max, host }) => ({ codigo, nombre, jugadores, max, host }));
  }
}

// Una sala: lobby + cable de red entre cabinas.
export class Sala extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.room = null; this.nombre = ''; }
  async iniciar({ codigo, nombre }) { this.room = new Room(codigo); this.nombre = nombre; }
  async info() { return this.room ? { ...this.room.publicInfo, nombre: this.nombre } : null; }
  lobby() { return this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby')); }
  report() {
    const r = this.room; if (!r) return;
    const lobby = this.lobby();
    if (!r.players.length) { lobby.borrar(r.code); this.room = null; return; }
    lobby.actualizar({ codigo: r.code, nombre: this.nombre, jugadores: r.players.length, max: MAX_PLAYERS, estado: r.state === 'lobby' ? 'sala' : 'carrera', host: r.publicInfo.host });
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (!this.room) return json({ error: 'la sala no existe o se cerró' }, 404);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const send = (m) => { try { server.send(m); } catch {} };
    const r = this.room.join(url.searchParams.get('name'), send);
    if (r.error) { send(JSON.stringify({ t: 'error', msg: r.error })); server.close(1008, 'sala'); return new Response(null, { status: 101, webSocket: client }); }
    const p = r.player, room = this.room;
    this.report();
    server.addEventListener('message', (e) => {
      if (typeof e.data === 'string') { try { room.control(p, JSON.parse(e.data)); } catch {} if (e.data.includes('"start"') || e.data.includes('"ready"')) this.report(); }
      else room.frame(p, e.data);
    });
    const bye = () => { room.leave(p); this.report(); };
    server.addEventListener('close', bye); server.addEventListener('error', bye);
    return new Response(null, { status: 101, webSocket: client });
  }
}
