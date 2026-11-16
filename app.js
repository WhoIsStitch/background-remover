import { detectBackground, backgroundSeeds, floodRegion, findGaps, applyStrokes, unmixEdges } from './imaging.js';
import { encodePNG } from './png.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d');
const marksCanvas = $('marks');
const mctx = marksCanvas.getContext('2d');
const wrap = $('canvasWrap');
const stage = $('stage');

const KEEP_COLOR = 'rgba(34,197,94,0.5)';
const REMOVE_COLOR = 'rgba(239,68,68,0.5)';
const TOOL_HINTS = {
  click: 'Click leftover background to remove it. Click a removed gap to bring it back.',
  keep: 'Paint over parts that must stay. For busy scenes (photos, game screenshots) paint a rough Keep stroke on the subject and a few Remove strokes on the background.',
  remove: 'Paint over background you want gone. It spreads up to the nearest strong edge.',
};

const state = {
  file: null, name: 'image', w: 0, h: 0,
  src: null, srcImage: null, resultImage: null,
  bg: null, gapInfo: null,
  actions: [],          // {kind:'click', i} | {kind:'keepGap', i} | {kind:'stroke', type, r, pts}
  tool: 'click', drawing: null,
  zoomed: false, showingOriginal: false, job: 0,
};

// ---------- Loading ----------
async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) { toastError('That file is not an image.'); return; }
  showBusy('Opening image…');
  $('drop').hidden = true;
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
      actions: [], resultImage: null, zoomed: false,
    });
    state.bg = detectBackground(state.src, w, h);
    view.width = marksCanvas.width = w;
    view.height = marksCanvas.height = h;
    $('zoom').textContent = '100%';
    stage.classList.remove('zoomed');
    fit();
    drawMarks();
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
async function run() {
  if (!state.src) return;
  const job = ++state.job;
  $('download').disabled = true;
  showBusy('Cutting…');
  await nextFrame();
  if (job !== state.job) return;
  const t0 = performance.now();
  compose();
  const ms = Math.round(performance.now() - t0);
  hideBusy();
  render();
  updatePanel();
  $('download').disabled = false;
  $('info').textContent = `${state.w} × ${state.h}px · ${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'}`;
}

function compose() {
  const { src, w, h, bg } = state;
  const n = w * h;
  const tol = +$('tol').value;
  const isBg = new Uint8Array(n);
  const ref = new Float32Array(n * 3);

  // 1. Background connected to the edges of the image, tracked inwards.
  floodRegion(src, w, h, backgroundSeeds(src, w, h, bg.color, tol), tol, isBg, ref);

  // 2. Enclosed gaps + clicked spots.
  const seeds = [];
  state.gapInfo = null;
  let removedGaps = 0;
  if ($('gaps').checked) {
    const info = findGaps(src, w, h, isBg);
    const kept = new Set(state.actions.filter((a) => a.kind === 'keepGap').map((a) => info.label[a.i]));
    info.removed = new Set();
    for (const g of info.gaps) {
      if (kept.has(g.id)) continue;
      seeds.push(g.seed);
      info.removed.add(g.id);
    }
    removedGaps = info.removed.size;
    state.gapInfo = info;
  }
  for (const a of state.actions) if (a.kind === 'click') seeds.push(a.i);
  if (seeds.length) floodRegion(src, w, h, seeds, tol, isBg, ref);

  // 3. Keep / Remove brush strokes.
  const strokes = state.actions.filter((a) => a.kind === 'stroke');
  if (strokes.length) {
    const marks = new Uint8Array(n);
    for (const s of strokes) rasterStroke(marks, w, h, s);
    applyStrokes(src, w, h, isBg, ref, marks);
  }

  // 4. Soft, halo-free edges; everything else keeps its original pixels.
  const out = new Uint8ClampedArray(src);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = src[i * 4 + 3];
  unmixEdges(src, out, alpha, w, h, isBg, ref, tol);
  for (let i = 0; i < n; i++) out[i * 4 + 3] = alpha[i];
  state.resultImage = new ImageData(out, w, h);

  $('gapNote').textContent = removedGaps
    ? `Removed ${removedGaps} enclosed gap${removedGaps > 1 ? 's' : ''}. Click one to bring it back.`
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
  const img = state.showingOriginal ? state.srcImage : state.resultImage;
  if (img) ctx.putImageData(img, 0, 0);
}

function drawMarks() {
  mctx.clearRect(0, 0, marksCanvas.width, marksCanvas.height);
  const strokes = state.actions.filter((a) => a.kind === 'stroke');
  if (state.drawing) strokes.push(state.drawing);
  mctx.lineCap = 'round';
  mctx.lineJoin = 'round';
  for (const s of strokes) {
    mctx.strokeStyle = s.type === 'keep' ? KEEP_COLOR : REMOVE_COLOR;
    mctx.fillStyle = mctx.strokeStyle;
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
}

function fit() {
  if (!state.w) return;
  let cw, ch;
  if (state.zoomed) {
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

function updatePanel() {
  const [r, g, b] = state.bg.color;
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  $('swatch').style.background = hex;
  $('swatchHex').textContent = hex;
  $('bgNote').textContent = state.bg.uniformity >= 0.8
    ? 'Solid background: the cut follows it exactly.'
    : 'The background changes colour: the cut tracks it as it goes. For busy scenes, use the Keep and Remove brushes below.';
  $('tolVal').textContent = $('tol').value;
  $('brushVal').textContent = $('brush').value;
  $('undo').disabled = !state.actions.length;
  $('reset').disabled = !state.actions.length;
  for (const b of $('tools').children) b.setAttribute('aria-checked', String(b.dataset.tool === state.tool));
  $('toolHint').textContent = TOOL_HINTS[state.tool];
  $('brushRow').hidden = state.tool === 'click';
}

function showBusy(text) { $('busyText').textContent = text; $('busy').hidden = false; }
function hideBusy() { $('busy').hidden = true; }

// Let the "Cutting…" overlay paint before heavy work. Falls back to a timer,
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
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));

window.addEventListener('dragover', (e) => { e.preventDefault(); $('drop').classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (f) loadFile(f);
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

// ---------- Events: settings ----------
$('gaps').addEventListener('change', run);
let tolTimer;
$('tol').addEventListener('input', () => {
  $('tolVal').textContent = $('tol').value;
  clearTimeout(tolTimer);
  tolTimer = setTimeout(run, 60);
});
$('brush').addEventListener('input', () => { $('brushVal').textContent = $('brush').value; });
$('tools').addEventListener('click', (e) => {
  const t = e.target.closest('button')?.dataset.tool;
  if (!t) return;
  state.tool = t;
  updatePanel();
});

// ---------- Events: drawing on the image ----------
function toImage(e) {
  const r = wrap.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * state.w, ((e.clientY - r.top) / r.height) * state.h];
}

wrap.addEventListener('pointerdown', (e) => {
  if (!state.resultImage || !$('busy').hidden || e.button !== 0) return;
  const [fx, fy] = toImage(e);
  const x = Math.floor(fx), y = Math.floor(fy);
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;

  if (state.tool === 'click') {
    const i = y * state.w + x;
    if (state.resultImage.data[i * 4 + 3] === 0) {
      const g = state.gapInfo;
      if (!g || !g.removed.has(g.label[i])) return;
      state.actions.push({ kind: 'keepGap', i });
    } else {
      state.actions.push({ kind: 'click', i });
    }
    run();
    return;
  }

  // Brush: radius in image pixels, from the on-screen brush size.
  const scale = state.w / wrap.getBoundingClientRect().width;
  const r = Math.max(1, (+$('brush').value / 2) * scale);
  state.drawing = { kind: 'stroke', type: state.tool, r, pts: [[fx, fy]] };
  wrap.setPointerCapture(e.pointerId);
  drawMarks();
});
wrap.addEventListener('pointermove', (e) => {
  if (!state.drawing) return;
  state.drawing.pts.push(toImage(e));
  drawMarks();
});
const endStroke = () => {
  if (!state.drawing) return;
  state.actions.push(state.drawing);
  state.drawing = null;
  drawMarks();
  run();
};
wrap.addEventListener('pointerup', endStroke);
wrap.addEventListener('pointercancel', endStroke);

$('undo').addEventListener('click', () => { state.actions.pop(); drawMarks(); run(); });
$('reset').addEventListener('click', () => { state.actions = []; drawMarks(); run(); });

// ---------- Events: view ----------
const setOriginal = (on) => {
  if (state.showingOriginal === on) return;
  state.showingOriginal = on;
  wrap.classList.toggle('hide-marks', on);
  render();
};
$('compare').addEventListener('pointerdown', () => setOriginal(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('compare').addEventListener(ev, () => setOriginal(false));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !$('work').hidden && !e.repeat && !/INPUT|SELECT|BUTTON/.test(document.activeElement?.tagName)) { e.preventDefault(); setOriginal(true); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && state.actions.length) { e.preventDefault(); $('undo').click(); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') setOriginal(false); });

$('zoom').addEventListener('click', () => {
  state.zoomed = !state.zoomed;
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
    const blob = await encodePNG(state.resultImage.data, state.w, state.h);
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
