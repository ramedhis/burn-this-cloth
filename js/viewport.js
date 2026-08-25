// === viewport.js ===

  const canvas = document.getElementById('c');

  // WIDTH/HEIGHT is the cloth's *nominal* footprint -- exactly what's
  // typed into the size fields, and exactly what the physics grid and
  // source texture are built against. 
  let WIDTH = 600;
  let HEIGHT = 600;

  // The canvas IS the browser window (full-bleed, edge to edge --
  // same idea as a print/broadcast layout that runs right off the page
  // with no border). 
  let VIEW_W = window.innerWidth;
  let VIEW_H = window.innerHeight;

  // How much of the window the cloth's fitted size is allowed to fill
  // -- the leftover is the safe-area gap around it.
  const SAFE_AREA_W_FRAC = 0.90; // Previous version: 0.92
  const SAFE_AREA_H_FRAC = 0.83; // Previous version: 0.88

  // clothScale: how many real screen pixels one WIDTH/HEIGHT-space
  // unit maps to. originX/originY: where the cloth's own (0,0) lands
  // in that full-window canvas.
  let clothScale = 1;
  let originX = 0, originY = 0;

  // How far the cloth has been dragged away from its natural centered
  // spot, in screen px (0,0 = centered, which is where everything
  // starts out).
  let dragOffsetX = 0, dragOffsetY = 0;

  let safeBoxLeft = 0, safeBoxTop = 0, safeBoxRight = 0, safeBoxBottom = 0;

  // Screen-space box the cloth actually occupies right now (derived
  // from originX/originY/clothScale + WIDTH/HEIGHT above).
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
  // the background/scorch canvases). 
  function applyCameraTransform() {
    const maxW = VIEW_W * SAFE_AREA_W_FRAC;
    const maxH = VIEW_H * SAFE_AREA_H_FRAC;
    const ar = WIDTH / HEIGHT;
    let dispW = maxW, dispH = dispW / ar;
    if (dispH > maxH) { dispH = maxH; dispW = dispH * ar; }

    clothScale = dispW / WIDTH; // == dispH / HEIGHT, same ratio either axis

    safeBoxLeft = (VIEW_W - maxW) / 2;
    safeBoxTop = (VIEW_H - maxH) / 2;
    safeBoxRight = safeBoxLeft + maxW;
    safeBoxBottom = safeBoxTop + maxH;

    const centeredX = (VIEW_W - dispW) / 2;
    const centeredY = (VIEW_H - dispH) / 2;

    // Desired position is "centered, plus however far it's been
    // dragged" -- then clamped so the cloth's own rect never pokes
    // outside the safe box.
    const minOriginX = safeBoxLeft;
    const maxOriginX = Math.max(minOriginX, safeBoxRight - dispW);
    const minOriginY = safeBoxTop;
    const maxOriginY = Math.max(minOriginY, safeBoxBottom - dispH);

    originX = Math.max(minOriginX, Math.min(maxOriginX, centeredX + dragOffsetX));
    originY = Math.max(minOriginY, Math.min(maxOriginY, centeredY + dragOffsetY));

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
    resetScorchLayer();
  }
  window.addEventListener('resize', updateViewport);

  // Hover overlay: a thin rectangle that traces the cloth (with a
  // small gap so the line never reads as part of the cloth/image
  // itself), plus a small toolbar that sits on top of the rectangle's
  // top edge. 
  const clothFrame = document.getElementById('clothFrame');
  const FRAME_GAP = 16; // px between the cloth's real edge and the rectangle

  function positionClothFrame() {
    if (!clothFrame) return;
    clothFrame.style.left = (clothRectLeft - FRAME_GAP) + 'px';
    clothFrame.style.top = (clothRectTop - FRAME_GAP) + 'px';
    clothFrame.style.width = (clothRectRight - clothRectLeft + FRAME_GAP * 2) + 'px';
    clothFrame.style.height = (clothRectBottom - clothRectTop + FRAME_GAP * 2) + 'px';
  }
