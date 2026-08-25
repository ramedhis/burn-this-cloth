// === cloth-physics.js ===

  function idx(i, j) { return j * (COLS + 1) + i; }

  let particles = [];

  function isClothGone() {
    if (particles.length === 0) return false;
    for (let n = 0; n < particles.length; n++) {
      const p = particles[n];
      if (p.destroyed) continue;
      const screenY = originY + p.y * clothScale;
      if (screenY <= VIEW_H) return false; // still on-screen and not burned through -- cloth isn't gone yet
    }
    return true;
  }

  // Structural + shear constraints between neighbouring particles.
  // This is the entire support structure.
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

  // Default pin pattern on a fresh grid: the whole top row.
  function isPinned(i, j) {
    return j === 0;
  }

  // Which boundary line (if any) a particle sits on.
  function edgeOf(p) {
    if (p.gj === 0) return 'top';
    if (p.gj === ROWS) return 'bottom';
    if (p.gi === 0) return 'left';
    if (p.gi === COLS) return 'right';
    return null;
  }

  function edgeParticleIndices(edge) {
    const out = [];
    if (edge === 'top') { for (let i = 0; i <= COLS; i++) out.push(idx(i, 0)); }
    else if (edge === 'bottom') { for (let i = 0; i <= COLS; i++) out.push(idx(i, ROWS)); }
    else if (edge === 'left') { for (let j = 0; j <= ROWS; j++) out.push(idx(0, j)); }
    else if (edge === 'right') { for (let j = 0; j <= ROWS; j++) out.push(idx(COLS, j)); }
    return out;
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
        const pinned = isPinned(i, j);
        particles.push({
          x: rx, y: ry, oldX: rx, oldY: ry, restX: rx, restY: ry,
          // Grid coordinates, kept on the particle itself so anything
          // that only has a particle reference (nearest-hit tests,
          // mostly) can still tell where it sits in the grid without
          // the caller having to carry i/j around separately. Used by
          // edgeOf() below to figure out which of the four boundary
          // lines (if any) a given particle belongs to.
          gi: i, gj: j,
          pinned,
          // Where a pinned particle actually holds itself, as opposed to
          // restX/restY (the flat, undeformed layout position, which stays
          // fixed forever for UV mapping and constraint rest-lengths).
          pinX: rx, pinY: ry,
          burn: 0,
          burning: false,
          destroyed: false,
          scorched: false,
          heat: 0,
          heatGlow: 0,
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
    ashFlakes.length = 0;
    resetScorchLayer();
    if (!keepTexture) {
      if (sourceImage) loadImageCover(sourceImage);
      else drawPlaceholderTexture();
    }
    refreshClothTexture();
    buildMeshObjects();
    clothContainer.addChild(gridGraphics);
    clothContainer.addChild(anchorGraphics);
    clothContainer.addChild(edgeHighlightGraphics);
  }

  function applyCanvasSize(w, h) {
    WIDTH = Math.max(64, Math.min(MAX_CANVAS_DIM, Math.round(w) || WIDTH));
    HEIGHT = Math.max(64, Math.min(MAX_CANVAS_DIM, Math.round(h) || HEIGHT));

    texCanvas.width = WIDTH;
    texCanvas.height = HEIGHT;
    resetCloth(false);
    updateViewport(); // re-fits the camera to the cloth's new size within the same window
  }

  // Cloth physics: Verlet integration + iterative distance-constraint
  // solving (the standard "position based dynamics" approach browser
  // cloth demos use).
  const DAMPING = 0.985;
  const GRAVITY = 780;
  const GRAVITY_BURN_EXTRA = 260; // weakened (but not yet cut) fibers sag a bit extra
  const PUSH_RADIUS = 110;
  const PUSH_STRENGTH = 3800;
  const CUT_THRESHOLD = 0.72;
  const CONSTRAINT_ITERATIONS = 5;

  // Wind: separate from the PUSH_* stuff above, which just shoves the
  // fabric away from wherever the cursor is.
  const WIND_GAIN = 0.45;       // Force per unit of eased gust strength (px/s)
  const WIND_RESPONSE = 7;      // How fast the gust ramps up when you move fast
  const WIND_DECAY = 2.0;       // How fast it eases back down once you slow/stop
  const WIND_WAVE_FREQ = 0.022; // Spatial frequency of the traveling ripple, per px
  const WIND_WAVE_SPEED = 6.5;  // How fast that ripple travels across the cloth
  const WIND_WAVE_DEPTH = 0.6;  // How much the ripple modulates the gust (0 = uniform push)
  const WIND_FLUTTER = 0.35;    // Extra sideways shimmer riding along the gust
  const MOUSE_SPEED_CAP = 4000; // px/s -- keeps one laggy frame from launching the cloth

  // Flames get their own (much gentler) read on the same gust system,
  // capped outright rather than just eased.
  const FLAME_WIND_GAIN = 0.12;
  const FLAME_LEAN_MAX = 90;
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  let mouse = { x: -9999, y: -9999, px: -9999, py: -9999, active: false, vx: 0, vy: 0, speed: 0 };
  let simTime = 0;   // Just keeps climbing, used to phase the wave and flutter
  let windPower = 0; // Eased gust strength -- chases cursor speed instead of snapping to it
  let windDirX = 1, windDirY = 0; // last direction the gust was heading

  // Cursor position updates every mousemove, but mousemove doesn't
  // fire on a tidy schedule.
  function updateMouseVelocity(dt) {
    if (shiftHeld) {
      // Shift-hover drives the anchor UI (single-point and edge-line
      // toggling, see interaction.js).
      mouse.vx = 0; mouse.vy = 0; mouse.speed = 0;
      windPower = 0;
      mouse.px = mouse.x; mouse.py = mouse.y;
      return;
    }
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

    // windPower eases toward the current speed rather than tracking it 1:1
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
        // Holds at pinX/pinY (wherever it was nailed), not restX/restY
        // (its original flat layout spot).
        p.x = p.pinX; p.y = p.pinY; p.oldX = p.pinX; p.oldY = p.pinY;
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

      if (mouse.active && !shiftHeld) {
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
        if (dist < PUSH_RADIUS) {
          const falloff = 1 - dist / PUSH_RADIUS;
          ax += (dx / dist) * PUSH_STRENGTH * falloff * falloff;
          ay += (dy / dist) * PUSH_STRENGTH * falloff * falloff;
        }
      }

      if (windPower > 3) {
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

      const fallLimit = (VIEW_H - originY) / clothScale + 40;
      if (p.burn >= CUT_THRESHOLD && p.y > fallLimit) {
        p.destroyed = true;
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

  const HEAT_SOURCE_GAIN = 1.0;  // How strongly an actively burning vertex radiates
  const HEAT_DIFFUSE = 0.5;      // How much of a neighbor's heat bleeds through per frame
  const HEAT_RESPONSE = 4.5;     // How fast a vertex's own glow chases its diffusion target
  const HEAT_DECAY = 0.35;       // Per-second fade once nothing nearby is still feeding it

  function updateHeatGlow(dt) {
    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const p = particles[idx(i, j)];
        if (p.destroyed) continue;

        const source = p.burning ? Math.min(p.burn, 1) * HEAT_SOURCE_GAIN : 0;

        // Reads neighbors' heatGlow from last frame (this is a single-
        // pass approximation, not a properly solved diffusion -- a
        // real one would need a double buffer to avoid directional
        // bias, but for a stylized "warmth is spreading" read this is
        // plenty and a lot cheaper).
        let neighborSum = 0, neighborCount = 0;
        const left = i > 0 ? particles[idx(i - 1, j)] : null;
        const right = i < COLS ? particles[idx(i + 1, j)] : null;
        const up = j > 0 ? particles[idx(i, j - 1)] : null;
        const down = j < ROWS ? particles[idx(i, j + 1)] : null;
        for (const n of [left, right, up, down]) {
          if (n && !n.destroyed) { neighborSum += n.heatGlow; neighborCount++; }
        }
        const bled = neighborCount ? (neighborSum / neighborCount) * HEAT_DIFFUSE : 0;

        const target = Math.max(source, bled);
        p.heatGlow += (target - p.heatGlow) * Math.min(1, HEAT_RESPONSE * dt);
        p.heatGlow = Math.max(0, p.heatGlow - HEAT_DECAY * dt);
      }
    }
  }

  function stepCloth(dt) {
    dt = Math.min(dt, 1 / 30);
    simTime += dt;
    updateMouseVelocity(dt);
    verletIntegrate(dt);
    satisfyConstraints();
    updateHeatGlow(dt);

    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const p = particles[idx(i, j)];
        if (p.destroyed || !p.burning) continue;

        p.burn += dt * (0.36 + Math.random() * 0.26);

        if (!p.scorched && p.burn >= CUT_THRESHOLD) {
          p.scorched = true;
          stampScorch(p.x, p.y, (16 + Math.random() * 16) * fireScale(), 0.45 + Math.random() * 0.25);
        }

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
