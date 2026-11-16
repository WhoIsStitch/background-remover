import { detectBackground, borderIndices, floodCut, maskFromBlob, refineMask } from './imaging.js';
import { encodePNG } from './png.js';

const AI_LIB = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';
const FLAT_THRESHOLD = 0.8; // share of the border that must be one colour for Auto to pick Flat

const $ = (id) => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d');
const stage = $('stage');

const state = {
  file: null, name: 'image', w: 0, h: 0,
  src: null, srcImage: null, resultImage: null,
  bg: null, mode: 'auto', clicks: [],
  aiMasks: new Map(), aiLib: null,
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
      clicks: [], aiMasks: new Map(), resultImage: null, zoomed: false,
    });
    state.bg = detectBackground(state.src, w, h);
    view.width = w; view.height = h;
    $('zoom').textContent = '100%';
    stage.classList.remove('zoomed');
    fit();
    updateClickButtons();
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
function effectiveMode() {
  if (state.mode !== 'auto') return state.mode;
  return state.bg.uniformity >= FLAT_THRESHOLD ? 'flat' : 'ai';
}

async function run() {
  if (!state.src) return;
  const job = ++state.job;
  const mode = effectiveMode();
  updatePanel(mode);
  $('download').disabled = true;
  const t0 = performance.now();

  let aiAlpha = null;
  if (mode === 'ai') {
    aiAlpha = await getAiMask(job);
    if (job !== state.job) return;
    if (!aiAlpha) { hideBusy(); return; }
  }
  if (state.clicks.length || mode === 'flat') showBusy('Cutting…');
  await nextFrame();
  if (job !== state.job) return;

  compose(mode, aiAlpha);
  hideBusy();
  render();
  $('download').disabled = false;
  const ms = Math.round(performance.now() - t0);
  $('info').textContent = `${state.w} × ${state.h}px · ${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'}`;
}

function compose(mode, aiAlpha) {
  const { src, w, h } = state;
  const n = w * h;
  const tol = +$('tol').value;
  const out = new Uint8ClampedArray(src); // exact copy of the original pixels
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = src[i * 4 + 3];

  if (mode === 'flat') {
    floodCut(src, out, alpha, w, h, borderIndices(w, h), state.bg.color, tol);
  } else {
    for (let i = 0; i < n; i++) alpha[i] = Math.round((alpha[i] * aiAlpha[i]) / 255);
  }
  for (const c of state.clicks) floodCut(src, out, alpha, w, h, [c.i], c.color, tol);

  for (let i = 0; i < n; i++) out[i * 4 + 3] = alpha[i];
  state.resultImage = new ImageData(out, w, h);
}

async function getAiMask(job) {
  const model = $('model').value;
  const refine = $('refine').checked;
  const key = model + (refine ? ':r' : '');
  if (state.aiMasks.has(key)) return state.aiMasks.get(key);

  let raw = state.aiMasks.get(model);
  if (!raw) {
    try {
      showBusy('Loading AI…');
      if (!state.aiLib) state.aiLib = await import(AI_LIB);
      const progress = (k, cur, total) => {
        if (job !== state.job) return;
        if (String(k).startsWith('fetch') && total) showBusy(`Downloading AI model… ${Math.round((cur / total) * 100)}%`);
        else if (String(k).startsWith('compute')) showBusy('Finding the subject…');
      };
      const opts = { model, progress, output: { format: 'image/png' } };
      let blob;
      try {
        blob = await state.aiLib.segmentForeground(state.file, { ...opts, device: navigator.gpu ? 'gpu' : 'cpu' });
      } catch (e) {
        if (!navigator.gpu) throw e;
        console.warn('GPU failed, using CPU', e);
        blob = await state.aiLib.segmentForeground(state.file, { ...opts, device: 'cpu' });
      }
      if (job !== state.job) return null;
      raw = await maskFromBlob(blob, state.w, state.h);
      state.aiMasks.set(model, raw);
    } catch (err) {
      console.error(err);
      toastError('The AI model could not load. Check your connection, or use Flat colour.');
      return null;
    }
  }
  if (!refine) return raw;
  showBusy('Sharpening edges…');
  await nextFrame();
  const refined = refineMask(state.src, state.w, state.h, raw);
  state.aiMasks.set(key, refined);
  return refined;
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

function updatePanel(mode) {
  for (const b of $('mode').children) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  $('flatOpts').hidden = mode !== 'flat';
  $('aiOpts').hidden = mode !== 'ai';
  const [r, g, b] = state.bg.color;
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  $('swatch').style.background = hex;
  $('swatchHex').textContent = hex;
  const notes = {
    'auto:flat': 'Auto chose Flat colour: the background is one solid colour, so the cut is exact.',
    'auto:ai': 'Auto chose AI: the background has more than one colour.',
    'flat:flat': 'Removes the solid colour touching the edges of the image. Exact and instant.',
    'ai:ai': 'Finds the subject with an AI model that runs on your device.',
  };
  $('modeNote').textContent = notes[`${state.mode}:${mode}`];
  $('tolVal').textContent = $('tol').value;
}

function updateClickButtons() {
  $('undo').disabled = !state.clicks.length;
  $('reset').disabled = !state.clicks.length;
}

function showBusy(text) { $('busyText').textContent = text; $('busy').hidden = false; }
function hideBusy() { $('busy').hidden = true; }
function nextFrame() { return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); }

function toastError(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'alert');
    Object.assign(t.style, { position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', background: '#c0362c', color: '#fff', padding: '10px 16px', borderRadius: '8px', zIndex: 10, maxWidth: '90vw' });
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

$('mode').addEventListener('click', (e) => {
  const m = e.target.closest('button')?.dataset.mode;
  if (!m || m === state.mode) return;
  state.mode = m;
  run();
});
$('model').addEventListener('change', run);
$('refine').addEventListener('change', run);

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
  const i = y * state.w + x, o = i * 4;
  if (state.resultImage.data[o + 3] === 0) return; // already removed
  state.clicks.push({ i, color: [state.src[o], state.src[o + 1], state.src[o + 2]] });
  updateClickButtons();
  run();
});
$('undo').addEventListener('click', () => { state.clicks.pop(); updateClickButtons(); run(); });
$('reset').addEventListener('click', () => { state.clicks = []; updateClickButtons(); run(); });

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
