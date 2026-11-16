// Lossless PNG encoder (RGBA, 8 bits per channel).
// We write the PNG ourselves instead of using canvas.toBlob(), because a canvas
// stores pixels with premultiplied alpha, which slightly changes the colours of
// semi-transparent edge pixels. This writes the exact pixel values we computed.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Pick the best PNG filter per row (smallest sum of absolute values), the
// standard heuristic used by libpng. Gives much smaller files than no filter.
function filterRows(rgba, w, h) {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  const zero = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgba.subarray((y - 1) * stride, y * stride) : zero;
    const [sub, up, avg, pae] = cand;
    let sSub = 0, sUp = 0, sAvg = 0, sPae = 0, sNone = 0;
    for (let i = 0; i < stride; i++) {
      const x = row[i], a = i >= 4 ? row[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      const v1 = (x - a) & 255, v2 = (x - b) & 255, v3 = (x - ((a + b) >> 1)) & 255, v4 = (x - paeth(a, b, c)) & 255;
      sub[i] = v1; up[i] = v2; avg[i] = v3; pae[i] = v4;
      sNone += x < 128 ? x : 256 - x;
      sSub += v1 < 128 ? v1 : 256 - v1;
      sUp += v2 < 128 ? v2 : 256 - v2;
      sAvg += v3 < 128 ? v3 : 256 - v3;
      sPae += v4 < 128 ? v4 : 256 - v4;
    }
    const sums = [sNone, sSub, sUp, sAvg, sPae];
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
    const o = y * (stride + 1);
    raw[o] = best;
    raw.set(best === 0 ? row : cand[best - 1], o + 1);
  }
  return raw;
}

export async function encodePNG(rgba, w, h) {
  const raw = filterRows(rgba, w, h);
  // 'deflate' = zlib format, which is exactly what PNG's IDAT chunk needs.
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  const srgb = new Uint8Array([0]); // sRGB, perceptual

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob([signature, chunk('IHDR', ihdr), chunk('sRGB', srgb), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}
