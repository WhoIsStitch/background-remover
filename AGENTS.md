# Clearcut – background remover

Static site on GitHub Pages (repo WhoIsStitch/background-remover, branch main, root). No build step.

- `index.html`, `style.css`: UI
- `app.js`: UI logic, loading, the AI path (dynamic import of @imgly/background-removal@1.7.0 from jsDelivr)
- `imaging.js`: detectBackground, floodCut (flat-colour removal + edge un-mixing), maskFromBlob, refineMask (fast guided filter)
- `png.js`: lossless RGBA PNG encoder (uses CompressionStream)

Rules: never resize the image; never change RGB of fully opaque pixels; save via `encodePNG`, not canvas.toBlob.
Run: `python -m http.server 8765`. Deploy: push to main (Pages builds automatically).
