// === interaction.js ===
// Part of the burn-this-cloth engine. Loaded as a plain <script> (not a
// module) in index.html, in the same order these sections used to appear
// inside the single big IIFE in the old script.js. All the let/const/function
// declarations below live at the top level of the page's shared script scope
// (that's just how classic, non-module <script> tags work -- each one's
// top-level declarations join one common global scope), so a name declared in
// an earlier-loaded file is already available here, and a name declared here is
// available to any file loaded after it -- no window.* namespace object, no
// imports, nothing to wire up by hand.

  // Input
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    // rect.width/height should already equal VIEW_W/VIEW_H (canvas is
    // CSS 100% of a full-window stage), but scale through them anyway
    // in case of any sub-pixel rounding -- then undo the camera's
    // offset and zoom to land back in the same nominal cloth space
    // the particles live in.
    const screenX = cx * (VIEW_W / rect.width);
    const screenY = cy * (VIEW_H / rect.height);
    return {
      x: (screenX - originX) / clothScale,
      y: (screenY - originY) / clothScale,
    };
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

  // Hover hit-test for the frame/toolbar overlay. Deliberately its own
  // window-level listener rather than piggybacking on the canvas one
  // above: once the toolbar is visible and the cursor moves onto one
  // of its buttons, the canvas stops being the topmost element there
  // and would otherwise fire mouseleave right as someone reaches for a
  // button. A window listener keeps tracking clientX/Y regardless of
  // which element is actually under the cursor.
  //
  // Two different boxes, on purpose: the frame should only ever switch
  // ON because the cursor is over the actual cloth -- hovering the
  // gap by itself shouldn't summon it. But once it's up, the cursor
  // has to cross that same gap to reach the toolbar sitting above it,
  // so switching OFF the instant the cursor leaves the strict cloth
  // box would make the buttons unreachable. So: entering the strict
  // box turns it on; leaving the padded box turns it off; anywhere in
  // between (the gap, or the toolbar itself) just leaves it however it
  // already was.
  const FRAME_HOVER_PAD = 16;      // matches FRAME_GAP, left/right/bottom slack
  const FRAME_HOVER_TOP_PAD = 56;  // extra headroom so the toolbar itself counts
  window.addEventListener('mousemove', (e) => {
    if (isClothGone()) { clothFrame.classList.remove('active'); return; }

    const inClothStrict =
      e.clientX >= clothRectLeft && e.clientX <= clothRectRight &&
      e.clientY >= clothRectTop && e.clientY <= clothRectBottom;
    const inPaddedZone =
      e.clientX >= clothRectLeft - FRAME_HOVER_PAD &&
      e.clientX <= clothRectRight + FRAME_HOVER_PAD &&
      e.clientY >= clothRectTop - FRAME_HOVER_TOP_PAD &&
      e.clientY <= clothRectBottom + FRAME_HOVER_PAD;

    if (inClothStrict) {
      clothFrame.classList.add('active');
    } else if (!inPaddedZone) {
      clothFrame.classList.remove('active');
    }
    // else: cursor is in the gap or on the toolbar -- leave state as is
  });

  function ignite(pos, opts) {
    // strength scales down both the catch radius and how much burn a
    // touch actually deposits -- used to make a held drag lay down a
    // trail of light touches (like dragging a lit match) instead of
    // spamming full click-strength bursts dozens of times a second.
    const strength = (opts && opts.strength != null) ? opts.strength : 1;

    // Roll a random patch size per click -- sometimes it's a small
    // lick of flame, sometimes a proper spreading blaze right away
    const radius = (14 + Math.random() * 70) * fireScale() * strength;
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
      const startBurn = (0.05 + falloff * 0.25 * Math.random()) * strength;
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
    // sizeMul below is additionally scaled by strength so a dragged
    // touch throws small licks instead of full click-sized tongues --
    // matters most at strength<1, where this fires many times a
    // second as you drag.
    const roll = Math.random();
    if (roll < 0.3) {
      // One flame, but a proper tall one
      spawnFlame(pos.x, pos.y, (2.2 + Math.random() * 1.6) * strength);
    } else if (roll < 0.6) {
      // A handful of small ones
      const n = 3 + Math.floor(Math.random() * 4);
      for (let k = 0; k < n; k++) {
        spawnFlame(pos.x, pos.y, (0.5 + Math.random() * 0.5) * strength);
      }
    } else {
      // Ordinary mixed burst
      const n = 1 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        spawnFlame(pos.x, pos.y, (0.8 + Math.random() * 1.3) * strength);
      }
    }
  }

  // Custom anchors: shift-click nails the nearest grid particle in
  // place exactly where it's currently hanging (not back to its flat
  // rest position -- see the pinX/pinY comment in buildGrid). Shift-
  // clicking an already-pinned particle un-nails it instead. Snap
  // radius is derived from the current grid spacing rather than a
  // fixed pixel number, so a coarse grid and a fine one both feel
  // equally easy to click a vertex on.
  function anchorSnapRadiusSq() {
    const spx = WIDTH / COLS, spy = HEIGHT / ROWS;
    return (Math.max(spx, spy) * 0.75) ** 2;
  }

  function nearestParticleAt(pos) {
    let best = null, bestDSq = Infinity;
    for (const p of particles) {
      if (p.destroyed) continue;
      const dx = p.x - pos.x, dy = p.y - pos.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDSq) { bestDSq = dSq; best = p; }
    }
    return { particle: best, distSq: bestDSq };
  }

  function toggleAnchorAt(pos) {
    const { particle: best, distSq } = nearestParticleAt(pos);
    if (!best || distSq > anchorSnapRadiusSq()) return; // click missed the cloth

    if (best.pinned) {
      best.pinned = false;
    } else {
      best.pinned = true;
      best.pinX = best.x;
      best.pinY = best.y;
    }
  }

  // Hover preview: while Shift is held, whichever existing anchor is
  // under the cursor lights up (see drawAnchors in mesh-render.js) so
  // it's clear a click will remove that specific point rather than
  // planting a new one somewhere nearby. Recomputed once a frame in the
  // main loop (updateAnchorHover) rather than only on mousemove, so it
  // also reacts the instant Shift itself is pressed or released without
  // needing the mouse to move first.
  let hoveredAnchor = null;

  function updateAnchorHover() {
    if (!shiftHeld || !mouse.active || particles.length === 0) {
      hoveredAnchor = null;
      return;
    }
    const { particle: best, distSq } = nearestParticleAt({ x: mouse.x, y: mouse.y });
    hoveredAnchor = (best && best.pinned && distSq <= anchorSnapRadiusSq()) ? best : null;
  }

  // Edge-line anchoring: Shift + hover a point sitting on one of the
  // cloth's four boundary lines, hold still there for a moment, and
  // the whole line lights up (drawEdgeHighlight in mesh-render.js),
  // previewing what a click is about to do to every point along it.
  // Works the same way in both directions -- hovering an un-anchored
  // stretch previews pinning it, hovering an already-anchored stretch
  // previews un-pinning it -- edgeHoverMode below is just which of
  // those two the currently-hovered point calls for, so the click
  // handler knows which one to actually do.
  const EDGE_HOVER_DWELL = 1; // seconds of continuous hover before it lights up
  let hoveredEdge = null;
  let edgeHoverMode = null; // 'pin' | 'unpin'
  let edgeHoverTimer = 0;
  let edgeHighlightActive = false;

  function resetEdgeHover() {
    hoveredEdge = null;
    edgeHoverMode = null;
    edgeHoverTimer = 0;
    edgeHighlightActive = false;
  }

  function updateEdgeHover(dt) {
    if (!shiftHeld || !mouse.active || particles.length === 0) { resetEdgeHover(); return; }

    const { particle: best, distSq } = nearestParticleAt({ x: mouse.x, y: mouse.y });
    if (!best || best.destroyed || distSq > anchorSnapRadiusSq()) { resetEdgeHover(); return; }

    const edge = edgeOf(best);
    if (!edge) { resetEdgeHover(); return; } // an interior point, not on any boundary line

    const mode = best.pinned ? 'unpin' : 'pin';
    if (edge !== hoveredEdge || mode !== edgeHoverMode) {
      // Landed on a different edge, or the same edge but the point
      // under the cursor flipped from anchored to un-anchored (or vice
      // versa) -- either way that's a different action than whatever
      // was being dwelled on before, so the wait starts over rather
      // than carrying leftover time across into it.
      hoveredEdge = edge;
      edgeHoverMode = mode;
      edgeHoverTimer = 0;
      edgeHighlightActive = false;
    }
    edgeHoverTimer += dt;
    if (edgeHoverTimer >= EDGE_HOVER_DWELL) edgeHighlightActive = true;
  }

  // Pins every still-intact, not-yet-anchored particle along one
  // boundary line, each nailed at wherever it's actually hanging right
  // now -- same "anchor in place" semantics toggleAnchorAt already
  // uses for a single point, just applied to the whole line at once.
  // Already-pinned points on that same line are left alone rather than
  // re-pinned, so this is safe to fire on a partially-anchored edge
  // without disturbing anchors someone placed earlier by hand.
  function pinEdge(edge) {
    for (const i of edgeParticleIndices(edge)) {
      const p = particles[i];
      if (p.destroyed || p.pinned) continue;
      p.pinned = true;
      p.pinX = p.x;
      p.pinY = p.y;
    }
  }

  // The reverse: un-pins every currently-anchored particle along one
  // boundary line, leaving anything already loose on that line alone.
  // Whatever falls now falls from wherever it was actually held, same
  // as removing any other anchor.
  function unpinEdge(edge) {
    for (const i of edgeParticleIndices(edge)) {
      const p = particles[i];
      if (p.destroyed || !p.pinned) continue;
      p.pinned = false;
    }
  }

  // pointerDown + dragIgniteTimer drive the "drag a lit match across
  // the cloth" behavior in the main loop below: the initial press
  // still lands one full-strength ignite() immediately (so a plain
  // tap/click feels exactly like it always did), and holding it down
  // afterward keeps lighting lighter touches along wherever the
  // cursor drifts, throttled by DRAG_IGNITE_INTERVAL rather than
  // firing once a frame.
  let pointerDown = false;
  let dragIgniteTimer = 0;
  const DRAG_IGNITE_INTERVAL = 0.045;

  canvas.addEventListener('mousedown', (e) => {
    const pos = getPos(e);

    // Shift turns a click into an anchor action instead of an ignite --
    // same modifier key the cloth-frame resize handles use, but this is
    // on the canvas itself so the two never fire on the same click.
    // A dwelled edge highlight takes priority over the plain single-
    // point toggle below: once the line has actually lit up, that's
    // what the click is understood to be aimed at, not just whichever
    // one grid point happens to be nearest the cursor. Which of the
    // two things it does (pin the line or clear it) is whatever
    // edgeHoverMode settled on while dwelling -- see updateEdgeHover.
    if (e.shiftKey) {
      if (edgeHighlightActive && hoveredEdge) {
        if (edgeHoverMode === 'unpin') unpinEdge(hoveredEdge);
        else pinEdge(hoveredEdge);
        resetEdgeHover(); // the line's state just flipped, so there's nothing left for this hover to be "about"
        return;
      }
      toggleAnchorAt(pos);
      return;
    }

    pointerDown = true;
    dragIgniteTimer = DRAG_IGNITE_INTERVAL;
    ignite(pos);
  });
  window.addEventListener('mouseup', () => { pointerDown = false; });

  canvas.addEventListener('touchstart', (e) => {
    pointerDown = true;
    dragIgniteTimer = DRAG_IGNITE_INTERVAL;
    ignite(getPos(e));
  }, { passive: true });
  canvas.addEventListener('touchend', () => { pointerDown = false; });
  canvas.addEventListener('touchcancel', () => { pointerDown = false; });

  // Load and Remove occupy the same slot in the toolbar rather than
  // both sitting there permanently -- Remove is meaningless with no
  // image loaded, and Load is redundant once one's already in. This
  // just flips which one has the .hidden class based on sourceImage.
  const loadImageBtn = document.getElementById('loadImageBtn');
  const removeImageBtnEl = document.getElementById('removeImageBtn');
  function updateImageToolButtons() {
    const hasImage = !!sourceImage;
    loadImageBtn.classList.toggle('hidden', hasImage);
    removeImageBtnEl.classList.toggle('hidden', !hasImage);
  }

  document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      sourceImage = img;
      resetCloth(false);
      URL.revokeObjectURL(url);
      updateImageToolButtons();
    };
    img.src = url;
  });

  document.getElementById('removeImageBtn').addEventListener('click', () => {
    // Clears the picture only -- cloth/burn/fire state is untouched
    sourceImage = null;
    drawPlaceholderTexture();
    refreshImageOnly();
    updateImageToolButtons();
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    resetCloth(false);
  });

  // Close lives on the cloth's own toolbar and does exactly what it
  // says: deletes the cloth entity outright, on demand, rather than
  // waiting for it to burn all the way through. Marking every particle
  // destroyed is enough on its own for rendering (destroyed particles
  // already skip drawing everywhere), but the flame/ember/smoke/ash
  // arrays are independent objects once spawned -- they don't hold a
  // reference back to the particle that lit them -- so without
  // clearing them too you'd get fire hanging in mid-air over a cloth
  // that no longer exists.
  document.getElementById('clothCloseBtn').addEventListener('click', () => {
    for (let n = 0; n < particles.length; n++) particles[n].destroyed = true;
    flames.length = 0;
    embers.length = 0;
    smoke.length = 0;
    ashFlakes.length = 0;
    clothFrame.classList.remove('active');
  });

  // Dragging the cloth around by its frame -- or, holding Shift,
  // resizing it instead. The frame rectangle itself stays
  // pointer-events:none like before (so it never steals a click meant
  // for the cloth underneath); what's actually grabbable is the four
  // edge strips (.cloth-edge-handle, added earlier) plus four small
  // corner squares (.cloth-corner-handle, HTML) sitting right on the
  // frame's own corners. Edges do double duty -- move when Shift is up,
  // resize just that one side when it's down -- corners are resize-only
  // and only turn on (pointer-events) while Shift is actually held, via
  // .cloth-frame.shift-armed in style.css.
  const dragHandles = document.querySelectorAll('.cloth-resize-handle');

  let clothDragging = false;
  let dragStartClientX = 0, dragStartClientY = 0;
  let dragStartOffsetX = 0, dragStartOffsetY = 0;

  function beginClothDrag(clientX, clientY) {
    // isClothGone() also means there's nothing left for the frame to
    // trace -- see the same check in the main loop below, which is
    // what actually pulls .active off the frame once the cloth is
    // gone. Belt-and-suspenders here in case a drag somehow starts in
    // the one-frame gap before that check runs.
    if (isClothGone()) return;
    clothDragging = true;
    dragStartClientX = clientX;
    dragStartClientY = clientY;
    dragStartOffsetX = dragOffsetX;
    dragStartOffsetY = dragOffsetY;
    // The push/ignite physics reads mouse.x/y every frame regardless
    // of whether the cursor is actually still over the canvas, so
    // without this the cloth would keep getting shoved around by
    // wherever the pointer was the instant before the drag grabbed it.
    mouse.active = false;
    document.body.classList.add('cloth-dragging');
  }

  function updateClothDrag(clientX, clientY) {
    if (!clothDragging) return;
    dragOffsetX = dragStartOffsetX + (clientX - dragStartClientX);
    dragOffsetY = dragStartOffsetY + (clientY - dragStartClientY);
    applyCameraTransform(); // re-clamps against the safe box and moves everything to match
  }

  function endClothDrag() {
    clothDragging = false;
    document.body.classList.remove('cloth-dragging');
  }

  // Resizing: dragging a side changes WIDTH and/or HEIGHT (the cloth's
  // actual nominal size, same numbers the width/height fields and
  // Apply button already control) rather than some separate on-screen
  // zoom -- which is exactly why it can't get past the safe-area lines:
  // applyCanvasSize()/updateViewport() always re-fits whatever size
  // comes out of this to the biggest box that fits inside the safe
  // area, same as typing a size in by hand always has.
  //
  // Rebuilding the cloth (resetCloth, inside applyCanvasSize) isn't
  // free, so a live drag doesn't call it on every single mousemove --
  // updateClothResize() just tracks where the pointer wants the size to
  // be, and the main loop below actually applies it a few times a
  // second (see RESIZE_APPLY_INTERVAL), the same throttle-a-continuous-
  // gesture trick DRAG_IGNITE_INTERVAL already uses for the lit-match drag.
  const RESIZE_APPLY_INTERVAL = 0.05;

  let resizing = false;
  let resizeSides = [];
  let resizeStartWidth = 0, resizeStartHeight = 0;
  let resizeStartClientX = 0, resizeStartClientY = 0;
  let resizeStartScale = 1;
  let resizeAnchorScreenX = 0, resizeAnchorScreenY = 0;
  let resizeCursorClass = '';
  let resizeApplyTimer = 0;
  let resizePendingWidth = 0, resizePendingHeight = 0;
  let resizeHasPending = false;

  function cursorClassForSides(sides) {
    const hasV = sides.includes('top') || sides.includes('bottom');
    const hasH = sides.includes('left') || sides.includes('right');
    if (hasV && hasH) {
      const leaningTLBR = (sides.includes('top') && sides.includes('left')) ||
                           (sides.includes('bottom') && sides.includes('right'));
      return leaningTLBR ? 'cloth-resizing-nwse' : 'cloth-resizing-nesw';
    }
    return hasV ? 'cloth-resizing-ns' : 'cloth-resizing-ew';
  }

  function beginClothResize(sides, clientX, clientY) {
    if (isClothGone()) return;
    resizing = true;
    resizeSides = sides;
    resizeStartWidth = WIDTH;
    resizeStartHeight = HEIGHT;
    resizeStartClientX = clientX;
    resizeStartClientY = clientY;
    resizeStartScale = clothScale;
    resizePendingWidth = WIDTH;
    resizePendingHeight = HEIGHT;
    resizeHasPending = false;
    resizeApplyTimer = 0;

    const hasTop = sides.includes('top'), hasBottom = sides.includes('bottom');
    const hasLeft = sides.includes('left'), hasRight = sides.includes('right');

    // Anchor = the point that stays visually put while the grabbed
    // side(s) follow the cursor, same idea as a Photoshop free-transform
    // handle leaving the opposite corner planted. When an axis isn't
    // part of this handle at all (e.g. the plain right-edge handle only
    // touches width), there's no "opposite edge" to anchor to on that
    // axis, so it anchors to the rect's own center instead -- otherwise
    // a pure width-only drag would still visually creep up/down
    // whenever the aspect-ratio change nudges the fitted height.
    resizeAnchorScreenX = hasRight ? clothRectLeft : hasLeft ? clothRectRight : (clothRectLeft + clothRectRight) / 2;
    resizeAnchorScreenY = hasBottom ? clothRectTop : hasTop ? clothRectBottom : (clothRectTop + clothRectBottom) / 2;

    resizeCursorClass = cursorClassForSides(sides);
    document.body.classList.add(resizeCursorClass);
    mouse.active = false; // same reasoning as beginClothDrag above
  }

  function updateClothResize(clientX, clientY) {
    if (!resizing) return;
    // Cloth-space size change, converted using the scale that was in
    // effect when the drag started -- not the live one, since that's
    // about to change *because* of this resize. Using anything but a
    // fixed reference would make the cloth grow or shrink at a
    // shifting rate as the drag went on.
    const dxCloth = (clientX - resizeStartClientX) / resizeStartScale;
    const dyCloth = (clientY - resizeStartClientY) / resizeStartScale;

    let newWidth = resizeStartWidth;
    let newHeight = resizeStartHeight;
    if (resizeSides.includes('right')) newWidth = resizeStartWidth + dxCloth;
    if (resizeSides.includes('left')) newWidth = resizeStartWidth - dxCloth;
    if (resizeSides.includes('bottom')) newHeight = resizeStartHeight + dyCloth;
    if (resizeSides.includes('top')) newHeight = resizeStartHeight - dyCloth;

    resizePendingWidth = Math.max(64, Math.min(MAX_CANVAS_DIM, Math.round(newWidth)));
    resizePendingHeight = Math.max(64, Math.min(MAX_CANVAS_DIM, Math.round(newHeight)));
    resizeHasPending = true;
  }

  function applyPendingResize() {
    if (!resizeHasPending) return;
    resizeHasPending = false;
    if (resizePendingWidth === WIDTH && resizePendingHeight === HEIGHT) return;

    applyCanvasSize(resizePendingWidth, resizePendingHeight);
    widthInput.value = WIDTH;
    heightInput.value = HEIGHT;
    setActivePreset(null);

    // applyCanvasSize (via updateViewport) just re-centered the cloth
    // for its new aspect ratio, same as it would after typing a size in
    // by hand -- pull it back so the anchor point picked in
    // beginClothResize lands exactly where it was, instead of wherever
    // plain re-centering happened to put it.
    const curAnchorX = resizeSides.includes('right') ? clothRectLeft
      : resizeSides.includes('left') ? clothRectRight
      : (clothRectLeft + clothRectRight) / 2;
    const curAnchorY = resizeSides.includes('bottom') ? clothRectTop
      : resizeSides.includes('top') ? clothRectBottom
      : (clothRectTop + clothRectBottom) / 2;
    dragOffsetX += resizeAnchorScreenX - curAnchorX;
    dragOffsetY += resizeAnchorScreenY - curAnchorY;
    applyCameraTransform(); // re-clamped to the safe box, same as any other camera move
  }

  function endClothResize() {
    if (!resizing) return;
    resizing = false;
    if (resizeCursorClass) document.body.classList.remove(resizeCursorClass);
    resizeCursorClass = '';
    applyPendingResize(); // land on exactly where the cursor let go, not wherever the last throttled tick was
  }

  // Shift-armed state drives two things in style.css now: corner
  // handles turning clickable, and edge handles swapping their cursor
  // from "move" to a resize cursor. It used to also gate the toolbar's
  // hidden state, but only in combination with hovering a resize
  // handle specifically -- that got widened to "hide any time Shift is
  // held at all" (see .cloth-frame.shift-armed .cloth-toolbar in
  // style.css), which plain shift-armed already covers on its own, so
  // there's no separate hover-tracked class needed for it anymore.
  let shiftHeld = false;

  function refreshShiftModeUI() {
    clothFrame.classList.toggle('shift-armed', shiftHeld);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !shiftHeld) { shiftHeld = true; refreshShiftModeUI(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') { shiftHeld = false; refreshShiftModeUI(); }
  });
  // Without this, alt-tabbing (or anything else that steals focus) away
  // while Shift happens to be down would leave shiftHeld stuck true
  // forever, since no keyup would ever fire back in this window.
  window.addEventListener('blur', () => {
    if (shiftHeld) { shiftHeld = false; refreshShiftModeUI(); }
  });

  dragHandles.forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      const sides = handle.dataset.resize ? handle.dataset.resize.split(' ') : null;
      if (e.shiftKey && sides) {
        beginClothResize(sides, e.clientX, e.clientY);
      } else if (handle.classList.contains('cloth-edge-handle')) {
        // Corner handles have no move behavior of their own -- they only
        // ever turn clickable in the first place while shift-armed (see
        // style.css), so this branch is unreachable for them in practice.
        beginClothDrag(e.clientX, e.clientY);
      }
      e.preventDefault();
    });

    // Touch has no Shift key to speak of, so touch stays move-only --
    // same as it was before resize existed.
    handle.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      if (!t || !handle.classList.contains('cloth-edge-handle')) return;
      beginClothDrag(t.clientX, t.clientY);
    }, { passive: true });
  });

  window.addEventListener('mousemove', (e) => {
    updateClothDrag(e.clientX, e.clientY);
    updateClothResize(e.clientX, e.clientY);
  });
  window.addEventListener('touchmove', (e) => {
    if (!clothDragging) return;
    const t = e.touches[0];
    if (!t) return;
    updateClothDrag(t.clientX, t.clientY);
    e.preventDefault(); // dragging the cloth shouldn't also scroll the page
  }, { passive: false });

  window.addEventListener('mouseup', () => { endClothDrag(); endClothResize(); });
  window.addEventListener('touchend', endClothDrag);
  window.addEventListener('touchcancel', endClothDrag);

