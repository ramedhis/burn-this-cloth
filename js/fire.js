// === fire.js ===

  // Fire particles -- same spawn/update logic as before, just
  // rendered as pooled GPU sprites instead of ctx.arc() calls.
  let flames = [];
  let embers = [];
  let smoke = [];
  let ashFlakes = [];
  const MAX_FLAMES = 260;
  const MAX_EMBERS = 140;
  const MAX_SMOKE = 90;
  const MAX_ASH = 120;

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
      lean: 0,
      windRate: 3 + Math.random() * 6,
      windMul: 0.5 + Math.random() * 0.9,
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

  // Everything that's ever destroyed the cloth so far reads as
  // upward-drifting smoke. 
  function spawnAshFlake(x, y) {
    if (ashFlakes.length > MAX_ASH) return;
    const fs = fireScale();
    ashFlakes.push({
      x, y,
      vx: (Math.random() - 0.5) * 30 * fs,
      vy: -(8 + Math.random() * 18) * fs, // small kick from the burn itself before gravity takes over
      life: 0,
      maxLife: 2.2 + Math.random() * 2.6,
      size: (1.4 + Math.random() * 2.4) * fs,
      flutter: Math.random() * Math.PI * 2,
    });
  }

  function spawnAshPuff(x, y) {
    for (let k = 0; k < 4; k++) spawnSmoke(x, y);
    const n = 2 + Math.floor(Math.random() * 4);
    for (let k = 0; k < n; k++) spawnAshFlake(x, y);
  }

  function updateFire(dt) {
    for (const p of particles) {
      if (p.destroyed) continue;

      const screenY = originY + p.y * clothScale;
      if (screenY > VIEW_H) continue;
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

      // f.lean eases toward the current gust rather than snapping to
      // it -- a spring-solved cloth gets that smoothing for free from
      // the constraint solver, but a flame sprite has nothing playing
      // that role, so applying windPower directly (like the first
      // pass at this did) made it read as the sprite being shoved,
      // not bending. Each flame's own windRate/windMul (set at spawn)
      // keeps every tongue catching the gust a little differently
      // instead of the whole fire leaning over in one rigid unit.
      const gustTarget = clamp(windDirX * windPower * FLAME_WIND_GAIN * f.windMul, -FLAME_LEAN_MAX, FLAME_LEAN_MAX);
      f.lean += (gustTarget - f.lean) * Math.min(1, f.windRate * dt);
      f.x += (f.vx + sway + f.lean) * dt;

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

    stepList(ashFlakes, (a) => {
      a.flutter += dt * 4;
      a.vy += 55 * dt; // much lighter than an ember's fall -- this is ash, not a spark
      a.x += (a.vx + Math.sin(a.flutter) * 18) * dt;
      a.y += a.vy * dt;
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
  const ashTex = makeRadialTexture(24, [
    [0, 'rgba(96,90,84,0.9)'], [0.55, 'rgba(64,60,56,0.55)'], [1, 'rgba(64,60,56,0)'],
  ]);
  const bloomTex = makeRadialTexture(128, [
    [0, 'rgba(255,150,60,0.5)'], [0.5, 'rgba(255,110,30,0.22)'], [1, 'rgba(255,110,30,0)'],
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
  const ashPool = makePool(smokeContainerObj, ashTex, MAX_ASH + 10, false);
  const MAX_BLOOM_LIGHTS = 18;
  const bloomPool = makePool(bloomContainer, bloomTex, MAX_BLOOM_LIGHTS, true);
  const fabricBloomPool = makePool(clothBloomContainer, bloomTex, MAX_BLOOM_LIGHTS, true);

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
      s.rotation = Math.max(-0.4, Math.min(0.4, f.vx / 90 + f.lean / 130)); // Leans with its own drift, plus wherever the wind's currently bending it
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
    applyPool(ashPool, ashFlakes,
      (a, t) => lerpColor(0x6a635b, 0x38332f, t), // Cools from warm grey ash toward dead soot as it falls
      (a) => a.size * 3,
      (a, t) => Math.pow(1 - t, 1.2) * 0.85);
  }

  // Firelight doesn't politely stay inside the cloth's own silhouette
  // -- in reality it throws warm light across whatever's behind the
  // burning fabric too. bgContainer/scorchContainer sit outside
  // worldRoot's camera transform (same reason the backdrop itself
  // does), so the existing per-vertex glowPool -- which lives inside
  // worldRoot and lights the cloth mesh itself -- can't reach it; this
  // needs its own pass in plain screen space. Rather than one bloom
  // sprite per burning vertex (expensive, and a wash of a hundred
  // overlapping blobs just reads as mush), burning particles get
  // bucketed into a coarse grid and only the handful of hottest
  // buckets actually get a light, placed at that bucket's intensity-
  // weighted centroid. Bucket count stays fixed regardless of mesh
  // density, so this stays cheap even at the "fine" grid setting.
  const BLOOM_GRID = 8;
  const bloomWeight = new Float32Array(BLOOM_GRID * BLOOM_GRID);
  const bloomSumX = new Float32Array(BLOOM_GRID * BLOOM_GRID);
  const bloomSumY = new Float32Array(BLOOM_GRID * BLOOM_GRID);
  let bloomOrder = [];

  function updateBloom() {
    bloomWeight.fill(0);
    bloomSumX.fill(0);
    bloomSumY.fill(0);

    for (let n = 0; n < particles.length; n++) {
      const p = particles[n];
      if (p.destroyed || (!p.burning && p.burn <= 0)) continue;
      const w = Math.min(p.burn, 1);
      const bx = Math.min(BLOOM_GRID - 1, Math.max(0, Math.floor((p.x / WIDTH) * BLOOM_GRID)));
      const by = Math.min(BLOOM_GRID - 1, Math.max(0, Math.floor((p.y / HEIGHT) * BLOOM_GRID)));
      const b = by * BLOOM_GRID + bx;
      bloomWeight[b] += w;
      bloomSumX[b] += p.x * w;
      bloomSumY[b] += p.y * w;
    }

    bloomOrder.length = 0;
    for (let b = 0; b < bloomWeight.length; b++) {
      if (bloomWeight[b] > 0.05) bloomOrder.push(b);
    }
    bloomOrder.sort((a, b) => bloomWeight[b] - bloomWeight[a]);

    for (let k = 0; k < bloomPool.length; k++) {
      const s = bloomPool[k];
      if (k >= bloomOrder.length) { s.visible = false; continue; }
      const b = bloomOrder[k];
      const w = bloomWeight[b];
      const cx = bloomSumX[b] / w;
      const cy = bloomSumY[b] / w;

      s.visible = true;
      s.x = originX + cx * clothScale;
      s.y = originY + cy * clothScale;
      const sizePx = (150 + w * 24) * clothScale;
      s.width = sizePx; s.height = sizePx;
      const flicker = 0.85 + Math.sin(simTime * 13 + b * 7) * 0.15;
      s.alpha = Math.min(1, 0.5 + w * 0.05) * flicker;
    }

    // Same clusters, but placed straight in cloth-space (no
    // origin/clothScale conversion needed -- clothBloomContainer sits
    // inside worldRoot, which already applies that transform to
    // everything in it).
    for (let k = 0; k < fabricBloomPool.length; k++) {
      const s = fabricBloomPool[k];
      if (k >= bloomOrder.length) { s.visible = false; continue; }
      const b = bloomOrder[k];
      const w = bloomWeight[b];
      const cx = bloomSumX[b] / w;
      const cy = bloomSumY[b] / w;

      s.visible = true;
      s.x = cx; s.y = cy;
      const sizePx = (260 + w * 50) * fireScale();
      s.width = sizePx; s.height = sizePx;
      const flicker = 0.85 + Math.sin(simTime * 11 + b * 5) * 0.15;
      s.alpha = Math.min(0.4, 0.16 + w * 0.02) * flicker;
    }
  }
