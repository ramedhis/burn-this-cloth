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

// Cloth + fire toy using PixiJS. Two systems glued together:
//   1) A mass-spring grid that warps an image (the "cloth")
//   2) A small particle sim for flames/embers/smoke (the "fire")
// They only talk to each other through burn values on grid points.
//
// This version renders the cloth as a real WebGL mesh (via PixiJS)
// instead of a hand-warped 2D canvas. The old approach split every
// grid cell into two triangles and warped each one with its own
// clip()+setTransform()+drawImage() call -- cheap conceptually, but
// every triangle edge was a hard affine seam, which is why the old
// code needed a whole second pass (Catmull-Rom over the coarse grid)
// just to fake smoothness. A GPU mesh doesn't need that fake: the
// rasterizer interpolates position, UV, and burn-amount per pixel
// across the whole mesh, so there's no seam to hide in the first
// place, no separate "fine mesh" resample step needed, and the physics
// grid itself can run at a much higher resolution since the render
// cost is one draw call regardless of vertex count.
(function () {
  const canvas = document.getElementById('c');
  const stageEl = document.querySelector('.stage');

  let WIDTH = 600;
  let HEIGHT = 600;

  // Fire visuals (flame/ember/smoke size, ignite radius) are all
  // tuned in absolute px against a 600x600 canvas. Everything
  // fire-related gets multiplied by this before use.
  function fireScale() {
    return Math.min(WIDTH, HEIGHT) / 600;
  }

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

  // PixiJS application, rendering into the existing <canvas id="c">.
  // resolution stays at 1 and autoDensity is left off on purpose --
  // the CSS rule (canvas { width:100%; height:100% }) is what scales
  // the drawing surface up to fill .stage, same as the old plain-2D
  // canvas did. Letting Pixi manage canvas.style itself (autoDensity)
  // would fight that rule.
  const app = new PIXI.Application({
    view: canvas,
    width: WIDTH,
    height: HEIGHT,
    resolution: 1,
    antialias: true,
    backgroundAlpha: 0,
  });
  app.stop(); // We drive our own rAF loop below and render manually

  // Ask the GPU what it can actually handle, but don't go past 4K
  // regardless -- a hardcoded cap was clamping both W and H to the
  // same number before, so anything past it always came out square
  // no matter what aspect ratio was typed in
  const MAX_CANVAS_DIM = (() => {
    try {
      return Math.min(app.renderer.gl.getParameter(app.renderer.gl.MAX_TEXTURE_SIZE), 4096);
    } catch (e) {
      return 4096; // WebGL1 baseline, safe fallback if the query fails
    }
  })();

  const clothContainer = new PIXI.Container();
  const smokeContainerObj = new PIXI.Container();
  const glowContainerObj = new PIXI.Container();
  const emberContainerObj = new PIXI.Container();
  const flameContainerObj = new PIXI.Container();
  app.stage.addChild(clothContainer, smokeContainerObj, glowContainerObj, emberContainerObj, flameContainerObj);

  // Grid resolution now drives BOTH physics and the render mesh --
  // there's no separate "sub" render multiplier anymore, since the
  // GPU interpolates the mesh smoothly no matter how coarse the
  // spring grid is. Numbers are picked to stay comfortably real-time
  // for the JS-side spring simulation while looking good on a GPU
  // mesh (which handles far more vertices than the old canvas
  // triangle-warp approach ever could at 60fps).
  const densities = [
    { c: 22, r: 22, label: 'coarse' },
    { c: 34, r: 34, label: 'normal' },
    { c: 48, r: 48, label: 'fine' },
  ];
  let densityIdx = 2;
  let COLS = densities[densityIdx].c;
  let ROWS = densities[densityIdx].r;

  // Gap between the cloth and the canvas edge used to be a fixed 20px
  // on every side so the cloth read as a piece of fabric sitting inside
  // a frame -- now that the canvas border itself can be toggled off,
  // keeping that gap just left a dead margin of bare background around
  // the image.
  // Cloth now runs flush with the canvas edge; set this back above 0
  // if a margin is ever wanted again.
  const CLOTH_GAP = 0;

  // The cloth's bottom edge runs a bit past the actual canvas, so it
  // reads as a longer piece of fabric that's just cut off by the
  // frame instead of a garment that conveniently ends exactly at
  // the edge
  const BOTTOM_BLEED_FRAC = 0;

  function clothBottomBleed() {
    return HEIGHT * BOTTOM_BLEED_FRAC;
  }
  function clothRect() {
    return {
      x: CLOTH_GAP, y: CLOTH_GAP,
      w: WIDTH - CLOTH_GAP * 2, h: HEIGHT - CLOTH_GAP * 2 + clothBottomBleed(),
    };
  }

  // texCanvas stays a plain 2D canvas -- it's just where we composite
  // the source image (or placeholder gradient) before handing the
  // pixels to Pixi as a texture. All the actual cloth deformation and
  // rendering downstream is GPU-side.
  const texCanvas = document.createElement('canvas');
  texCanvas.width = WIDTH;
  texCanvas.height = HEIGHT;
  const texCtx = texCanvas.getContext('2d');

  let sourceImage = null;
  let clothTexture = null;

  function drawPlaceholderTexture() {
    const rect = clothRect();
    const g = texCtx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    g.addColorStop(0, '#2e2e2c');
    g.addColorStop(0.5, '#232321');
    g.addColorStop(1, '#161615');
    texCtx.fillStyle = g;
    texCtx.fillRect(rect.x, rect.y, rect.w, rect.h);

    texCtx.strokeStyle = 'rgba(200,200,196,0.25)';
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
    const scale = Math.max(rect.w / iw, rect.h / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = rect.x + (rect.w - dw) / 2, dy = rect.y + (rect.h - dh) / 2;
    texCtx.clearRect(0, 0, WIDTH, HEIGHT);
    texCtx.fillStyle = '#1a1a18';
    texCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
    texCtx.drawImage(img, dx, dy, dw, dh);
  }

  // Recreates the GPU texture from whatever's currently painted on
  // texCanvas. Destroy-and-recreate rather than update() in place --
  // this only ever runs on user actions (load image, reset, resize),
  // never per-frame, so the extra GPU upload cost is a non-issue and
  // it sidesteps any ambiguity about stale dimensions after a resize.
  function refreshClothTexture() {
    if (clothTexture) clothTexture.destroy(true);
    clothTexture = PIXI.Texture.from(texCanvas);
    clothTexture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  }

  function idx(i, j) { return j * (COLS + 1) + i; }

  let particles = [];

  // Structural + shear constraints between neighbouring particles.
  // This is the entire support structure. A point stays up only
  // because an unbroken chain of these links connects it, particle by
  // particle, back to a still-intact pinned point on the top row.
  // Burn a link and only the particles that actually depended on
  // that specific link lose support.
  let constraints = [];

  function addConstraint(a, b, diagonal) {
    const pa = particles[a], pb = particles[b];
    const dx = pa.restX - pb.restX, dy = pa.restY - pb.restY;
    constraints.push({ a, b, restLen: Math.sqrt(dx * dx + dy * dy), diagonal: !!diagonal });
  }

  function buildConstraints() {
    constraints = [];
    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        if (i < COLS) addConstraint(idx(i, j), idx(i + 1, j));
        if (j < ROWS) addConstraint(idx(i, j), idx(i, j + 1));
      }
    }
    // Shear/diagonal bracing so the sheet doesn't collapse into a
    // shapeless mess -- softer than the structural links so it can
    // still fold and drape instead of acting like a rigid plate.
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        addConstraint(idx(i, j), idx(i + 1, j + 1), true);
        addConstraint(idx(i + 1, j), idx(i, j + 1), true);
      }
    }
  }

  // A link still carries support only if neither endpoint is gone
  // and neither has burned past the cut threshold. Used identically
  // by the physics solver (does this constraint pull?) and the mesh
  // renderer (does this triangle still exist?), so the two can never
  // disagree about where a tear is.
  function linkIntact(pa, pb) {
    if (pa.destroyed || pb.destroyed) return false;
    return Math.max(pa.burn, pb.burn) < CUT_THRESHOLD;
  }

  function buildGrid() {
    COLS = densities[densityIdx].c;
    ROWS = densities[densityIdx].r;

    const rect = clothRect();
    const spx = rect.w / COLS, spy = rect.h / ROWS;
    particles = [];

    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const rx = rect.x + i * spx, ry = rect.y + j * spy;
        const pinned = j === 0; // Whole top edge anchored, curtain-rod style
        particles.push({
          x: rx, y: ry, oldX: rx, oldY: ry, restX: rx, restY: ry,
          pinned,
          burn: 0,
          burning: false,
          destroyed: false,
          heat: 0,
          destroyAt: 0.82 + Math.random() * 0.35,
          seed: Math.random() * 1000,
        });
      }
    }

    buildConstraints();
    rebuildGlowPool();
  }

  function resetCloth(keepTexture) {
    buildGrid();
    flames.length = 0;
    embers.length = 0;
    smoke.length = 0;
    if (!keepTexture) {
      if (sourceImage) loadImageCover(sourceImage);
      else drawPlaceholderTexture();
    }
    refreshClothTexture();
    buildMeshObjects();
    clothContainer.addChild(gridGraphics); // buildMeshObjects re-adds the mesh on top, pull the grid back above it
  }

  function applyCanvasSize(w, h) {
    WIDTH = Math.max(64, Math.min(MAX_CANVAS_DIM, Math.round(w) || WIDTH));
    HEIGHT = Math.max(64, Math.min(MAX_CANVAS_DIM, Math.round(h) || HEIGHT));
    texCanvas.width = WIDTH;
    texCanvas.height = HEIGHT;
    app.renderer.resize(WIDTH, HEIGHT);
    fitStage();
    resetCloth(false);
  }

  // Cloth physics: Verlet integration + iterative distance-constraint
  // solving (the standard "position based dynamics" approach browser
  // cloth demos use). No point is ever sprung back toward its own
  // original position -- the only thing holding anything up is the
  // literal chain of intact constraints back to a pinned point.
  // Gravity is constant and universal; there's no separate "torn
  // freefall" gravity vs "still attached" gravity, because there's no
  // separate "attached" state to switch on anymore -- a fully cut-off
  // flap simply has no intact constraints reaching the anchor, so
  // nothing holds it back from falling, which the solver produces for
  // free instead of needing a special case.
  const DAMPING = 0.985;
  const GRAVITY = 780;
  const GRAVITY_BURN_EXTRA = 260; // weakened (but not yet cut) fibers sag a bit extra
  const PUSH_RADIUS = 110;
  const PUSH_STRENGTH = 3800;
  const CUT_THRESHOLD = 0.55;
  const CONSTRAINT_ITERATIONS = 5;

  // Wind: separate from the PUSH_* stuff above, which just shoves the
  // fabric away from wherever the cursor is. This instead looks at
  // how the cursor is moving and blows the cloth along that same
  // direction, scaled by how fast it's moving -- wave your mouse
  // across it like fanning a curtain and the fabric billows with it;
  // stand still and it settles back down.
  //
  // A first pass at this just applied cursor velocity as a force
  // near the cursor, and it just looked like the cloth getting shoved
  // -- a real gust doesn't hit as one rigid slab, it rolls through
  // the fabric as a wave, so nearby columns are pushed at slightly
  // different times and by slightly different amounts. That's what
  // windPower + the traveling sine term below are for.
  const WIND_GAIN = 0.45;       // Force per unit of eased gust strength (px/s)
  const WIND_RESPONSE = 7;      // How fast the gust ramps up when you move fast
  const WIND_DECAY = 2.0;       // How fast it eases back down once you slow/stop
  const WIND_WAVE_FREQ = 0.022; // Spatial frequency of the traveling ripple, per px
  const WIND_WAVE_SPEED = 6.5;  // How fast that ripple travels across the cloth
  const WIND_WAVE_DEPTH = 0.6;  // How much the ripple modulates the gust (0 = uniform push)
  const WIND_FLUTTER = 0.35;    // Extra sideways shimmer riding along the gust
  const MOUSE_SPEED_CAP = 4000; // px/s -- keeps one laggy frame from launching the cloth

  let mouse = { x: -9999, y: -9999, px: -9999, py: -9999, active: false, vx: 0, vy: 0, speed: 0 };
  let simTime = 0;   // Just keeps climbing, used to phase the wave and flutter
  let windPower = 0; // Eased gust strength -- chases cursor speed instead of snapping to it
  let windDirX = 1, windDirY = 0; // last direction the gust was heading

  // Cursor position updates every mousemove, but mousemove doesn't
  // fire on a tidy schedule -- so instead of trusting a single event's
  // delta, this samples position once per physics step and smooths
  // the resulting velocity. That's also what keeps a single stray
  // jump (e.g. re-entering the canvas somewhere completely different)
  // from registering as one absurd gust.
  function updateMouseVelocity(dt) {
    if (mouse.active && mouse.px > -9000 && dt > 0) {
      const rawVx = (mouse.x - mouse.px) / dt;
      const rawVy = (mouse.y - mouse.py) / dt;
      mouse.vx += (rawVx - mouse.vx) * 0.35;
      mouse.vy += (rawVy - mouse.vy) * 0.35;
    } else {
      mouse.vx *= 0.9;
      mouse.vy *= 0.9;
    }
    const spd = Math.hypot(mouse.vx, mouse.vy);
    if (spd > MOUSE_SPEED_CAP) {
      const k = MOUSE_SPEED_CAP / spd;
      mouse.vx *= k; mouse.vy *= k;
    }
    mouse.speed = Math.hypot(mouse.vx, mouse.vy);
    mouse.px = mouse.x; mouse.py = mouse.y;

    // windPower eases toward the current speed rather than tracking it
    // 1:1 -- ramping up fast but decaying slower is what makes a swipe
    // feel like it kicks off a gust that then has to die down, instead
    // of the wind just being "on" exactly while the mouse is moving.
    const target = mouse.active ? mouse.speed : 0;
    const rate = target > windPower ? WIND_RESPONSE : WIND_DECAY;
    windPower += (target - windPower) * Math.min(1, rate * dt);
    if (mouse.speed > 30) {
      windDirX = mouse.vx / mouse.speed;
      windDirY = mouse.vy / mouse.speed;
    }
  }

  function verletIntegrate(dt) {
    for (let n = 0; n < particles.length; n++) {
      const p = particles[n];
      if (p.pinned && !p.destroyed) {
        p.x = p.restX; p.y = p.restY; p.oldX = p.restX; p.oldY = p.restY;
        continue;
      }
      if (p.destroyed) continue;

      const burnAmt = Math.min(p.burn, 1);
      let ax = 0, ay = GRAVITY;

      if (p.burning || p.burn > 0) {
        p.heat += dt;
        ay += GRAVITY_BURN_EXTRA * burnAmt;
        ax += Math.sin(p.seed + p.heat * 9) * 60 * burnAmt;
      }

      if (mouse.active) {
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
        if (dist < PUSH_RADIUS) {
          const falloff = 1 - dist / PUSH_RADIUS;
          ax += (dx / dist) * PUSH_STRENGTH * falloff * falloff;
          ay += (dy / dist) * PUSH_STRENGTH * falloff * falloff;
        }
      }

      if (windPower > 3) {

        // The gust isn't the same strength everywhere at the same
        // instant -- it's a wave running along the sheet, phased by
        // each vertex's rest position, so different columns catch it
        // at slightly different moments. That's the difference between
        // "the fabric got shoved" and "the fabric is billowing": a
        // uniform push moves the whole thing as one rigid card, a
        // traveling wave makes ridges form and roll across it.
        const wavePos = p.restX * WIND_WAVE_FREQ + simTime * WIND_WAVE_SPEED;
        const wave = 0.5 + 0.5 * Math.sin(wavePos + p.seed * 0.4);
        const gust = windPower * WIND_GAIN * (1 - WIND_WAVE_DEPTH + WIND_WAVE_DEPTH * wave);
        ax += windDirX * gust;
        ay += windDirY * gust * 0.4; // wind mostly drives sideways drift, not straight into the ground

        // Sideways shimmer riding along the gust, on its own faster
        // wave so it doesn't just retrace the same shape every pass
        const perpX = -windDirY, perpY = windDirX;
        const flutter = Math.sin(simTime * 9 + p.restX * 0.05 + p.seed) * gust * WIND_FLUTTER;
        ax += perpX * flutter;
        ay += perpY * flutter;
      }

      const vx = (p.x - p.oldX) * DAMPING;
      const vy = (p.y - p.oldY) * DAMPING;
      p.oldX = p.x; p.oldY = p.y;
      p.x += vx + ax * dt * dt;
      p.y += vy + ay * dt * dt;

      if (p.y > HEIGHT + clothBottomBleed() + 80) {
        p.destroyed = true;
        spawnAshPuff(p.x, HEIGHT + 20);
      }
    }
  }

  function satisfyConstraints() {
    for (let iter = 0; iter < CONSTRAINT_ITERATIONS; iter++) {
      for (let c = 0; c < constraints.length; c++) {
        const con = constraints[c];
        const pa = particles[con.a], pb = particles[con.b];
        if (!linkIntact(pa, pb)) continue;

        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const diff = (dist - con.restLen) / dist;
        const stiffness = con.diagonal ? 0.5 : 1.0;

        const movableA = !(pa.pinned && !pa.destroyed) ? 1 : 0;
        const movableB = !(pb.pinned && !pb.destroyed) ? 1 : 0;
        const total = movableA + movableB;
        if (total === 0) continue;

        const corrX = dx * diff * stiffness;
        const corrY = dy * diff * stiffness;
        if (movableA) { pa.x += corrX * (movableA / total); pa.y += corrY * (movableA / total); }
        if (movableB) { pb.x -= corrX * (movableB / total); pb.y -= corrY * (movableB / total); }
      }
    }
  }

  function stepCloth(dt) {
    dt = Math.min(dt, 1 / 30);
    simTime += dt;
    updateMouseVelocity(dt);
    verletIntegrate(dt);
    satisfyConstraints();

    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const p = particles[idx(i, j)];
        if (p.destroyed || !p.burning) continue;

        p.burn += dt * (0.5 + Math.random() * 0.35);

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

  // GPU mesh:
  // A single PIXI.Mesh covering the whole cloth. Vertex positions and
  // per-vertex burn amount are pushed to the GPU every frame; UVs are
  // static (they just map each vertex back to its rest position in
  // the source texture). The index buffer is rebuilt every frame too,
  // but not to resize anything -- it's fixed-length and always
  // COLS*ROWS*6 long. Cells that straddle a tear (their corners don't
  // all share the same "attached" state, or one corner is destroyed)
  // get written as a degenerate triangle (three copies of vertex 0),
  // which the rasterizer treats as zero-area and simply doesn't draw.
  // That's what produces the actual rip/hole instead of a smoothed-
  // over seam, without ever touching buffer sizes.
  let geometry = null, mesh = null;
  let positions, uvs, burnArr, shadeArr, indices;
  const glowPool = [];

  // Fake lighting for the fold shading below. There's no real z on
  // these particles, just x/y, so instead of an actual normal we use
  // the direction the local patch of cloth is curling in screen space
  // (see vertexShade) and dot it against a light coming from up and
  // slightly to the left. Flip these two numbers if you want the
  // "sun" coming from somewhere else.
  function normalize2(x, y) {
    const len = Math.hypot(x, y) || 1;
    return [x / len, y / len];
  }
  const [LIGHT_X, LIGHT_Y] = normalize2(-0.55, -1);
  const SHADE_BEND_STRENGTH = 2.4; // How visible ridges/valleys are
  const SHADE_AO_STRENGTH = 4.5;   // Extra darkening where cloth bunches into a crease

  // Per-vertex fake-3D term, recomputed every frame since the cloth
  // keeps moving. Two things get blended together:
  //  - "bend": the discrete Laplacian of the vertex's position (how
  //    far it sits from the average of its neighbors) points toward
  //    whichever way the local patch is curling. Dotting that with a
  //    fixed light direction gives ridges facing the light a little
  //    boost and the far side of the fold a little shadow -- same
  //    read as a normal map, just derived from in-plane bending
  //    instead of an actual surface normal.
  //  - "ao": wherever neighboring particles are pulled closer
  //    together than their rest spacing (the mesh compressing on
  //    itself), that's a crease pinching shut, and creases catch less
  //    light than flat fabric regardless of which way they lean.
  // Both terms get divided by the local rest spacing before anything
  // else -- a raw pixel Laplacian shrinks the second you switch to a
  // denser grid (more, smaller cells = smaller numbers for the exact
  // same fold), which is why this was barely visible at the "fine"
  // density that loads by default. Dividing by restLen turns it into
  // "how much this deviates as a fraction of a cell", which stays
  // meaningful at any density or canvas size.
  function vertexShade(i, j) {
    const p = particles[idx(i, j)];
    if (p.destroyed) return 0;

    const left = i > 0 ? particles[idx(i - 1, j)] : null;
    const right = i < COLS ? particles[idx(i + 1, j)] : null;
    const up = j > 0 ? particles[idx(i, j - 1)] : null;
    const down = j < ROWS ? particles[idx(i, j + 1)] : null;

    let lapX = 0, lapY = 0, bendTaps = 0;
    let compress = 0, compressTaps = 0;

    if (left && right && !left.destroyed && !right.destroyed) {
      const restLen = Math.hypot(right.restX - left.restX, right.restY - left.restY) || 1;
      lapX += (left.x + right.x - 2 * p.x) / restLen;
      lapY += (left.y + right.y - 2 * p.y) / restLen;
      bendTaps++;
      const curLen = Math.hypot(right.x - left.x, right.y - left.y);
      compress += (restLen - curLen) / restLen;
      compressTaps++;
    }
    if (up && down && !up.destroyed && !down.destroyed) {
      const restLen = Math.hypot(down.restX - up.restX, down.restY - up.restY) || 1;
      lapX += (up.x + down.x - 2 * p.x) / restLen;
      lapY += (up.y + down.y - 2 * p.y) / restLen;
      bendTaps++;
      const curLen = Math.hypot(down.x - up.x, down.y - up.y);
      compress += (restLen - curLen) / restLen;
      compressTaps++;
    }
    if (bendTaps === 0) return 0;

    const bend = (lapX * LIGHT_X + lapY * LIGHT_Y) * SHADE_BEND_STRENGTH;
    const ao = compressTaps ? Math.max(0, compress / compressTaps) * SHADE_AO_STRENGTH : 0;
    const raw = bend - ao;

    // Push weak-but-real curvature (a gentle sag, a shallow ripple)
    // further toward visible without needing to crank the strength
    // constants so high that an actual sharp fold blows out to pure
    // black/white. Same shape as a gamma curve, just kept symmetric
    // around zero since this can go either light or dark.
    const sign = raw < 0 ? -1 : 1;
    return sign * Math.pow(Math.min(Math.abs(raw), 1), 0.55);
  }

  // wireframe overlay, just the structural links -- reuses linkIntact
  // so the lines drop out exactly where the cloth actually tears instead
  // of keeping their own separate idea of what's still connected
  const gridGraphics = new PIXI.Graphics();
  clothContainer.addChild(gridGraphics);
  let showGrid = false;

  function drawGrid() {
    gridGraphics.clear();
    if (!showGrid) return;
    gridGraphics.lineStyle(1, 0xffffff, 0.35);
    for (const con of constraints) {
      if (con.diagonal) continue;
      const pa = particles[con.a], pb = particles[con.b];
      if (!linkIntact(pa, pb)) continue;
      gridGraphics.moveTo(pa.x, pa.y);
      gridGraphics.lineTo(pb.x, pb.y);
    }
  }

  const vertexSrc = `
    attribute vec2 aVertexPosition;
    attribute vec2 aTextureCoord;
    attribute float aBurn;
    attribute float aShade;

    uniform mat3 projectionMatrix;
    uniform mat3 translationMatrix;

    varying vec2 vTextureCoord;
    varying float vBurn;
    varying float vShade;

    void main(void) {
      gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
      vTextureCoord = aTextureCoord;
      vBurn = aBurn;
      vShade = aShade;
    }
  `;

  const fragmentSrc = `
    varying vec2 vTextureCoord;
    varying float vBurn;
    varying float vShade;

    uniform sampler2D uSampler;
    uniform vec4 uColor;

    // cheap 2D hash, just need something that doesn't look like a grid
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main(void) {
      vec4 texColor = texture2D(uSampler, vTextureCoord);
      float t = clamp(vBurn, 0.0, 1.0);

      // A dropped-in photo comes in glossy-print vibrant -- dyed
      // fabric never looks like that, ink sinks into the weave
      // instead of sitting on a reflective surface. Pull it toward
      // something closer to printed cloth: a bit less saturated, a
      // bit less contrasty, a bit less bright. Small nudges on
      // purpose -- enough to read as "this is fabric" without it
      // looking washed out or grey.
      float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
      vec3 fabricColor = mix(texColor.rgb, vec3(luma), 0.22);
      fabricColor = mix(vec3(0.5), fabricColor, 0.85);
      fabricColor *= 0.92;

      // Fold shading: vShade comes from the JS side (vertexShade),
      // where it's derived from how much each vertex is bending and
      // bunching up relative to its neighbors. Positive = ridge
      // catching the light, negative = crease or the far side of a
      // fold. Applied as a simple brightness multiplier rather than
      // anything physically-based -- it just needs to sell "this is
      // draped fabric" and not "this is a flat poster".
      float shade = clamp(vShade, -1.0, 1.0);
      vec3 lit = clamp(fabricColor * (1.0 + shade * 0.85), 0.0, 1.0);

      // Char: darkens and browns out smoothly with burn amount --
      // continuous across the whole mesh since it's a per-pixel
      // shader value, so there's no triangle-edge seam to fight the
      // way the old multiply-rect-per-triangle pass had to.
      vec3 charColor = mix(vec3(0.35, 0.22, 0.14), vec3(0.05, 0.03, 0.02), smoothstep(0.15, 0.85, t));
      float charMix = smoothstep(0.05, 0.85, t);
      vec3 scorched = mix(lit, lit * charColor * 2.2, charMix);

      // A thin band of ember glow right where a patch is actively
      // burning through, before it's fully charred black.
      float glow = smoothstep(0.35, 0.65, t) * (1.0 - smoothstep(0.65, 0.95, t));
      vec3 emberColor = vec3(1.0, 0.5, 0.12);
      vec3 finalColor = mix(scorched, emberColor, glow * 0.9);

      gl_FragColor = vec4(finalColor, texColor.a) * uColor;

      // eat little holes into the fabric before the whole triangle
      // gets pulled from the mesh (CUT_THRESHOLD on the JS side) --
      // otherwise a burning patch just vanishes as one clean wedge,
      // which is what made the tear line read as "triangle" instead
      // of "burnt cloth". noise-driven so the lace pattern doesn't
      // line up with the grid underneath it.
      float grain = hash(floor(vTextureCoord * 260.0));
      float keepChance = mix(1.0, 0.1, smoothstep(0.28, 0.55, t));
      if (grain > keepChance) discard;
    }
  `;

  function buildMeshObjects() {
    const nVerts = (COLS + 1) * (ROWS + 1);
    positions = new Float32Array(nVerts * 2);
    uvs = new Float32Array(nVerts * 2);
    burnArr = new Float32Array(nVerts);
    shadeArr = new Float32Array(nVerts);
    indices = new Uint32Array(COLS * ROWS * 6);

    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const id = idx(i, j);
        const p = particles[id];
        uvs[id * 2] = p.restX / WIDTH;
        uvs[id * 2 + 1] = p.restY / HEIGHT;
        positions[id * 2] = p.x;
        positions[id * 2 + 1] = p.y;
      }
    }

    geometry = new PIXI.Geometry()
      .addAttribute('aVertexPosition', positions, 2)
      .addAttribute('aTextureCoord', uvs, 2)
      .addAttribute('aBurn', burnArr, 1)
      .addAttribute('aShade', shadeArr, 1)
      .addIndex(indices);

    const shader = PIXI.Shader.from(vertexSrc, fragmentSrc, {
      uSampler: clothTexture,
      uColor: new Float32Array([1, 1, 1, 1]),
    });

    if (mesh) { clothContainer.removeChild(mesh); mesh.destroy(); }
    mesh = new PIXI.Mesh(geometry, shader);
    clothContainer.addChild(mesh);
  }

  // A triangle renders only if every edge it's built from is still an
  // intact structural/shear link -- exactly the same links (and the
  // same linkIntact() test) the physics solver uses. The tear you see
  // is always exactly the tear the solver is acting on; there's no
  // separate "is this attached" concept left to disagree with it.
  function rebuildMeshIndices() {
    let n = 0;
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const v00 = idx(i, j), v10 = idx(i + 1, j), v01 = idx(i, j + 1), v11 = idx(i + 1, j + 1);
        const p00 = particles[v00], p10 = particles[v10], p01 = particles[v01], p11 = particles[v11];

        // Flip which corner the diagonal runs through every other
        // cell (checkerboard). Splitting every cell the same way was
        // the other half of the "triangle mesh" look -- once a few
        // adjacent cells burned through, the missing wedges all
        // pointed the same direction and the tear read as a straight
        // sawtooth cut instead of a ragged hole.
        if ((i + j) % 2 === 0) {
          if (linkIntact(p00, p10) && linkIntact(p10, p11) && linkIntact(p00, p11)) {
            indices[n++] = v00; indices[n++] = v10; indices[n++] = v11;
          } else {
            indices[n++] = 0; indices[n++] = 0; indices[n++] = 0;
          }

          if (linkIntact(p00, p11) && linkIntact(p11, p01) && linkIntact(p00, p01)) {
            indices[n++] = v00; indices[n++] = v11; indices[n++] = v01;
          } else {
            indices[n++] = 0; indices[n++] = 0; indices[n++] = 0;
          }
        } else {
          if (linkIntact(p00, p10) && linkIntact(p10, p01) && linkIntact(p00, p01)) {
            indices[n++] = v00; indices[n++] = v10; indices[n++] = v01;
          } else {
            indices[n++] = 0; indices[n++] = 0; indices[n++] = 0;
          }

          if (linkIntact(p10, p11) && linkIntact(p11, p01) && linkIntact(p10, p01)) {
            indices[n++] = v10; indices[n++] = v11; indices[n++] = v01;
          } else {
            indices[n++] = 0; indices[n++] = 0; indices[n++] = 0;
          }
        }
      }
    }
  }

  function updateMeshBuffers() {
    const rowLen = COLS + 1;
    for (let n = 0; n < particles.length; n++) {
      const p = particles[n];
      positions[n * 2] = p.x;
      positions[n * 2 + 1] = p.y;
      burnArr[n] = Math.min(p.burn, 1);

      // n walks the same j-outer, i-inner order buildGrid() filled
      // particles in, so this recovers the (i,j) vertexShade wants
      // without needing a second lookup table.
      shadeArr[n] = vertexShade(n % rowLen, (n / rowLen) | 0);
    }
    rebuildMeshIndices();

    geometry.getBuffer('aVertexPosition').update(positions);
    geometry.getBuffer('aBurn').update(burnArr);
    geometry.getBuffer('aShade').update(shadeArr);
    geometry.indexBuffer.update(indices);
  }

  // Fire particles -- same spawn/update logic as before, just
  // rendered as pooled GPU sprites instead of ctx.arc() calls.
  let flames = [];
  let embers = [];
  let smoke = [];
  const MAX_FLAMES = 260;
  const MAX_EMBERS = 140;
  const MAX_SMOKE = 90;

  function spawnFlame(x, y, sizeMul) {
    if (flames.length > MAX_FLAMES) return;
    sizeMul = sizeMul || 1;
    const fs = fireScale();
    flames.push({
      x: x + (Math.random() - 0.5) * 6 * fs,
      y: y + (Math.random() - 0.5) * 6 * fs,
      vx: (Math.random() - 0.5) * 20 * fs,
      vy: -(45 + Math.random() * 40) * Math.sqrt(sizeMul) * fs, // Bigger tongues punch up harder too
      life: 0,
      maxLife: (0.3 + Math.random() * 0.35) * (0.7 + sizeMul * 0.5), // and stick around longer
      size: (8 + Math.random() * 9) * sizeMul * fs,
      wobble: Math.random() * Math.PI * 2,
      wobble2: Math.random() * Math.PI * 2,
      flicker: Math.random() * 10,
    });
  }

  function spawnEmber(x, y) {
    if (embers.length > MAX_EMBERS) return;
    const fs = fireScale();
    embers.push({
      x, y,
      vx: (Math.random() - 0.5) * 40 * fs,
      vy: -(30 + Math.random() * 70) * fs,
      life: 0,
      maxLife: 0.6 + Math.random() * 1.1,
      size: (1 + Math.random() * 2.2) * fs,
      flicker: Math.random() * 10,
      hue: Math.random(), // Some run hotter/yellower, some already cooling toward red
    });
  }

  function spawnSmoke(x, y) {
    if (smoke.length > MAX_SMOKE) return;
    const fs = fireScale();
    smoke.push({
      x, y,
      vx: (Math.random() - 0.5) * 12 * fs,
      vy: -(18 + Math.random() * 18) * fs,
      life: 0,
      maxLife: 1.8 + Math.random() * 1.4,
      size: (10 + Math.random() * 10) * fs,
    });
  }

  function spawnAshPuff(x, y) {
    for (let k = 0; k < 4; k++) spawnSmoke(x, y);
  }

  function updateFire(dt) {
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
      f.wobble += dt * 11;
      f.wobble2 += dt * 23;

      // Two sine waves beat against each other instead of one
      // clean wave, so the tongue doesn't just swing side to
      // side on a metronomexpress
      const sway = Math.sin(f.wobble) * 16 + Math.sin(f.wobble2) * 7;
      f.x += (f.vx + sway) * dt;

      // Hot gas shoots up fast right off the fuel, then that push
      // dies out and it's just drifting/cooling like before
      const launch = Math.max(0, 1 - f.life * 5) * 85;
      f.y += (f.vy - launch) * dt;
      f.vy *= 0.985;
    });

    stepList(embers, (e) => {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.vy += 25 * dt;
      e.vx *= 0.99;
    });

    stepList(smoke, (s) => {
      s.x += (s.vx + Math.sin(s.life * 3 + s.x) * 6) * dt;
      s.y += s.vy * dt;
      s.vy *= 0.99; // Rises fast off the flame, then spreads out and loiters
      s.size += dt * (12 + s.life * 6); // billows out faster the older/cooler it gets
    });
  }

  // Soft radial-gradient sprite textures, generated once. These are
  // what give flames/embers/smoke/glow their soft falloff on the GPU
  // instead of a hard-edged circle.
  function makeRadialTexture(size, stops) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const cctx = c.getContext('2d');
    const g = cctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [off, col] of stops) g.addColorStop(off, col);
    cctx.fillStyle = g;
    cctx.fillRect(0, 0, size, size);
    return PIXI.Texture.from(c);
  }

  const flameTex = makeRadialTexture(64, [
    [0, 'rgba(255,244,214,1)'], [0.35, 'rgba(255,170,60,0.9)'],
    [0.7, 'rgba(232,90,20,0.45)'], [1, 'rgba(232,90,20,0)'],
  ]);
  const emberTex = makeRadialTexture(32, [
    [0, 'rgba(255,236,180,1)'], [0.4, 'rgba(255,150,40,0.95)'], [1, 'rgba(255,80,20,0)'],
  ]);
  const smokeTex = makeRadialTexture(64, [
    [0, 'rgba(90,90,86,0.55)'], [0.6, 'rgba(90,90,86,0.28)'], [1, 'rgba(90,90,86,0)'],
  ]);
  const glowTex = makeRadialTexture(96, [
    [0, 'rgba(255,200,120,0.55)'], [0.5, 'rgba(255,140,40,0.25)'], [1, 'rgba(255,140,40,0)'],
  ]);

  function makePool(container, texture, count, blend) {
    const pool = [];
    for (let k = 0; k < count; k++) {
      const s = new PIXI.Sprite(texture);
      s.anchor.set(0.5);
      s.visible = false;
      if (blend) s.blendMode = PIXI.BLEND_MODES.ADD;
      container.addChild(s);
      pool.push(s);
    }
    return pool;
  }

  const flamePool = makePool(flameContainerObj, flameTex, MAX_FLAMES + 10, true);
  const emberPool = makePool(emberContainerObj, emberTex, MAX_EMBERS + 10, true);
  const smokePool = makePool(smokeContainerObj, smokeTex, MAX_SMOKE + 10, false);

  // Rebuilt whenever the grid resolution or canvas size changes,
  // since it needs exactly one sprite per grid particle.
  function rebuildGlowPool() {
    for (const s of glowPool) { glowContainerObj.removeChild(s); s.destroy(); }
    glowPool.length = 0;
    for (let n = 0; n < particles.length; n++) {
      const s = new PIXI.Sprite(glowTex);
      s.anchor.set(0.5);
      s.blendMode = PIXI.BLEND_MODES.ADD;
      s.visible = false;
      glowContainerObj.addChild(s);
      glowPool.push(s);
    }
  }

  // 0xRRGGBB lerp -- used to get an actual color gradient over a
  // particle's life instead of snapping between 2-3 fixed colors
  function lerpColor(c1, c2, t) {
    const r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255;
    const r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return (r << 16) | (g << 8) | b;
  }

  // Pale hot core -> yellow -> orange -> dying red-brown, as one
  // continuous ramp instead of a couple of hard-edged color bands
  function flameColorAt(t) {
    if (t < 0.18) return lerpColor(0xfffbe8, 0xfff2a8, t / 0.18);
    if (t < 0.45) return lerpColor(0xfff2a8, 0xffa53a, (t - 0.18) / 0.27);
    if (t < 0.75) return lerpColor(0xffa53a, 0xe8551a, (t - 0.45) / 0.3);
    return lerpColor(0xe8551a, 0x781c0a, (t - 0.75) / 0.25);
  }

  function updateFireSprites() {
    for (let n = 0; n < particles.length; n++) {
      const p = particles[n];
      const s = glowPool[n];
      if (!s) continue;
      if (p.destroyed || (!p.burning && p.burn <= 0)) { s.visible = false; continue; }
      const intensity = Math.min(p.burn, 1);
      s.visible = true;
      s.x = p.x; s.y = p.y;
      const sizePx = (60 + intensity * 70) * fireScale();
      s.width = sizePx; s.height = sizePx;

      // A little pulse so the ambient light doesn't sit dead-flat
      const flicker = 0.85 + Math.sin(p.seed * 3 + p.heat * 8) * 0.15;
      s.alpha = (0.35 + intensity * 0.4) * flicker;
    }

    // Flames get their own pass
    for (let k = 0; k < flamePool.length; k++) {
      const s = flamePool[k];
      if (k >= flames.length) { s.visible = false; continue; }
      const f = flames[k];
      const t = f.life / f.maxLife;
      s.visible = true;
      s.x = f.x; s.y = f.y;
      const taper = 1 - 0.45 * t; // Narrows as it rises
      const stretch = 1 + 0.9 * t; // and stretches into a tongue
      s.width = f.size * 2 * taper;
      s.height = f.size * 2.6 * stretch;
      s.rotation = Math.max(-0.35, Math.min(0.35, f.vx / 90)); // Leans with its own drift
      const shimmer = 0.85 + Math.sin(f.flicker + f.life * 40) * 0.15;
      s.alpha = Math.max(0, (1 - t) * shimmer);
      s.tint = flameColorAt(t);
    }

    const applyPool = (pool, list, tintFn, sizeFn, alphaFn) => {
      for (let k = 0; k < pool.length; k++) {
        const s = pool[k];
        if (k < list.length) {
          const it = list[k];
          const lifeT = it.life / it.maxLife;
          s.visible = true;
          s.x = it.x; s.y = it.y;
          const sz = sizeFn(it, lifeT);
          s.width = sz; s.height = sz;
          s.alpha = alphaFn ? alphaFn(it, lifeT) : Math.max(0, 1 - lifeT);
          s.tint = tintFn(it, lifeT);
        } else {
          s.visible = false;
        }
      }
    };

    applyPool(emberPool, embers,
      (e, t) => lerpColor(lerpColor(0xffe9a8, 0xff6a1a, e.hue), 0x501008, t),
      (e, t) => e.size * 5 * (1 - 0.3 * t),
      (e, t) => Math.max(0, 1 - t) * (0.7 + 0.3 * Math.sin(e.flicker + e.life * 30)));
    applyPool(smokePool, smoke,
      (s, t) => lerpColor(0x201d1a, 0x6a6a66, t), // Starts as dark soot, thins out grey
      (s) => s.size * 1.6,
      (s, t) => Math.pow(1 - t, 1.4) * 0.8);
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
    // if the cursor was off the canvas:
    // snap px/py to here so the gap doesn't get read as one giant
    // instantaneous swipe
    if (!mouse.active) { mouse.px = pos.x; mouse.py = pos.y; mouse.vx = 0; mouse.vy = 0; }
    mouse.x = pos.x; mouse.y = pos.y; mouse.active = true;
  });
  canvas.addEventListener('mouseleave', () => { mouse.active = false; });
  canvas.addEventListener('touchmove', (e) => {
    const pos = getPos(e);
    if (!mouse.active) { mouse.px = pos.x; mouse.py = pos.y; mouse.vx = 0; mouse.vy = 0; }
    mouse.x = pos.x; mouse.y = pos.y; mouse.active = true;
    e.preventDefault();
  }, { passive: false });

  function ignite(pos) {
    // Roll a random patch size per click -- sometimes it's a small
    // lick of flame, sometimes a proper spreading blaze right away
    const radius = (14 + Math.random() * 70) * fireScale();
    const radiusSq = radius * radius;
    let hitAny = false;

    for (const p of particles) {
      if (p.destroyed) continue;
      const dx = p.x - pos.x, dy = p.y - pos.y;
      const d = dx * dx + dy * dy;
      if (d > radiusSq) continue;

      hitAny = true;
      p.burning = true;
      const falloff = 1 - Math.sqrt(d) / radius;
      const startBurn = 0.05 + falloff * 0.25 * Math.random();
      if (p.burn < startBurn) p.burn = startBurn;
    }

    // Click landed somewhere with nothing in range (e.g. right at an
    // edge) -- fall back to just the closest particle so it never
    // just silently does nothing
    if (!hitAny) {
      let best = null, bestD = Infinity;
      for (const p of particles) {
        if (p.destroyed) continue;
        const dx = p.x - pos.x, dy = p.y - pos.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best) { best.burning = true; if (best.burn < 0.05) best.burn = 0.05; }
    }

    // The sprite burst land -- separate roll from the cloth-patch
    // radius above, so a click can catch a wide patch of cloth but
    // still only throw out one big flame, or the other way around.
    const roll = Math.random();
    if (roll < 0.3) {
      // One flame, but a proper tall one
      spawnFlame(pos.x, pos.y, 2.2 + Math.random() * 1.6);
    } else if (roll < 0.6) {
      // A handful of small ones
      const n = 3 + Math.floor(Math.random() * 4);
      for (let k = 0; k < n; k++) {
        spawnFlame(pos.x, pos.y, 0.5 + Math.random() * 0.5);
      }
    } else {
      // Ordinary mixed burst
      const n = 1 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        spawnFlame(pos.x, pos.y, 0.8 + Math.random() * 1.3);
      }
    }
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
    e.target.textContent = 'Density: ' + densities[densityIdx].label;
    resetCloth(true);
  });

  const gridToggleBtn = document.getElementById('gridToggleBtn');
  gridToggleBtn.addEventListener('click', () => {
    showGrid = !showGrid;
    gridToggleBtn.textContent = 'Mesh: ' + (showGrid ? 'shown' : 'hidden');
    gridToggleBtn.classList.toggle('is-on', showGrid);
  });

  // Starts true since the stage ships with its border painted
  let showBorder = true;
  const borderToggleBtn = document.getElementById('borderToggleBtn');
  borderToggleBtn.addEventListener('click', () => {
    showBorder = !showBorder;
    borderToggleBtn.textContent = 'Border: ' + (showBorder ? 'shown' : 'hidden');
    borderToggleBtn.classList.toggle('is-on', showBorder);
    stageEl.classList.toggle('no-border', !showBorder);
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
    setActivePreset(null);
    applyCanvasSize(parseInt(widthInput.value, 10), parseInt(heightInput.value, 10));
  });

  // Main loop:
  fitStage();
  drawPlaceholderTexture();
  resetCloth(true);

  let last = performance.now();
  function loop(now) {
    const dt = (now - last) / 1000;
    last = now;
    stepCloth(dt);
    updateFire(dt);
    updateMeshBuffers();
    drawGrid();
    updateFireSprites();
    app.renderer.render(app.stage);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
