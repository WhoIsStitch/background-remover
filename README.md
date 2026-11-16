# Clearcut – background remover

A fast background remover that runs entirely in your browser. Nothing is uploaded.

**Live site:** https://whoisstitch.github.io/background-remover/

## Why the quality stays the same
- The image is never resized. The result has exactly the same width and height as the original.
- Only transparency is added. Every pixel that stays solid keeps its exact original colour.
- The PNG is written by our own lossless encoder (`png.js`), not by the browser's canvas, so semi-transparent edge pixels are saved exactly too.

## Two methods
- **Flat colour**: for art, logos, product shots and anything on a single-colour background. It removes the colour touching the edges and un-mixes the anti-aliased edge pixels, so there's no white halo. It's instant (about 70 ms for 1500×1500).
- **AI**: for photos. It uses [IMG.LY background-removal](https://github.com/imgly/background-removal-js) (AGPL), running locally with WebGPU when available. The model downloads once (44–88 MB) and is then cached. An optional guided filter snaps the mask edges to the photo.
- **Auto** checks the image border and picks the right method.

Click any leftover patch (for example a gap between an arm and the body) to remove it as well.

## Run locally
```
python -m http.server 8765
```
Then open http://localhost:8765. There's no build step: it's plain HTML, CSS and JS modules.
