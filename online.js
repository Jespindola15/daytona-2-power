// online.js — salas online (2 a 8 jugadores) por Cloudflare.
// Cada jugador corre su propia cabina; la sala hace de cable de red del arcade y el juego original
// sincroniza la carrera. Usa del app.js: worker, reboot(), linkCfg, toast(), log(), $(), toggle().
'use strict';
(function () {
  const BASE = (window.D2_SALAS_URL || '').replace(/\/$/, '');
  const WSBASE = BASE.replace(/^http/, 'ws');
  const body = $('roomsBody'), badge = $('netBadge');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let ws = null, room = null, me = null, mode = 'idle', start = null, chat = [], pings = [], pingT = 0, listT = 0, rooms = [], lastNet = null, dropped = [];
  let myName = ''; try { myName = localStorage.getItem('daytona2.name') || ''; } catch {}

  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  const sendJ = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };

  // ---------- lista de salas ----------
  async function refreshList() {
    if (mode !== 'idle' || $('rooms').hidden) return;
    try { rooms = await (await fetch(`${BASE}/api/salas`, { cache: 'no-store' })).json(); } catch { rooms = null; }
    const list = body.querySelector('.room-list');
    if (list) { list.innerHTML = roomList(); bindJoin(); } else render();   // no pisar lo que estás escribiendo
  }
  async function createRoom() {
    if (!askName()) return;
    try {
      const r = await (await fetch(`${BASE}/api/salas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nombre: `Sala de ${myName}` }) })).json();
      if (!r.codigo) throw new Error(r.error || 'sin código');
      connect(r.codigo);
    } catch (e) { toast('No se pudo crear la sala: ' + e.message, 4000); }
  }
  function askName() {
    const el = $('netName'); const v = (el?.value || myName).trim().slice(0, 16);
    if (!v) { toast('Escribí tu nombre de piloto'); el?.focus(); return false; }
    myName = v; try { localStorage.setItem('daytona2.name', v); } catch {}
    return true;
  }

  // ---------- conexión a una sala ----------
  function connect(code) {
    if (!askName()) return;
    if (!running) { toast('Esperá a que termine de cargar el juego'); return; }
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{4,6}$/.test(code)) { toast('Código de sala inválido'); return; }
    leave(true);
    chat = []; dropped = []; pings = []; mode = 'lobby'; room = { code, players: [] };
    ws = new WebSocket(`${WSBASE}/api/salas/${code}/ws?name=${encodeURIComponent(myName)}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { ping(); pingT = setInterval(ping, 1000); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { if (mode === 'racing' && worker) worker.postMessage({ t: 'net', data: e.data }, [e.data]); return; }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'room') { room = m; me = m.you; if (m.sys) addChat(null, m.sys); render(); }
      else if (m.t === 'pong') { pings.push(Date.now() - m.ts); if (pings.length > 7) pings.shift(); sendJ({ t: 'rtt', ms: median(pings) }); }
      else if (m.t === 'chat') { addChat(m.name, m.text); }
      else if (m.t === 'error') toast(m.msg, 4500);
      else if (m.t === 'start') beginRace(m);
      else if (m.t === 'drop') {
        dropped.push(m.name); toast(`${m.name} se desconectó: la carrera online terminó`, 5000);
        worker?.postMessage({ t: 'netdrop' }); render();
      }
    };
    ws.onclose = () => {
      clearInterval(pingT);
      if (mode === 'racing') { worker?.postMessage({ t: 'netdrop' }); toast('Se cortó la conexión con la sala', 5000); mode = 'ended'; render(); return; }
      if (mode === 'lobby') { toast('Saliste de la sala'); mode = 'idle'; room = null; render(); refreshList(); }
    };
    render();
  }
  function ping() { sendJ({ t: 'ping', ts: Date.now() }); }
  function leave(silent) {
    if (!ws) return;
    const w = ws; ws = null; w.onclose = null; try { w.close(); } catch {}
    clearInterval(pingT);
    const wasRacing = mode === 'racing' || mode === 'ended';
    mode = 'idle'; room = null; start = null; badge.hidden = true;
    if (wasRacing) reboot(null).then(() => toast('De vuelta al modo de un jugador'));
    if (!silent) { render(); refreshList(); }
  }
  function addChat(name, text) { chat.push({ name, text }); if (chat.length > 60) chat.shift(); renderChat(); }

  // ---------- carrera ----------
  function beginRace(m) {
    start = m; mode = 'racing';
    $('rooms').hidden = true;
    toast(`¡Carrera online! Sos la cabina ${m.index + 1} de ${m.num}. Esperá a que arranquen todas.`, 6000);
    log(`[online] cabinas: ${m.roster.map((n, i) => `${i + 1}:${n}`).join(' ')} · ping máx ${m.maxRtt} ms → demora ${m.delay}`);
    reboot({ index: m.index, num: m.num, delay: m.delay });
    render();
  }
  window.__online = {
    send(msg) { if (ws?.readyState === 1 && mode === 'racing') ws.send(msg); },
    booting(link) { if (!link) badge.hidden = true; },
    netStats(n, perf) {
      lastNet = { ...n, fps: perf.fps };
      const linked = n.state === 3, broken = n.state === 4;
      badge.hidden = mode !== 'racing' && mode !== 'ended';
      badge.className = 'badge' + (broken ? ' bad' : !linked || perf.fps < 50 ? ' warn' : '');
      const txt = broken ? 'enlace cortado' : linked ? `cabina ${start ? start.index + 1 : '?'}/${start?.num || '?'} · ${perf.fps.toFixed(0)} FPS · ping ${median(pings)} ms` : 'esperando a las otras cabinas…';
      badge.innerHTML = `<span class="dot"></span>ONLINE · ${esc(txt)}`;
      if (!$('rooms').hidden) render();
    },
  };

  // ---------- interfaz ----------
  function render() {
    if (!BASE) { body.innerHTML = `<section class="soon"><span class="soon-badge">FALTA CONFIGURAR</span><h3>Servidor de salas</h3><p class="hint">Poné la dirección de tu Worker de Cloudflare en <code>config.js</code>.</p></section>`; return; }
    if (mode === 'idle') {
      body.innerHTML = `
        <section><h3>Tu nombre de piloto</h3><input class="input" id="netName" maxlength="16" placeholder="Ej: Joaco" value="${esc(myName)}"></section>
        <section><h3>Crear</h3><button class="btn primary" id="netCreate">Crear sala nueva</button>
          <p class="hint">Hasta 8 jugadores. Cada uno necesita su propia ROM; la sala hace de cable de red entre las cabinas, como en el arcade.</p></section>
        <section><h3>Unirse con código</h3><div class="row"><input class="input" id="netCode" maxlength="6" placeholder="CÓDIGO" style="flex:1;text-transform:uppercase"><button class="btn" id="netJoin">Entrar</button></div></section>
        <section><h3>Salas abiertas</h3><div class="room-list">${roomList()}</div></section>`;
      $('netName').oninput = (e) => { myName = e.target.value.trim().slice(0, 16); try { localStorage.setItem('daytona2.name', myName); } catch {} };
      $('netCreate').onclick = createRoom;
      $('netJoin').onclick = () => connect($('netCode').value);
      $('netCode').onkeydown = (e) => { if (e.key === 'Enter') connect(e.target.value); };
      bindJoin();
      return;
    }
    if (mode === 'lobby') {
      const ps = room.players || [], mine = ps.find((p) => p.id === me), host = mine?.host;
      const ready = ps.length >= 2 && ps.every((p) => p.host || p.ready);
      body.innerHTML = `
        <section><h3>Código de la sala</h3><div class="row" style="justify-content:space-between"><span class="code">${esc(room.code)}</span><button class="btn" id="netCopy">Copiar</button></div>
          <p class="hint">Pasale el código a tus amigos. El anfitrión es la cabina 1 (MASTER).</p></section>
        <section><h3>Pilotos (${ps.length}/8)</h3><ul class="players">${ps.map((p, i) => `
          <li><span><span class="num">${i + 1}</span>${esc(p.name)}${p.id === me ? ' <small class="dim">(vos)</small>' : ''}</span>
          <span>${p.rtt ? `<span class="tag ${p.rtt > 120 ? 'bad' : ''}">${p.rtt} ms</span> ` : ''}${p.host ? '<span class="tag host">anfitrión</span>' : p.ready ? '<span class="tag ok">listo</span>' : '<span class="tag">esperando</span>'}</span></li>`).join('')}</ul>
          ${host ? `<button class="btn primary" id="netStart" ${ready ? '' : 'disabled'}>🏁 Largar carrera</button><p class="hint">${ps.length < 2 ? 'Hacen falta al menos 2 pilotos.' : ready ? 'Todos listos.' : 'Esperando a que todos marquen «Listo».'}</p>`
            : `<button class="btn ${mine?.ready ? '' : 'primary'}" id="netReady">${mine?.ready ? 'No estoy listo' : '✔ Estoy listo'}</button>`}
          <p class="hint">Al largar, cada PC reinicia su cabina enlazada (unos segundos). Después cada uno pone moneda (3) y start (1), como en el arcade.</p></section>
        <section><h3>Chat</h3><div class="chat" id="netChat"></div><div class="row"><input class="input" id="netMsg" maxlength="200" placeholder="Escribí y Enter" style="flex:1"></div></section>
        <section><button class="btn" id="netLeave">Salir de la sala</button></section>`;
      $('netCopy').onclick = () => navigator.clipboard?.writeText(room.code).then(() => toast('Código copiado'));
      if (host) $('netStart').onclick = () => sendJ({ t: 'start' });
      else $('netReady').onclick = () => sendJ({ t: 'ready', v: !mine?.ready });
      $('netMsg').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) { sendJ({ t: 'chat', text: e.target.value }); e.target.value = ''; } };
      $('netLeave').onclick = () => leave();
      renderChat();
      return;
    }
    // racing / ended
    const n = lastNet;
    const st = !n ? 'arrancando la cabina…' : n.state === 3 ? 'enlazada ✔' : n.state === 4 ? 'enlace cortado' : 'esperando a las otras cabinas…';
    body.innerHTML = `
      <section><h3>Carrera online · sala ${esc(room?.code || '')}</h3>
        <div class="stat"><span>Tu cabina</span><b>${start ? `${start.index + 1} de ${start.num} (${start.index ? 'SLAVE' : 'MASTER'})` : '—'}</b></div>
        <div class="stat"><span>Estado del cable</span><b>${st}</b></div>
        <div class="stat"><span>Velocidad</span><b>${n ? `${n.fps.toFixed(1)} FPS` : '—'}</b></div>
        <div class="stat"><span>Ping a la sala</span><b>${median(pings) || '—'} ms</b></div>
        <div class="stat"><span>Demora del cable</span><b>${start ? `${start.delay} cuadros (${Math.round(start.delay * 17.4)} ms)` : '—'}</b></div>
        <div class="stat"><span>Esperas por red</span><b>${n ? `${n.waitMs} ms/s` : '—'}</b></div>
        ${dropped.length ? `<p class="notice">Se desconectó: ${dropped.map(esc).join(', ')}. El juego muestra que se cortó el enlace.</p>` : ''}
        <p class="hint">Pilotos: ${start ? start.roster.map((r, i) => `${i + 1}. ${esc(r)}`).join(' · ') : ''}</p>
        <p class="hint">Si alguien va más lento, todos esperan un poco: así las cabinas quedan sincronizadas cuadro a cuadro, igual que con el cable del arcade.</p></section>
      <section><button class="btn" id="netLeave">Salir de la carrera online</button></section>`;
    $('netLeave').onclick = () => leave();
  }
  function roomList() {
    if (rooms === null) return '<p class="empty">No se pudo conectar con el servidor de salas.</p>';
    if (!rooms.length) return '<p class="empty">No hay salas abiertas. ¡Creá una!</p>';
    return rooms.map((r) => `<div class="room"><div><b>${esc(r.nombre)}</b><small>${r.jugadores}/${r.max} · ${esc(r.codigo)}${r.host ? ` · anfitrión ${esc(r.host)}` : ''}</small></div><button class="btn" data-join="${esc(r.codigo)}">Entrar</button></div>`).join('');
  }
  function bindJoin() { for (const b of body.querySelectorAll('[data-join]')) b.onclick = () => connect(b.dataset.join); }
  function renderChat() {
    const el = $('netChat'); if (!el) return;
    el.innerHTML = chat.map((c) => c.name ? `<div><b>${esc(c.name)}:</b> ${esc(c.text)}</div>` : `<div class="sys">${esc(c.text)}</div>`).join('');
    el.scrollTop = 1e9;
  }

  $('btnRooms').addEventListener('click', () => { if (mode === 'idle') refreshList(); render(); });
  listT = setInterval(refreshList, 4000);
  render();
})();
