// === main.js ===

  document.getElementById('densityBtn').addEventListener('click', () => {
    densityIdx = (densityIdx + 1) % densities.length;
    resetCloth(true);
  });

  const gridToggleBtn = document.getElementById('gridToggleBtn');
  gridToggleBtn.addEventListener('click', () => {
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

    // updateClothResize() (called from the mousemove listener) only ever
    // records where the pointer wants the size to be.
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
    updateAnchorHover();
    drawAnchors();
    updateEdgeHover(dt);
    drawEdgeHighlight();
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
