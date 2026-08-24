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

// === viewport.js ===
// Part of the burn-this-cloth engine. Loaded as a plain <script> (not a
// module) in index.html, in the same order these sections used to appear
// inside the single big IIFE in the old script.js. All the let/const/function
// declarations below live at the top level of the page's shared script scope
// (that's just how classic, non-module <script> tags work -- each one's
// top-level declarations join one common global scope), so a name declared in
// an earlier-loaded file is already available here, and a name declared here is
// available to any file loaded after it -- no window.* namespace object, no
// imports, nothing to wire up by hand.

  const canvas = document.getElementById('c');

  // WIDTH/HEIGHT is the cloth's *nominal* footprint -- exactly what's
  // typed into the size fields, and exactly what the physics grid and
  // source texture are built against. It has nothing to do with the
  // actual pixel size of the renderer anymore -- see VIEW_W/VIEW_H
  // below, which is the real canvas size, and is just "the browser
  // window."
  let WIDTH = 600;
  let HEIGHT = 600;

  // The renderer used to be sized at exactly WIDTH x HEIGHT (or, for a
  // while, WIDTH x HEIGHT plus a modest fixed bleed). Either way, the
  // instant a swaying or falling bit of cloth crossed that boundary it
  // just stopped being drawn -- no fade, no scroll-off, just a dead
  // straight line it vanished behind. That reads as an invisible wall.
  //
  // This version drops the idea of "the canvas" having its own size at
  // all. The canvas IS the browser window (full-bleed, edge to edge --
  // same idea as a print/broadcast layout that runs right off the page
  // with no border). The cloth is drawn as a scaled, centered region
  // inside that -- basically a camera looking at a fixed WIDTH x HEIGHT
  // "world," parked back far enough that the cloth reads at the size
  // you'd expect. What used to be the outer page-edge gap is now a
  // safe-area inset: the space between the cloth's own top/bottom/side
  // anchors and the true window edge, same as how broadcast TV keeps
  // titles inside a "title-safe" box while the picture behind them
  // still bleeds to the actual edge of the frame. Cloth can swing or
  // fall anywhere across the whole window before it hits a real edge,
  // which in practice is never.
  let VIEW_W = window.innerWidth;
  let VIEW_H = window.innerHeight;

  // How much of the window the cloth's fitted size is allowed to fill
  // -- the leftover is the safe-area gap around it. Same two numbers
  // fitStage used to size the old letterboxed stage box; kept as
  // fractions of the window rather than the cloth, so the gap reads as
  // "a fixed sliver of the page" regardless of what size cloth you pick.
  const SAFE_AREA_W_FRAC = 0.92;
  const SAFE_AREA_H_FRAC = 0.88;

  // clothScale: how many real screen pixels one WIDTH/HEIGHT-space
  // unit maps to. originX/originY: where the cloth's own (0,0) lands
  // in that full-window canvas. Recomputed by updateViewport() below
  // any time the cloth size or the window size changes.
  let clothScale = 1;
  let originX = 0, originY = 0;

  // How far the cloth has been dragged away from its natural centered
  // spot, in screen px (0,0 = centered, which is where everything
  // starts out). This is the one piece of camera state that survives
  // a resize or a re-fit -- a drag is a deliberate placement choice,
  // so it sticks around and just gets re-clamped against wherever the
  // safe box ends up, instead of snapping back to center every time.
  let dragOffsetX = 0, dragOffsetY = 0;

  // The rectangle dragOffsetX/Y gets clamped against -- same box the
  // SAFE_AREA fractions below already carve out of the window, just
  // kept here as its own left/top/right/bottom so the drag handler
  // can clamp against it directly instead of re-deriving the fit math
  // on every single mousemove. Filled in by applyCameraTransform().
  let safeBoxLeft = 0, safeBoxTop = 0, safeBoxRight = 0, safeBoxBottom = 0;

  // Screen-space box the cloth actually occupies right now (derived
  // from originX/originY/clothScale + WIDTH/HEIGHT above). Kept as its
  // own set of variables, refreshed by updateViewport(), so the hover
  // frame/toolbar overlay and its hit-test have a cheap answer to
  // "where's the cloth on screen right now" without recomputing the
  // camera math themselves.
  let clothRectLeft = 0, clothRectTop = 0, clothRectRight = 0, clothRectBottom = 0;

  // Fire visuals (flame/ember/smoke size, ignite radius) are all
  // tuned in absolute px against a 600x600 cloth. Everything
  // fire-related gets multiplied by this before use. Stays keyed off
  // the nominal cloth size, not the window, so fire scale doesn't
  // quietly shift just because someone resized their browser.
  function fireScale() {
    return Math.min(WIDTH, HEIGHT) / 600;
  }

  // Just the "where does the cloth sit, and how big" half of the
  // camera math -- everything updateViewport() does EXCEPT the parts
  // that are actually expensive (resizing the renderer, re-painting
  // the background/scorch canvases). Pulled out on its own so the
  // drag handler below can call it on every mousemove without dragging
  // all that other work along for the ride.
  //
  // dispW/dispH (the cloth's fitted on-screen size) only depend on
  // WIDTH/HEIGHT/VIEW_W/VIEW_H, none of which change mid-drag, so
  // recomputing them here each call is redundant but cheap -- far
  // cheaper than caching them and risking them going stale.
  function applyCameraTransform() {
    const maxW = VIEW_W * SAFE_AREA_W_FRAC;
    const maxH = VIEW_H * SAFE_AREA_H_FRAC;
    const ar = WIDTH / HEIGHT;
    let dispW = maxW, dispH = dispW / ar;
    if (dispH > maxH) { dispH = maxH; dispW = dispH * ar; }

    clothScale = dispW / WIDTH; // == dispH / HEIGHT, same ratio either axis

    // The safe box is the same maxW x maxH rectangle the fit above is
    // computed against, just centered in the window rather than sized
    // to it. It's deliberately NOT "wherever the cloth happens to be
    // centered" -- those two only match when dispW/dispH actually hit
    // maxW/maxH, which a non-square cloth in a differently-shaped
    // window usually won't. Anchoring drag to the fixed safe box
    // (rather than to the cloth's own centered rect) is what keeps the
    // draggable range the same invisible box people already see
    // implied by the layout, regardless of the cloth's aspect ratio.
    safeBoxLeft = (VIEW_W - maxW) / 2;
    safeBoxTop = (VIEW_H - maxH) / 2;
    safeBoxRight = safeBoxLeft + maxW;
    safeBoxBottom = safeBoxTop + maxH;

    const centeredX = (VIEW_W - dispW) / 2;
    const centeredY = (VIEW_H - dispH) / 2;

    // Desired position is "centered, plus however far it's been
    // dragged" -- then clamped so the cloth's own rect never pokes
    // outside the safe box. maxOriginX/Y can dip below minOriginX/Y if
    // the cloth is ever bigger than the safe box itself (shouldn't
    // happen given how dispW/dispH are fit above, but the Math.max
    // guards against a negative-width clamp range just in case).
    const minOriginX = safeBoxLeft;
    const maxOriginX = Math.max(minOriginX, safeBoxRight - dispW);
    const minOriginY = safeBoxTop;
    const maxOriginY = Math.max(minOriginY, safeBoxBottom - dispH);

    originX = Math.max(minOriginX, Math.min(maxOriginX, centeredX + dragOffsetX));
    originY = Math.max(minOriginY, Math.min(maxOriginY, centeredY + dragOffsetY));

    // Fold the clamp back into dragOffsetX/Y so it's the offset that's
    // authoritative going forward, not the origin -- next time the
    // window resizes (and centeredX/Y shift under it), the cloth
    // should still read as "dragged this far from center," not silently
    // re-derive a new offset from wherever the clamp last happened to
    // land it.
    dragOffsetX = originX - centeredX;
    dragOffsetY = originY - centeredY;

    clothRectLeft = originX;
    clothRectTop = originY;
    clothRectRight = originX + dispW;
    clothRectBottom = originY + dispH;
    positionClothFrame();

    worldRoot.scale.set(clothScale, clothScale);
    worldRoot.position.set(originX, originY);
  }

  // Recomputes everything that depends on "how big is the window" or
  // "how big is the cloth right now": the renderer's actual pixel
  // size, the camera scale/offset that places the cloth inside it, and
  // the background canvas that has to cover the whole thing. Called on
  // load, on window resize, and any time the cloth's own size changes.
  function updateViewport() {
    VIEW_W = window.innerWidth;
    VIEW_H = window.innerHeight;

    applyCameraTransform();

    app.renderer.resize(VIEW_W, VIEW_H);
    bgCanvas.width = VIEW_W;
    bgCanvas.height = VIEW_H;
    refreshBackgroundTexture();
    // Same tradeoff as the background canvas above: resizing wipes
    // whatever soot was stamped on it. Not ideal, but the window
    // getting resized mid-burn is a rare enough edge case that it's
    // not worth carrying pixel data across a full re-fit.
    resetScorchLayer();
  }
  window.addEventListener('resize', updateViewport);

  // Hover overlay: a thin rectangle that traces the cloth (with a
  // small gap so the line never reads as part of the cloth/image
  // itself), plus a small toolbar that sits on top of the rectangle's
  // top edge. The toolbar carries the tools that only make sense
  // "about this cloth" -- load/remove image, density, mesh -- so they
  // live right where you're already looking instead of a side panel.
  // Both are just CSS, driven by the numbers below; see positionClothFrame()
  // and the hover hit-test near the other pointer listeners further down.
  const clothFrame = document.getElementById('clothFrame');
  const FRAME_GAP = 16; // px between the cloth's real edge and the rectangle

  function positionClothFrame() {
    if (!clothFrame) return;
    clothFrame.style.left = (clothRectLeft - FRAME_GAP) + 'px';
    clothFrame.style.top = (clothRectTop - FRAME_GAP) + 'px';
    clothFrame.style.width = (clothRectRight - clothRectLeft + FRAME_GAP * 2) + 'px';
    clothFrame.style.height = (clothRectBottom - clothRectTop + FRAME_GAP * 2) + 'px';
  }
