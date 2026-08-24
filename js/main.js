// === main.js ===
// Part of the burn-this-cloth engine. Loaded as a plain <script> (not a
// module) in index.html, in the same order these sections used to appear
// inside the single big IIFE in the old script.js. All the let/const/function
// declarations below live at the top level of the page's shared script scope
// (that's just how classic, non-module <script> tags work -- each one's
// top-level declarations join one common global scope), so a name declared in
// an earlier-loaded file is already available here, and a name declared here is
// available to any file loaded after it -- no window.* namespace object, no
// imports, nothing to wire up by hand.

  document.getElementById('densityBtn').addEventListener('click', () => {
    // Button label stays put ("Density") regardless of which setting is
    // active -- it's a cycle button living in a small toolbar now, not
    // a status readout, so there's no room (or need) to spell out the
    // current value on the button itself.
    densityIdx = (densityIdx + 1) % densities.length;
    resetCloth(true);
  });

  const anchorBtns = document.querySelectorAll('.anchor-btn');
  anchorBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      anchorMode = btn.dataset.anchor;
      anchorBtns.forEach((b) => b.classList.toggle('active', b === btn));
      resetCloth(true);
    });
  });

  const gridToggleBtn = document.getElementById('gridToggleBtn');
  gridToggleBtn.addEventListener('click', () => {
    // Same deal as densityBtn above -- label just says "Mesh" always,
    // the is-on class (already styled in CSS) is what shows whether
    // it's currently active.
    showGrid = !showGrid;
    gridToggleBtn.classList.toggle('is-on', showGrid);
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
  updateViewport();
  drawPlaceholderTexture();
  resetCloth(true);
  updateImageToolButtons();

  let last = performance.now();
  function loop(now) {
    const dt = (now - last) / 1000;
    last = now;

    // Held-down dragging lights a trail as it goes, throttled by time
    // rather than by mousemove events -- a fast swipe shouldn't get
    // MORE ignition points than a slow one just because it fired more
    // mousemove events along the way.
    if (pointerDown && mouse.active) {
      dragIgniteTimer -= dt;
      if (dragIgniteTimer <= 0) {
        ignite({ x: mouse.x, y: mouse.y }, { strength: 0.5 });
        dragIgniteTimer = DRAG_IGNITE_INTERVAL;
      }
    }

    // Same throttle-by-time idea as the drag-ignite trail above, just
    // applied to an in-progress resize: updateClothResize() (called
    // from the mousemove listener) only ever records where the pointer
    // wants the size to be, this is what actually rebuilds the cloth to
    // match, a handful of times a second rather than every mousemove.
    if (resizing) {
      resizeApplyTimer -= dt;
      if (resizeApplyTimer <= 0) {
        applyPendingResize();
        resizeApplyTimer = RESIZE_APPLY_INTERVAL;
      }
    }

    stepCloth(dt);
    updateFire(dt);
    updateMeshBuffers();
    drawGrid();
    updateFireSprites();
    updateBloom();
    if (isClothGone()) clothFrame.classList.remove('active');
    try {
      app.renderer.render(app.stage);
    } catch (err) {
      console.error('render() failed, skipping this frame:', err);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
