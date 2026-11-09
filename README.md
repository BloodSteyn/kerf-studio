# Kerf Studio

A clean, modern laser design and control app for the **Ortur Laser Master 2 Pro** (GRBL 1.1).
It runs in Chrome or Edge, with nothing to install, and talks to the laser over USB through Web Serial.

<img width="1260" height="1034" alt="image" src="https://github.com/user-attachments/assets/edadb67e-27d3-426e-aeec-2dae8fe08c83" />

<img width="590" height="518" alt="image" src="https://github.com/user-attachments/assets/90acac8c-0bb7-4648-b652-9db8bf3eb93f" />


## Start it

Double-click **`Start Kerf Studio.cmd`**. It serves the app on `http://localhost:8787` and opens it in Chrome or Edge.
You can also open `index.html` directly in Chrome or Edge.

## What it does

| Area | Features |
|---|---|
| Design | Import Bambu Suite / MakerWorld `.lac` projects, SVG (layers by colour), DXF, PNG/JPG/BMP/WebP. Draw rectangles and ellipses, add text. Move, scale, rotate, duplicate, undo/redo. |
| Cut settings | Layers with Line (cut/score), Fill (scan engrave) and Image (photo) modes. Speed, power, min power, passes, line interval/DPI. Output on/off per layer. |
| Images | Jarvis, Floyd–Steinberg, threshold and grayscale modes, plus brightness, contrast and invert. |
| Preview | Toolpath overlay with travel moves, estimated time, burn distance and job size. |
| Laser | Connect, live position, jog pad, Home ($H), Unlock ($X), Frame, Start / Pause / Resume / Stop. Start from absolute coordinates or the current position. |
| Console | Raw G-code and `$` commands, with history and quick buttons. |
| Files | Save/open projects (`.kerf.json`), export `.gcode`. Autosaves in the browser. |

When it connects, it reads `$30` (S-max), `$130/$131` (work area) and `$32` (laser mode) from the controller.

## Bambu `.lac` projects

Kerf Studio reads the design from a `.lac` file: vector paths, engraving images and their placement, and which parts are cut or engraved.
It creates one layer per process, in burn order (image engrave → fill engrave → score → cut).
The file's power and speed values are for a 55 W Bambu laser and its G-code is Bambu-only, so neither is used.
Layers start with conservative Ortur LM2 Pro values instead. Tune them on scrap material.

## Shortcuts

`V` select · `R` rectangle · `E` ellipse · `T` text · `H` or hold `Space` to pan · `P` preview · `F` fit
`Ctrl+Z / Ctrl+Y` undo/redo · `Ctrl+D` duplicate · `Del` delete · arrow keys nudge 1 mm (`Shift` 10 mm, `Alt` 0.1 mm)
Hold `Shift` while dragging a corner handle to scale freely. Double-click text to edit it.

## Files

```
index.html          UI layout
css/app.css         Styles (dark and light themes)
js/geometry.js      Geometry, SVG and DXF import
js/raster.js        Image processing, dithering, text rendering
js/gcode.js         G-code generation (line / fill / raster) and framing
js/grbl.js          GRBL serial connection and buffered streaming
js/lac.js           Bambu Suite .lac project import (ZIP + scene graph)
js/app.js           Editor, panels and machine control
```

## Safety

Always wear 445 nm-rated laser safety glasses, and never leave the laser running unattended.
