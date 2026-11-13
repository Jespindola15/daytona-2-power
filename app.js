// UI thread: loads the user's romset, starts the worker and paints the real 2D layers.
const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (s) => { logEl.textContent += s + '\n'; logEl.scrollTop = 1e9; console.log(s); };
let worker, audio;
let booting = false;
// The core makes 735 samples per emulated frame; at 57.524 frames/s that is 42280 Hz.
async function startAudio() {
  if (audio) { audio.ctx.resume(); return; }
  try {
    const ctx = new AudioContext({ sampleRate: 42280, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('audio-worklet.js');
    const node = new AudioWorkletNode(ctx, 'd2-audio', { outputChannelCount: [2] });
    const gain = new GainNode(ctx, { gain: 0.8 });
    node.connect(gain).connect(ctx.destination);
    audio = { ctx, node, gain };
    log(`[audio] AudioWorklet a ${ctx.sampleRate} Hz (${ctx.state})`);
  } catch (e) { log('[audio] no disponible: ' + e.message); }
}
addEventListener('pointerdown', () => audio?.ctx.resume());
addEventListener('keydown', () => audio?.ctx.resume());
const RES = { '1': [496, 384], '2': [992, 768], '3': [1488, 1152], '4': [1984, 1536] };

// ---- NVRAM in IndexedDB (records and settings survive reloads)
const idb = () => new Promise((ok, ko) => { const r = indexedDB.open('daytona2', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
async function kvGet(k) { try { const db = await idb(); return await new Promise((ok) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); }); } catch { return null; } }
async function kvSet(k, v) { try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch {} }
async function kvDel(k) { try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').delete(k); } catch {} }

async function boot(zipBuf) {
  if (booting) return;
  booting = true;
  $('carga').hidden = true; $('juego').hidden = false;
  log(`[web] romset: ${(zipBuf.byteLength / 1048576).toFixed(1)} MB (local, no se sube)`);
  const saved = await kvGet('nvram');
  const [xml, nv] = await Promise.all([
    fetch('data/Games.xml').then((r) => r.arrayBuffer()),
    saved ? Promise.resolve(saved.slice(0)) : fetch('data/dayto2pe.nv').then((r) => (r.ok ? r.arrayBuffer() : null)),
  ]);
  log(saved ? '[web] NVRAM: la tuya (guardada en este navegador)' : '[web] NVRAM: inicial (USA, SINGLE)');
  worker = new Worker('worker.js');
  const [w, h] = RES[$('res').value];
  const off = $('pantalla').transferControlToOffscreen();
  off.width = w; off.height = h;
  worker.onmessage = ({ data: m }) => {
    if (m.t === 'log') log(m.s);
    else if (m.t === 'frame') { $('frame').textContent = m.frame; if (m.pcm) { window.__audioN = (window.__audioN || 0) + m.pcm.length / 2; if (audio) audio.node.port.postMessage(m.pcm, [m.pcm.buffer]); } }
    else if (m.t === 'perf') {
      $('fps').textContent = `${m.fps.toFixed(1)} fps (${(m.fps / 57.524 * 100).toFixed(0)}%)`;
      $('cpu').textContent = `${m.cpu.toFixed(1)} ms (3D ${m.draw3d.toFixed(1)} ms)`;
      $('skip').textContent = m.skipped ? `${m.skipped}/s sin dibujar` : 'ninguno';
      window.__perf = m;
    } else if (m.t === 'bench') { log(`[bench] ${m.n} cuadros en ${m.ms.toFixed(0)} ms = ${m.fps.toFixed(1)} fps sin límite`); window.__bench = m; }
    else if (m.t === 'nvram') { kvSet('nvram', m.data.buffer); window.__nvSaved = m.data.byteLength; }
    else if (m.t === 'ready') { log('[web] máquina lista'); window.__ready = true; }
  };
  worker.postMessage({ t: 'boot', zip: zipBuf, xml, nv, canvas: off, glstats: !!window.__glstats }, [zipBuf, off]);
}

// Auto-load the bundled ROM from the same origin. No file picker is needed.
// Keep manual selection as fallback if the server does not contain the ROM.
async function autoBoot() {
  const status = $('autostatus');
  try {
    status.textContent = 'Descargando Daytona USA 2: Power Edition…';
    const r = await fetch('data/dayto2pe.zip', { cache: 'force-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status} al descargar la ROM`);
    const total = Number(r.headers.get('content-length')) || 0;
    let buf;
    if (r.body && total) {
      const reader = r.body.getReader();
      const chunks = []; let got = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        status.textContent = `Descargando ROM… ${(got / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB (${Math.min(100, Math.round(got * 100 / total))}%)`;
      }
      const bytes = new Uint8Array(got); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      buf = bytes.buffer;
    } else buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 * 1024) throw new Error('ROM incompleta o archivo incorrecto');
    status.textContent = 'Iniciando el emulador…';
    log(`[web] ROM automática: ${(buf.byteLength / 1048576).toFixed(1)} MB`);
    await boot(buf);
  } catch (e) {
    log('[web] autocarga falló: ' + e.message);
    status.textContent = 'No se pudo cargar la ROM automáticamente. Podés elegirla manualmente.';
    $('elegir').hidden = false;
  }
}

// Manual selection remains an optional recovery path.
$('zip').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  startAudio();
  const buf = await f.arrayBuffer();
  kvSet('rom', new Blob([buf])); kvSet('romname', f.name);
  boot(buf);
});
autoBoot();
$('res').onchange = () => { const [w, h] = RES[$('res').value]; worker?.postMessage({ t: 'size', w, h }); };
$('resetnv').onclick = async () => { await kvDel('nvram'); log('[web] NVRAM borrada: al recargar vuelve la inicial (USA, SINGLE)'); };
$('bench').onclick = () => worker?.postMessage({ t: 'bench', n: 600 });

// ---- Gamepad (standard mapping): stick = wheel, RT/LT = gas/brake (analog),
// A B X Y = VR1-VR4 (view), Start = start, Back/Select = coin, LB/RB = gear down/up
// (4-speed MT: the selected gear is held, like the cabinet's H shifter).
let gear = 1;
const lastAx = {}, lastBt = {};
let prevPad = {};
function pollPad() {
  const pad = [...(navigator.getGamepads?.() || [])].find((p) => p);
  if (pad && worker) {
    const dead = (v) => (Math.abs(v) < 0.08 ? 0 : v);
    const btn = (i) => pad.buttons[i] || { pressed: false, value: 0 };
    const axes = { 0: Math.round(dead(pad.axes[0] || 0) * 32767), 5: Math.round(btn(7).value * 32767), 2: Math.round(btn(6).value * 32767) };
    const edge = (i) => btn(i).pressed && !prevPad[i];
    if (edge(4)) gear = Math.max(1, gear - 1);
    if (edge(5)) gear = Math.min(4, gear + 1);
    const buttons = { 0: btn(0).pressed, 1: btn(1).pressed, 2: btn(2).pressed, 3: btn(3).pressed,
      8: btn(9).pressed, 9: btn(8).pressed, 4: gear === 1, 5: gear === 2, 6: gear === 3, 7: gear === 4 };
    const ax = [], bt = [];
    for (const k in axes) if (lastAx[k] !== axes[k]) { ax.push([+k, axes[k]]); lastAx[k] = axes[k]; }
    for (const k in buttons) if (lastBt[k] !== buttons[k]) { bt.push([+k, buttons[k]]); lastBt[k] = buttons[k]; }
    if (ax.length || bt.length) worker.postMessage({ t: 'joy', axes: ax, buttons: bt });
    prevPad = Object.fromEntries(pad.buttons.map((b, i) => [i, b.pressed]));
    $('pad').textContent = `${pad.id.slice(0, 40)} · marcha ${gear}`;
  }
  requestAnimationFrame(pollPad);
}
requestAnimationFrame(pollPad);

const KEYS = { Digit1: 'KEY_1', Digit3: 'KEY_3', Digit5: 'KEY_5', Digit6: 'KEY_6', ArrowUp: 'KEY_UP', ArrowDown: 'KEY_DOWN',
  ArrowLeft: 'KEY_LEFT', ArrowRight: 'KEY_RIGHT', KeyA: 'KEY_A', KeyS: 'KEY_S', KeyD: 'KEY_D', KeyF: 'KEY_F', KeyQ: 'KEY_Q', KeyW: 'KEY_W', KeyE: 'KEY_E', KeyR: 'KEY_R' };
for (const [type, d] of [['keydown', true], ['keyup', false]])
  addEventListener(type, (e) => { const k = KEYS[e.code]; if (k && worker && !e.repeat) { worker.postMessage({ t: 'key', k, d }); e.preventDefault(); } });
window.__boot = boot;
window.__send = (m) => worker?.postMessage(m);
