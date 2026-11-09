// === texture.js ===

  // texCanvas stays a plain 2D canvas -- it's just where we composite
  // the source image (or placeholder gradient) before handing the
  // pixels to Pixi as a texture. All the actual cloth deformation and
  // rendering downstream is GPU-side.
  const texCanvas = document.createElement('canvas');
  texCanvas.width = WIDTH;
  texCanvas.height = HEIGHT;
  const texCtx = texCanvas.getContext('2d');

  let sourceImage = null;
  let clothTexture = null;

  // Separate canvas + texture for the background layer. Default is
  // plain black -- same as the canvas has always looked -- so loading
  // nothing here changes nothing about the current look. Sized to
  // VIEW_W/VIEW_H (the actual browser window) since this layer sits
  // outside worldRoot's camera transform and has to cover the whole
  // visible page itself, independent of whatever size cloth is set.
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = VIEW_W;
  bgCanvas.height = VIEW_H;
  const bgCtx = bgCanvas.getContext('2d');

  let bgTexture = null;
  let bgSprite = null;

  function drawBackgroundCanvas() {
    bgCtx.fillStyle = '#000000';
    bgCtx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  function refreshBackgroundTexture() {
    drawBackgroundCanvas();
    if (bgTexture) bgTexture.destroy(true);
    bgTexture = PIXI.Texture.from(bgCanvas);
    bgTexture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    if (bgSprite) bgContainer.removeChild(bgSprite);
    bgSprite = new PIXI.Sprite(bgTexture);
    bgContainer.addChild(bgSprite);
  }

  // Persistent scorch layer. This is a plain 2D canvas sitting in
  // screen space (same footprint as bgCanvas) that gets soot stamped
  // onto it once, permanently, the moment a patch of cloth actually
  // burns through. It's cheap because stamping only happens on that
  // one transition, never per-frame.
  const scorchCanvas = document.createElement('canvas');
  scorchCanvas.width = VIEW_W;
  scorchCanvas.height = VIEW_H;
  const scorchCtx = scorchCanvas.getContext('2d');
  let scorchTexture = null;
  let scorchSprite = null;

  function resetScorchLayer() {
    scorchCanvas.width = VIEW_W;
    scorchCanvas.height = VIEW_H;
    scorchCtx.clearRect(0, 0, VIEW_W, VIEW_H);
    if (scorchTexture) scorchTexture.destroy(true);
    scorchTexture = PIXI.Texture.from(scorchCanvas);
    scorchTexture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    if (scorchSprite) scorchContainer.removeChild(scorchSprite);
    scorchSprite = new PIXI.Sprite(scorchTexture);
    scorchContainer.addChild(scorchSprite);
  }

  // Stamps one soot smudge, given in cloth-space coordinates (same
  // space particles live in) -- converted here into the scorch
  // canvas's screen space using the same clothScale/originX/originY
  // camera math everything else uses to cross that boundary. Multiply
  // blend on purpose: a second stamp landing on an already-sooty spot
  // should darken it further, not just stack more opacity on top,
  // which is closer to what real charring does.
  function stampScorch(cx, cy, radius, strength) {
    const sx = originX + cx * clothScale;
    const sy = originY + cy * clothScale;
    const r = Math.max(1, radius * clothScale);
    const g = scorchCtx.createRadialGradient(sx, sy, 0, sx, sy, r);
    g.addColorStop(0, `rgba(12,9,7,${strength})`);
    g.addColorStop(0.55, `rgba(12,9,7,${strength * 0.5})`);
    g.addColorStop(1, 'rgba(12,9,7,0)');
    scorchCtx.globalCompositeOperation = 'multiply';
    scorchCtx.fillStyle = g;
    scorchCtx.beginPath();
    scorchCtx.arc(sx, sy, r, 0, Math.PI * 2);
    scorchCtx.fill();
    scorchCtx.globalCompositeOperation = 'source-over';
    scorchTexture.update();
  }

  function drawPlaceholderTexture() {
    const rect = clothRect();
    const g = texCtx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    g.addColorStop(0, '#2e2e2c');
    g.addColorStop(0.5, '#232321');
    g.addColorStop(1, '#161615');
    texCtx.fillStyle = g;
    texCtx.fillRect(rect.x, rect.y, rect.w, rect.h);

    texCtx.strokeStyle = 'rgba(200,200,196,0.25)';
    texCtx.lineWidth = 3;
    texCtx.lineCap = 'round';
    texCtx.beginPath();
    texCtx.moveTo(rect.x, rect.y);
    texCtx.lineTo(rect.x + rect.w, rect.y + rect.h);
    texCtx.moveTo(rect.x + rect.w, rect.y);
    texCtx.lineTo(rect.x, rect.y + rect.h);
    texCtx.stroke();
  }

  function loadImageCover(img) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const rect = clothRect();
    const scale = Math.max(rect.w / iw, rect.h / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = rect.x + (rect.w - dw) / 2, dy = rect.y + (rect.h - dh) / 2;
    texCtx.clearRect(0, 0, WIDTH, HEIGHT);
    texCtx.fillStyle = '#1a1a18';
    texCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
    texCtx.drawImage(img, dx, dy, dw, dh);
  }

  // Recreates the GPU texture from whatever's currently painted on
  // texCanvas. Destroy-and-recreate rather than update() in place --
  // this only ever runs on user actions (load image, reset, resize),
  // never per-frame, so the extra GPU upload cost is a non-issue and
  // it sidesteps any ambiguity about stale dimensions after a resize.
  function refreshClothTexture() {
    if (clothTexture) clothTexture.destroy(true);
    clothTexture = PIXI.Texture.from(texCanvas);
    clothTexture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  }

  // Swaps the texture the mesh is actually painting without touching
  // the cloth grid, burn state, or fire particles -- used by "remove
  // image", which is only supposed to clear the picture, not act like
  // a second reset button.
  function refreshImageOnly() {
    refreshClothTexture();
    if (mesh && mesh.shader) mesh.shader.uniforms.uSampler = clothTexture;
  }
