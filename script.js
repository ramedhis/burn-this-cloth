// Just the floating panel: dragging + show/hide
(function () {
  const panel = document.getElementById('panel');
  const head = document.getElementById('panelHead');
  const closeBtn = document.getElementById('panelClose');
  const menuToggle = document.getElementById('menuToggle');

  let dragging = false;
  let offX = 0, offY = 0;

  head.addEventListener('mousedown', (e) => {
    // Don't start a drag if clicked the close button
    if (e.target === closeBtn) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let x = e.clientX - offX;
    let y = e.clientY - offY;

    // Keep it from getting dragged completely off-screen
    x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, x));
    y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, y));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  closeBtn.addEventListener('click', () => {
    panel.classList.add('hidden');
    menuToggle.classList.remove('hidden');
  });

  menuToggle.addEventListener('click', () => {
    panel.classList.remove('hidden');
    menuToggle.classList.add('hidden');
  });
})();

// Cloth + fire toy. Two systems glued together:
//   1) A mass-spring grid that warps an image (the "cloth")
//   2) A small particle sim for flames/embers/smoke (the "fire")
// They only talk to each other through burn values on grid points.

(function () {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  // Canvas is no longer locked to a square -- these two are mutable now,
  // changed via applyCanvasSize() when someone picks a preset or types
  // in a custom width/height.
  // Default stays at the original 600x600
  let WIDTH = 600;
  let HEIGHT = 600;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  const stageEl = document.querySelector('.stage');

  // Sizes the box the canvas actually sits in so it never blows past
  // the viewport, while keeping the true pixel aspect ratio intact
  function fitStage() {
    const maxW = window.innerWidth * 0.92;
    const maxH = window.innerHeight * 0.88;
    const ar = WIDTH / HEIGHT;
    let w = maxW, h = w / ar;
    if (h > maxH) { h = maxH; w = h * ar; }
    stageEl.style.width = w + 'px';
    stageEl.style.height = h + 'px';
  }
  window.addEventListener('resize', fitStage);

  // Default used to be "fine" back when the canvas defaulted to
  // 600x600, and stays "fine" now since the default canvas size is
  // still 600x600 -- only picking a bigger preset should cost you
  // anything, not just having the feature available
  // "sub" is how many render cells each physics cell gets split into
  // when we build the smoothed mesh below -- picked by hand rather
  // than from some formula so each tier lands somewhere sane instead
  // of trusting a ratio to do the right thing at both extremes.
  // coarse*2 and fine*1 land on the same rendered resolution (36x36)
  // on purpose, so "coarse" gets to look as smooth as "fine" used to
  // while the actual spring grid underneath stays cheap. normal gets
  // its own *2 bump since it's the one people are likely to leave it
  // on by default.
  const densities = [
    { c: 18, r: 18, label: 'coarse', sub: 2 },
    { c: 26, r: 26, label: 'normal', sub: 2 },
    { c: 36, r: 36, label: 'fine', sub: 1 },
  ];
  let densityIdx = 2;
  let COLS = densities[densityIdx].c;
  let ROWS = densities[densityIdx].r;
  let SUB = densities[densityIdx].sub;

  // Fixed pixel gap on every side
  const CLOTH_GAP = 20;
  function clothRect() {
    return {
      x: CLOTH_GAP, y: CLOTH_GAP,
      w: WIDTH - CLOTH_GAP * 2, h: HEIGHT - CLOTH_GAP * 2,
    };
  }

  const texCanvas = document.createElement('canvas');
  texCanvas.width = WIDTH;
  texCanvas.height = HEIGHT;
  const texCtx = texCanvas.getContext('2d');

  let particles = [];
  let sourceImage = null;

  function drawPlaceholderTexture() {
    const rect = clothRect();

    const g = texCtx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    g.addColorStop(0, '#f2f2f0');
    g.addColorStop(0.5, '#e2e2de');
    g.addColorStop(1, '#d0d0cc');
    texCtx.fillStyle = g;
    texCtx.fillRect(rect.x, rect.y, rect.w, rect.h);

    // Two strokes corner-to-corner across the cloth
    texCtx.strokeStyle = 'rgba(90,90,86,0.35)';
    texCtx.lineWidth = 3;
    texCtx.lineCap = 'round';
    texCtx.beginPath();
    texCtx.moveTo(rect.x, rect.y);
    texCtx.lineTo(rect.x + rect.w, rect.y + rect.h);
    texCtx.moveTo(rect.x + rect.w, rect.y);
    texCtx.lineTo(rect.x, rect.y + rect.h);
    texCtx.stroke();
  }

  function loadImageCover(img) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const rect = clothRect();

    // cover-fit: scale so the shorter side fills the cloth, crop the rest
    const scale = Math.max(rect.w / iw, rect.h / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = rect.x + (rect.w - dw) / 2, dy = rect.y + (rect.h - dh) / 2;
    texCtx.clearRect(0, 0, WIDTH, HEIGHT);

    // This only ever shows through if the loaded image has transparent pixels
    texCtx.fillStyle = '#e2e2de';
    texCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
    texCtx.drawImage(img, dx, dy, dw, dh);
  }

  function buildGrid() {
    COLS = densities[densityIdx].c;
    ROWS = densities[densityIdx].r;
    SUB = densities[densityIdx].sub;
    allocFineBuffers();

    const rect = clothRect();
    const spx = rect.w / COLS, spy = rect.h / ROWS;
    particles = [];

    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const rx = rect.x + i * spx, ry = rect.y + j * spy;
        const pinned =
          (i === 0 && j === 0) ||
          (i === COLS && j === 0) ||
          (i === 0 && j === ROWS) ||
          (i === COLS && j === ROWS);
        particles.push({
          x: rx, y: ry, restX: rx, restY: ry,
          vx: 0, vy: 0,
          pinned,
          burn: 0,
          burning: false,
          destroyed: false,
          heat: 0,

          // Random-ish so neighbouring cells don't all give out at
          // exactly the same moment
          destroyAt: 0.82 + Math.random() * 0.35,
          seed: Math.random() * 1000,
        });
      }
    }
  }

  function idx(i, j) { return j * (COLS + 1) + i; }

  function resetCloth(keepTexture) {
    buildGrid();
    flames.length = 0;
    embers.length = 0;
    smoke.length = 0;
    if (!keepTexture) {
      if (sourceImage) loadImageCover(sourceImage);
      else drawPlaceholderTexture();
    }
  }

  // Swaps the working resolution
  // Resizes both the visible canvas and the offscreen texture canvas,
  // then rebuilds the grid and redraws whatever image (or the placeholder)
  // at the new dimensions
  function applyCanvasSize(w, h) {
    WIDTH = Math.max(64, Math.min(2160, Math.round(w) || WIDTH));
    HEIGHT = Math.max(64, Math.min(2160, Math.round(h) || HEIGHT));
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    texCanvas.width = WIDTH;
    texCanvas.height = HEIGHT;
    fitStage();
    resetCloth(false);
  }

  // Cloth Physics
  const SPRING_REST = 42;
  const SPRING_NEIGH = 18;
  const DAMPING = 0.90;
  const PUSH_RADIUS = 90;
  const PUSH_STRENGTH = 2600;

  let mouse = { x: -9999, y: -9999, active: false };

  function stepCloth(dt) {
    dt = Math.min(dt, 1 / 30); // Clamp so a dropped frame doesn't launch the cloth into orbit

    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const p = particles[idx(i, j)];
        if (p.pinned) { p.x = p.restX; p.y = p.restY; p.vx = 0; p.vy = 0; continue; }
        if (p.destroyed) continue;

        let fx = (p.restX - p.x) * SPRING_REST;
        let fy = (p.restY - p.y) * SPRING_REST;

        const neighbors = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
        for (const [ni, nj] of neighbors) {
          if (ni < 0 || ni > COLS || nj < 0 || nj > ROWS) continue;
          const n = particles[idx(ni, nj)];
          fx += (n.x - p.x - (n.restX - p.restX)) * SPRING_NEIGH;
          fy += (n.y - p.y - (n.restY - p.restY)) * SPRING_NEIGH;
        }

        if (mouse.active) {
          const dx = p.x - mouse.x, dy = p.y - mouse.y;
          const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
          if (dist < PUSH_RADIUS) {
            const falloff = 1 - dist / PUSH_RADIUS;
            fx += (dx / dist) * PUSH_STRENGTH * falloff * falloff;
            fy += (dy / dist) * PUSH_STRENGTH * falloff * falloff;
          }
        }

        if (p.burning || p.burn > 0) {
          p.heat += dt;
          // Burning bits curl up and shudder a little, heat rises after all
          fy -= 40 * Math.min(p.burn, 1);
          fx += Math.sin(p.seed + p.heat * 9) * 14 * Math.min(p.burn, 1);
        }

        p.vx = (p.vx + fx * dt) * DAMPING;
        p.vy = (p.vy + fy * dt) * DAMPING;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }

    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const p = particles[idx(i, j)];
        if (p.destroyed || !p.burning) continue;

        p.burn += dt * (0.5 + Math.random() * 0.35);

        // Once a point is decently caught, it has a shot at lighting
        // its neighbours each frame -- keep the odds low or the whole
        // sheet goes up in about half a second
        if (p.burn >= 0.35) {
          const neighbors = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
          for (const [ni, nj] of neighbors) {
            if (ni < 0 || ni > COLS || nj < 0 || nj > ROWS) continue;
            const n = particles[idx(ni, nj)];
            if (!n.burning && !n.destroyed && Math.random() < 0.04) {
              n.burning = true;
            }
          }
        }

        if (p.burn >= p.destroyAt) {
          p.burn = 1;
          p.destroyed = true;
          p.burning = false;
          spawnAshPuff(p.x, p.y);
        }
      }
    }
  }

  // Fire Particles:
  let flames = [];
  let embers = [];
  let smoke = [];
  const MAX_FLAMES = 260;
  const MAX_EMBERS = 140;
  const MAX_SMOKE = 90;

  function spawnFlame(x, y) {
    if (flames.length > MAX_FLAMES) return;
    flames.push({
      x: x + (Math.random() - 0.5) * 6,
      y: y + (Math.random() - 0.5) * 6,
      vx: (Math.random() - 0.5) * 26,
      vy: -(40 + Math.random() * 55),
      life: 0,
      maxLife: 0.35 + Math.random() * 0.4,
      size: 9 + Math.random() * 10,
      wobble: Math.random() * Math.PI * 2,
    });
  }

  function spawnEmber(x, y) {
    if (embers.length > MAX_EMBERS) return;
    embers.push({
      x, y,
      vx: (Math.random() - 0.5) * 40,
      vy: -(30 + Math.random() * 70),
      life: 0,
      maxLife: 0.6 + Math.random() * 1.1,
      size: 1 + Math.random() * 2.2,
      flicker: Math.random() * 10,
    });
  }

  function spawnSmoke(x, y) {
    if (smoke.length > MAX_SMOKE) return;
    smoke.push({
      x, y,
      vx: (Math.random() - 0.5) * 12,
      vy: -(18 + Math.random() * 18),
      life: 0,
      maxLife: 1.8 + Math.random() * 1.4,
      size: 10 + Math.random() * 10,
    });
  }

  function spawnAshPuff(x, y) {
    for (let k = 0; k < 4; k++) spawnSmoke(x, y);
  }

  function updateFire(dt) {
    // Burning points continually feed the particle pools
    for (const p of particles) {
      if (p.destroyed) continue;
      if (p.burning) {
        if (Math.random() < 0.85) spawnFlame(p.x, p.y);
        if (Math.random() < 0.35) spawnEmber(p.x, p.y);
        if (Math.random() < 0.12) spawnSmoke(p.x, p.y);
      }
    }

    const stepList = (list, fn) => {
      for (let k = list.length - 1; k >= 0; k--) {
        const it = list[k];
        it.life += dt;
        if (it.life >= it.maxLife) { list.splice(k, 1); continue; }
        fn(it);
      }
    };

    stepList(flames, (f) => {
      f.wobble += dt * 10;
      f.x += (f.vx + Math.sin(f.wobble) * 18) * dt;
      f.y += f.vy * dt;
      f.vy *= 0.985; // Flames decelerate as they cool, not a real physical thing but reads right
    });

    stepList(embers, (e) => {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vy += 25 * dt; // Slight gravity pulls the dead ones back down
      e.vx *= 0.99;
    });

    stepList(smoke, (s) => {
      s.x += (s.vx + Math.sin(s.life * 3 + s.x) * 6) * dt;
      s.y += s.vy * dt;
      s.size += dt * 14; // Smoke puffs out as it rises
    });
  }

  function renderFire() {
    // Soft glow first, underneath everything
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      if (p.destroyed || (!p.burning && p.burn <= 0)) continue;
      const intensity = Math.min(p.burn, 1);
      const r = 46 + intensity * 20;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(0, `rgba(255,150,40,${0.14 * intensity})`);
      grad.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Flame licks
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flames) {
      const t = f.life / f.maxLife; // 0 = just born, 1 = about to die
      const size = f.size * (1 - t * 0.8);
      if (size <= 0) continue;
      const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, size);
      if (t < 0.3) {
        grad.addColorStop(0, 'rgba(255,250,220,0.9)');
        grad.addColorStop(0.5, 'rgba(255,200,60,0.7)');
        grad.addColorStop(1, 'rgba(255,120,20,0)');
      } else {
        grad.addColorStop(0, `rgba(255,160,40,${0.75 * (1 - t)})`);
        grad.addColorStop(0.6, `rgba(230,70,20,${0.45 * (1 - t)})`);
        grad.addColorStop(1, 'rgba(180,30,10,0)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(f.x, f.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Embers -- tiny bright dots
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of embers) {
      const t = e.life / e.maxLife;
      const twinkle = 0.5 + 0.5 * Math.sin(e.life * 24 + e.flicker);
      ctx.fillStyle = `rgba(255,${140 + twinkle * 80},${40 + twinkle * 40},${(1 - t) * 0.9})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Smoke on top, normal blending so it actually darkens/obscures
    // rather than glowing like the flame layers
    ctx.save();
    for (const s of smoke) {
      const t = s.life / s.maxLife;
      const alpha = (1 - t) * 0.16;
      const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size);
      grad.addColorStop(0, `rgba(40,36,32,${alpha})`);
      grad.addColorStop(1, 'rgba(40,36,32,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Mesh -> image warp:
  // Maps a triangle of (u,v) texture coords onto a triangle of (x,y)
  // screen coords using a plain affine transform. This is the
  // textbook 3-point solution, not something I derived myself.
  function drawTri(x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2, burnAvg) {
    const denom = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
    if (Math.abs(denom) < 1e-6) return; // Degenerate triangle, skip it

    const a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / denom;
    const b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / denom;
    const c = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / denom;
    const d = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / denom;
    const e = (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / denom;
    const f = (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / denom;

    // Only the bit of the source image this triangle actually needs
    const pad = 1;
    const sx = Math.max(0, Math.min(u0, u1, u2) - pad);
    const sy = Math.max(0, Math.min(v0, v1, v2) - pad);
    const sw = Math.min(WIDTH, Math.max(u0, u1, u2) + pad) - sx;
    const sh = Math.min(HEIGHT, Math.max(v0, v1, v2) + pad) - sy;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(texCanvas, sx, sy, sw, sh, sx, sy, sw, sh);

    // Char/scorch pass, same clip so this doesn't cost a second
    // save/clip. kept subtle and multiplied in instead of painted flat
    // on top, otherwise every triangle edge shows up as a visible seam
    // (this was the "looks like a grid" problem)
    if (burnAvg > 0.15) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const t = Math.min(burnAvg, 1);
      ctx.globalCompositeOperation = 'multiply';
      const darkness = Math.min((t - 0.15) / 0.85, 1);
      ctx.fillStyle = `rgba(${60 - darkness * 45},${40 - darkness * 32},${28 - darkness * 24},${0.25 + darkness * 0.55})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
    ctx.restore();
  }

  // Smoothed render mesh:
  // the physics above only ever runs on the coarse spring grid -- has
  // to, that's what keeps it cheap enough to shove around with a
  // mouse in real time. But drawing that grid straight is what makes
  // the cloth look faceted/low-poly, especially on "coarse". So
  // instead of feeding particle positions straight to drawTri, we fit
  // a bicubic surface through the coarse grid and re-sample it at
  // SUB times the resolution, and draw that instead. Still just the
  // one spring simulation underneath -- this part never touches
  // velocities or forces, it only ever reads finished positions.
  //
  // The interpolation itself is Catmull-Rom, done the standard
  // separable way: interpolate along rows first, then interpolate
  // those results down a column. Four points in, one point out, in
  // both passes -- nothing fancier than that.
  function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  // Clamps a coarse grid index back onto the real column/row range --
  // used a lot below, kept as one-liners rather than a helper function
  // since this is hot-path code and a function call per lookup adds
  // up once you're doing it thousands of times a frame
  function clampCol(i) { return i < 0 ? 0 : (i > COLS ? COLS : i); }
  function clampRow(j) { return j < 0 ? 0 : (j > ROWS ? ROWS : j); }

  // Fine-mesh scratch buffers. Typed arrays, allocated once per
  // density/canvas change and just overwritten every frame after
  // that -- this whole mesh gets rebuilt 60 times a second, so
  // there's no handing the GC a fresh batch of arrays every frame.
  //
  // rowTmp* holds the in-between state: each real physics row, already
  // stretched out horizontally to fine resolution, but not yet blended
  // vertically. One array per field, (ROWS+1) rows of (fineCols+1)
  // values each.
  let fineCols = 0, fineRows = 0;
  let fineX, fineY, fineU, fineV, fineBurn, fineAlive;
  let rowTmpX, rowTmpY, rowTmpBurn, rowTmpAlive;

  function allocFineBuffers() {
    fineCols = COLS * SUB;
    fineRows = ROWS * SUB;
    const n = (fineCols + 1) * (fineRows + 1);
    fineX = new Float32Array(n);
    fineY = new Float32Array(n);
    fineU = new Float32Array(n);
    fineV = new Float32Array(n);
    fineBurn = new Float32Array(n);
    fineAlive = new Float32Array(n);

    const rowN = (ROWS + 1) * (fineCols + 1);
    rowTmpX = new Float32Array(rowN);
    rowTmpY = new Float32Array(rowN);
    rowTmpBurn = new Float32Array(rowN);
    rowTmpAlive = new Float32Array(rowN);
  }

  function fineIdx(i, j) { return j * (fineCols + 1) + i; }
  function rowTmpIdx(i, j) { return j * (fineCols + 1) + i; } // j here is a *coarse* row

  // Builds the render mesh from the current particle positions. Two
  // passes, same idea the comment above describes: stretch every
  // coarse row out to fine resolution first (horizontal pass), then
  // blend those stretched rows down into fine rows (vertical pass).
  // Each physics cell's four control points get fetched once and
  // reused for all SUB in-between samples, rather than re-deriving
  // them from scratch per output pixel like a naive per-vertex
  // sampler would -- that was the first draft of this, and it spent
  // more time re-walking the particle grid than actually blending it.
  function buildFineMesh() {
    const rect = clothRect();
    const spx = rect.w / COLS, spy = rect.h / ROWS;

    // Pass 1: horizontal, one real row at a time
    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const ia = clampCol(i - 1), ib = i, ic = clampCol(i + 1), id = clampCol(i + 2);
        const pa = particles[idx(ia, j)], pb = particles[idx(ib, j)];
        const pc = particles[idx(ic, j)], pd = particles[idx(id, j)];
        const ba = pa.destroyed ? 0 : 1, bb = pb.destroyed ? 0 : 1;
        const bc = pc.destroyed ? 0 : 1, bd = pd.destroyed ? 0 : 1;

        for (let k = 0; k < SUB; k++) {
          const t = k / SUB;
          const n = rowTmpIdx(i * SUB + k, j);
          rowTmpX[n] = catmullRom(pa.x, pb.x, pc.x, pd.x, t);
          rowTmpY[n] = catmullRom(pa.y, pb.y, pc.y, pd.y, t);
          rowTmpBurn[n] = catmullRom(pa.burn, pb.burn, pc.burn, pd.burn, t);
          rowTmpAlive[n] = catmullRom(ba, bb, bc, bd, t);
        }
      }
      // Right edge of the cloth -- not covered by the loop above since
      // it only walks whole cells, so the very last fine column of
      // each row is just the real edge particle, exactly
      const p = particles[idx(COLS, j)];
      const n = rowTmpIdx(fineCols, j);
      rowTmpX[n] = p.x; rowTmpY[n] = p.y; rowTmpBurn[n] = p.burn;
      rowTmpAlive[n] = p.destroyed ? 0 : 1;
    }

    // Pass 2: vertical, blending the stretched rows together
    for (let i = 0; i <= fineCols; i++) {
      const u = i / SUB;
      const uPix = rect.x + u * spx;
      for (let j = 0; j < ROWS; j++) {
        const ja = clampRow(j - 1), jb = j, jc = clampRow(j + 1), jd = clampRow(j + 2);
        const xa = rowTmpX[rowTmpIdx(i, ja)], xb = rowTmpX[rowTmpIdx(i, jb)];
        const xc = rowTmpX[rowTmpIdx(i, jc)], xd = rowTmpX[rowTmpIdx(i, jd)];
        const ya = rowTmpY[rowTmpIdx(i, ja)], yb = rowTmpY[rowTmpIdx(i, jb)];
        const yc = rowTmpY[rowTmpIdx(i, jc)], yd = rowTmpY[rowTmpIdx(i, jd)];
        const bua = rowTmpBurn[rowTmpIdx(i, ja)], bub = rowTmpBurn[rowTmpIdx(i, jb)];
        const buc = rowTmpBurn[rowTmpIdx(i, jc)], bud = rowTmpBurn[rowTmpIdx(i, jd)];
        const ala = rowTmpAlive[rowTmpIdx(i, ja)], alb = rowTmpAlive[rowTmpIdx(i, jb)];
        const alc = rowTmpAlive[rowTmpIdx(i, jc)], ald = rowTmpAlive[rowTmpIdx(i, jd)];

        for (let k = 0; k < SUB; k++) {
          const t = k / SUB;
          const n = fineIdx(i, j * SUB + k);
          fineX[n] = catmullRom(xa, xb, xc, xd, t);
          fineY[n] = catmullRom(ya, yb, yc, yd, t);

          // Burn/alive are step-ish fields and Catmull-Rom will happily
          // overshoot past 0/1 chasing a sharp edge -- clamped so we
          // don't get a scorch darker than "fully burned" or a hole
          // with negative alpha weirdness
          fineBurn[n] = Math.max(0, Math.min(1, catmullRom(bua, bub, buc, bud, t)));
          fineAlive[n] = Math.max(0, Math.min(1, catmullRom(ala, alb, alc, ald, t)));
          fineU[n] = uPix;
          fineV[n] = rect.y + (j * SUB + k) / SUB * spy;
        }
      }
      // Bottom edge, same reasoning as the row loop's right edge above
      const n = fineIdx(i, fineRows);
      fineX[n] = rowTmpX[rowTmpIdx(i, ROWS)];
      fineY[n] = rowTmpY[rowTmpIdx(i, ROWS)];
      fineBurn[n] = rowTmpBurn[rowTmpIdx(i, ROWS)];
      fineAlive[n] = rowTmpAlive[rowTmpIdx(i, ROWS)];
      fineU[n] = uPix;
      fineV[n] = rect.y + rect.h;
    }
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Pure white now instead of the old near-black -- this is what
    // shows in the gap around the cloth, and whatever's left exposed
    // once a patch has burned all the way through
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    buildFineMesh();

    // A fine vertex counts as "gone" once its interpolated alive
    // value dips under half -- gives the burnt-through edge a curve
    // to follow instead of the coarse grid's blocky staircase
    const ALIVE_CUTOFF = 0.5;

    for (let j = 0; j < fineRows; j++) {
      for (let i = 0; i < fineCols; i++) {
        const i00 = fineIdx(i, j), i10 = fineIdx(i + 1, j);
        const i01 = fineIdx(i, j + 1), i11 = fineIdx(i + 1, j + 1);

        const dead1 = fineAlive[i00] < ALIVE_CUTOFF || fineAlive[i10] < ALIVE_CUTOFF || fineAlive[i11] < ALIVE_CUTOFF;
        const dead2 = fineAlive[i00] < ALIVE_CUTOFF || fineAlive[i11] < ALIVE_CUTOFF || fineAlive[i01] < ALIVE_CUTOFF;

        if (!dead1) {
          const avg1 = (fineBurn[i00] + fineBurn[i10] + fineBurn[i11]) / 3;
          drawTri(fineX[i00], fineY[i00], fineX[i10], fineY[i10], fineX[i11], fineY[i11],
            fineU[i00], fineV[i00], fineU[i10], fineV[i10], fineU[i11], fineV[i11], avg1);
        }
        if (!dead2) {
          const avg2 = (fineBurn[i00] + fineBurn[i11] + fineBurn[i01]) / 3;
          drawTri(fineX[i00], fineY[i00], fineX[i11], fineY[i11], fineX[i01], fineY[i01],
            fineU[i00], fineV[i00], fineU[i11], fineV[i11], fineU[i01], fineV[i01], avg2);
        }
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    renderFire();
  }

  // Input
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    return { x: cx * (WIDTH / rect.width), y: cy * (HEIGHT / rect.height) };
  }

  canvas.addEventListener('mousemove', (e) => {
    const pos = getPos(e);
    mouse.x = pos.x; mouse.y = pos.y; mouse.active = true;
  });
  canvas.addEventListener('mouseleave', () => { mouse.active = false; });
  canvas.addEventListener('touchmove', (e) => {
    const pos = getPos(e);
    mouse.x = pos.x; mouse.y = pos.y; mouse.active = true;
    e.preventDefault();
  }, { passive: false });

  function ignite(pos) {
    // Brute force nearest-particle search. Grid is small enough
    // (a few hundred points) that this is not worth optimizing
    let best = null, bestD = Infinity;
    for (const p of particles) {
      if (p.destroyed) continue;
      const dx = p.x - pos.x, dy = p.y - pos.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { best.burning = true; if (best.burn < 0.05) best.burn = 0.05; }
  }

  canvas.addEventListener('click', (e) => { ignite(getPos(e)); });
  canvas.addEventListener('touchstart', (e) => { ignite(getPos(e)); }, { passive: true });

  document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      sourceImage = img;
      resetCloth(false);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    resetCloth(false);
  });

  document.getElementById('densityBtn').addEventListener('click', (e) => {
    densityIdx = (densityIdx + 1) % densities.length;
    e.target.textContent = 'Grid: ' + densities[densityIdx].label;
    resetCloth(true);
  });

  // Canvas size controls:
  const sizePresets = {
    square: [1080, 1080],
    portrait: [1080, 1350],
    story: [1080, 1920],
  };
  const widthInput = document.getElementById('widthInput');
  const heightInput = document.getElementById('heightInput');
  const presetBtns = document.querySelectorAll('.preset-btn');

  function setActivePreset(name) {
    presetBtns.forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
  }

  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const [w, h] = sizePresets[btn.dataset.preset];
      widthInput.value = w;
      heightInput.value = h;
      setActivePreset(btn.dataset.preset);
      applyCanvasSize(w, h);
    });
  });

  document.getElementById('applySizeBtn').addEventListener('click', () => {
    // Typing in your own numbers counts as "custom", so no preset
    // should look selected anymore
    setActivePreset(null);
    applyCanvasSize(parseInt(widthInput.value, 10), parseInt(heightInput.value, 10));
  });

  // Main loop:
  // No preset gets marked active by default -- the starting canvas is
  // the plain 600x600 default
  fitStage();
  drawPlaceholderTexture();
  resetCloth(true);

  let last = performance.now();
  function loop(now) {
    const dt = (now - last) / 1000;
    last = now;
    stepCloth(dt);
    updateFire(dt);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
