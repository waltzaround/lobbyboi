import { mountConnections } from './connections';
import { Interpolator } from 'lobbyboi/client';
import './landing.css';

mountConnections(document.querySelector<HTMLCanvasElement>('#connections')!, document.querySelector<HTMLButtonElement>('#motion-toggle')!);

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
document.querySelectorAll<HTMLElement>('pre code:not(#local-cmd)').forEach(highlight);

for (const [index, card] of [...document.querySelectorAll<HTMLElement>('[data-tabs]')].entries()) {
  const tabs = [...card.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const panels = [...card.querySelectorAll<HTMLElement>('[data-panel]')];
  const activate = (tab: HTMLButtonElement) => {
    for (const other of tabs) {
      other.setAttribute('aria-selected', String(other === tab));
      other.tabIndex = other === tab ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  };
  for (const [tabIndex, tab] of tabs.entries()) {
    const panel = panels.find((candidate) => candidate.dataset.panel === tab.dataset.tab);
    if (panel) {
      tab.id ||= `tab-${index}-${tabIndex}`;
      panel.id ||= `panel-${index}-${tabIndex}`;
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.tabIndex = 0;
    }
    tab.onclick = () => activate(tab);
    tab.onkeydown = (event) => {
      const next = event.key === 'ArrowRight' ? (tabIndex + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (tabIndex + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      activate(tabs[next]!);
      tabs[next]!.focus();
    };
  }
  if (tabs.length) activate(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0]!);
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  const label = button.textContent;
  button.onclick = async () => {
    const target = document.querySelector<HTMLElement>(button.dataset.copy!);
    if (!target) return;
    const text = target instanceof HTMLTextAreaElement ? target.value : target.textContent ?? '';
    const status = document.querySelector<HTMLElement>('#copy-status')!;
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied!';
      status.textContent = 'Copied to clipboard. Paste it into your coding agent or terminal.';
    } catch {
      target.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'instant' : 'smooth' });
      if (target instanceof HTMLTextAreaElement) {
        target.focus();
        target.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      button.textContent = 'Select & copy manually';
      status.textContent = 'Clipboard access unavailable. Text selected; use your device’s copy command.';
    } finally {
      setTimeout(() => {
        button.textContent = label;
        button.disabled = false;
      }, 2500);
    }
  };
}

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
