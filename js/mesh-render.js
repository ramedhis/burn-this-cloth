// === mesh-render.js ===

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
  let positions, uvs, burnArr, shadeArr, heatArr, indices;
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

  // Ambient heat bleed for the pre-scorch glow (feeds the fragment
  // shader's vHeatGlow/preheat block below). Purely visual -- it
  // just looks a couple of grid cells out and reports how hot the
  // hottest nearby thing currently is, decayed by distance. A vertex
  // sitting right next to a fully-burning neighbor reads almost as hot
  // as that neighbor; another ring out and it fades fast, so this
  // reads as "the fire is right next to this specific patch" rather
  // than smearing a uniform warm wash across the whole sheet.
  const HEAT_RADIUS = 2; // how many grid cells out the glow reaches
  function vertexHeat(i, j) {
    const p = particles[idx(i, j)];
    if (p.destroyed) return 0;
    let best = 0;
    for (let dj = -HEAT_RADIUS; dj <= HEAT_RADIUS; dj++) {
      for (let di = -HEAT_RADIUS; di <= HEAT_RADIUS; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || ni > COLS || nj < 0 || nj > ROWS) continue;
        const n = particles[idx(ni, nj)];
        if (n.destroyed) continue;
        const dist = Math.max(Math.abs(di), Math.abs(dj));
        const falloff = 1 - (dist - 1) / HEAT_RADIUS; // immediate neighbor (dist=1) sits closest to full strength
        const contribution = Math.min(n.burn, 1) * falloff;
        if (contribution > best) best = contribution;
      }
    }
    return best;
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

  // Anchor highlight overlay: shift-clicking the cloth (see
  // toggleAnchorAt in interaction.js) nails or un-nails individual grid
  // points.
  const anchorGraphics = new PIXI.Graphics();
  clothContainer.addChild(anchorGraphics);
  const ANCHOR_DOT_COLOR = 0x999999;
  const ANCHOR_GLOW_COLOR = 0xffffff;

  function drawAnchors() {
    anchorGraphics.clear();
    if (!hoveredAnchor || hoveredAnchor.destroyed || !hoveredAnchor.pinned) return;

    const dotRadius = 4 * fireScale();
    const glowRadius = dotRadius * 2.2;
    const p = hoveredAnchor;

    anchorGraphics.beginFill(ANCHOR_GLOW_COLOR, 0.25);
    anchorGraphics.drawCircle(p.x, p.y, glowRadius);
    anchorGraphics.endFill();
    anchorGraphics.beginFill(ANCHOR_DOT_COLOR, 0.95);
    anchorGraphics.drawCircle(p.x, p.y, dotRadius);
    anchorGraphics.endFill();
  }

  // Edge-anchor highlight: holding Shift over an un-anchored point on
  // one of the cloth's four boundary lines and dwelling there for a
  // moment lights up the whole line, previewing what a click will
  // pin -- see updateEdgeHover/pinEdge in interaction.js for the
  // hover-timing and the actual pinning.
  const edgeHighlightGraphics = new PIXI.Graphics();
  clothContainer.addChild(edgeHighlightGraphics);

  function drawEdgeHighlight() {
    edgeHighlightGraphics.clear();
    if (!edgeHighlightActive || !hoveredEdge) return;

    const idxs = edgeParticleIndices(hoveredEdge);
    if (idxs.length < 2) return;

    const glowWidth = 10 * fireScale();
    const lineWidth = 2.5 * fireScale();

    for (const [width, alpha] of [[glowWidth, 0.18], [lineWidth, 0.9]]) {
      edgeHighlightGraphics.lineStyle(width, 0xffffff, alpha);
      let started = false;
      for (const i of idxs) {
        const p = particles[i];
        // A destroyed vertex breaks the line into separate runs rather
        // than letting it draw a stray segment through wherever that
        // point last was -- matters once an edge has already partly
        // burned through by the time someone goes to anchor the rest
        // of it.
        if (p.destroyed) { started = false; continue; }
        if (!started) { edgeHighlightGraphics.moveTo(p.x, p.y); started = true; }
        else edgeHighlightGraphics.lineTo(p.x, p.y);
      }
    }
  }

  const vertexSrc = `
    attribute vec2 aVertexPosition;
    attribute vec2 aTextureCoord;
    attribute float aBurn;
    attribute float aShade;
    attribute float aHeatGlow;

    uniform mat3 projectionMatrix;
    uniform mat3 translationMatrix;

    varying vec2 vTextureCoord;
    varying float vBurn;
    varying float vShade;
    varying float vHeatGlow;

    void main(void) {
      gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
      vTextureCoord = aTextureCoord;
      vBurn = aBurn;
      vShade = aShade;
      vHeatGlow = aHeatGlow;
    }
  `;

  const fragmentSrc = `
    varying vec2 vTextureCoord;
    varying float vBurn;
    varying float vShade;
    varying float vHeatGlow;

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

      // Pull it toward something closer to printed cloth: a bit
      // less saturated, a bit less contrasty, a bit less bright.
      // Small nudges on purpose.
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

      // Ambient heat bleeding in from nearby active fire, entirely
      // separate from this vertex's own char band below. Fades out
      // fast once real burning starts here (the (1.0 - t-based term))
      // so it hands off to the char band instead of doubling up with it.
      float preheat = clamp(vHeatGlow, 0.0, 1.0) * (1.0 - smoothstep(0.0, 0.3, t));
      vec3 preheatColor = vec3(0.24, 0.09, 0.03);
      lit = mix(lit, preheatColor, preheat * 0.5);

      // Char: fabric burns down toward near-black charcoal well
      // before the hole opens.
      vec3 charColor = vec3(0.045, 0.032, 0.026);
      float charAmt = smoothstep(0.04, 0.50, t);
      vec3 charred = mix(lit, charColor, charAmt);

      // Fire ring: the actual combustion front. It peaks just below
      // CUT_THRESHOLD (0.72 on the JS side), so the brightest pixels
      // are the ones about to become a hole, and fades back toward
      // the char.
      float ring = smoothstep(0.30, 0.55, t) * (1.0 - smoothstep(0.55, 0.74, t));
      vec3 emberColor = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.92, 0.62), smoothstep(0.34, 0.58, t));
      vec3 finalColor = mix(charred, emberColor, ring);

      // A small overexposed core right at the hottest sliver of the
      // ring -- pushes those pixels toward blown-out white instead of
      // just pale yellow, which is what actually reads as "glowing"
      // rather than "painted yellow".
      float hot = smoothstep(0.52, 0.64, t) * (1.0 - smoothstep(0.64, 0.74, t));
      finalColor += vec3(0.5, 0.4, 0.25) * hot;
      finalColor = clamp(finalColor, 0.0, 1.0);

      gl_FragColor = vec4(finalColor, texColor.a) * uColor;

      // eat little holes into the fabric before the whole triangle
      // gets pulled from the mesh (CUT_THRESHOLD on the JS side) --
      // otherwise a burning patch just vanishes as one clean wedge,
      // which is what made the tear line read as "triangle" instead
      // of "burnt cloth". noise-driven so the lace pattern doesn't
      // line up with the grid underneath it. Range shifted to sit
      // right under the fire ring above, so what survives the grain
      // right at the edge is still glowing, not already char-brown.
      float grain = hash(floor(vTextureCoord * 260.0));
      float keepChance = mix(1.0, 0.1, smoothstep(0.38, 0.72, t));
      if (grain > keepChance) discard;
    }
  `;

  function buildMeshObjects() {
    const nVerts = (COLS + 1) * (ROWS + 1);
    positions = new Float32Array(nVerts * 2);
    uvs = new Float32Array(nVerts * 2);
    burnArr = new Float32Array(nVerts);
    shadeArr = new Float32Array(nVerts);
    heatArr = new Float32Array(nVerts);
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
      .addAttribute('aHeatGlow', heatArr, 1)
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
        // cell (checkerboard).
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
      // particles in, so this recovers the (i,j) vertexShade/vertexHeat
      // want without needing a second lookup table.
      const gi = n % rowLen, gj = (n / rowLen) | 0;
      shadeArr[n] = vertexShade(gi, gj);
      heatArr[n] = vertexHeat(gi, gj);
    }
    rebuildMeshIndices();

    geometry.getBuffer('aVertexPosition').update(positions);
    geometry.getBuffer('aBurn').update(burnArr);
    geometry.getBuffer('aShade').update(shadeArr);
    geometry.getBuffer('aHeatGlow').update(heatArr);
    geometry.indexBuffer.update(indices);
  }
