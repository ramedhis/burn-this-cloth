// === pixi-stage.js ===

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
  // no matter what aspect ratio was typed in.
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
  // just fills the whole visible page edge to edge. 
  const bgContainer = new PIXI.Container();
  const scorchContainer = new PIXI.Container();
  const bloomContainer = new PIXI.Container();
  const worldRoot = new PIXI.Container();
  const clothContainer = new PIXI.Container();
  const smokeContainerObj = new PIXI.Container();
  const glowContainerObj = new PIXI.Container();
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
  // a bordered frame. 
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
