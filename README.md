# Clearcut – background remover

A fast background remover that runs entirely in your browser. No AI and no upload.

**Live site:** https://whoisstitch.github.io/background-remover/

## Why the quality stays the same
- The image is never resized. The result has exactly the same width and height as the original.
- Only transparency is added. Every pixel that stays solid keeps its exact original colour.
- The PNG is written by our own lossless encoder (`png.js`), not by the browser's canvas, so semi-transparent edge pixels are saved exactly too.

## How the cut works
1. **Background tracking:** the cut starts from the background at the image edges and spreads inward. It carries an estimate of the background colour that slowly adapts as it goes, so gradients, vignettes, soft shadows and uneven scans are followed. The estimate only adapts in smooth areas, so it can't creep through an outline.
2. **Edge un-mixing:** each pixel on the boundary is split into "subject" and "local background". It gets matching transparency, and the background colour is taken out of it, so there's no halo on any new background.
3. **Enclosed gaps:** patches made of exactly the background's colours that are fully surrounded by the subject are removed automatically. That includes big ones (the space between an arm and the body) and thin slivers (between strands of hair). Small compact details such as eye whites are kept, and so is near-white skin. Click a removed gap to bring it back.
4. **Touch-up tools:**
   - **Click:** removes a leftover patch.
   - **Keep / Remove brushes:** for busy scenes like photos and game screenshots. Paint a rough Keep stroke on the subject and a few Remove strokes on the background. A marker-controlled watershed grows both sets of marks at once, always across the weakest edge first, so they meet along the subject's outline. Textures such as floor tiles are crossed freely. Ctrl+Z undoes.

It's about 0.1 s for a 1500×1500 image.

## Run locally
```
python -m http.server 8765
```
Then open http://localhost:8765. There's no build step: it's plain HTML, CSS and JS modules.
