// Web Worker: hosts the WebAssembly Model 3 core (Supermodel, GPLv3) off the UI thread.
importScripts('core/d2core.js');
let M, canvas, videoInit, skip3d, userSkip = false, skipped = 0, run, key, frame = 0, running = false, timer = 0;
const HZ = 57.524;                 // Model 3 refresh rate
const log = (s) => postMessage({ t: 'log', s });

onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'boot') {
    const t0 = performance.now();
    postMessage({ t: 'stage', s: 'Cargando el emulador…', p: 0.55 });
    M = await createD2({ print: log, printErr: log, locateFile: (p) => 'core/' + p });
    log(`[web] wasm listo en ${(performance.now() - t0).toFixed(0)} ms`);
    M.FS.mkdir('/rom');
    M.FS.writeFile('/rom/dayto2pe.zip', new Uint8Array(m.zip));
    M.FS.writeFile('/rom/Games.xml', new Uint8Array(m.xml));
    if (m.nv) M.FS.writeFile('/rom/dayto2pe.nv', new Uint8Array(m.nv));
    const init = M.cwrap('d2_init', 'number', ['string', 'string', 'string']);
    run = M.cwrap('d2_run', 'number', ['number']);
    key = M.cwrap('d2_key', null, ['string', 'number']);
    // WebGL2 on the canvas the page handed over (OffscreenCanvas): Supermodel's
    // own New3D/Render2D draw into it through Emscripten's GL layer.
    const gl = m.canvas.getContext('webgl2', { antialias: false, depth: true, stencil: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) { log('[web] este navegador no tiene WebGL2'); postMessage({ t: 'fail' }); return; }
    log(`[web] WebGL2: ${gl.getParameter(gl.VERSION)} · ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) log(`[web] GPU: ${gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}`);
    if (self.D2_GLSTATS || m.glstats) {           // diagnostics: GL calls per second
      self.glCount = {};
      for (const k of Object.getOwnPropertyNames(WebGL2RenderingContext.prototype)) {
        const f = gl[k]; if (typeof f !== 'function') continue;
        gl[k] = function (...a) { glCount[k] = (glCount[k] || 0) + 1; return f.apply(gl, a); };
      }
      setInterval(() => { const top = Object.entries(glCount).sort((a, b) => b[1] - a[1]).slice(0, 12); log('[gl/s] ' + JSON.stringify(top)); glCount = {}; }, 2000);
    }
    const h = M.GL.registerContext(gl, { majorVersion: 2, minorVersion: 0, enableExtensionsByDefault: 1 });
    M.GL.makeContextCurrent(h);
    postMessage({ t: 'stage', s: 'Armando la placa Model 3…', p: 0.75 });
    const rc = init('/rom/dayto2pe.zip', '/rom/Games.xml', '/rom/dayto2pe.nv');
    if (rc) { log(`[web] d2_init falló (${rc})`); postMessage({ t: 'fail' }); return; }
    canvas = m.canvas;
    videoInit = M.cwrap('d2_video_init', 'number', ['number', 'number']);
    skip3d = M.cwrap('d2_skip3d', null, ['number']);
    const vr = videoInit(canvas.width, canvas.height);
    const se = M.ccall('d2_shader_errors', 'number', [], []);
    if (vr || se) { log(`[web] video init ${vr}, shaders con error: ${se}`); postMessage({ t: 'fail' }); return; }
    postMessage({ t: 'ready' });
    // Backup RAM (records, settings) goes back to the page every 20 s to be kept in IndexedDB.
    setInterval(() => {
      try {
        M.ccall('d2_save_nvram', null, ['string'], ['/rom/save.nv']);
        const data = M.FS.readFile('/rom/save.nv').slice();
        postMessage({ t: 'nvram', data }, [data.buffer]);
      } catch (e) { log('[web] no se pudo guardar la NVRAM: ' + e); }
    }, 20000);
    running = true; loop();
  } else if (m.t === 'key') key && key(m.k, m.d ? 1 : 0);
  else if (m.t === 'speed') { running = !!m.on; next = 0; }
  else if (m.t === 'reset' && M) M.ccall('d2_reset', null, [], []);
  else if (m.t === 'joy' && M) {
    for (const [a, v] of m.axes) M.ccall('d2_joy_axis', null, ['number', 'number'], [a, v]);
    for (const [b, d] of m.buttons) M.ccall('d2_joy_button', null, ['number', 'number'], [b, d ? 1 : 0]);
  }
  else if (m.t === 'skip3d') { userSkip = !!m.on; skip3d(m.on ? 1 : 0); }
  else if (m.t === 'bench') bench(m.n);
  else if (m.t === 'size' && canvas) { canvas.width = m.w; canvas.height = m.h; videoInit(m.w, m.h); }
};

// Paced loop: one emulated frame per 1/57.524 s; reports the real speed.
let next = 0, acc = 0, accFrames = 0, accT = performance.now();
function loop() {
  if (!running) { timer = setTimeout(loop, 50); return; }
  const now = performance.now();
  if (!next) next = now;
  // Frames due now. When behind, several run in this task, but only the last one
  // reaches the screen (an OffscreenCanvas commits when the task ends), so the
  // 3D scene is drawn only for that last one: free catch-up on slow GPUs.
  const due = Math.min(4, Math.floor((now - next) / (1000 / HZ)) + 1);
  let n = 0;
  if (now >= next) for (; n < due; n++) {
    const last = n === due - 1;
    if (!userSkip) skip3d(last ? 0 : 1);
    acc += run(1); frame++; next += 1000 / HZ;
    if (!last) skipped++;
  }
  if (now - next > 250) next = now;          // too slow: do not spiral
  if (n) {
    accFrames += n;
    const len = M.ccall('d2_audio_len', 'number', [], []);
    if (len) {
      const p = M.ccall('d2_audio_ptr', 'number', [], []) >> 2;
      const pcm = M.HEAPF32.slice(p, p + len);
      M.ccall('d2_audio_clear', null, [], []);
      postMessage({ t: 'frame', frame, pcm }, [pcm.buffer]);
    } else postMessage({ t: 'frame', frame });
  }
  if (now - accT >= 1000) {
    postMessage({ t: 'perf', fps: accFrames * 1000 / (now - accT), cpu: acc / accFrames, draw3d: M.ccall('d2_draw_ms', 'number', [], []), skipped, frame });
    skipped = 0;
    acc = 0; accFrames = 0; accT = now;
  }
  timer = setTimeout(loop, Math.max(0, next - performance.now()));
}

// Unthrottled: how many frames per second the core can do in this browser.
function bench(n) {
  running = false;
  const ms = run(n); frame += n;
  postMessage({ t: 'bench', n, ms, fps: n * 1000 / ms });
  running = true; next = 0;
}
