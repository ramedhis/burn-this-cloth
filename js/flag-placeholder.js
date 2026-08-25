// === flag-placeholder.js ===
// Default placeholder when there's no image loaded: an abstract,
// Bauhaus-leaning graphic pattern -- structured (not chaotic), built
// from a small shape vocabulary (circle / rectangle / diamond) and a
// limited color count (2-4). Rolled fresh whenever
// regenerateFlagPlaceholder() is called (e.g. on page load, or a
// "shuffle" button).
// drawPlaceholderTexture() (the grey/X one in texture.js) is reserved
// for the Unload button specifically.

let flagSpec = null;

// Fixed color palette -- every generated pattern draws only from this set.
const PALETTE = [
  '#222323', '#f0f6f0', '#636663', '#87857c', '#bcad9f',
  '#f2b888', '#eb9661', '#b55945', '#734c44', '#3d3333',
  '#593e47', '#7a5859', '#a57855', '#de9f47', '#fdd179',
  '#fee1b8', '#d4c692', '#a6b04f', '#819447', '#44702d',
  '#2f4d2f', '#546756', '#89a477', '#a4c5af', '#cae6d9',
  '#f1f6f0', '#d5d6db', '#bbc3d0', '#96a9c1',
];

const SHAPES = ['circle', 'rect', 'diamond'];

const LAYOUTS = [
  'shape-grid', 'block-columns', 'quadrant-composition',
  'shape-row', 'shape-trio',
];

// Structured column/row proportions -- curated rather than fully random,
// so bars stay clean multiples of each other instead of arbitrary widths.
const SCHEMES = [
  [1, 1], [1, 2], [2, 1], [1, 1, 1], [2, 1, 1], [1, 2, 1], [1, 1, 1, 1], [3, 1],
];

// Ways to tile the canvas into 3 non-overlapping regions -- one shape
// gets centered in each, so shapes can never touch or overlap each
// other, only the region boundaries can.
const REGION_TEMPLATES = [
  [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
  [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
  [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }],
  [{ x: 0, y: 0, w: 1, h: 1 / 3 }, { x: 0, y: 1 / 3, w: 1, h: 1 / 3 }, { x: 0, y: 2 / 3, w: 1, h: 1 / 3 }],
];

function rand(n) {
  return Math.floor(Math.random() * n);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Distinct colors sampled fresh from PALETTE, no repeats within one spec.
function pickColors(n) {
  return shuffle([...PALETTE]).slice(0, n);
}

// 2-4 colors per pattern, weighted toward 2-3 so it reads as "designed"
// rather than a rainbow grab-bag.
function weightedColorCount() {
  const weights = [2, 2, 3, 3, 3, 4];
  return weights[rand(weights.length)];
}

function generateFlagSpec() {
  const layout = LAYOUTS[rand(LAYOUTS.length)];
  const colors = pickColors(weightedColorCount());
  const spec = { layout, colors };

  switch (layout) {
    case 'shape-grid':
      spec.cols = 4 + rand(4);
      spec.rows = 4 + rand(4);
      spec.shapeType = SHAPES[rand(SHAPES.length)];
      spec.fillProbability = 0.45 + Math.random() * 0.3;
      break;
    case 'block-columns':
      spec.direction = Math.random() < 0.5 ? 'horizontal' : 'vertical';
      spec.scheme = SCHEMES[rand(SCHEMES.length)];
      break;
    case 'quadrant-composition':
      spec.shape = SHAPES[rand(SHAPES.length)];
      break;
    case 'shape-row':
      spec.direction = Math.random() < 0.5 ? 'horizontal' : 'vertical';
      spec.count = 5 + rand(5);
      spec.lines = 1 + rand(2);
      spec.shapeType = SHAPES[rand(SHAPES.length)];
      break;
    case 'shape-trio':
      spec.template = rand(REGION_TEMPLATES.length);
      spec.shapeType = SHAPES[rand(SHAPES.length)];
      spec.mirror = Math.random() < 0.5;
      break;
  }

  return spec;
}

// ---- Shape Primitive ----
// size = half-height; aspect stretches half-width for rect/diamond so
// one function covers squares, rectangles, and rhombi.
function drawShape(ctx, type, cx, cy, size, color, aspect = 1) {
  ctx.fillStyle = color;
  const hw = size * aspect;
  const hh = size;
  switch (type) {
    case 'circle':
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'rect':
      ctx.fillRect(cx - hw, cy - hh, hw * 2, hh * 2);
      break;
    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(cx, cy - hh);
      ctx.lineTo(cx + hw, cy);
      ctx.lineTo(cx, cy + hh);
      ctx.lineTo(cx - hw, cy);
      ctx.closePath();
      ctx.fill();
      break;
  }
}

// ---- Layouts ----
function drawShapeGrid(ctx, rect, spec) {
  const { x, y, w, h } = rect;
  const { cols, rows, shapeType, fillProbability, colors } = spec;
  ctx.fillStyle = colors[0];
  ctx.fillRect(x, y, w, h);
  const cw = w / cols, ch = h / rows;
  const shapeColors = colors.length > 1 ? colors.slice(1) : colors;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.random() < fillProbability) {
        const cx = x + c * cw + cw / 2;
        const cy = y + r * ch + ch / 2;
        const size = Math.min(cw, ch) * 0.36;
        drawShape(ctx, shapeType, cx, cy, size, shapeColors[rand(shapeColors.length)]);
      }
    }
  }
}

function drawBlockColumns(ctx, rect, spec) {
  const { x, y, w, h } = rect;
  const { direction, scheme, colors } = spec;
  const total = scheme.reduce((a, b) => a + b, 0);
  let pos = direction === 'horizontal' ? x : y;
  for (let i = 0; i < scheme.length; i++) {
    const frac = scheme[i] / total;
    const size = (direction === 'horizontal' ? w : h) * frac;
    ctx.fillStyle = colors[i % colors.length];
    if (direction === 'horizontal') {
      ctx.fillRect(pos, y, size + 1, h);
    } else {
      ctx.fillRect(x, pos, w, size + 1);
    }
    pos += size;
  }
}

function drawQuadrantComposition(ctx, rect, spec) {
  const { x, y, w, h } = rect;
  const { colors, shape } = spec;
  const midX = x + w / 2;
  const midY = y + h / 2;
  const pad = 1; // 1px overlap so sub-pixel rounding never leaves a hairline seam

  // Base fill covers the whole rect (and doubles as the top-left quadrant);
  // the other three are drawn on top, each overlapping its shared edges.
  ctx.fillStyle = colors[0];
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = colors[1 % colors.length];
  ctx.fillRect(midX - pad, y, x + w - midX + pad, midY - y + pad);
  ctx.fillStyle = colors[2 % colors.length];
  ctx.fillRect(x, midY - pad, midX - x + pad, y + h - midY + pad);
  ctx.fillStyle = colors[3 % colors.length];
  ctx.fillRect(midX - pad, midY - pad, x + w - midX + pad, y + h - midY + pad);

  const cx = x + w / 2, cy = y + h / 2;
  const size = Math.min(w, h) * 0.28;
  drawShape(ctx, shape, cx, cy, size, colors[colors.length - 1]);
}

function drawShapeRow(ctx, rect, spec) {
  const { x, y, w, h } = rect;
  const { direction, count, shapeType, lines, colors } = spec;
  ctx.fillStyle = colors[0];
  ctx.fillRect(x, y, w, h);
  const shapeColors = colors.length > 1 ? colors.slice(1) : colors;
  for (let l = 0; l < lines; l++) {
    const lineFrac = (l + 1) / (lines + 1);
    for (let i = 0; i < count; i++) {
      const itemFrac = (i + 0.5) / count;
      const cx = direction === 'horizontal' ? x + w * itemFrac : x + w * lineFrac;
      const cy = direction === 'horizontal' ? y + h * lineFrac : y + h * itemFrac;
      const size = Math.min(w / count, h / (lines + 1)) * 0.32;
      drawShape(ctx, shapeType, cx, cy, size, shapeColors[i % shapeColors.length]);
    }
  }
}

// Tiles the canvas into 3 non-overlapping regions and centers one shape
// in each -- shapes can never touch since their regions don't either.
function drawShapeTrio(ctx, rect, spec) {
  const { x, y, w, h } = rect;
  const { colors, template, shapeType, mirror } = spec;
  ctx.fillStyle = colors[0];
  ctx.fillRect(x, y, w, h);

  const regions = REGION_TEMPLATES[template];
  regions.forEach((r, i) => {
    const rx = mirror ? 1 - r.x - r.w : r.x;
    const regionX = x + w * rx;
    const regionY = y + h * r.y;
    const regionW = w * r.w;
    const regionH = h * r.h;
    const cx = regionX + regionW / 2;
    const cy = regionY + regionH / 2;
    const size = Math.min(regionW, regionH) * 0.32; // margin inside its own region
    drawShape(ctx, shapeType, cx, cy, size, colors[(i + 1) % colors.length]);
  });
}

function drawFlagPattern(ctx, rect, spec) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip(); // keeps every layout below honest about the canvas's actual edges

  switch (spec.layout) {
    case 'shape-grid': drawShapeGrid(ctx, rect, spec); break;
    case 'block-columns': drawBlockColumns(ctx, rect, spec); break;
    case 'quadrant-composition': drawQuadrantComposition(ctx, rect, spec); break;
    case 'shape-row': drawShapeRow(ctx, rect, spec); break;
    case 'shape-trio': drawShapeTrio(ctx, rect, spec); break;
  }

  ctx.restore();
}

// Paints whatever the current flagSpec is (rolling a fresh one first if
// none exists yet) -- used by resetCloth() any time the canvas needs
// repainting but the pattern itself shouldn't change, e.g. a resize.
function drawFlagPlaceholder() {
  if (!flagSpec) flagSpec = generateFlagSpec();
  drawFlagPattern(texCtx, clothRect(), flagSpec);
}

// Rolls a brand new pattern and paints it -- call this on page load,
// and wire it up to your "shuffle / regenerate" button.
function regenerateFlagPlaceholder() {
  flagSpec = generateFlagSpec();
  drawFlagPattern(texCtx, clothRect(), flagSpec);
}
