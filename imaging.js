// Image maths. Everything works on the full-resolution pixels; nothing is resized.
//
// Two automatic methods:
//   Colour  - floodRegion (track the background in from the edges) + findGaps
//             (enclosed patches); edges finished with unmixEdges. Exact for art.
//   Subject - grabCut (colour models + graph cut, maxflow.js); edges finished
//             with matteEdges (soft, for photos, hair and fur).
// Touch-ups: regionAt (Select tool), applyStrokes (brush watershed), shrinkEdge.

import { gridMaxflow } from './maxflow.js';

// ---------- Background colour ----------

// The most common colour around the image border and how much of the
// border it covers (0..1).
export function detectBackground(px, w, h) {
  const idx = borderIndices(w, h);
  const counts = new Map();
  const key = (o) => ((px[o] >> 4) << 8) | ((px[o + 1] >> 4) << 4) | (px[o + 2] >> 4);
  for (const i of idx) { const k = key(i * 4); counts.set(k, (counts.get(k) || 0) + 1); }
  let bestKey = 0, bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { bestKey = k; bestCount = c; }
  let r = 0, g = 0, b = 0, n = 0;
  for (const i of idx) {
    const o = i * 4;
    if (key(o) === bestKey) { r += px[o]; g += px[o + 1]; b += px[o + 2]; n++; }
  }
  const color = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  let near = 0;
  for (const i of idx) {
    const o = i * 4;
    if (px[o + 3] < 16 || dist2(px, o, color) <= 40 * 40) near++;
  }
  return { color, uniformity: near / idx.length };
}

export function borderIndices(w, h) {
  const out = [];
  for (let x = 0; x < w; x++) { out.push(x); if (h > 1) out.push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { out.push(y * w); if (w > 1) out.push(y * w + w - 1); }
  return out;
}

function dist2(px, o, c) {
  const dr = px[o] - c[0], dg = px[o + 1] - c[1], db = px[o + 2] - c[2];
  return dr * dr + dg * dg + db * db;
}

// Border pixels that look like the background: where the cut starts from.
// Parts of the subject that touch the edge of the image are not used.
export function backgroundSeeds(px, w, h, bg, tol) {
  const lim = Math.max(30, tol * 1.5) ** 2;
  return borderIndices(w, h).filter((i) => px[i * 4 + 3] < 16 || dist2(px, i * 4, bg) <= lim);
}

// ---------- 1. Background tracking ----------

// Mark background reachable from `seeds` in `isBg`, recording the tracked
// background colour per pixel in `ref` (3 floats per pixel).
// The flood carries an estimate of the local background colour that slowly
// adapts as it spreads, so gradients, vignettes, soft shadows and uneven
// scans are followed, while a sudden change (an outline, the subject's edge)
// stops it. The estimate only adapts on smooth pixels, so it can never creep
// along the soft rim of an outline.
export function floodRegion(src, w, h, seeds, tol, isBg, ref) {
  const n = w * h;
  const tol2 = tol * tol;
  const RATE = 0.25;
  const edge2 = Math.max(12, tol * 0.6) ** 2;
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  for (const s of seeds) {
    if (isBg[s]) continue;
    isBg[s] = 1;
    ref[s * 3] = src[s * 4]; ref[s * 3 + 1] = src[s * 4 + 1]; ref[s * 3 + 2] = src[s * 4 + 2];
    queue[tail++] = s;
  }

  const far = (o, q) => {
    const d0 = src[q] - src[o], d1 = src[q + 1] - src[o + 1], d2 = src[q + 2] - src[o + 2];
    return d0 * d0 + d1 * d1 + d2 * d2 > edge2;
  };
  const smooth = (j, o) => {
    const x = j % w;
    if (x > 0 && far(o, o - 4)) return false;
    if (x < w - 1 && far(o, o + 4)) return false;
    if (j >= w && far(o, o - w * 4)) return false;
    if (j < n - w && far(o, o + w * 4)) return false;
    return true;
  };

  const visit = (j, r0, r1, r2) => {
    if (isBg[j]) return;
    const o = j * 4;
    if (src[o + 3] >= 16) {
      const d0 = src[o] - r0, d1 = src[o + 1] - r1, d2 = src[o + 2] - r2;
      if (d0 * d0 + d1 * d1 + d2 * d2 > tol2) return;
      if (smooth(j, o)) { r0 += d0 * RATE; r1 += d1 * RATE; r2 += d2 * RATE; }
    }
    isBg[j] = 1;
    ref[j * 3] = r0; ref[j * 3 + 1] = r1; ref[j * 3 + 2] = r2;
    queue[tail++] = j;
  };

  while (head < tail) {
    const i = queue[head++];
    const r0 = ref[i * 3], r1 = ref[i * 3 + 1], r2 = ref[i * 3 + 2];
    const x = i % w;
    if (x > 0) visit(i - 1, r0, r1, r2);
    if (x < w - 1) visit(i + 1, r0, r1, r2);
    if (i >= w) visit(i - w, r0, r1, r2);
    if (i < n - w) visit(i + w, r0, r1, r2);
  }
}

// ---------- 2. Enclosed gaps ----------

// Patches of background fully enclosed by the subject (e.g. the space between
// an arm and the body, or a sliver between strands of hair).
// We record the exact colours found in the open background (away from any
// edge), then look for connected patches made of exactly those colours that
// are either big, or long and thin. Exact matching matters: pale skin like
// (255,253,252) must not count as a white background. Small patches, like eye
// whites and highlights, are left alone.
// Returns { label: Int32Array (pixel -> patch id), gaps: [{ id, seed, area }] }.
export function findGaps(src, w, h, isBg) {
  const n = w * h;
  const rgb = (o) => (src[o] << 16) | (src[o + 1] << 8) | src[o + 2];
  const seen = new Uint8Array(1 << 24); // how often each exact colour appears in open background
  let any = false;
  for (let i = w; i < n - w; i++) {
    const x = i % w;
    if (x === 0 || x === w - 1) continue;
    if (!isBg[i] || !isBg[i - 1] || !isBg[i + 1] || !isBg[i - w] || !isBg[i + w] || src[i * 4 + 3] < 16) continue;
    const c = rgb(i * 4);
    if (seen[c] < 255) seen[c]++;
    any = true;
  }
  if (!any) return { label: new Int32Array(n), gaps: [] };

  const bigArea = Math.max(200, n * 0.0008);   // ~1800px on a 1500×1500 image
  const thinArea = Math.max(100, n * 0.0004);  // ~900px: bigger than an eye white
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const gaps = [];
  const match = (i) => !isBg[i] && seen[rgb(i * 4)] >= 3;
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] || !match(s)) continue;
    id++;
    let sp = 0, area = 0, seed = -1;
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    label[s] = id; stack[sp++] = s;
    while (sp) {
      const i = stack[--sp];
      area++;
      const x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      // Start the cut from a pixel well inside the patch, not on its soft rim.
      if (seed < 0 && x > 1 && x < w - 2 && y > 1 && y < h - 2 &&
          match(i - 2) && match(i + 2) && match(i - 2 * w) && match(i + 2 * w)) seed = i;
      if (x > 0 && !label[i - 1] && match(i - 1)) { label[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && !label[i + 1] && match(i + 1)) { label[i + 1] = id; stack[sp++] = i + 1; }
      if (i >= w && !label[i - w] && match(i - w)) { label[i - w] = id; stack[sp++] = i - w; }
      if (i < n - w && !label[i + w] && match(i + w)) { label[i + w] = id; stack[sp++] = i + w; }
    }
    const extent = Math.max(x1 - x0, y1 - y0) + 1;
    const thin = area / (extent * extent) < 0.2 && extent >= 25; // sliver, not a blob
    if (area >= bigArea || (area >= thinArea && thin)) gaps.push({ id, seed: seed >= 0 ? seed : s, area });
  }
  return { label, gaps };
}

// ---------- 3. Keep / Remove brush (marker-controlled watershed) ----------

// Marker-controlled watershed. Keep and Remove marks grow at the same time,
// always crossing the weakest available edge first (edge = colour difference
// between neighbouring pixels). Each pixel belongs to whichever mark reaches
// it first, so the two sides meet along the strongest edge between them,
// which is the subject's outline. Textures and weak lines (floor tiles,
// folds, shading) are crossed freely.
// A mark stops at edges of strength LIMIT or more; anything no mark can
// reach below that keeps the automatic result.
// marks: 0 = none, 1 = keep, 2 = remove. Runs in linear time (bucket queue).
export function applyStrokes(src, w, h, isBg, ref, marks) {
  const n = w * h;
  const lab = watershed(src, w, h, marks, 96);
  for (let i = 0; i < n; i++) {
    if (!lab[i]) continue;
    const bg = lab[i] === 2 ? 1 : 0;
    if (bg && !isBg[i]) { ref[i * 3] = src[i * 4]; ref[i * 3 + 1] = src[i * 4 + 1]; ref[i * 3 + 2] = src[i * 4 + 2]; }
    isBg[i] = bg;
  }
}

// Grow labelled seeds (1 = subject, 2 = background) across the image, always
// crossing the weakest edge first. Returns labels; 0 where nothing reached
// below `limit` (edge strength 0..442).
export function watershed(src, w, h, seeds, limit) {
  const n = w * h;
  const LIMIT = limit;
  const lab = new Uint8Array(n); // 0 = unclaimed
  const buckets = Array.from({ length: LIMIT }, () => []);
  for (let i = 0; i < n; i++) if (seeds[i]) buckets[0].push(i * 4 + seeds[i]);

  for (let L = 0; L < LIMIT; L++) {
    const b = buckets[L];
    for (let k = 0; k < b.length; k++) {
      const e = b[k], i = (e - (e & 3)) / 4, l = e & 3;
      if (lab[i]) continue;
      lab[i] = l;
      const o = i * 4, x = i % w;
      for (let d = 0; d < 4; d++) {
        let j;
        if (d === 0) { if (x === 0) continue; j = i - 1; }
        else if (d === 1) { if (x === w - 1) continue; j = i + 1; }
        else if (d === 2) { if (i < w) continue; j = i - w; }
        else { if (i >= n - w) continue; j = i + w; }
        if (lab[j]) continue;
        const q = j * 4;
        const d0 = src[q] - src[o], d1 = src[q + 1] - src[o + 1], d2 = src[q + 2] - src[o + 2];
        let c = Math.round(Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2));
        if (c < L) c = L;
        if (c < LIMIT) buckets[c].push(j * 4 + l);
      }
    }
    buckets[L] = null;
  }
  return lab;
}

// ---------- Automatic subject finder: GrabCut (graph cut), no AI ----------

// Separates the subject from a busy background.
// It balances two things over the whole image at once:
//   - colour: does this pixel look like the subject's colours or the background's?
//   - edges:  cutting between two similar neighbours is expensive, cutting
//             along a strong edge is cheap.
// The best balance is found exactly with a min-cut (maxflow.js). Colour
// models are then re-learned from the result and the cut repeated.
// It runs on a reduced copy for speed (about 0.3 MP); the outline is then
// re-traced at full resolution so no detail is lost.
//
// opts.box   [x0, y0, x1, y1): where the subject is.
// opts.hard  pixels outside the box are definitely background (Box tool).
// opts.marks optional Uint8Array (1 = keep, 2 = remove): definite answers.
// Returns isBg (Uint8Array, full resolution).
export function grabCut(src, w, h, opts) {
  const { box, hard, marks } = opts;
  const n = w * h;
  const f = Math.max(1, Math.ceil(Math.sqrt(n / 300000)));
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f), sn = sw * sh;

  // Reduced copy (block average) and reduced marks.
  const img = new Float32Array(sn * 3), cnt = new Float32Array(sn);
  const keepN = marks ? new Uint16Array(sn) : null, remN = marks ? new Uint16Array(sn) : null;
  for (let y = 0; y < h; y++) {
    const row = ((y / f) | 0) * sw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = row + ((x / f) | 0), o = i * 4;
      img[j * 3] += src[o]; img[j * 3 + 1] += src[o + 1]; img[j * 3 + 2] += src[o + 2]; cnt[j]++;
      if (marks) { if (marks[i] === 1) keepN[j]++; else if (marks[i] === 2) remN[j]++; }
    }
  }
  const sbin = new Uint16Array(sn);
  for (let j = 0; j < sn; j++) {
    const r = img[j * 3] /= cnt[j], g = img[j * 3 + 1] /= cnt[j], b = img[j * 3 + 2] /= cnt[j];
    sbin[j] = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
  }
  const sx0 = Math.floor(box[0] / f), sy0 = Math.floor(box[1] / f), sx1 = Math.ceil(box[2] / f), sy1 = Math.ceil(box[3] / f);
  const inBox = new Uint8Array(sn);
  for (let y = sy0; y < sy1; y++) inBox.fill(1, y * sw + sx0, y * sw + sx1);
  const smark = new Uint8Array(sn);
  if (marks) for (let j = 0; j < sn; j++) smark[j] = keepN[j] > remN[j] ? 1 : remN[j] ? 2 : 0;

  // Edge costs: high between similar neighbours, low across strong edges.
  const d2 = (a, b) => {
    const dr = img[a * 3] - img[b * 3], dg = img[a * 3 + 1] - img[b * 3 + 1], db = img[a * 3 + 2] - img[b * 3 + 2];
    return dr * dr + dg * dg + db * db;
  };
  let sum = 0, cntE = 0;
  for (let j = 0; j < sn; j++) {
    const x = j % sw;
    if (x < sw - 1) { sum += d2(j, j + 1); cntE++; }
    if (j < sn - sw) { sum += d2(j, j + sw); cntE++; }
  }
  const beta = 1 / (2 * (sum / Math.max(1, cntE)) + 1e-6);
  const GAMMA = 50, SCALE = 8, HARD = 1 << 24;
  const ecap = new Int32Array(sn * 4);
  for (let j = 0; j < sn; j++) {
    const x = j % sw;
    if (x < sw - 1) { const c = Math.round(SCALE * GAMMA * Math.exp(-beta * d2(j, j + 1))); ecap[j * 4] = c; ecap[(j + 1) * 4 + 1] = c; }
    if (j < sn - sw) { const c = Math.round(SCALE * GAMMA * Math.exp(-beta * d2(j, j + sw))); ecap[j * 4 + 2] = c; ecap[(j + sw) * 4 + 3] = c; }
  }

  let lab = new Uint8Array(sn);
  for (let j = 0; j < sn; j++) lab[j] = smark[j] ? (smark[j] === 1 ? 1 : 0) : inBox[j];

  // Colour models: blurred colour histograms (16 levels per channel),
  // re-learned from the result on every round.
  const tcap = new Int32Array(sn);
  for (let iter = 0; iter < 5; iter++) {
    const hf = new Float32Array(4096), hb = new Float32Array(4096);
    for (let j = 0; j < sn; j++) (lab[j] ? hf : hb)[sbin[j]]++;
    const pf = probs(blurHist(hf)), pb = probs(blurHist(hb));
    for (let j = 0; j < sn; j++) {
      let t;
      if (smark[j] === 1) t = HARD;
      else if (smark[j] === 2 || (hard && !inBox[j])) t = -HARD;
      else {
        t = Math.round(SCALE * (Math.log(pf[sbin[j]]) - Math.log(pb[sbin[j]])));
        if (!inBox[j]) t -= SCALE * 2; // soft border strip leans to background
      }
      tcap[j] = t;
    }
    const next = gridMaxflow(sw, sh, tcap, ecap.slice()).label;
    let changed = 0;
    for (let j = 0; j < sn; j++) if (next[j] !== lab[j]) changed++;
    lab = next;
    if (changed < sn * 0.001) break;
  }

  dropSpecks(lab, sw, sh, smark);

  // Back to full resolution: pixels near the reduced outline are re-traced
  // along the real edges (watershed); everything else takes its block's answer.
  const isBg = new Uint8Array(n);
  if (f === 1) {
    for (let i = 0; i < n; i++) isBg[i] = lab[i] ? 0 : 1;
  } else {
    const edgeBlock = new Uint8Array(sn);
    for (let j = 0; j < sn; j++) {
      const x = j % sw, l = lab[j];
      if ((x > 0 && lab[j - 1] !== l) || (x < sw - 1 && lab[j + 1] !== l) || (j >= sw && lab[j - sw] !== l) || (j < sn - sw && lab[j + sw] !== l)) edgeBlock[j] = 1;
    }
    const seeds = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const row = ((y / f) | 0) * sw;
      for (let x = 0; x < w; x++) {
        const j = row + ((x / f) | 0), i = y * w + x;
        if (!edgeBlock[j]) seeds[i] = lab[j] ? 1 : 2;
        if (marks && marks[i]) seeds[i] = marks[i];
      }
    }
    const traced = watershed(src, w, h, seeds, 443);
    for (let i = 0; i < n; i++) isBg[i] = traced[i] === 1 ? 0 : 1;
  }
  if (marks) for (let i = 0; i < n; i++) if (marks[i]) isBg[i] = marks[i] === 2 ? 1 : 0;
  return isBg;
}

function probs(hist) {
  const m = hist.length;
  let total = 0;
  for (let k = 0; k < m; k++) total += hist[k];
  const p = new Float32Array(m), a = 0.5, den = total + a * m;
  for (let k = 0; k < m; k++) p[k] = (hist[k] + a) / den;
  return p;
}


// Remove subject pieces smaller than 1% of the biggest (unless the user marked them).
function dropSpecks(lab, w, h, keepMarks) {
  const n = w * h;
  const comp = new Int32Array(n), stack = new Int32Array(n), sizes = [0], marked = [false];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (lab[s] !== 1 || comp[s]) continue;
    id++;
    let sp = 0, area = 0, mk = false;
    comp[s] = id; stack[sp++] = s;
    while (sp) {
      const i = stack[--sp]; area++;
      if (keepMarks[i] === 1) mk = true;
      const x = i % w;
      if (x > 0 && lab[i - 1] === 1 && !comp[i - 1]) { comp[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && lab[i + 1] === 1 && !comp[i + 1]) { comp[i + 1] = id; stack[sp++] = i + 1; }
      if (i >= w && lab[i - w] === 1 && !comp[i - w]) { comp[i - w] = id; stack[sp++] = i - w; }
      if (i < n - w && lab[i + w] === 1 && !comp[i + w]) { comp[i + w] = id; stack[sp++] = i + w; }
    }
    sizes.push(area); marked.push(mk);
  }
  let biggest = 0;
  for (const a of sizes) if (a > biggest) biggest = a;
  for (let i = 0; i < n; i++) if (lab[i] === 1 && sizes[comp[i]] < biggest * 0.01 && !marked[comp[i]]) lab[i] = 0;
}

function blurHist(hist) {
  const out = new Float32Array(4096);
  for (let r = 0; r < 16; r++) for (let g = 0; g < 16; g++) for (let b = 0; b < 16; b++) {
    const v = hist[(r << 8) | (g << 4) | b];
    if (!v) continue;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const rr = r + dr, gg = g + dg, bb = b + db;
      if (rr < 0 || rr > 15 || gg < 0 || gg > 15 || bb < 0 || bb > 15) continue;
      out[(rr << 8) | (gg << 4) | bb] += v * (dr || dg || db ? 0.25 : 1);
    }
  }
  return out;
}

// ---------- Select tool ----------

let stampBuf = null, listBuf = null, gen = 0;

// The area the Select tool highlights at pixel `s`: pixels within `tol` of
// its colour, either connected to it (contiguous) or anywhere in the image.
// Returns { idx: Int32Array of pixel indices (a view, copy to keep), x0, y0, x1, y1 }.
export function regionAt(src, w, h, s, tol, contiguous) {
  const n = w * h;
  if (!stampBuf || stampBuf.length !== n) { stampBuf = new Uint32Array(n); listBuf = new Int32Array(n); gen = 0; }
  if (++gen >= 0xfffffff0) { stampBuf.fill(0); gen = 1; }
  const o = s * 4, c0 = src[o], c1 = src[o + 1], c2 = src[o + 2], t2 = tol * tol;
  const ok = (j) => {
    const q = j * 4;
    const d0 = src[q] - c0, d1 = src[q + 1] - c1, d2 = src[q + 2] - c2;
    return d0 * d0 + d1 * d1 + d2 * d2 <= t2;
  };
  let count = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
  const add = (j) => {
    listBuf[count++] = j;
    const x = j % w, y = (j - x) / w;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  if (!contiguous) {
    for (let j = 0; j < n; j++) if (ok(j)) add(j);
  } else {
    stampBuf[s] = gen; add(s);
    for (let k = 0; k < count; k++) {
      const i = listBuf[k], x = i % w;
      if (x > 0 && stampBuf[i - 1] !== gen && ok(i - 1)) { stampBuf[i - 1] = gen; add(i - 1); }
      if (x < w - 1 && stampBuf[i + 1] !== gen && ok(i + 1)) { stampBuf[i + 1] = gen; add(i + 1); }
      if (i >= w && stampBuf[i - w] !== gen && ok(i - w)) { stampBuf[i - w] = gen; add(i - w); }
      if (i < n - w && stampBuf[i + w] !== gen && ok(i + w)) { stampBuf[i + w] = gen; add(i + w); }
    }
  }
  return { idx: listBuf.subarray(0, count), x0, y0, x1, y1 };
}

// Trim `px` pixels off the subject's outline (removes leftover fringes).
export function shrinkEdge(src, w, h, isBg, ref, px) {
  const n = w * h;
  for (let k = 0; k < px; k++) {
    const grow = [];
    for (let i = 0; i < n; i++) {
      if (isBg[i]) continue;
      const x = i % w;
      const j = x > 0 && isBg[i - 1] ? i - 1 : x < w - 1 && isBg[i + 1] ? i + 1 : i >= w && isBg[i - w] ? i - w : i < n - w && isBg[i + w] ? i + w : -1;
      if (j >= 0) grow.push(i, j);
    }
    for (let g = 0; g < grow.length; g += 2) {
      const i = grow[g], j = grow[g + 1];
      isBg[i] = 1;
      ref[i * 3] = ref[j * 3]; ref[i * 3 + 1] = ref[j * 3 + 1]; ref[i * 3 + 2] = ref[j * 3 + 2];
    }
  }
}

// ---------- 4. Soft, halo-free edges ----------

// Every pixel on the border between removed and kept areas is "un-mixed":
// we estimate how much of it is subject (F) and how much is the local
// background (B), give it matching transparency, and take the background
// colour out of it. Every other kept pixel keeps its exact original value.
// Writes into `out` (RGBA) and lowers `alpha` (one byte per pixel).
export function unmixEdges(src, out, alpha, w, h, isBg, ref, tol) {
  const tol2 = tol * tol;
  const minContrast2 = Math.max(tol * 1.5, 40) ** 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const bgPix = isBg[i];

      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && isBg[yy * w + xx] !== bgPix) { edge = true; break; }
        }
      }
      if (!edge) {
        if (bgPix) alpha[i] = 0;
        continue;
      }

      // Local background colour B: average tracked colour of removed pixels nearby.
      let B0 = 0, B1 = 0, B2 = 0, nb = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!isBg[j]) continue;
          B0 += ref[j * 3]; B1 += ref[j * 3 + 1]; B2 += ref[j * 3 + 2]; nb++;
        }
      }
      B0 /= nb; B1 /= nb; B2 /= nb;

      // Most "solid" subject colour nearby (F): the kept pixel furthest from B.
      let best = -1, F0 = 0, F1 = 0, F2 = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (isBg[j]) continue;
          const q = j * 4;
          const dr = src[q] - B0, dg = src[q + 1] - B1, db = src[q + 2] - B2;
          const d2 = dr * dr + dg * dg + db * db;
          if (d2 > best) { best = d2; F0 = src[q]; F1 = src[q + 1]; F2 = src[q + 2]; }
        }
      }

      if (best < minContrast2) {
        if (bgPix) alpha[i] = 0;
        continue;
      }

      const o = i * 4;
      const f0 = F0 - B0, f1 = F1 - B1, f2 = F2 - B2;
      const v0 = src[o] - B0, v1 = src[o + 1] - B1, v2 = src[o + 2] - B2;
      let a = (v0 * f0 + v1 * f1 + v2 * f2) / best;
      a = a < 0 ? 0 : a > 1 ? 1 : a;

      if (!bgPix) {
        // Only treat kept pixels as a blend if they really lie between B and F.
        const r0 = v0 - a * f0, r1 = v1 - a * f1, r2 = v2 - a * f2;
        if (r0 * r0 + r1 * r1 + r2 * r2 > tol2 || a > 0.97) continue;
      }

      if (a < 0.02) { alpha[i] = 0; continue; }
      out[o] = clamp255(B0 + v0 / a);
      out[o + 1] = clamp255(B1 + v1 / a);
      out[o + 2] = clamp255(B2 + v2 / a);
      const na = Math.round(a * src[o + 3]);
      if (na < alpha[i]) alpha[i] = na;
    }
  }
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

// ---------- Soft edges for photos (sampling-based matting) ----------

// For photos, hair and fur: every pixel within `radius` px of the outline gets
// a real partial transparency. Around each one we sample candidate subject
// colours (F) and background colours (B) a little further out along 8
// directions, pick the pair that best explains the pixel as a mix
// P = a*F + (1-a)*B, and use that a. The background is then taken out of the
// pixel's colour. Pixels further inside keep their exact original values.
export function matteEdges(src, out, alpha, w, h, isBg, radius) {
  const n = w * h;
  const FAR = radius + 6;
  // Distance (in steps) to the outline, up to FAR.
  const dist = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) {
    const x = i % w, b = isBg[i];
    if ((x > 0 && isBg[i - 1] !== b) || (x < w - 1 && isBg[i + 1] !== b) || (i >= w && isBg[i - w] !== b) || (i < n - w && isBg[i + w] !== b)) {
      dist[i] = 0; queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++], d = dist[i] + 1;
    if (d > FAR) continue;
    const x = i % w;
    if (x > 0 && dist[i - 1] > d) { dist[i - 1] = d; queue[qt++] = i - 1; }
    if (x < w - 1 && dist[i + 1] > d) { dist[i + 1] = d; queue[qt++] = i + 1; }
    if (i >= w && dist[i - w] > d) { dist[i - w] = d; queue[qt++] = i - w; }
    if (i < n - w && dist[i + w] > d) { dist[i + w] = d; queue[qt++] = i + w; }
  }

  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const F = new Int32Array(8), B = new Int32Array(8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] > radius) { if (isBg[i]) alpha[i] = 0; continue; }
      // Collect samples: first confident pixel of each kind along each ray.
      let nf = 0, nb = 0;
      for (let r = 0; r < 8; r++) {
        let gotF = false, gotB = false;
        for (let s = 1; s <= FAR + radius && !(gotF && gotB); s++) {
          const xx = x + DX[r] * s, yy = y + DY[r] * s;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          const j = yy * w + xx;
          if (dist[j] <= radius) continue;
          if (isBg[j]) { if (!gotB) { B[nb++] = j; gotB = true; } }
          else if (!gotF) { F[nf++] = j; gotF = true; }
        }
      }
      const o = i * 4;
      if (!nf || !nb) { if (isBg[i]) alpha[i] = 0; continue; }
      const P0 = src[o], P1 = src[o + 1], P2 = src[o + 2];
      let bestErr = Infinity, bestA = 0, bB = 0;
      for (let a = 0; a < nf; a++) {
        const fo = F[a] * 4;
        for (let b = 0; b < nb; b++) {
          const bo = B[b] * 4;
          const f0 = src[fo] - src[bo], f1 = src[fo + 1] - src[bo + 1], f2 = src[fo + 2] - src[bo + 2];
          const ff = f0 * f0 + f1 * f1 + f2 * f2;
          if (ff < 400) continue; // subject and background too alike here
          const v0 = P0 - src[bo], v1 = P1 - src[bo + 1], v2 = P2 - src[bo + 2];
          let al = (v0 * f0 + v1 * f1 + v2 * f2) / ff;
          al = al < 0 ? 0 : al > 1 ? 1 : al;
          const r0 = v0 - al * f0, r1 = v1 - al * f1, r2 = v2 - al * f2;
          const err = (r0 * r0 + r1 * r1 + r2 * r2) / ff; // relative to how far apart F and B are
          if (err < bestErr) { bestErr = err; bestA = al; bB = bo; }
        }
      }
      if (bestErr === Infinity) { if (isBg[i]) alpha[i] = 0; continue; }
      if (bestA > 0.97) continue; // solid: keep the exact original pixel
      if (bestA < 0.03) { alpha[i] = 0; continue; }
      out[o] = clamp255(src[bB] + (P0 - src[bB]) / bestA);
      out[o + 1] = clamp255(src[bB + 1] + (P1 - src[bB + 1]) / bestA);
      out[o + 2] = clamp255(src[bB + 2] + (P2 - src[bB + 2]) / bestA);
      alpha[i] = Math.round(bestA * src[o + 3]);
    }
  }
}
