// app.js — Daytona USA 2 en el navegador: solo el juego en pantalla; ajustes en paneles laterales.
// El núcleo (Supermodel → WebAssembly) corre en worker.js y dibuja en el canvas con WebGL2.
'use strict';
const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const BASE_W = 496, BASE_H = 384;          // resolución de la placa Model 3

// ---------- ajustes persistentes ----------
const DEFAULTS = { scale: 'fit', res: 'auto', filter: 'suave', fps: false, volume: 80, mute: false, padIndex: 'auto', sens: 100, log: false };
let opts = { ...DEFAULTS };
try { opts = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('daytona2.opts') || '{}') }; } catch {}
const saveOpts = () => { try { localStorage.setItem('daytona2.opts', JSON.stringify(opts)); } catch {} };

// ---------- registro ----------
const allLog = [];
function log(s) {
  allLog.push(s); if (allLog.length > 5000) allLog.splice(0, 1000);
  console.log(s);
  if (opts.log) { const el = $('log'); el.textContent = allLog.slice(-400).join('\n'); el.scrollTop = 1e9; }
}
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms); }
function loadState(text, p) { $('loadText').textContent = text; if (p != null) $('loadBar').style.width = `${Math.round(p * 100)}%`; }

// ---------- IndexedDB: ROM elegida y NVRAM (récords, ajustes del juego) ----------
const idb = () => new Promise((ok, ko) => { const r = indexedDB.open('daytona2', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
async function kvGet(k) { try { const db = await idb(); return await new Promise((ok) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); }); } catch { return null; } }
async function kvSet(k, v) { try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch {} }
async function kvDel(k) { try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').delete(k); } catch {} }

// ---------- resolución interna del 3D ----------
function resMult() {
  if (opts.res !== 'auto') return +opts.res;
  const px = Math.min(innerWidth / BASE_W, innerHeight / BASE_H) * (devicePixelRatio || 1);
  return Math.max(1, Math.min(4, Math.round(px)));
}
let curMult = 0;

// ---------- layout / video ----------
function layout() {
  const W = innerWidth, H = innerHeight;
  let w, h;
  if (opts.scale === 'stretch') { w = W; h = H; }
  else {
    let s = Math.min(W / BASE_W, H / BASE_H);
    if (opts.scale === 'int') s = Math.max(1, Math.floor(s));
    w = Math.floor(BASE_W * s); h = Math.floor(BASE_H * s);
  }
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const crt = $('crt'); const r = canvas.getBoundingClientRect();
  Object.assign(crt.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  canvas.classList.toggle('pixel', opts.filter === 'nitido');
  document.body.classList.toggle('crt', opts.filter === 'crt');
  const m = resMult();
  if (worker && running && m !== curMult) { curMult = m; worker.postMessage({ t: 'size', w: BASE_W * m, h: BASE_H * m }); }
  $('videoInfo').textContent = `3D a ${BASE_W * (curMult || m)}×${BASE_H * (curMult || m)} · en pantalla ${w}×${h} px`;
}
addEventListener('resize', () => { clearTimeout(layout.t); layout.t = setTimeout(layout, 150); });

// ---------- sonido (AudioWorklet) ----------
// El núcleo genera 735 muestras por cuadro; a 57,524 cuadros/s son 42 280 Hz.
let audio;
async function startAudio() {
  if (audio) { audio.ctx.resume(); return; }
  try {
    const ctx = new AudioContext({ sampleRate: 42280, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('audio-worklet.js');
    const node = new AudioWorkletNode(ctx, 'd2-audio', { outputChannelCount: [2] });
    const gain = new GainNode(ctx);
    node.connect(gain).connect(ctx.destination);
    audio = { ctx, node, gain };
    applyVolume();
    log(`[audio] AudioWorklet a ${ctx.sampleRate} Hz`);
  } catch (e) { log('[audio] no disponible: ' + e.message); }
}
function applyVolume() {
  if (audio) audio.gain.gain.value = opts.mute ? 0 : (opts.volume / 100) ** 2;
  $('btnMute').textContent = opts.mute ? '🔇' : '🔊';
  $('btnMute').setAttribute('aria-pressed', opts.mute);
}
addEventListener('pointerdown', () => audio?.ctx.resume());
addEventListener('keydown', () => audio?.ctx.resume());

// ---------- worker ----------
let worker, running = false, paused = false;
async function boot(zipBuf) {
  $('loadActions').hidden = true;
  loadState(`ROM lista (${(zipBuf.byteLength / 1048576).toFixed(0)} MB) · preparando…`, 0.35);
  const saved = await kvGet('nvram');
  const [xml, nv] = await Promise.all([
    fetch('data/Games.xml').then((r) => r.arrayBuffer()),
    saved ? Promise.resolve(saved.slice(0)) : fetch('data/dayto2pe.nv').then((r) => (r.ok ? r.arrayBuffer() : null)),
  ]);
  log(saved ? '[web] NVRAM: la guardada en este navegador' : '[web] NVRAM: inicial (USA, SINGLE)');
  worker = new Worker('worker.js');
  curMult = resMult();
  const off = canvas.transferControlToOffscreen();
  off.width = BASE_W * curMult; off.height = BASE_H * curMult;
  worker.onmessage = ({ data: m }) => {
    if (m.t === 'log') log(m.s);
    else if (m.t === 'stage') loadState(m.s, m.p);
    else if (m.t === 'frame') { if (m.pcm && audio && !paused) audio.node.port.postMessage(m.pcm, [m.pcm.buffer]); }
    else if (m.t === 'perf') showPerf(m);
    else if (m.t === 'bench') { toast(`Velocidad máxima: ${m.fps.toFixed(0)} cuadros/s (${(m.fps / 57.524 * 100).toFixed(0)} %)`, 5000); log(`[bench] ${m.n} cuadros en ${m.ms.toFixed(0)} ms`); }
    else if (m.t === 'nvram') kvSet('nvram', m.data.buffer);
    else if (m.t === 'ready') started();
    else if (m.t === 'fail') { loadState('No se pudo arrancar el juego. Mirá Ajustes → Diagnóstico.', 0); $('loadActions').hidden = false; }
  };
  worker.postMessage({ t: 'boot', zip: zipBuf, xml, nv, canvas: off }, [zipBuf, off]);
}
function started() {
  running = true; window.__ready = true;
  loadState('¡Listo!', 1);
  document.body.classList.add('playing');
  $('loader').classList.add('ready');
  setTimeout(() => { $('loader').hidden = true; }, 250);
  $('dock').hidden = false;
  layout(); wake(); canvas.focus();
  toast('3 = moneda · 1 = start · ↑ acelerar', 4000);
}
let lastPerf;
function showPerf(m) {
  lastPerf = m; window.__perf = m;
  const pct = (m.fps / 57.524 * 100).toFixed(0);
  $('fps').textContent = `${m.fps.toFixed(1)} FPS${m.skipped ? ` · ${m.skipped} saltos` : ''}`;
  $('perfInfo').textContent = `Velocidad: ${m.fps.toFixed(1)} cuadros/s (${pct} % de la placa original)\nCPU por cuadro: ${m.cpu.toFixed(1)} ms (3D ${m.draw3d.toFixed(1)} ms)\nCuadros sin dibujar: ${m.skipped || 0} por segundo`;
}

// ---------- carga de la ROM: elegida, arrastrada o guardada en este navegador ----------
async function useFile(f) {
  if (!f) return;
  if (!/\.zip$/i.test(f.name)) { toast('Tiene que ser el archivo .zip de la ROM (dayto2pe.zip)'); return; }
  startAudio();
  const buf = await f.arrayBuffer();
  kvSet('rom', new Blob([buf])); kvSet('romname', f.name);
  if (running) { toast('ROM guardada: se usa al recargar la página'); setTimeout(() => location.reload(), 900); return; }
  boot(buf);
}
$('zipPick').onchange = (e) => useFile(e.target.files[0]);
$('zipPick2').onchange = (e) => useFile(e.target.files[0]);
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (!running && e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); if (!running) useFile(e.dataTransfer.files[0]); });

(async function intro() {
  if (!('transferControlToOffscreen' in canvas) || !self.WebGL2RenderingContext) {
    loadState('Este navegador no sirve: hace falta Google Chrome o Edge actualizados (WebGL2).', 0); return;
  }
  const name = await kvGet('romname');
  loadState(name ? 'Todo listo para correr.' : 'Falta la ROM del juego.', name ? 0.25 : 0.05);
  $('loadActions').hidden = false;
  if (name) {
    $('btnPlay').hidden = false;
    $('btnPick').firstChild.textContent = 'Usar otra ROM ';
    $('romInfo').textContent = `ROM guardada en este navegador: ${name}`;
    $('btnPlay').onclick = async () => {
      startAudio();
      const blob = await kvGet('rom');
      if (!blob) { toast('No encontré la ROM guardada: elegila de nuevo'); return; }
      boot(await blob.arrayBuffer());
    };
    $('btnPlay').focus();
  }
})();

// ---------- pausa / pantalla completa / paneles ----------
function setPause(p) {
  if (!running) return;
  paused = p; worker.postMessage({ t: 'speed', on: !p });
  $('paused').hidden = !p; $('btnPause').textContent = p ? '▶' : '❚❚'; $('btnPause').setAttribute('aria-pressed', p);
  if (audio) p ? audio.ctx.suspend() : audio.ctx.resume();
}
$('btnPause').onclick = () => setPause(!paused);
$('btnResume').onclick = () => setPause(false);
$('btnMute').onclick = () => { opts.mute = !opts.mute; $('optMute').checked = opts.mute; applyVolume(); saveOpts(); };
const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
$('btnFull').onclick = fullscreen;
document.addEventListener('fullscreenchange', () => { $('btnFull').setAttribute('aria-pressed', !!document.fullscreenElement); layout(); });

const panels = ['settings', 'local', 'rooms'];
const openPanel = () => panels.find((p) => !$(p).hidden);
function toggle(id) { const was = !$(id).hidden; for (const p of panels) $(p).hidden = true; $(id).hidden = was; wake(); }
$('btnSettings').onclick = () => toggle('settings');
$('btnLocal').onclick = () => toggle('local');
$('btnRooms').onclick = () => toggle('rooms');
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => { $(b.dataset.close).hidden = true; canvas.focus(); };

// la barra se esconde sola mientras jugás
let idleT;
function wake() { document.body.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (running && !openPanel() && !paused) document.body.classList.add('idle'); }, 2500); }
addEventListener('mousemove', wake);

// ---------- controles de ajustes ----------
function bindSelect(id, key, after) { const el = $(id); el.value = opts[key]; el.onchange = () => { opts[key] = el.value; saveOpts(); after?.(); }; }
bindSelect('optScale', 'scale', layout);
bindSelect('optRes', 'res', layout);
bindSelect('optFilter', 'filter', layout);
bindSelect('optPadIndex', 'padIndex');
$('optFps').checked = opts.fps; $('fps').hidden = !opts.fps;
$('optFps').onchange = (e) => { opts.fps = e.target.checked; $('fps').hidden = !opts.fps; saveOpts(); };
$('optVolume').value = opts.volume; $('volVal').textContent = `${opts.volume} %`;
$('optVolume').oninput = (e) => { opts.volume = +e.target.value; $('volVal').textContent = `${opts.volume} %`; applyVolume(); saveOpts(); };
$('optMute').checked = opts.mute;
$('optMute').onchange = (e) => { opts.mute = e.target.checked; applyVolume(); saveOpts(); };
$('optSens').value = opts.sens; $('sensVal').textContent = `${opts.sens} %`;
$('optSens').oninput = (e) => { opts.sens = +e.target.value; $('sensVal').textContent = `${opts.sens} %`; saveOpts(); };
$('optLog').checked = opts.log; $('log').hidden = !opts.log;
$('optLog').onchange = (e) => { opts.log = e.target.checked; $('log').hidden = !opts.log; saveOpts(); log('[web] registro visible'); };
$('btnSaveLog').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([allLog.join('\n')], { type: 'text/plain' })); a.download = 'daytona2-registro.txt'; a.click(); };
$('btnRestart').onclick = () => { if (running) { worker.postMessage({ t: 'reset' }); toast('Placa reiniciada'); } };
$('btnResetNv').onclick = async () => { await kvDel('nvram'); toast('Récords y ajustes borrados: al recargar vuelve la configuración inicial'); };
$('btnBench').onclick = () => { if (running) { worker.postMessage({ t: 'bench', n: 600 }); toast('Midiendo… (el juego se acelera unos segundos)'); } };
applyVolume();

// ---------- teclado ----------
const KEYS = { Digit1: 'KEY_1', Digit3: 'KEY_3', Digit5: 'KEY_5', Digit6: 'KEY_6', ArrowUp: 'KEY_UP', ArrowDown: 'KEY_DOWN',
  ArrowLeft: 'KEY_LEFT', ArrowRight: 'KEY_RIGHT', KeyA: 'KEY_A', KeyS: 'KEY_S', KeyD: 'KEY_D', KeyF: 'KEY_F',
  KeyQ: 'KEY_Q', KeyW: 'KEY_W', KeyE: 'KEY_E', KeyR: 'KEY_R' };
addEventListener('keydown', (e) => {
  if (e.target.closest?.('select, input')) return;
  if (e.code === 'KeyP' && running) { setPause(!paused); return; }
  if (e.code === 'KeyM') { $('btnMute').click(); return; }
  if (e.code === 'F11') { e.preventDefault(); fullscreen(); return; }
  if (e.code === 'Escape' && openPanel()) { $(openPanel()).hidden = true; return; }
  const k = KEYS[e.code]; if (k && worker && !e.repeat) { worker.postMessage({ t: 'key', k, d: true }); e.preventDefault(); }
});
addEventListener('keyup', (e) => { const k = KEYS[e.code]; if (k && worker) { worker.postMessage({ t: 'key', k, d: false }); e.preventDefault(); } });

// ---------- mando (Gamepad API, mapeo estándar) ----------
// Palanca = volante analógico · RT/LT = acelerador/freno analógicos · A B X Y = VR1-VR4 · Start · Back = moneda
// LB/RB = bajar/subir marcha: la caja de 4 marchas mantiene la marcha elegida, como la palanca H del mueble.
let gear = 1, prevPad = {}, padId = '';
const lastAx = {}, lastBt = {};
function pollPad() {
  const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
  const pad = opts.padIndex === 'auto' ? pads[0] : pads.find((p) => p.index === +opts.padIndex);
  if (pad?.id !== padId) {
    padId = pad?.id || '';
    $('padInfo').textContent = pad ? `Conectado: ${pad.id}\n(mapeo ${pad.mapping || 'no estándar'})` : 'Ningún mando detectado (apretá un botón del mando).';
    if (pad) toast('🎮 Mando conectado');
  }
  if (pad && worker && running) {
    const btn = (i) => pad.buttons[i] || { pressed: false, value: 0 };
    let sx = pad.axes[0] || 0;
    sx = Math.abs(sx) < 0.08 ? 0 : Math.sign(sx) * (Math.abs(sx) - 0.08) / 0.92;
    sx = Math.max(-1, Math.min(1, sx * opts.sens / 100));
    if (btn(14).pressed) sx = -1; else if (btn(15).pressed) sx = 1;
    const edge = (i) => btn(i).pressed && !prevPad[i];
    if (edge(4)) { gear = Math.max(1, gear - 1); toast(`Marcha ${gear}`, 800); }
    if (edge(5)) { gear = Math.min(4, gear + 1); toast(`Marcha ${gear}`, 800); }
    const axes = { 0: Math.round(sx * 32767), 5: Math.round(btn(7).value * 32767), 2: Math.round(btn(6).value * 32767) };
    const buttons = { 0: btn(0).pressed, 1: btn(1).pressed, 2: btn(2).pressed, 3: btn(3).pressed,
      8: btn(9).pressed, 9: btn(8).pressed, 4: gear === 1, 5: gear === 2, 6: gear === 3, 7: gear === 4 };
    const ax = [], bt = [];
    for (const k in axes) if (lastAx[k] !== axes[k]) { ax.push([+k, axes[k]]); lastAx[k] = axes[k]; }
    for (const k in buttons) if (lastBt[k] !== buttons[k]) { bt.push([+k, buttons[k]]); lastBt[k] = buttons[k]; }
    if (ax.length || bt.length) worker.postMessage({ t: 'joy', axes: ax, buttons: bt });
    if (btn(9).pressed && !prevPad[9] && paused) setPause(false);
    prevPad = Object.fromEntries(pad.buttons.map((b, i) => [i, b.pressed]));
  }
  requestAnimationFrame(pollPad);
}
requestAnimationFrame(pollPad);
layout();
window.__send = (m) => worker?.postMessage(m);
