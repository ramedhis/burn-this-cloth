// === cloth-physics.js ===
// Part of the burn-this-cloth engine. Loaded as a plain <script> (not a
// module) in index.html, in the same order these sections used to appear
// inside the single big IIFE in the old script.js. All the let/const/function
// declarations below live at the top level of the page's shared script scope
// (that's just how classic, non-module <script> tags work -- each one's
// top-level declarations join one common global scope), so a name declared in
// an earlier-loaded file is already available here, and a name declared here is
// available to any file loaded after it -- no window.* namespace object, no
// imports, nothing to wire up by hand.

  function idx(i, j) { return j * (COLS + 1) + i; }

  let particles = [];

  // True once there's nothing left of the cloth to see -- either every
  // particle has actually burned through, or whatever's left has torn
  // free and fallen off the bottom of the window. A scrap that ripped
  // loose and dropped out of view is just as gone as one that burned
  // up; the physics sim has no idea the window has an edge (particles
  // keep falling in cloth-space forever), so "off past VIEW_H" is what
  // "gone" looks like for a piece that never actually finished
  // burning. At that point there's no cloth left to trace a rectangle
  // around, so the hover frame shouldn't be able to show up either,
  // until a reload/reset brings particles back.
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

  // Which grid points are pinned in place, picked from the panel
  let anchorMode = 'edge';
  function isPinned(i, j) {
    if (anchorMode === 'three') {
      if (j !== 0) return false;
      const mid = Math.round(COLS / 2);
      return i === 0 || i === COLS || i === mid;
    }
    if (anchorMode === 'eight') {
      const midCol = Math.round(COLS / 2);
      const midRow = Math.round(ROWS / 2);
      const corner = (i === 0 || i === COLS) && (j === 0 || j === ROWS);
      const topBottomMid = (j === 0 || j === ROWS) && i === midCol;
      const leftRightMid = (i === 0 || i === COLS) && j === midRow;
      return corner || topBottomMid || leftRightMid;
    }
    return j === 0;
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
          pinned,
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
    clothContainer.addChild(gridGraphics); // buildMeshObjects re-adds the mesh on top, pull the grid back above it
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
  const CUT_THRESHOLD = 0.72;
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

  // Flames get their own (much gentler) read on the same gust system,
  // capped outright rather than just eased -- windPower can run into
  // the thousands on a fast swipe (same range MOUSE_SPEED_CAP allows),
  // which is fine as an acceleration term for the cloth's spring solver
  // but was wildly too much as a direct per-frame position shift for
  // an unconstrained sprite.
  const FLAME_WIND_GAIN = 0.12;
  const FLAME_LEAN_MAX = 90;
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

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

      // Window bottom edge, converted from screen space back into the
      // same nominal cloth space p.y lives in -- this is what "falls
      // off the visible page" actually means now that the canvas is
      // the whole window instead of a fixed box, so it stays correct
      // through resizes and cloth-size changes without needing its
      // own constant.
      //
      // This only exists to clean up torn-off burning fragments that
      // have fallen well clear of view -- it's NOT supposed to catch
      // ordinary cloth swinging on a pendulum. destroyed is permanent
      // (linkIntact treats a destroyed particle as gone forever, on
      // both the physics and the mesh side), so marking a perfectly
      // healthy, unburned vertex destroyed just because a gust or the
      // cloth's own momentum swung it a bit past the bottom edge meant
      // it never came back once it swung back into view -- it read as
      // a permanent bite taken out of the cloth, which is exactly the
      // "chunk missing after it swings back" bug this was causing from
      // the very start. CUT_THRESHOLD (not just "any burn at all") is
      // the right line here -- that's the exact point linkIntact()
      // already treats a vertex as cut loose from the mesh, so this
      // only ever fires on something that's already a free, untethered
      // scrap. A vertex that's lightly charred but still structurally
      // part of the fabric is not a "fragment" yet and shouldn't be
      // eligible either.
      const fallLimit = (VIEW_H - originY) / clothScale + 40;
      if (p.burn >= CUT_THRESHOLD && p.y > fallLimit) {
        // No ash puff here on purpose -- by this point the fragment has
        // already fallen well clear of the visible window (fallLimit is
        // 40 cloth-units past VIEW_H), so it's not actually visible
        // anymore. A puff used to fire anyway at a fixed spot near the
        // cloth's own bottom edge (HEIGHT + 20) to "represent" it, but
        // that put a small puff of smoke right where the hover frame's
        // border sits, over and over, every time a scrap crossed this
        // line -- reading as smoke stuck to the frame rather than
        // anything to do with the actual cloth. Nothing is visibly
        // lost by just letting it go quietly.
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

  // Right now cloth is either burning (and showing it) or completely
  // untouched, with nothing in between -- a vertex two cells away from
  // an active flame looks exactly as pristine as one on the far
  // corner of the sheet, right up until the ignite-chain in stepCloth
  // below actually reaches it. heatGlow is a cheap, approximate
  // diffusion (not a real heat equation, just neighbor-averaging) that
  // gives fabric a warm pre-char discoloration bleeding outward from
  // wherever's actively burning, so a patch visibly warms before it
  // catches instead of catching with no warning at all.
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

        // Slowed down a bit (was 0.5 + rand*0.35) -- combined with the
        // higher CUT_THRESHOLD above, this gives the char/fire-ring
        // shading room to actually be seen instead of flashing by on
        // the way to a hole.
        p.burn += dt * (0.36 + Math.random() * 0.26);

        // linkIntact() cuts a vertex's constraints at CUT_THRESHOLD --
        // that's the actual instant a hole opens in the mesh, well
        // before this particle counts as fully "destroyed" below. This
        // is the one moment worth marking permanently: everything
        // after it is just the torn flap falling away, but the mark of
        // it having burned through belongs on the backdrop, not on a
        // piece of cloth that's about to be gone.
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
