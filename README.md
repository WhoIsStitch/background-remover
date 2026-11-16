# Clearcut – background remover

A fast background remover that runs entirely in your browser. No AI and no upload.

**Live site:** https://whoisstitch.github.io/background-remover/

## Why the quality stays the same
- The image is never resized. The result has exactly the same width and height as the original.
- Only transparency is added. Every pixel that stays solid keeps its exact original colour.
- The PNG is written by our own lossless encoder (`png.js`), not by the browser's canvas, so semi-transparent edge pixels are saved exactly too.

## Automatic methods
**Auto** picks one of these for you:
- **Colour:** for art, logos and anything on a solid or smoothly changing background. The cut starts at the image edges and tracks the background colour inward, following gradients and soft shadows but stopping at outlines. Enclosed gaps, such as the space between an arm and the body or a sliver between strands of hair, are removed too. Eye whites and near-white skin are kept.
- **Subject:** for busy backgrounds like photos and game screenshots. It uses GrabCut, without AI. Colour models for subject and background are weighed against edge strength over the whole image, and the best cut is found exactly with a min-cut/max-flow solver (`maxflow.js`, Boykov–Kolmogorov). It repeats this with refined colour models, then re-traces the outline at full resolution. Edges get soft matting: each edge pixel picks the best subject/background colour pair around it, so hair and fur get real partial transparency. Keep/Remove strokes become hard constraints in the cut.

## Tools
| Tool | Key | What it does |
|---|---|---|
| Select | S | Hover to highlight an area. Click removes it, Shift+click keeps it. Untick "Connected area only" to grab that colour everywhere. |
| Box | B | Drag a box around the subject. Everything outside goes, and the inside is found automatically. |
| Keep / Remove | K / R | Brushes for fine touch-ups. They spread to the nearest strong edge. |

- **Trim edge:** shaves 1–4 px off the outline to remove fringes.
- **Shortcuts:** Ctrl+Z undoes; hold Space to compare with the original.

Every step ends with **edge un-mixing**: each boundary pixel is split into subject and local background, so there's no halo on a new background.

## Run locally
```
python -m http.server 8765
```
Then open http://localhost:8765. There's no build step: it's plain HTML, CSS and JS modules.
