LOADING SCREEN ART
==================

Drop 5 images here, named exactly:

    slide-1.jpg
    slide-2.jpg
    slide-3.jpg
    slide-4.jpg
    slide-5.jpg

They are served at /loading/slide-N.jpg and cross-fade on the loading screen
(see #loading-slides in src/index.html, styled in src/style.css).

HOW THESE WERE MADE / HOW TO RE-SHOOT
-------------------------------------
    npm run dev   ->   http://localhost:5173/capture.html

A dev-only page that loads the map (and NOTHING else - no character), lets you
fly around with WASD + mouse, and writes the five JPEGs straight back into this
folder. Press X to export all 5, P for just the current one. Full hotkey list is
on screen. Re-run it whenever the map changes.

Tips:
- Landscape, ~1920x1080 (or larger). They are background-size: cover.
- The captions and a bottom gradient sit on top, so leave the lower portion
  relatively clean / dark-friendly.
- To change a caption or tint, edit the matching .loading-slide in index.html.
- Other formats are fine — just update the file extension in index.html.
