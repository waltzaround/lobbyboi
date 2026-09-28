import { Interpolator } from 'lobbyboi/client';
import { COIN_RADIUS, RADIUS, WORLD, move, type Coin, type Input, type Runner } from 'arena/game';
import './landing.css';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- Code: tabs, highlighting, copy ------------------------------------------

const TOKENS =
  /(\/\/.*$|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`]*`)|\b(import|from|export|class|extends|static|const|let|return|for|of|if|await|async|function|new|default)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)(?=\()/gm;
const escapeHtml = (text: string) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function highlight(code: HTMLElement) {
  const text = code.textContent ?? '';
  let html = '';
  let last = 0;
  for (const match of text.matchAll(TOKENS)) {
    html += escapeHtml(text.slice(last, match.index));
    const kind = match[1] ? 'c' : match[2] ? 's' : match[3] ? 'k' : match[4] ? 'n' : 'f';
    html += `<span class="tok-${kind}">${escapeHtml(match[0])}</span>`;
    last = match.index! + match[0].length;
  }
  code.innerHTML = html + escapeHtml(text.slice(last));
}
document.querySelectorAll<HTMLElement>('pre code').forEach(highlight);

for (const card of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
  const tabs = [...card.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  for (const tab of tabs)
    tab.onclick = () => {
      for (const other of tabs) other.setAttribute('aria-selected', String(other === tab));
      for (const panel of card.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    };
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]'))
  button.onclick = async () => {
    const text = document.querySelector(button.dataset.copy!)?.textContent ?? '';
    await navigator.clipboard.writeText(text).catch(() => {});
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy'), 1500);
  };

// ---- Only animate what's on screen ------------------------------------------

function whileVisible(element: Element, tick: (now: number) => void) {
  let visible = false;
  let frame = 0;
  const loop = (now: number) => {
    tick(now);
    frame = visible ? requestAnimationFrame(loop) : 0;
  };
  new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    if (visible && !frame) frame = requestAnimationFrame(loop);
  }).observe(element);
}

function fit(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const rect = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) [canvas.width, canvas.height] = [width, height];
  return { ctx, scale: rect.width, dpr };
}

// ---- Netcode demo -----------------------------------------------------------
// A dot follows a curve on a pretend server. Snapshots of it are sent at the
// chosen rate through a pretend network with delay, jitter and loss. The left
// canvas draws whatever arrived last; the right one uses lobbyboi's Interpolator.

const W = 480;
const H = 300;
const BASE_LATENCY = 30;
const truth = (t: number) => ({ x: W / 2 + 175 * Math.sin(t * 0.0011), y: H / 2 + 95 * Math.sin(t * 0.0019 + 0.6) });

type Dot = { id: string; x: number; y: number; vx: number; vy: number };
const settings = { rate: 15, jitter: 40, loss: 0.05 };
let interpolator = new Interpolator<Dot>();
let raw: Dot | null = null;
let lastSent = performance.now();
const inFlight: { at: number; snap: Dot & { time: number } }[] = [];
const rawTrail: { x: number; y: number }[] = [];
const smoothTrail: { x: number; y: number }[] = [];

function resetInterpolator() {
  const delay = Math.round((1000 / settings.rate) * 1.5 + settings.jitter + BASE_LATENCY);
  interpolator = new Interpolator<Dot>({ delayMs: delay, maxExtrapolateMs: 150 });
  document.querySelector('#delay-label')!.textContent = String(delay);
}
resetInterpolator();

const rateGroup = document.querySelector<HTMLElement>('#rate')!;
rateGroup.onclick = (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
  if (!button) return;
  for (const b of rateGroup.querySelectorAll('button')) {
    b.classList.toggle('on', b === button);
    b.setAttribute('aria-checked', String(b === button));
  }
  settings.rate = Number(button.dataset.value);
  resetInterpolator();
};
const jitter = document.querySelector<HTMLInputElement>('#jitter')!;
jitter.oninput = () => {
  settings.jitter = Number(jitter.value);
  document.querySelector('#jitter-out')!.textContent = `${jitter.value} ms`;
  resetInterpolator();
};
const loss = document.querySelector<HTMLInputElement>('#loss')!;
loss.oninput = () => {
  settings.loss = Number(loss.value) / 100;
  document.querySelector('#loss-out')!.textContent = `${loss.value}%`;
};

const rawCanvas = document.querySelector<HTMLCanvasElement>('#raw')!;
const smoothCanvas = document.querySelector<HTMLCanvasElement>('#smooth')!;

function drawDemo(canvas: HTMLCanvasElement, dot: { x: number; y: number } | null, trail: { x: number; y: number }[], now: number) {
  const { ctx, scale, dpr } = fit(canvas);
  const k = (scale / W) * dpr;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const ink = css('--ink');
  const coin = css('--coin');

  ctx.strokeStyle = css('--line');
  ctx.lineWidth = 1;
  for (let x = 40; x < W; x += 40) line(ctx, x, 0, x, H);
  for (let y = 40; y < H; y += 40) line(ctx, 0, y, W, y);

  const server = truth(now);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(server.x, server.y, 17, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  if (dot) {
    trail.push({ x: dot.x, y: dot.y });
    if (trail.length > 28) trail.shift();
  }
  ctx.fillStyle = coin;
  trail.forEach((p, i) => {
    ctx.globalAlpha = (i / trail.length) * 0.35;
    circle(ctx, p.x, p.y, 4);
  });
  ctx.globalAlpha = 1;
  if (dot) {
    ctx.fillStyle = coin;
    circle(ctx, dot.x, dot.y, 13);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 13, 0, Math.PI * 2);
    ctx.stroke();
  }
}

whileVisible(rawCanvas, (now) => {
  const interval = 1000 / settings.rate;
  // Don't replay a backlog after the tab was hidden.
  if (now - lastSent > 1000) lastSent = now;
  while (now - lastSent >= interval) {
    lastSent += interval;
    if (Math.random() < settings.loss) continue;
    const p = truth(lastSent);
    const ahead = truth(lastSent + 1);
    inFlight.push({
      at: lastSent + BASE_LATENCY + Math.random() * settings.jitter,
      snap: { id: 'p', time: lastSent, x: p.x, y: p.y, vx: (ahead.x - p.x) * 1000, vy: (ahead.y - p.y) * 1000 },
    });
  }
  inFlight.sort((a, b) => a.at - b.at);
  while (inFlight.length && inFlight[0]!.at <= now) {
    const { snap } = inFlight.shift()!;
    raw = snap;
    interpolator.push(snap.time, [snap]);
  }
  drawDemo(rawCanvas, raw, rawTrail, now);
  drawDemo(smoothCanvas, interpolator.sample(now)[0] ?? null, smoothTrail, now);
});

// ---- Lifecycle ----------------------------------------------------------------

const steps = [...document.querySelectorAll('#lifecycle li')];
let step = 0;
steps[0]?.classList.add('active');
if (!reducedMotion)
  setInterval(() => {
    steps[step]?.classList.remove('active');
    step = (step + 1) % steps.length;
    steps[step]?.classList.add('active');
  }, 1800);

// ---- Coin Rush, played by bots, behind the call to action ---------------------

const arena = document.querySelector<HTMLCanvasElement>('#arena')!;
const BOT_COLOURS = ['#ff6b6b', '#4dabf7', '#69db7c', '#b197fc', '#ffa94d', '#63e6be', '#f783ac'];
const bots: Runner[] = Array.from({ length: 7 }, (_, i) => ({
  id: String(i),
  x: 200 + ((i * 173) % 800),
  y: 150 + ((i * 97) % 500),
  vx: 0,
  vy: 0,
  score: 0,
  dashLeft: 0,
  cooldown: 0,
  dx: 1,
  dy: 0,
}));
let coins: Coin[] = [];
let coinId = 0;
const dropCoin = () =>
  coins.push({ id: `c${coinId++}`, x: 40 + Math.random() * (WORLD.width - 80), y: 40 + Math.random() * (WORLD.height - 80) });
for (let i = 0; i < 16; i++) dropCoin();

function botInput(me: Runner, t: number): Input {
  let target: Coin | null = null;
  let best = Infinity;
  for (const coin of coins) {
    const d = Math.hypot(coin.x - me.x, coin.y - me.y);
    if (d < best) [best, target] = [d, coin];
  }
  if (!target) return { x: 0, y: 0, dash: false };
  const angle = Math.atan2(target.y - me.y, target.x - me.x) + Math.sin(t / 400 + me.id.length) * 0.3;
  return { x: Math.cos(angle), y: Math.sin(angle), dash: best > 220 && me.cooldown === 0 };
}

let arenaLast = 0;
whileVisible(arena, (now) => {
  const dt = Math.min(0.05, (now - (arenaLast || now)) / 1000);
  arenaLast = now;
  if (!reducedMotion) {
    for (const bot of bots) move(bot, botInput(bot, now), dt * 0.8);
    for (const bot of bots)
      coins = coins.filter((coin) => Math.hypot(coin.x - bot.x, coin.y - bot.y) > RADIUS + COIN_RADIUS || (bot.score++, false));
    while (coins.length < 16) dropCoin();
  }

  const { ctx, dpr } = fit(arena);
  const rect = arena.getBoundingClientRect();
  // Fit the arena's height and sit it on the right, beside the copy. On narrow
  // screens, cover the band instead.
  const wide = rect.width > rect.height * 2;
  const k = (wide ? rect.height / WORLD.height : Math.max(rect.width / WORLD.width, rect.height / WORLD.height)) * dpr;
  const ox = wide ? arena.width - WORLD.width * k - 24 * dpr : (arena.width - WORLD.width * k) / 2;
  const oy = (arena.height - WORLD.height * k) / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, arena.width, arena.height);
  ctx.setTransform(k, 0, 0, k, ox, oy);
  ctx.strokeStyle = '#1f2533';
  ctx.lineWidth = 1;
  // Grid across the whole band, so the arena's edges don't show.
  const left = -ox / k;
  for (let x = left - (left % 50) - 50; x <= (arena.width - ox) / k; x += 50) line(ctx, x, -oy / k, x, (arena.height - oy) / k);
  for (let y = 0; y <= WORLD.height; y += 50) line(ctx, left, y, (arena.width - ox) / k, y);
  ctx.fillStyle = '#ffd34d';
  for (const coin of coins) circle(ctx, coin.x, coin.y, COIN_RADIUS);
  for (const bot of bots) {
    ctx.fillStyle = BOT_COLOURS[Number(bot.id)]!;
    if (bot.dashLeft > 0) {
      ctx.globalAlpha = 0.3;
      circle(ctx, bot.x - bot.vx * 0.04, bot.y - bot.vy * 0.04, RADIUS);
      ctx.globalAlpha = 1;
    }
    circle(ctx, bot.x, bot.y, RADIUS);
  }
});

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
