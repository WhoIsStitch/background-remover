// Image maths. Everything works on the full-resolution pixels; nothing is resized.

// Find the most common colour around the image border and how much of the
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
// Pixels of the subject that touch the edge of the image are not used.
export function backgroundSeeds(px, w, h, bg, tol) {
  const lim = Math.max(30, tol * 1.5) ** 2;
  return borderIndices(w, h).filter((i) => px[i * 4 + 3] < 16 || dist2(px, i * 4, bg) <= lim);
}

// Remove the background, starting from `seeds`, by *tracking* it:
// the flood carries an estimate of the local background colour that slowly
// adapts as it spreads, so gradients, vignettes, soft shadows and uneven
// scans are followed, while any sudden change (an outline, the subject's
// edge) stops it.
//
// Then every pixel on the border between removed and kept areas is
// "un-mixed": we estimate how much of it is subject and how much is the
// local background, give it matching transparency, and take the background
// colour out of it, so there is no halo.
//
// Every other kept pixel keeps its exact original value.
// Writes into `out` (RGBA) and lowers `alpha` (one byte per pixel).
export function floodCut(src, out, alpha, w, h, seeds, tol) {
  const n = w * h;
  const tol2 = tol * tol;
  const RATE = 0.25; // how quickly the tracked background colour adapts
  const isBg = new Uint8Array(n);
  const ref = new Float32Array(n * 3); // tracked background colour per removed pixel
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  for (const s of seeds) {
    if (isBg[s]) continue;
    isBg[s] = 1;
    ref[s * 3] = src[s * 4]; ref[s * 3 + 1] = src[s * 4 + 1]; ref[s * 3 + 2] = src[s * 4 + 2];
    queue[tail++] = s;
  }

  // A pixel is "smooth" when it differs only a little from its neighbours.
  // The tracked colour only adapts on smooth pixels, so it can follow a
  // gradient but can never creep along the soft rim of an outline.
  const edge2 = Math.max(12, tol * 0.6) ** 2;
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
    const c0 = src[o], c1 = src[o + 1], c2 = src[o + 2];
    if (src[o + 3] >= 16) {
      const d0 = c0 - r0, d1 = c1 - r1, d2 = c2 - r2;
      if (d0 * d0 + d1 * d1 + d2 * d2 > tol2) return;
      if (smooth(j, o)) { r0 += d0 * RATE; r1 += d1 * RATE; r2 += d2 * RATE; }
    }
    isBg[j] = 1;
    ref[j * 3] = r0; ref[j * 3 + 1] = r1; ref[j * 3 + 2] = r2;
    queue[tail++] = j;
  };

  // Breadth-first, so the background estimate spreads out evenly.
  while (head < tail) {
    const i = queue[head++];
    const r0 = ref[i * 3], r1 = ref[i * 3 + 1], r2 = ref[i * 3 + 2];
    const x = i % w;
    if (x > 0) visit(i - 1, r0, r1, r2);
    if (x < w - 1) visit(i + 1, r0, r1, r2);
    if (i >= w) visit(i - w, r0, r1, r2);
    if (i < n - w) visit(i + w, r0, r1, r2);
  }

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
        // Subject looks too much like the background to un-mix safely.
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
        if (r0 * r0 + r1 * r1 + r2 * r2 > tol2 || a > 0.97) continue; // keep untouched
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

// Find patches of background that are fully enclosed by the subject (e.g. the
// gap between an arm and the body), which the edge flood can't reach.
// We record every colour the removed background actually contains (so this
// works on gradients too), then look for big connected patches of those
// colours. Small patches, like eye whites or highlights, are left alone.
// Returns { label: Int32Array (pixel -> patch id), gaps: [{ id, seed, area }] }.
export function findGaps(src, w, h, alpha, minArea) {
  const n = w * h;
  const bin = (o) => ((src[o] >> 3) << 10) | ((src[o + 1] >> 3) << 5) | (src[o + 2] >> 3);
  const hist = new Uint32Array(32768);
  let removed = 0;
  for (let i = 0; i < n; i++) if (alpha[i] === 0 && src[i * 4 + 3] >= 16) { hist[bin(i * 4)]++; removed++; }
  if (!removed) return { label: new Int32Array(n), gaps: [] };
  // A colour counts as "background" if enough background pixels had it;
  // neighbouring shades count too (one step of 8 levels per channel).
  const minCount = Math.max(20, removed * 0.0002);
  const isBgColor = new Uint8Array(32768);
  for (let k = 0; k < 32768; k++) {
    if (hist[k] < minCount) continue;
    const r = k >> 10, g = (k >> 5) & 31, b = k & 31;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const rr = r + dr, gg = g + dg, bb = b + db;
      if (rr >= 0 && rr < 32 && gg >= 0 && gg < 32 && bb >= 0 && bb < 32) isBgColor[(rr << 10) | (gg << 5) | bb] = 1;
    }
  }
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const gaps = [];
  const match = (i) => alpha[i] !== 0 && isBgColor[bin(i * 4)] === 1;
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] || !match(s)) continue;
    id++;
    let sp = 0, area = 0, seed = -1;
    label[s] = id; stack[sp++] = s;
    while (sp) {
      const i = stack[--sp];
      area++;
      const x = i % w;
      // Start the cut from a pixel well inside the patch, not on its soft rim.
      if (seed < 0 && x > 1 && x < w - 2 && i >= 2 * w && i < n - 2 * w &&
          match(i - 2) && match(i + 2) && match(i - 2 * w) && match(i + 2 * w)) seed = i;
      if (x > 0 && !label[i - 1] && match(i - 1)) { label[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && !label[i + 1] && match(i + 1)) { label[i + 1] = id; stack[sp++] = i + 1; }
      if (i >= w && !label[i - w] && match(i - w)) { label[i - w] = id; stack[sp++] = i - w; }
      if (i < n - w && !label[i + w] && match(i + w)) { label[i + w] = id; stack[sp++] = i + w; }
    }
    if (area >= minArea) gaps.push({ id, seed: seed >= 0 ? seed : s, area });
  }
  return { label, gaps };
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
