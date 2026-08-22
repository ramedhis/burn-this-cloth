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

// Cloth + fire toy, PixiJS edition. Two systems glued together:
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
  app.stop(); // we drive our own rAF loop below and render manually

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

  // Fixed pixel gap on every side
  const CLOTH_GAP = 20;
  function clothRect() {
    return {
      x: CLOTH_GAP, y: CLOTH_GAP,
      w: WIDTH - CLOTH_GAP * 2, h: HEIGHT - CLOTH_GAP * 2,
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
  // This is the entire support structure -- there is no separate
  // "attachment" bookkeeping anymore. A point stays up only because
  // an unbroken chain of these links connects it, particle by
  // particle, back to a still-intact pinned point on the top row.
  // Burn a link and only the particles that actually depended on
  // that specific link lose support -- nothing routes "the long way
  // around" to fake staying attached.
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

  // A link (real or implied, e.g. a mesh-render triangle edge) still
  // carries support only if neither endpoint is gone and neither has
  // burned past the cut threshold. Used identically by the physics
  // solver (does this constraint pull?) and the mesh renderer (does
  // this triangle still exist?), so the two can never disagree about
  // where a tear is.
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
        const pinned = j === 0; // whole top edge anchored, curtain-rod style
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
  }

  function applyCanvasSize(w, h) {
    WIDTH = Math.max(64, Math.min(2160, Math.round(w) || WIDTH));
    HEIGHT = Math.max(64, Math.min(2160, Math.round(h) || HEIGHT));
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

  let mouse = { x: -9999, y: -9999, active: false };

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

      const vx = (p.x - p.oldX) * DAMPING;
      const vy = (p.y - p.oldY) * DAMPING;
      p.oldX = p.x; p.oldY = p.y;
      p.x += vx + ax * dt * dt;
      p.y += vy + ay * dt * dt;

      if (p.y > HEIGHT + 80) {
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
  let positions, uvs, burnArr, indices;
  const glowPool = [];

  const vertexSrc = `
    attribute vec2 aVertexPosition;
    attribute vec2 aTextureCoord;
    attribute float aBurn;

    uniform mat3 projectionMatrix;
    uniform mat3 translationMatrix;

    varying vec2 vTextureCoord;
    varying float vBurn;

    void main(void) {
      gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
      vTextureCoord = aTextureCoord;
      vBurn = aBurn;
    }
  `;

  const fragmentSrc = `
    varying vec2 vTextureCoord;
    varying float vBurn;

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

      // Char: darkens and browns out smoothly with burn amount --
      // continuous across the whole mesh since it's a per-pixel
      // shader value, so there's no triangle-edge seam to fight the
      // way the old multiply-rect-per-triangle pass had to.
      vec3 charColor = mix(vec3(0.35, 0.22, 0.14), vec3(0.05, 0.03, 0.02), smoothstep(0.15, 0.85, t));
      float charMix = smoothstep(0.05, 0.85, t);
      vec3 scorched = mix(texColor.rgb, texColor.rgb * charColor * 2.2, charMix);

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
    for (let n = 0; n < particles.length; n++) {
      const p = particles[n];
      positions[n * 2] = p.x;
      positions[n * 2 + 1] = p.y;
      burnArr[n] = Math.min(p.burn, 1);
    }
    rebuildMeshIndices();

    geometry.getBuffer('aVertexPosition').update(positions);
    geometry.getBuffer('aBurn').update(burnArr);
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
      s.size += dt * 14;
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

  function updateFireSprites() {
    for (let n = 0; n < particles.length; n++) {
      const p = particles[n];
      const s = glowPool[n];
      if (!s) continue;
      if (p.destroyed || (!p.burning && p.burn <= 0)) { s.visible = false; continue; }
      const intensity = Math.min(p.burn, 1);
      s.visible = true;
      s.x = p.x; s.y = p.y;
      const sizePx = 60 + intensity * 70;
      s.width = sizePx; s.height = sizePx;
      s.alpha = 0.35 + intensity * 0.4;
    }

    const applyPool = (pool, list, tintFn, sizeFn) => {
      for (let k = 0; k < pool.length; k++) {
        const s = pool[k];
        if (k < list.length) {
          const it = list[k];
          const lifeT = it.life / it.maxLife;
          s.visible = true;
          s.x = it.x; s.y = it.y;
          const sz = sizeFn(it, lifeT);
          s.width = sz; s.height = sz;
          s.alpha = Math.max(0, 1 - lifeT);
          s.tint = tintFn(it, lifeT);
        } else {
          s.visible = false;
        }
      }
    };

    applyPool(flamePool, flames,
      (f, t) => (t < 0.4 ? 0xfff2c0 : (t < 0.75 ? 0xffa53a : 0xe8551a)),
      (f, t) => f.size * (1.15 - 0.3 * t) * 2);
    applyPool(emberPool, embers, () => 0xffcf7a, (e) => e.size * 5);
    applyPool(smokePool, smoke, () => 0x5a5a56, (s) => s.size * 1.6);
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
    updateFireSprites();
    app.renderer.render(app.stage);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
