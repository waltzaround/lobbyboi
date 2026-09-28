import { Interpolator, LobbyClient, LobbyError, type Listing, type RoomConnection, type RoomInfo } from 'lobbyboi/client';
import { COIN_RADIUS, RADIUS, WORLD, colourFor, move, type Coin, type Input, type Runner } from '../game.js';
import './style.css';

type View = { timeLeft: number; runners: Runner[]; coins: Coin[] };

const lobby = new LobbyClient();
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const esc = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let conn: RoomConnection<View, Input> | null = null;
let room: RoomInfo | null = null;

// ---- Screens ---------------------------------------------------------------

function show(screen: 'home' | 'room' | 'game') {
  for (const id of ['home', 'room', 'game']) $(`#${id}`).hidden = id !== screen;
}

function toast(text: string, sticky = false) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = !text;
  if (!sticky && text) setTimeout(() => el.textContent === text && (el.hidden = true), 3000);
}

async function ensureSession() {
  const name = $<HTMLInputElement>('#name').value.trim() || 'Player';
  localStorage.setItem('lobbyboi:name', name);
  if (lobby.me?.name !== name) await lobby.login(name);
}

async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (err) {
    toast(err instanceof LobbyError ? err.message : String(err));
  }
}

// ---- Home ------------------------------------------------------------------

$<HTMLInputElement>('#name').value = localStorage.getItem('lobbyboi:name') ?? '';
$('#quick').onclick = () => run(async () => {
  await ensureSession();
  enter(await lobby.quickMatch());
});
$('#create').onclick = () => run(async () => {
  await ensureSession();
  enter(await lobby.create({ name: `${lobby.me!.name}'s room` }));
});
$('#join-form').onsubmit = (event) => {
  event.preventDefault();
  const code = $<HTMLInputElement>('#code').value.trim().toUpperCase();
  if (code) run(async () => {
    await ensureSession();
    enter(code);
  });
};

async function refreshRooms() {
  if ($('#home').hidden) return;
  const list = await lobby.rooms().catch(() => [] as Listing[]);
  $('#rooms').innerHTML = list.length
    ? list
        .map(
          (r) => `<li><span>${esc(r.name)}</span><span class="muted">${r.players}/${r.maxPlayers}</span>
            <button data-code="${r.code}">Join</button></li>`,
        )
        .join('')
    : '<li class="muted">No open rooms. Make one!</li>';
}
$('#rooms').onclick = (event) => {
  const code = (event.target as HTMLElement).dataset.code;
  if (code) run(async () => {
    await ensureSession();
    enter(code);
  });
};
setInterval(refreshRooms, 3000);

// ---- Room ------------------------------------------------------------------

function enter(code: string) {
  conn?.close();
  history.replaceState(null, '', `?room=${code}`);
  conn = lobby.join<View, Input>(code);
  conn.on('room', (info) => {
    const previous = room?.phase;
    room = info;
    if (info.phase === 'playing' && previous !== 'playing') startGame();
    renderRoom();
  });
  conn.on('status', (status, detail) => {
    if (status === 'reconnecting') toast('Connection lost, reconnecting…', true);
    else if (status === 'open') toast('');
    else if (status === 'closed') {
      toast(detail?.reason ? `Disconnected: ${detail.reason}` : 'Disconnected');
      leaveRoom();
    }
  });
  conn.on('error', (error) => toast(error.message));
  conn.on('chat', ({ name, text }) => {
    const log = $('#chat-log');
    log.insertAdjacentHTML('beforeend', `<div><b>${esc(name)}</b> ${esc(text)}</div>`);
    log.scrollTop = log.scrollHeight;
  });
  conn.on('snapshot', onSnapshot);
  conn.on('event', (name, data) => {
    const bonk = data as { by: string; hit: string; lost: number };
    if (name === 'bonk') flashes.push({ ...position(bonk.hit), until: performance.now() + 400, text: `-${bonk.lost}` });
  });
  show('room');
}

function leaveRoom() {
  conn = null;
  room = null;
  history.replaceState(null, '', location.pathname);
  show('home');
  void refreshRooms();
}

$('#leave').onclick = () => {
  conn?.leave();
  leaveRoom();
};
$('#ready').onclick = () => {
  const me = room?.players.find((p) => p.id === conn?.you);
  conn?.ready(!me?.ready);
};
$('#start').onclick = () => conn?.start();
$('#bots').onchange = (e) => conn?.settings({ bots: Number((e.target as HTMLSelectElement).value) });
$('#length').onchange = (e) =>
  conn?.settings({ custom: { roundSeconds: Number((e.target as HTMLSelectElement).value) } });
$('#public').onchange = (e) => conn?.settings({ public: (e.target as HTMLInputElement).checked });
$('#copy').onclick = () => navigator.clipboard.writeText(location.href).then(() => toast('Invite link copied'));
$('#chat-form').onsubmit = (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>('#chat');
  if (input.value.trim()) conn?.chat(input.value);
  input.value = '';
};

function renderRoom() {
  if (!room || !conn) return;
  if (room.phase !== 'playing' && !$('#game').hidden && room.phase !== 'results') show('room');
  const me = room.players.find((p) => p.id === conn!.you);
  $('#room-name').textContent = room.settings.name;
  $('#room-code').textContent = room.code;
  $('#players').innerHTML = room.players
    .map(
      (p) => `<li style="--c:${colourFor(p.id)}">
        <i class="dot"></i><span>${esc(p.name)}${p.id === conn!.you ? ' (you)' : ''}</span>
        ${p.id === room!.hostId ? '<em>host</em>' : ''}${p.bot ? '<em>bot</em>' : ''}
        ${!p.connected ? '<em class="warn">away</em>' : ''}
        <b class="${p.ready ? 'ok' : 'muted'}">${p.ready ? 'ready' : 'not ready'}</b></li>`,
    )
    .join('');
  const host = conn.isHost;
  for (const id of ['#bots', '#length', '#public']) $<HTMLInputElement>(id).disabled = !host;
  $<HTMLSelectElement>('#bots').value = String(room.settings.bots);
  $<HTMLSelectElement>('#length').value = String(room.settings.custom.roundSeconds ?? 60);
  $<HTMLInputElement>('#public').checked = room.settings.public;
  $('#ready').textContent = me?.ready ? 'Not ready' : 'Ready';
  $('#start').hidden = !host;
  const countdown = room.phase === 'countdown' && room.phaseEndsAt;
  $('#countdown').hidden = !countdown;
  if (room.phase === 'results') showResults();
}

setInterval(() => {
  if (room?.phase === 'countdown' && room.phaseEndsAt && conn) {
    const left = Math.max(0, Math.ceil((room.phaseEndsAt - conn.serverTime()) / 1000));
    $('#countdown').textContent = left ? String(left) : 'Go!';
  }
}, 100);

// ---- Game ------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('#canvas');
const g = canvas.getContext('2d')!;
const others = new Interpolator<Runner>({ delayMs: 110 });
const keys = new Set<string>();
let view: View | null = null;
let local: Runner | null = null;
let previousLocal: Runner | null = null;
let pending: { seq: number; input: Input }[] = [];
let sendClock = 0;
let lastFrame = performance.now();
const flashes: { x: number; y: number; until: number; text: string }[] = [];
const STEP = 1 / 30;

addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  keys.add(e.key.toLowerCase());
  if (e.key === ' ') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

function readInput(): Input {
  const x = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const y = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
  return { x, y, dash: keys.has(' ') || keys.has('shift') };
}

function startGame() {
  others.clear();
  local = previousLocal = null;
  pending = [];
  view = null;
  $('#results').hidden = true;
  show('game');
}

function onSnapshot({ time, ack, state }: { time: number; ack: number; state: View }) {
  view = state;
  others.push(time, state.runners);
  const server = state.runners.find((r) => r.id === conn?.you);
  if (!server) return;
  // Reconcile: start from the server's copy of us, replay inputs it hasn't seen yet.
  pending = pending.filter((p) => p.seq > ack);
  // `held` (dash edge detection) isn't sent; cooldown stops a replayed double dash anyway.
  const replay: Runner = { ...server, held: pending.length ? false : (local?.held ?? false) };
  for (const p of pending) move(replay, p.input, STEP);
  if (!local || Math.hypot(replay.x - local.x, replay.y - local.y) > 90) {
    local = replay;
    previousLocal = { ...replay };
  } else {
    // Ease out small disagreements instead of snapping.
    local.x += (replay.x - local.x) * 0.35;
    local.y += (replay.y - local.y) * 0.35;
    local.score = replay.score;
    local.cooldown = replay.cooldown;
  }
}

function position(id: string) {
  if (id === conn?.you && local) return { x: local.x, y: local.y };
  const r = view?.runners.find((r) => r.id === id);
  return { x: r?.x ?? 0, y: r?.y ?? 0 };
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if ($('#game').hidden || !conn) return;

  // Fixed 30 Hz input: send, predict, remember for reconciliation.
  sendClock += dt;
  while (sendClock >= STEP) {
    sendClock -= STEP;
    if (room?.phase !== 'playing' || !local) break;
    const input = readInput();
    const seq = conn.sendInput(input);
    pending.push({ seq, input });
    if (pending.length > 120) pending.shift();
    previousLocal = { ...local };
    move(local, input, STEP);
  }
  draw(sendClock / STEP);
}
requestAnimationFrame(frame);

function draw(alpha: number) {
  const scale = Math.min(innerWidth / WORLD.width, (innerHeight - 56) / WORLD.height);
  const dpr = devicePixelRatio || 1;
  canvas.style.width = `${WORLD.width * scale}px`;
  canvas.style.height = `${WORLD.height * scale}px`;
  canvas.width = Math.round(WORLD.width * scale * dpr);
  canvas.height = Math.round(WORLD.height * scale * dpr);
  g.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);

  g.fillStyle = '#10131a';
  g.fillRect(0, 0, WORLD.width, WORLD.height);
  g.strokeStyle = '#1b2130';
  for (let x = 0; x <= WORLD.width; x += 50) line(x, 0, x, WORLD.height);
  for (let y = 0; y <= WORLD.height; y += 50) line(0, y, WORLD.width, y);

  for (const coin of view?.coins ?? []) {
    g.fillStyle = '#ffd34d';
    circle(coin.x, coin.y, COIN_RADIUS);
  }

  const names = new Map(room?.players.map((p) => [p.id, p.name]));
  const runners = others.sample(conn!.serverTime(), conn!.you ?? undefined);
  if (local && previousLocal)
    runners.push({ ...local, x: lerp(previousLocal.x, local.x, alpha), y: lerp(previousLocal.y, local.y, alpha) });
  for (const r of runners) {
    const colour = colourFor(r.id);
    if (r.dashLeft > 0) {
      g.globalAlpha = 0.25;
      g.fillStyle = colour;
      circle(r.x - r.vx * 0.04, r.y - r.vy * 0.04, RADIUS);
      g.globalAlpha = 1;
    }
    g.fillStyle = colour;
    circle(r.x, r.y, RADIUS);
    if (r.id === conn!.you) {
      g.strokeStyle = '#fff';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(r.x, r.y, RADIUS + 4, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 1;
    }
    g.fillStyle = '#e8ecf4';
    g.font = '600 14px system-ui';
    g.textAlign = 'center';
    g.fillText(`${names.get(r.id) ?? '?'} · ${r.score}`, r.x, r.y - RADIUS - 10);
  }

  const now = performance.now();
  for (const f of flashes.filter((f) => f.until > now)) {
    g.fillStyle = '#ff6b6b';
    g.font = '800 22px system-ui';
    g.fillText(f.text, f.x, f.y - 40 - (400 - (f.until - now)) / 12);
  }
  flashes.splice(0, flashes.length, ...flashes.filter((f) => f.until > now));

  const me = runners.find((r) => r.id === conn!.you);
  $('#hud').innerHTML = `<span>⏱ ${view?.timeLeft ?? '–'}s</span><span>🪙 ${me?.score ?? 0}</span>
    <span class="muted">${Math.round(conn!.rtt)} ms</span>
    <span class="muted">${me && me.cooldown > 0 ? 'dash cooling' : 'space to dash'}</span>`;
}

function showResults() {
  const results = room?.results as { scores: { id: string; score: number }[]; winner: string | null } | null;
  if (!results || $('#game').hidden) return;
  const names = new Map(room!.players.map((p) => [p.id, p.name]));
  $('#results').hidden = false;
  $('#results').innerHTML = `<h2>${results.winner === conn?.you ? 'You win!' : `${esc(names.get(results.winner ?? '') ?? 'Nobody')} wins`}</h2>
    <ol>${results.scores.map((s) => `<li><span>${esc(names.get(s.id) ?? '?')}</span><b>${s.score}</b></li>`).join('')}</ol>
    <p class="muted">Back to the lobby in a moment…</p>`;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function circle(x: number, y: number, r: number) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}
function line(x1: number, y1: number, x2: number, y2: number) {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}

// ---- Boot ------------------------------------------------------------------

void (async () => {
  show('home');
  await lobby.resume();
  if (lobby.me) $<HTMLInputElement>('#name').value ||= lobby.me.name;
  const code = new URLSearchParams(location.search).get('room');
  if (code) await run(async () => {
    await ensureSession();
    enter(code);
  });
  void refreshRooms();
})();

