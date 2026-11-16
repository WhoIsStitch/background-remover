import { detectBackground, backgroundSeeds, floodCut, findGaps } from './imaging.js';
import { encodePNG } from './png.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d');
const stage = $('stage');

const state = {
  file: null, name: 'image', w: 0, h: 0,
  src: null, srcImage: null, resultImage: null,
  bg: null, clicks: [], gapInfo: null,
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
      clicks: [], resultImage: null, zoomed: false,
    });
    state.bg = detectBackground(state.src, w, h);
    view.width = w; view.height = h;
    $('zoom').textContent = '100%';
    stage.classList.remove('zoomed');
    fit();
    updatePanel();
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
  const out = new Uint8ClampedArray(src); // exact copy of the original pixels
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = src[i * 4 + 3];

  // 1. Background connected to the edges of the image.
  floodCut(src, out, alpha, w, h, backgroundSeeds(src, w, h, bg.color, tol), tol);

  // 2. Enclosed gaps + anything the user clicked, in one pass.
  const seeds = [];
  state.gapInfo = null;
  let removedGaps = 0;
  if ($('gaps').checked) {
    const minArea = Math.max(200, Math.round(n * 0.0008)); // ~1800px on a 1500×1500 image
    const info = findGaps(src, w, h, alpha, minArea);
    const kept = new Set(state.clicks.filter((c) => c.keep).map((c) => info.label[c.i]));
    info.removed = new Set();
    for (const g of info.gaps) {
      if (kept.has(g.id)) continue;
      seeds.push(g.seed);
      info.removed.add(g.id);
    }
    removedGaps = info.removed.size;
    state.gapInfo = info;
  }
  for (const c of state.clicks) if (!c.keep) seeds.push(c.i);
  if (seeds.length) floodCut(src, out, alpha, w, h, seeds, tol);

  for (let i = 0; i < n; i++) out[i * 4 + 3] = alpha[i];
  state.resultImage = new ImageData(out, w, h);
  $('gapNote').textContent = removedGaps
    ? `Removed ${removedGaps} enclosed gap${removedGaps > 1 ? 's' : ''}. Click one to bring it back.`
    : '';
}

// ---------- Display ----------
function render() {
  const img = state.showingOriginal ? state.srcImage : state.resultImage;
  if (img) ctx.putImageData(img, 0, 0);
}

function fit() {
  if (!state.w) return;
  if (state.zoomed) {
    const dpr = window.devicePixelRatio || 1;
    view.style.width = state.w / dpr + 'px';
    view.style.height = state.h / dpr + 'px';
    return;
  }
  const pad = 24;
  const sw = stage.clientWidth - pad, sh = stage.clientHeight - pad;
  const s = Math.min(sw / state.w, sh / state.h, 2);
  view.style.width = Math.max(1, Math.floor(state.w * s)) + 'px';
  view.style.height = Math.max(1, Math.floor(state.h * s)) + 'px';
}

function updatePanel() {
  const [r, g, b] = state.bg.color;
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  $('swatch').style.background = hex;
  $('swatchHex').textContent = hex;
  $('bgNote').textContent = state.bg.uniformity >= 0.8
    ? 'Solid background — the cut follows it exactly.'
    : 'The background changes colour — the cut tracks it as it goes. Raise the tolerance if some is left, or click it.';
  $('tolVal').textContent = $('tol').value;
  $('undo').disabled = !state.clicks.length;
  $('reset').disabled = !state.clicks.length;
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

// ---------- Events ----------
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

$('gaps').addEventListener('change', run);

let tolTimer;
$('tol').addEventListener('input', () => {
  $('tolVal').textContent = $('tol').value;
  clearTimeout(tolTimer);
  tolTimer = setTimeout(run, 60);
});

view.addEventListener('click', (e) => {
  if (!state.resultImage || !$('busy').hidden) return;
  const r = view.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * state.w);
  const y = Math.floor(((e.clientY - r.top) / r.height) * state.h);
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;
  const i = y * state.w + x;
  if (state.resultImage.data[i * 4 + 3] === 0) {
    // Clicking a gap that was removed automatically brings it back.
    const g = state.gapInfo;
    if (!g || !g.removed.has(g.label[i])) return;
    state.clicks.push({ i, keep: true });
  } else {
    state.clicks.push({ i });
  }
  run();
});
$('undo').addEventListener('click', () => { state.clicks.pop(); run(); });
$('reset').addEventListener('click', () => { state.clicks = []; run(); });

const setOriginal = (on) => { if (state.showingOriginal !== on) { state.showingOriginal = on; render(); } };
$('compare').addEventListener('pointerdown', () => setOriginal(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('compare').addEventListener(ev, () => setOriginal(false));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !$('work').hidden && !e.repeat && !/INPUT|SELECT|BUTTON/.test(document.activeElement?.tagName)) { e.preventDefault(); setOriginal(true); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && state.clicks.length) { e.preventDefault(); $('undo').click(); }
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
