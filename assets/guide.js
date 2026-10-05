(() => {
  for (const button of document.querySelectorAll("button.copy")) {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copy);
      if (!target) return;
      const clone = target.cloneNode(true);
      for (const extra of clone.querySelectorAll("button, .c")) extra.remove();
      const text = clone.textContent
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
  }

  const canvas = document.querySelector("canvas.aurora");
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  if (!ctx) return;
  const root = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const SCALE = 0.2;
  const FRAME_MS = 1000 / 30;
  const blobs = [
    { rgb: "91,45,110", x: 0.18, y: 0.18, r: 0.6, a: 0.85, s: 0.00011 },
    { rgb: "44,88,201", x: 0.85, y: 0.28, r: 0.5, a: 0.6, s: 0.00009 },
    { rgb: "123,63,147", x: 0.4, y: 0.68, r: 0.45, a: 0.5, s: 0.00007 },
    { rgb: "255,216,74", x: 0.7, y: 0.95, r: 0.32, a: 0.16, s: 0.00013 },
  ];
  let raf = 0;
  let last = 0;

  function resize() {
    canvas.width = Math.max(1, Math.round(innerWidth * SCALE));
    canvas.height = Math.max(1, Math.round(innerHeight * SCALE));
  }

  function draw(t) {
    const w = canvas.width;
    const h = canvas.height;
    const span = Math.max(w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0d0b17";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const x = (b.x + Math.sin(t * b.s * 6.3) * 0.08) * w;
      const y = (b.y + Math.cos(t * b.s * 5.1) * 0.08) * h;
      const g = ctx.createRadialGradient(x, y, 0, x, y, b.r * span);
      g.addColorStop(0, `rgba(${b.rgb},${b.a})`);
      g.addColorStop(1, `rgba(${b.rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < FRAME_MS) return;
    last = t;
    draw(t);
  }

  function update() {
    if (still.matches) {
      cancelAnimationFrame(raf);
      raf = 0;
      root.classList.remove("aurora-on");
      return;
    }
    root.classList.add("aurora-on");
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) raf = requestAnimationFrame(loop);
  }

  resize();
  draw(performance.now());
  addEventListener("resize", () => {
    resize();
    draw(performance.now());
  });
  document.addEventListener("visibilitychange", update);
  still.addEventListener("change", update);
  update();
})();
