import {
  detectBackground, backgroundSeeds, floodRegion, findGaps, grabCut, matteEdges,
  regionAt, applyStrokes, shrinkEdge, unmixEdges,
} from './imaging.js';
import { encodePNG } from './png.js';
import { applyEffects } from './effects.js';
import { makeZip } from './zip.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d');
const marksCanvas = $('marks');
const mctx = marksCanvas.getContext('2d');
const hlCanvas = $('hl');
const hctx = hlCanvas.getContext('2d');
const wrap = $('canvasWrap');
const stage = $('stage');

const KEEP_COLOR = 'rgba(34,197,94,0.5)';
const REMOVE_COLOR = 'rgba(239,68,68,0.5)';
const TOOL_HINTS = {
  select: 'Hover to highlight an area. Click to remove it, Shift+click to keep it.',
  box: 'Drag a box around the subject. Everything outside goes, and the inside is worked out automatically.',
  keep: 'Paint over parts that must stay. It spreads to the nearest strong edge.',
  remove: 'Paint over background you want gone. It spreads to the nearest strong edge.',
};
const TOOL_KEYS = { s: 'select', b: 'box', k: 'keep', r: 'remove' };

const state = {
  file: null, name: 'image', w: 0, h: 0,
  src: null, srcImage: null, resultImage: null,
  bg: null, method: 'auto', base: null, baseKey: '',
  // {kind:'box', rect} | {kind:'wand', i, keep, tol, contiguous} | {kind:'stroke', type, r, pts}
  actions: [],
  tool: 'select', drawing: null, boxDrag: null, hover: null,
  zoomed: false, scale: null, showingOriginal: false, job: 0,
  previewImage: null, fxBg: 'none',
};

// ---------- Loading ----------
async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) { toastError('That file is not an image.'); return; }
  showBusy('Opening image…');
  $('drop').hidden = true;
  $('batch').hidden = true;
  $('work').hidden = false;
  try {
    const bmp = await createImageBitmap(file);
    const w = bmp.width, h = bmp.height;
    const c = new OffscreenCanvas(w, h);
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    bmp.close?.();
    state.srcImage = cx.getImageData(0, 0, w, h);
    Object.assign(state, {
      file, w, h, src: state.srcImage.data,
      name: (file.name || 'image').replace(/\.[^.]+$/, ''),
      actions: [], resultImage: null, previewImage: null, zoomed: false, scale: null, base: null, baseKey: '', hover: null,
    });
    state.bg = detectBackground(state.src, w, h);
    view.width = marksCanvas.width = hlCanvas.width = w;
    view.height = marksCanvas.height = hlCanvas.height = h;
    $('zoom').textContent = '100%';
    stage.classList.remove('zoomed');
    fit();
    drawMarks();
    clearHl();
    await run();
  } catch (err) {
    console.error(err);
    hideBusy();
    toastError('Could not open that image. Try a PNG, JPG or WebP.');
    reset();
  }
}

function reset() {
  state.job++;
  $('work').hidden = true;
  $('drop').hidden = false;
  $('file').value = '';
}

// ---------- Processing ----------
function lastBox() {
  for (let k = state.actions.length - 1; k >= 0; k--) if (state.actions[k].kind === 'box') return state.actions[k].rect;
  return null;
}

// Which method actually runs, and with which box.
function plan() {
  const box = lastBox();
  if (box) return { method: 'subject', box, hard: true };
  let method = state.method;
  if (method === 'auto') method = state.bg.uniformity >= 0.8 ? 'colour' : 'subject';
  if (method === 'subject') {
    const mx = Math.max(2, Math.round(state.w * 0.02)), my = Math.max(2, Math.round(state.h * 0.02));
    return { method, box: [mx, my, state.w - mx, state.h - my], hard: false };
  }
  return { method };
}

async function run() {
  if (!state.src) return;
  const job = ++state.job;
  $('download').disabled = true;
  const p = plan();
  showBusy(p.method === 'subject' && baseKey(p) !== state.baseKey ? 'Finding the subject…' : 'Cutting…');
  await nextFrame();
  if (job !== state.job) return;
  const t0 = performance.now();
  compose(p);
  const ms = Math.round(performance.now() - t0);
  hideBusy();
  refreshPreview();
  updatePanel(p);
  $('download').disabled = false;
  $('copy').disabled = false;
  $('info').textContent = `${state.w} × ${state.h}px · ${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'}`;
}

function strokesOf() { return state.actions.filter((a) => a.kind === 'stroke'); }

function baseKey(p) {
  // In Subject mode the brush strokes are part of the graph cut itself.
  const strokes = p.method === 'subject' ? strokesOf().length : 0;
  return [p.method, p.box, p.hard, $('tol').value, $('gaps').checked, strokes].join('|');
}

function strokeMarks() {
  const strokes = strokesOf();
  if (!strokes.length) return null;
  const marks = new Uint8Array(state.w * state.h);
  for (const s of strokes) rasterStroke(marks, state.w, state.h, s);
  return marks;
}

// The automatic cut. Cached, so touch-ups are quick.
function getBase(p) {
  const key = baseKey(p);
  if (state.base && state.baseKey === key) return state.base;
  const { src, w, h, bg } = state;
  const n = w * h;
  const tol = +$('tol').value;
  let isBg, ref = new Float32Array(n * 3), removedGaps = 0;
  if (p.method === 'colour') {
    isBg = new Uint8Array(n);
    floodRegion(src, w, h, backgroundSeeds(src, w, h, bg.color, tol), tol, isBg, ref);
    if ($('gaps').checked) {
      const info = findGaps(src, w, h, isBg);
      removedGaps = info.gaps.length;
      if (removedGaps) floodRegion(src, w, h, info.gaps.map((g) => g.seed), tol, isBg, ref);
    }
  } else {
    isBg = grabCut(src, w, h, { box: p.box, hard: p.hard, marks: strokeMarks() });
    for (let i = 0; i < n; i++) if (isBg[i]) { ref[i * 3] = src[i * 4]; ref[i * 3 + 1] = src[i * 4 + 1]; ref[i * 3 + 2] = src[i * 4 + 2]; }
  }
  state.base = { isBg, ref, removedGaps };
  state.baseKey = key;
  return state.base;
}

function compose(p) {
  const { src, w, h } = state;
  const n = w * h;
  const tol = +$('tol').value;
  const base = getBase(p);
  const isBg = base.isBg.slice();
  const ref = base.ref.slice();

  // Select-tool clicks, in order.
  for (const a of state.actions) {
    if (a.kind !== 'wand') continue;
    const r = regionAt(src, w, h, a.i, a.tol, a.contiguous);
    for (const i of r.idx) {
      if (a.keep) { isBg[i] = 0; continue; }
      if (!isBg[i]) { ref[i * 3] = src[i * 4]; ref[i * 3 + 1] = src[i * 4 + 1]; ref[i * 3 + 2] = src[i * 4 + 2]; }
      isBg[i] = 1;
    }
  }

  // Keep / Remove brush strokes (Colour mode; in Subject mode they are
  // already part of the graph cut).
  if (p.method === 'colour') {
    const marks = strokeMarks();
    if (marks) applyStrokes(src, w, h, isBg, ref, marks);
  }

  const trim = +$('shrink').value;
  if (trim) shrinkEdge(src, w, h, isBg, ref, trim);

  // Edges: exact un-mixing for art (Colour), soft matting for photos (Subject).
  // Everything away from the edge keeps its original pixels.
  const out = new Uint8ClampedArray(src);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = src[i * 4 + 3];
  if (p.method === 'subject') matteEdges(src, out, alpha, w, h, isBg, 2);
  else unmixEdges(src, out, alpha, w, h, isBg, ref, tol);
  for (let i = 0; i < n; i++) out[i * 4 + 3] = alpha[i];
  state.resultImage = new ImageData(out, w, h);

  $('gapNote').textContent = p.method === 'colour' && base.removedGaps
    ? `Removed ${base.removedGaps} enclosed gap${base.removedGaps > 1 ? 's' : ''}. Shift+click one with Select to bring it back.`
    : '';
}

// Stamp a brush stroke into the marks array (1 = keep, 2 = remove).
function rasterStroke(marks, w, h, s) {
  const v = s.type === 'keep' ? 1 : 2;
  const r = s.r, r2 = r * r;
  const stamp = (cx, cy) => {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) marks[y * w + x] = v;
    }
  };
  const pts = s.pts;
  stamp(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, r / 2)));
    for (let t = 1; t <= steps; t++) stamp(ax + ((bx - ax) * t) / steps, ay + ((by - ay) * t) / steps);
  }
}

// ---------- Display ----------
function render() {
  const img = state.showingOriginal ? state.srcImage : state.previewImage || state.resultImage;
  if (img) ctx.putImageData(img, 0, 0);
}

// ---------- Background & effects ----------
function hexRGB(hex) { return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)); }
function fxSettings(withCrop) {
  return {
    bg: state.fxBg,
    bgColor: hexRGB($('bgColor').value),
    outline: { width: +$('outline').value, color: hexRGB($('outlineColor').value) },
    crop: { on: withCrop && $('crop').checked, pad: +$('pad').value },
  };
}
function fxActive() { return state.fxBg !== 'none' || +$('outline').value > 0; }

// Preview shows effects at full size; cropping happens on export.
function refreshPreview() {
  state.previewImage = null;
  if (state.resultImage && fxActive()) {
    const r = applyEffects(state.resultImage.data, state.w, state.h, state.src, fxSettings(false));
    state.previewImage = new ImageData(r.data, r.w, r.h);
  }
  $('outlineVal').textContent = +$('outline').value ? $('outline').value + ' px' : 'off';
  $('padVal').textContent = $('pad').value + ' px';
  $('bgColorRow').hidden = state.fxBg !== 'color';
  render();
}

async function exportBlob() {
  const r = applyEffects(state.resultImage.data, state.w, state.h, state.src, fxSettings(true));
  return encodePNG(r.data, r.w, r.h);
}

function drawMarks() {
  mctx.clearRect(0, 0, marksCanvas.width, marksCanvas.height);
  const strokes = state.actions.filter((a) => a.kind === 'stroke');
  if (state.drawing) strokes.push(state.drawing);
  mctx.lineCap = 'round';
  mctx.lineJoin = 'round';
  for (const s of strokes) {
    mctx.strokeStyle = mctx.fillStyle = s.type === 'keep' ? KEEP_COLOR : REMOVE_COLOR;
    mctx.lineWidth = s.r * 2;
    if (s.pts.length === 1) {
      mctx.beginPath(); mctx.arc(s.pts[0][0], s.pts[0][1], s.r, 0, Math.PI * 2); mctx.fill();
      continue;
    }
    mctx.beginPath();
    mctx.moveTo(s.pts[0][0], s.pts[0][1]);
    for (const [x, y] of s.pts.slice(1)) mctx.lineTo(x, y);
    mctx.stroke();
  }
  // The active box, as a dashed outline.
  const box = lastBox();
  if (box && !state.boxDrag) drawBoxOutline(mctx, box, false);
}

function drawBoxOutline(c, [x0, y0, x1, y1], dim) {
  const scale = state.w / wrap.getBoundingClientRect().width;
  if (dim) {
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(0, 0, state.w, state.h);
    c.clearRect(x0, y0, x1 - x0, y1 - y0);
  }
  c.save();
  c.setLineDash([8 * scale, 6 * scale]);
  c.lineWidth = 2 * scale;
  c.strokeStyle = '#fff';
  c.strokeRect(x0, y0, x1 - x0, y1 - y0);
  c.lineDashOffset = 8 * scale;
  c.strokeStyle = '#5b5bd6';
  c.strokeRect(x0, y0, x1 - x0, y1 - y0);
  c.restore();
}

// Highlight layer: hovered Select area, or the box being dragged.
let hlRect = null;
function clearHl() {
  if (hlRect) hctx.clearRect(...hlRect); else hctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
  hlRect = null;
}
function drawHover(i, keep) {
  clearHl();
  const r = regionAt(state.src, state.w, state.h, i, +$('tol').value, $('contiguous').checked);
  const bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
  const img = hctx.createImageData(bw, bh);
  const d = img.data;
  const [cr, cg, cb] = keep ? [34, 197, 94] : [59, 130, 246];
  for (const j of r.idx) {
    const x = j % state.w, y = (j - x) / state.w;
    const o = ((y - r.y0) * bw + (x - r.x0)) * 4;
    d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = 120;
  }
  hctx.putImageData(img, r.x0, r.y0);
  hlRect = [r.x0, r.y0, bw, bh];
}

function fit() {
  if (!state.w) return;
  let cw, ch;
  if (state.scale) {
    cw = state.w * state.scale; ch = state.h * state.scale;
  } else if (state.zoomed) {
    const dpr = window.devicePixelRatio || 1;
    cw = state.w / dpr; ch = state.h / dpr;
  } else {
    const pad = 24;
    const s = Math.min((stage.clientWidth - pad) / state.w, (stage.clientHeight - pad) / state.h, 2);
    cw = Math.max(1, Math.floor(state.w * s)); ch = Math.max(1, Math.floor(state.h * s));
  }
  wrap.style.width = cw + 'px';
  wrap.style.height = ch + 'px';
}

function updatePanel(p = plan()) {
  for (const b of $('method').children) b.setAttribute('aria-checked', String(b.dataset.method === state.method));
  const [r, g, b] = state.bg.color;
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  $('swatch').style.background = hex;
  $('swatchHex').textContent = hex;
  $('colourOpts').hidden = p.method !== 'colour';
  let note;
  if (lastBox()) note = 'Using your box. Undo to remove it.';
  else if (state.method === 'auto') {
    note = p.method === 'colour'
      ? 'Solid background, so it is removed by colour. Exact and instant.'
      : 'Busy background, so the subject was found automatically. Not quite right? Drag a box around it with the Box tool.';
  } else note = p.method === 'colour'
    ? 'Removes the background colour from the edges inward, following gradients.'
    : 'Finds the subject from its colours and outline. Use the Box tool to show it where the subject is.';
  $('methodNote').textContent = note;
  $('tolVal').textContent = $('tol').value;
  $('brushVal').textContent = $('brush').value;
  $('shrinkVal').textContent = $('shrink').value === '0' ? 'off' : $('shrink').value + ' px';
  $('undo').disabled = !state.actions.length;
  $('reset').disabled = !state.actions.length;
  for (const btn of $('tools').children) btn.setAttribute('aria-checked', String(btn.dataset.tool === state.tool));
  $('toolHint').textContent = TOOL_HINTS[state.tool] + ` (${Object.keys(TOOL_KEYS).find((k) => TOOL_KEYS[k] === state.tool).toUpperCase()})`;
  $('brushRow').hidden = state.tool !== 'keep' && state.tool !== 'remove';
  $('contigRow').hidden = state.tool !== 'select';
}

function setTool(t) {
  state.tool = t;
  clearHl();
  updatePanel();
}

function showBusy(text) { $('busyText').textContent = text; $('busy').hidden = false; }
function hideBusy() { $('busy').hidden = true; }

// Let the "Working…" overlay paint before heavy work. Falls back to a timer,
// because hidden tabs never fire animation frames.
function nextFrame() {
  return new Promise((r) => {
    let done = false;
    const go = () => { if (!done) { done = true; setTimeout(r, 0); } };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });
}

function toastError(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'alert');
    document.body.append(t);
  }
  t.textContent = msg;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.remove(), 5000);
}

// ---------- Events: loading ----------
$('pick').addEventListener('click', (e) => { e.stopPropagation(); $('file').click(); });
$('drop').addEventListener('click', () => $('file').click());
$('drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', (e) => loadFiles(e.target.files));

window.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  loadFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

// ---------- Events: settings ----------
$('method').addEventListener('click', (e) => {
  const m = e.target.closest('button')?.dataset.method;
  if (!m || m === state.method) return;
  state.method = m;
  run();
});
$('gaps').addEventListener('change', run);
$('contiguous').addEventListener('change', () => clearHl());
let tolTimer;
$('tol').addEventListener('input', () => {
  $('tolVal').textContent = $('tol').value;
  clearTimeout(tolTimer);
  tolTimer = setTimeout(run, 80);
});
$('shrink').addEventListener('input', () => { updatePanel(); run(); });
$('brush').addEventListener('input', () => { $('brushVal').textContent = $('brush').value; });
$('tools').addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.tool;
  if (t) setTool(t);
});

// ---------- Events: working on the image ----------
function toImage(e) {
  const r = wrap.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * state.w, ((e.clientY - r.top) / r.height) * state.h];
}
const ready = () => state.resultImage && $('busy').hidden;

wrap.addEventListener('pointerdown', (e) => {
  if (!ready() || e.button !== 0) return;
  const [fx, fy] = toImage(e);
  const x = Math.floor(fx), y = Math.floor(fy);
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;

  if (state.tool === 'select') {
    clearHl();
    state.actions.push({ kind: 'wand', i: y * state.w + x, keep: e.shiftKey, tol: +$('tol').value, contiguous: $('contiguous').checked });
    run();
    return;
  }
  wrap.setPointerCapture(e.pointerId);
  if (state.tool === 'box') {
    state.boxDrag = [fx, fy, fx, fy];
    return;
  }
  const scale = state.w / wrap.getBoundingClientRect().width;
  const r = Math.max(1, (+$('brush').value / 2) * scale);
  state.drawing = { kind: 'stroke', type: state.tool, r, pts: [[fx, fy]] };
  drawMarks();
});

let hoverFrame = 0;
wrap.addEventListener('pointermove', (e) => {
  if (state.drawing) {
    state.drawing.pts.push(toImage(e));
    drawMarks();
    return;
  }
  if (state.boxDrag) {
    const [fx, fy] = toImage(e);
    state.boxDrag[2] = fx; state.boxDrag[3] = fy;
    clearHl();
    drawBoxOutline(hctx, normBox(state.boxDrag), true);
    return;
  }
  if (state.tool !== 'select' || !ready()) return;
  const [fx, fy] = toImage(e);
  const x = Math.floor(fx), y = Math.floor(fy);
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;
  hoverNext = [y * state.w + x, e.shiftKey];
  if (!hoverFrame) {
    // One redraw per frame at most (timer fallback for background tabs).
    const go = () => {
      if (!hoverFrame) return;
      cancelAnimationFrame(hoverFrame.raf); clearTimeout(hoverFrame.t);
      hoverFrame = 0;
      if (hoverNext && state.tool === 'select' && ready()) drawHover(...hoverNext);
    };
    hoverFrame = { raf: requestAnimationFrame(go), t: setTimeout(go, 32) };
  }
});
let hoverNext = null;
wrap.addEventListener('pointerleave', () => {
  if (state.tool !== 'select') return;
  hoverNext = null;
  clearHl();
});

function normBox([ax, ay, bx, by]) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx))), y0 = Math.max(0, Math.floor(Math.min(ay, by)));
  const x1 = Math.min(state.w, Math.ceil(Math.max(ax, bx))), y1 = Math.min(state.h, Math.ceil(Math.max(ay, by)));
  return [x0, y0, x1, y1];
}

const endPointer = () => {
  if (state.boxDrag) {
    const box = normBox(state.boxDrag);
    state.boxDrag = null;
    clearHl();
    if (box[2] - box[0] > 8 && box[3] - box[1] > 8) {
      state.actions.push({ kind: 'box', rect: box });
      drawMarks();
      run();
    }
    return;
  }
  if (!state.drawing) return;
  state.actions.push(state.drawing);
  state.drawing = null;
  drawMarks();
  run();
};
wrap.addEventListener('pointerup', endPointer);
wrap.addEventListener('pointercancel', endPointer);

$('undo').addEventListener('click', () => { state.actions.pop(); drawMarks(); clearHl(); run(); });
$('reset').addEventListener('click', () => { state.actions = []; drawMarks(); clearHl(); run(); });

// ---------- Events: view & keyboard ----------
const setOriginal = (on) => {
  if (state.showingOriginal === on) return;
  state.showingOriginal = on;
  wrap.classList.toggle('hide-marks', on);
  render();
};
$('compare').addEventListener('pointerdown', () => setOriginal(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('compare').addEventListener(ev, () => setOriginal(false));
window.addEventListener('keydown', (e) => {
  if ($('work').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); setOriginal(true); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    if (state.actions.length) { e.preventDefault(); $('undo').click(); }
    return;
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) setTool(TOOL_KEYS[e.key.toLowerCase()]);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') setOriginal(false); });

$('zoom').addEventListener('click', () => {
  state.zoomed = state.scale ? false : !state.zoomed;
  state.scale = null;
  stage.classList.toggle('zoomed', state.zoomed);
  $('zoom').textContent = state.zoomed ? 'Fit' : '100%';
  fit();
});
new ResizeObserver(fit).observe(stage);

$('bgPick').addEventListener('click', (e) => {
  const bg = e.target.closest('button')?.dataset.bg;
  if (!bg) return;
  for (const b of $('bgPick').children) b.setAttribute('aria-checked', String(b.dataset.bg === bg));
  stage.className = stage.className.replace(/bg-\w+/, 'bg-' + bg);
});

$('download').addEventListener('click', async () => {
  const btn = $('download');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const blob = await exportBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.name}-no-bg.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err) {
    console.error(err);
    toastError('Saving failed. Your browser may be out of memory for an image this big.');
  } finally {
    btn.textContent = 'Download PNG';
    btn.disabled = false;
  }
});
$('another').addEventListener('click', reset);

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
    $('copy').textContent = 'Copied!';
  } catch (err) {
    console.error(err);
    toastError('Your browser blocked copying. Use Download instead.');
  }
  setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
});

// Effects controls
$('fxBg').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.fxbg;
  if (!v) return;
  state.fxBg = v;
  for (const b of $('fxBg').children) b.setAttribute('aria-checked', String(b.dataset.fxbg === v));
  refreshPreview();
});
let fxTimer;
for (const id of ['bgColor', 'outline', 'outlineColor', 'crop', 'pad']) {
  $(id).addEventListener('input', () => { clearTimeout(fxTimer); fxTimer = setTimeout(refreshPreview, 60); });
}

// Mouse-wheel zoom around the cursor.
stage.addEventListener('wheel', (e) => {
  if (!state.w || $('work').hidden) return;
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const cur = r.width / state.w;
  const next = Math.min(16, Math.max(0.05, cur * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
  state.scale = next;
  stage.classList.add('zoomed');
  fit();
  const r2 = wrap.getBoundingClientRect();
  stage.scrollLeft += r2.left + fx * r2.width - e.clientX;
  stage.scrollTop += r2.top + fy * r2.height - e.clientY;
  $('zoom').textContent = Math.round(next * (window.devicePixelRatio || 1) * 100) + '% · Fit';
}, { passive: false });

// ---------- Batch ----------
function loadFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (imgs.length > 1) runBatch(imgs);
  else if (imgs.length) loadFile(imgs[0]);
}

// Automatic cut for batch: same methods as Auto, no touch-ups.
function autoCut(src, w, h) {
  const n = w * h, tol = 36;
  const bg = detectBackground(src, w, h);
  const out = new Uint8ClampedArray(src), alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = src[i * 4 + 3];
  if (bg.uniformity >= 0.8) {
    const isBg = new Uint8Array(n), ref = new Float32Array(n * 3);
    floodRegion(src, w, h, backgroundSeeds(src, w, h, bg.color, tol), tol, isBg, ref);
    const info = findGaps(src, w, h, isBg);
    if (info.gaps.length) floodRegion(src, w, h, info.gaps.map((g) => g.seed), tol, isBg, ref);
    unmixEdges(src, out, alpha, w, h, isBg, ref, tol);
  } else {
    const mx = Math.max(2, Math.round(w * 0.02)), my = Math.max(2, Math.round(h * 0.02));
    const isBg = grabCut(src, w, h, { box: [mx, my, w - mx, h - my], hard: false });
    matteEdges(src, out, alpha, w, h, isBg, 2);
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = alpha[i];
  return out;
}

let batchItems = [];
async function runBatch(files) {
  state.job++;
  for (const it of batchItems) URL.revokeObjectURL(it.url);
  batchItems = [];
  $('drop').hidden = true; $('work').hidden = true; $('batch').hidden = false;
  $('zipBtn').disabled = true;
  const grid = $('batchGrid');
  grid.textContent = '';
  const fx = fxSettings(true);
  for (let k = 0; k < files.length; k++) {
    const file = files[k];
    $('batchInfo').textContent = `Cutting ${k + 1} of ${files.length}…`;
    const el = document.createElement('div');
    el.className = 'batch-item';
    el.innerHTML = '<img alt=""><span></span>';
    el.querySelector('span').textContent = file.name;
    el.addEventListener('click', () => { $('batch').hidden = true; loadFile(file); });
    grid.append(el);
    await nextFrame();
    try {
      const bmp = await createImageBitmap(file);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0);
      const src = cx.getImageData(0, 0, bmp.width, bmp.height).data;
      const cut = autoCut(src, bmp.width, bmp.height);
      const r = applyEffects(cut, bmp.width, bmp.height, src, fx);
      const blob = await encodePNG(r.data, r.w, r.h);
      const url = URL.createObjectURL(blob);
      el.querySelector('img').src = url;
      batchItems.push({ name: file.name.replace(/\.[^.]+$/, '') + '-no-bg.png', blob, url });
    } catch (err) {
      console.error(err);
      el.querySelector('span').textContent = file.name + ' (failed)';
    }
  }
  $('batchInfo').textContent = `${batchItems.length} of ${files.length} done`;
  $('zipBtn').disabled = !batchItems.length;
}
$('zipBtn').addEventListener('click', async () => {
  // Make names unique inside the ZIP.
  const seen = new Map();
  const files = batchItems.map((it) => {
    const c = seen.get(it.name) || 0; seen.set(it.name, c + 1);
    return { name: c ? it.name.replace(/\.png$/, `-${c}.png`) : it.name, blob: it.blob };
  });
  const zip = await makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = 'no-bg-images.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});
$('batchClose').addEventListener('click', () => { $('batch').hidden = true; $('drop').hidden = false; });
