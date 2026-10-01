// Illustrative traffic, not a live connection: browsers share one authoritative room.
export function mountConnections(canvas: HTMLCanvasElement, toggle: HTMLButtonElement) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const ctx = context;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motion.matches;
  let visible = false;
  let frame = 0;
  let elapsed = 0;
  let previous = 0;
  let width = 0;
  let height = 0;
  const colours = ['#528fb5', '#9a7abd', '#629d7d'];
  const players = [65, 200, 335];
  const ink = '#303a32';
  const muted = '#6a746b';
  const phases = ['Players connect to the same room', 'Player inputs travel to the room', 'The room updates the shared game', 'Game snapshots return to everyone'];

  function text(value: string, x: number, y: number, size = 11, colour = ink) {
    ctx.fillStyle = colour;
    ctx.font = `${size}px "DM Sans", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(value, x, y);
  }
  function dot(x: number, y: number, radius: number, colour: string) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  function box(x: number, y: number, w: number, h: number, fill = '#fcfcfa', stroke = '#d8dfd6') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 7);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  function path(points: [number, number][], colour: string, progress?: number, reverse = false) {
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (progress === undefined) return;
    const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
    let distance = (reverse ? 1 - progress : progress) * lengths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < lengths.length; i++) {
      if (distance <= lengths[i]! || i === lengths.length - 1) {
        const t = distance / lengths[i]!;
        const from = points[i]!;
        const to = points[i + 1]!;
        const x = from[0] + (to[0] - from[0]) * t;
        const y = from[1] + (to[1] - from[1]) * t;
        ctx.globalAlpha = 0.12;
        dot(x, y, 9, colour);
        ctx.globalAlpha = 1;
        dot(x, y, 3.5, colour);
        return;
      }
      distance -= lengths[i]!;
    }
  }
  function draw() {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    const scale = Math.min(width / 400, height / 450);
    ctx.save();
    ctx.translate((width - 400 * scale) / 2, (height - 450 * scale) / 2);
    ctx.scale(scale, scale);
    const phase = Math.floor(elapsed / 2400) % 4;
    const progress = (elapsed % 2400) / 2400;
    const flow = phase === 0 || phase === 1 || phase === 3;
    // All sockets are routed through the Worker into the same Durable Object.
    players.forEach((x, i) => {
      path([[x, 100], [x, 126], [200 + (i - 1) * 20, 156], [200 + (i - 1) * 20, 173]], colours[i]!, flow ? progress : undefined, phase === 3);
    });
    path([[184, 229], [184, 298]], colours[0]!, phase === 1 ? progress : undefined);
    path([[216, 229], [216, 298]], colours[2]!, phase === 3 ? progress : undefined, true);
    text('inputs ↓', 137, 268, 10, colours[0]);
    text('↑ snapshots', 273, 268, 10, colours[2]);
    players.forEach((x, i) => {
      box(x - 52, 30, 104, 70);
      dot(x - 37, 42, 2, colours[i]!);
      text(`Player ${i + 1}`, x + 2, 46, 10, muted);
      // Matching mini-scenes make the shared state visible in each browser.
      colours.forEach((colour, j) => {
        const shift = Math.sin(elapsed / 1300 + j * 2) * 5;
        dot(x - 23 + j * 23 + shift, 75 + Math.cos(elapsed / 1600 + j) * 5, 4, colour);
      });
    });
    text('Three browsers. One room code.', 200, 13, 11, muted);
    box(109, 173, 182, 56);
    text('Cloudflare Worker', 200, 195, 14);
    text('Checks the session · routes the connection', 200, 214, 8.5, muted);
    const pulse = phase === 2 ? Math.sin(progress * Math.PI) : 0;
    box(72, 298, 256, 112, '#f1f5ed', phase === 2 ? '#80a276' : '#cbd8c5');
    text('Game room / K7QX2', 200, 321, 14);
    text('One Durable Object · shared game state', 200, 339, 10, muted);
    colours.forEach((colour, i) => {
      const x = 157 + i * 43 + Math.sin(elapsed / 1300 + i * 2) * 9;
      const y = 371 + Math.cos(elapsed / 1600 + i) * 5;
      ctx.globalAlpha = 0.1 + pulse * 0.1;
      dot(x, y, 12, colour);
      ctx.globalAlpha = 1;
      dot(x, y, 5, colour);
    });
    text('The server runs the rules for everyone.', 200, 399, 9, muted);
    phases.forEach((_, i) => dot(175 + i * 16, 432, i === phase ? 3 : 2, i === phase ? '#52684a' : '#d7ded2'));
    text(phases[phase]!, 200, 449, 10, muted);
    ctx.restore();
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
  }
  function animate(now: number) {
    elapsed += previous ? Math.min(now - previous, 50) : 0;
    previous = now;
    draw();
    frame = requestAnimationFrame(animate);
  }
  function sync() {
    toggle.textContent = paused ? 'Play motion' : 'Pause motion';
    toggle.setAttribute('aria-pressed', String(paused));
    if (paused || !visible || document.hidden) stop();
    else if (!frame) frame = requestAnimationFrame(animate);
    draw();
  }
  toggle.onclick = () => { paused = !paused; sync(); };
  motion.addEventListener('change', () => { paused = motion.matches; sync(); });
  document.addEventListener('visibilitychange', sync);
  new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }).observe(canvas);
  new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; sync(); }).observe(canvas);
  sync();
}
