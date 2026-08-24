// === pixi-stage.js ===
// Part of the burn-this-cloth engine. Loaded as a plain <script> (not a
// module) in index.html, in the same order these sections used to appear
// inside the single big IIFE in the old script.js. All the let/const/function
// declarations below live at the top level of the page's shared script scope
// (that's just how classic, non-module <script> tags work -- each one's
// top-level declarations join one common global scope), so a name declared in
// an earlier-loaded file is already available here, and a name declared here is
// available to any file loaded after it -- no window.* namespace object, no
// imports, nothing to wire up by hand.

  // PixiJS application, rendering into the existing <canvas id="c">.
  // resolution stays at 1 and autoDensity is left off on purpose --
  // the CSS rule (canvas { width:100%; height:100% }) is what scales
  // the drawing surface up to fill .stage, same as the old plain-2D
  // canvas did. Letting Pixi manage canvas.style itself (autoDensity)
  // would fight that rule.
  const app = new PIXI.Application({
    view: canvas,
    width: VIEW_W,
    height: VIEW_H,
    resolution: 1,
    antialias: true,
    backgroundAlpha: 0,
  });
  app.stop(); // We drive our own rAF loop below and render manually

  // Ask the GPU what it can actually handle, but don't go past 4K
  // regardless -- a hardcoded cap was clamping both W and H to the
  // same number before, so anything past it always came out square
  // no matter what aspect ratio was typed in. This still governs the
  // cloth's own WIDTH/HEIGHT (the texture and physics grid); the
  // window itself is whatever it is and isn't clamped against this.
  const MAX_CANVAS_DIM = (() => {
    try {
      return Math.min(app.renderer.gl.getParameter(app.renderer.gl.MAX_TEXTURE_SIZE), 4096);
    } catch (e) {
      return 4096; // WebGL1 baseline, safe fallback if the query fails
    }
  })();

  // Background layer sits behind everything else, sized to the full
  // window (see updateViewport) and drawn directly -- it does NOT sit
  // inside worldRoot, so it's untouched by the camera scale/offset and
  // just fills the whole visible page edge to edge. Everything cloth-
  // and fire-related lives inside worldRoot instead, which carries the
  // camera transform: physics, mouse mapping, fire spawns etc. all
  // keep working in the same 0..WIDTH/0..HEIGHT space they always
  // have, Pixi just draws that space scaled and offset into whatever
  // the actual browser window happens to be.
  const bgContainer = new PIXI.Container();
  // Two more layers between the backdrop and the cloth, both living in
  // plain screen space (not worldRoot) for the same reason bgContainer
  // does -- they're stuck to the page, not to the cloth's own camera.
  // scorchContainer holds the permanent soot stamped onto the backdrop
  // as things burn through; bloomContainer is the dynamic warm light
  // the fire throws onto that same backdrop while it's actively
  // burning. Order matters: soot first so the light can fall on top of
  // old marks the same way it'd fall across a clean backdrop.
  const scorchContainer = new PIXI.Container();
  const bloomContainer = new PIXI.Container();
  const worldRoot = new PIXI.Container();
  const clothContainer = new PIXI.Container();
  const smokeContainerObj = new PIXI.Container();
  const glowContainerObj = new PIXI.Container();
  // Sits inside worldRoot (unlike bloomContainer above, which is
  // screen-space) so it automatically rides the same camera transform
  // as the cloth -- coordinates go in as plain cloth-space x/y, no
  // origin/scale conversion needed. Same cluster data as the backdrop
  // bloom, just applied directly over nearby fabric instead of the
  // wall behind it.
  const clothBloomContainer = new PIXI.Container();
  const emberContainerObj = new PIXI.Container();
  const flameContainerObj = new PIXI.Container();
  worldRoot.addChild(clothContainer, smokeContainerObj, glowContainerObj, clothBloomContainer, emberContainerObj, flameContainerObj);
  app.stage.addChild(bgContainer, scorchContainer, bloomContainer, worldRoot);

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

  // Gap between the cloth and the canvas edge used to be a fixed 20px
  // on every side so the cloth read as a piece of fabric sitting inside
  // a bordered frame. There's no frame anymore -- the canvas border got
  // removed for good -- so that gap would just be a dead margin of bare
  // background around the image now instead of a cloth-inside-a-frame look.
  // Cloth runs flush with the canvas edge, i.e. whatever you type into
  // the width/height fields IS the cloth size. Set this back above 0
  // if a margin is ever wanted again.
  const CLOTH_GAP = 0;

  // The cloth's bottom edge runs a bit past the actual canvas, so it
  // reads as a longer piece of fabric that's just cut off by the
  // frame instead of a garment that conveniently ends exactly at
  // the edge
  const BOTTOM_BLEED_FRAC = 0;

  function clothBottomBleed() {
    return HEIGHT * BOTTOM_BLEED_FRAC;
  }
  function clothRect() {
    return {
      x: CLOTH_GAP, y: CLOTH_GAP,
      w: WIDTH - CLOTH_GAP * 2, h: HEIGHT - CLOTH_GAP * 2 + clothBottomBleed(),
    };
  }
