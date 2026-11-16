// Image maths. Everything works on the full-resolution pixels; nothing is resized.
//
// Pipeline (see app.js compose()):
//   1. floodRegion  – track the background in from the image edges
//   2. findGaps     – enclosed patches of background colour (+ user clicks)
//   3. applyStrokes – optional Keep/Remove brush marks, solved with a
//                     marker-controlled watershed along the strongest edges
//   4. unmixEdges   – soft, halo-free edges on the final boundary

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
  const LIMIT = 96;
  const lab = new Uint8Array(n); // 0 = unclaimed, 1 = keep, 2 = remove
  const buckets = Array.from({ length: LIMIT }, () => []);
  for (let i = 0; i < n; i++) if (marks[i]) buckets[0].push(i * 4 + marks[i]);

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

  for (let i = 0; i < n; i++) {
    if (!lab[i]) continue;
    const bg = lab[i] === 2 ? 1 : 0;
    if (bg && !isBg[i]) { ref[i * 3] = src[i * 4]; ref[i * 3 + 1] = src[i * 4 + 1]; ref[i * 3 + 2] = src[i * 4 + 2]; }
    isBg[i] = bg;
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
