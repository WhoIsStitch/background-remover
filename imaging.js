// Image maths. Everything works on the full-resolution pixels; nothing is resized.

// Find the most common colour around the image border and how much of the
// border it covers (0..1). A high value means a flat, single-colour background.
export function detectBackground(px, w, h) {
  const idx = borderIndices(w, h);
  const counts = new Map();
  for (const i of idx) {
    const o = i * 4;
    const k = ((px[o] >> 4) << 8) | ((px[o + 1] >> 4) << 4) | (px[o + 2] >> 4);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bestKey = 0, bestCount = -1;
  for (const [k, c] of counts) if (c > bestCount) { bestKey = k; bestCount = c; }
  let r = 0, g = 0, b = 0, n = 0;
  for (const i of idx) {
    const o = i * 4;
    const k = ((px[o] >> 4) << 8) | ((px[o + 1] >> 4) << 4) | (px[o + 2] >> 4);
    if (k === bestKey) { r += px[o]; g += px[o + 1]; b += px[o + 2]; n++; }
  }
  const color = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  let near = 0;
  for (const i of idx) {
    const o = i * 4;
    if (px[o + 3] < 16) { near++; continue; }
    const dr = px[o] - color[0], dg = px[o + 1] - color[1], db = px[o + 2] - color[2];
    if (dr * dr + dg * dg + db * db <= 40 * 40) near++;
  }
  return { color, uniformity: near / idx.length };
}

export function borderIndices(w, h) {
  const out = [];
  for (let x = 0; x < w; x++) { out.push(x); if (h > 1) out.push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { out.push(y * w); if (w > 1) out.push(y * w + w - 1); }
  return out;
}

// Remove a connected region of colour `bg`, starting from `seeds`.
// - Pixels inside the region become fully transparent.
// - Anti-aliased edge pixels get a matching partial transparency, and the
//   background colour is "un-mixed" out of them, so there is no white/coloured
//   halo around the cut-out.
// - Every other pixel keeps its exact original value.
// Writes into `out` (RGBA) and lowers `alpha` (one byte per pixel).
export function floodCut(src, out, alpha, w, h, seeds, bg, tol) {
  const n = w * h;
  const tol2 = tol * tol;
  const [B0, B1, B2] = bg;
  const isBg = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;

  const near = (i) => {
    const o = i * 4;
    if (src[o + 3] < 16) return true;
    const dr = src[o] - B0, dg = src[o + 1] - B1, db = src[o + 2] - B2;
    return dr * dr + dg * dg + db * db <= tol2;
  };

  for (const s of seeds) if (!isBg[s] && near(s)) { isBg[s] = 1; stack[sp++] = s; }
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0 && !isBg[i - 1] && near(i - 1)) { isBg[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && !isBg[i + 1] && near(i + 1)) { isBg[i + 1] = 1; stack[sp++] = i + 1; }
    if (i >= w && !isBg[i - w] && near(i - w)) { isBg[i - w] = 1; stack[sp++] = i - w; }
    if (i < n - w && !isBg[i + w] && near(i + w)) { isBg[i + w] = 1; stack[sp++] = i + w; }
  }

  const minContrast2 = Math.max(tol * 1.5, 40) ** 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const bgPix = isBg[i];

      // Is this pixel on the border between removed and kept areas?
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (isBg[yy * w + xx] !== bgPix) { edge = true; break; }
        }
      }

      if (!edge) {
        if (bgPix) alpha[i] = 0;
        continue;
      }

      // Edge pixel: find the most "solid" foreground colour nearby (F), then
      // work out how much of this pixel is F versus the background B.
      const o = i * 4;
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
        // Foreground looks too much like the background to un-mix safely.
        if (bgPix) alpha[i] = 0;
        continue;
      }

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

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

// Read a mask image (from the AI model) at the exact size of the photo.
export async function maskFromBlob(blob, w, h) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, w, h).data;
  // The mask may be stored in the alpha channel or as grey; use whichever varies.
  let alphaVaries = false;
  for (let i = 3; i < d.length; i += 4 * 97) if (d[i] !== 255) { alphaVaries = true; break; }
  const m = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < m.length; i++, o += 4) m[i] = alphaVaries ? d[o + 3] : d[o];
  return m;
}

// Snap a soft AI mask to the real edges in the photo (fast guided filter).
// The heavy part runs at up to 2048px, then the result is applied at full size.
export function refineMask(src, w, h, mask) {
  const s = Math.max(1, Math.ceil(Math.max(w, h) / 2048));
  const lw = Math.ceil(w / s), lh = Math.ceil(h / s), ln = lw * lh;
  const I = new Float32Array(ln), P = new Float32Array(ln), cnt = new Float32Array(ln);
  for (let y = 0; y < h; y++) {
    const ly = (y / s) | 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4, j = ly * lw + ((x / s) | 0);
      I[j] += (0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2]) / 255;
      P[j] += mask[i] / 255;
      cnt[j]++;
    }
  }
  for (let j = 0; j < ln; j++) { I[j] /= cnt[j]; P[j] /= cnt[j]; }

  const r = Math.max(2, Math.round(Math.min(lw, lh) / 300));
  const eps = 1e-3;
  const II = new Float32Array(ln), IP = new Float32Array(ln);
  for (let j = 0; j < ln; j++) { II[j] = I[j] * I[j]; IP[j] = I[j] * P[j]; }
  const mI = boxBlur(I, lw, lh, r), mP = boxBlur(P, lw, lh, r);
  const mII = boxBlur(II, lw, lh, r), mIP = boxBlur(IP, lw, lh, r);
  const A = new Float32Array(ln), Bc = new Float32Array(ln);
  for (let j = 0; j < ln; j++) {
    const varI = mII[j] - mI[j] * mI[j];
    const cov = mIP[j] - mI[j] * mP[j];
    A[j] = cov / (varI + eps);
    Bc[j] = mP[j] - A[j] * mI[j];
  }
  const mA = boxBlur(A, lw, lh, r), mB = boxBlur(Bc, lw, lh, r);

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) / s - 0.5; if (fy < 0) fy = 0; if (fy > lh - 1) fy = lh - 1;
    const y0 = fy | 0, y1 = Math.min(y0 + 1, lh - 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = mask[i];
      // Solid inside / solid outside stays exactly as the model said.
      if (m === 0 || m === 255) {
        // ...unless we're near an edge, which the guided filter handles below.
        if (!nearEdge(mask, w, h, x, y, 2)) { out[i] = m; continue; }
      }
      let fx = (x + 0.5) / s - 0.5; if (fx < 0) fx = 0; if (fx > lw - 1) fx = lw - 1;
      const x0 = fx | 0, x1 = Math.min(x0 + 1, lw - 1), tx = fx - x0;
      const a = lerp2(mA, lw, x0, x1, y0, y1, tx, ty);
      const b = lerp2(mB, lw, x0, x1, y0, y1, tx, ty);
      const o = i * 4;
      const lum = (0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2]) / 255;
      let q = a * lum + b;
      q = q < 0 ? 0 : q > 1 ? 1 : q;
      out[i] = q > 0.985 ? 255 : q < 0.015 ? 0 : Math.round(q * 255);
    }
  }
  return out;
}

function nearEdge(mask, w, h, x, y, r) {
  const v = mask[y * w + x];
  for (let dy = -r; dy <= r; dy += r) {
    const yy = y + dy; if (yy < 0 || yy >= h) continue;
    for (let dx = -r; dx <= r; dx += r) {
      const xx = x + dx; if (xx < 0 || xx >= w) continue;
      if (mask[yy * w + xx] !== v) return true;
    }
  }
  return false;
}

function lerp2(arr, lw, x0, x1, y0, y1, tx, ty) {
  const a = arr[y0 * lw + x0], b = arr[y0 * lw + x1], c = arr[y1 * lw + x0], d = arr[y1 * lw + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// Separable box blur (mean filter), O(1) per pixel regardless of radius.
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (2 * r + 1);
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * r + 1);
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
