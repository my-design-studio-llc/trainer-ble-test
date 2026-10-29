// Guesses where trees stand from satellite image colours.

/**
 * Canopy likelihood 0..1 for one pixel. Uses excess green (2G − R − B) and
 * brightness: canopy is green and fairly dark; lawns and fields are green but bright,
 * roofs/roads are grey, shadows are near-black.
 */
export function canopyScore(r, g, b) {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luma < 12 || luma > 150) return 0;
  const exg = 2 * g - r - b;
  const greenness = Math.min(1, Math.max(0, (exg - 8) / 40));
  const darkness = Math.min(1, Math.max(0, (150 - luma) / 70));
  return greenness * darkness;
}

/**
 * Picks tree positions on an image.
 * @param pixels RGBA bytes, `width` × `height`
 * @param spacing grid spacing in pixels (one candidate per cell)
 * @param rand    () => [0, 1)
 * @returns {{ u:number, v:number, r:number, g:number, b:number, conifer:boolean, size:number }[]}
 *   u, v in [0, 1] from the image's top-left; size in [0, 1)
 */
export function scatterTrees(pixels, width, height, { spacing = 4, rand = Math.random, max = 4000 } = {}) {
  const trees = [];
  for (let y = 0; y < height; y += spacing) {
    for (let x = 0; x < width; x += spacing) {
      const px = Math.min(width - 1, Math.floor(x + rand() * spacing));
      const py = Math.min(height - 1, Math.floor(y + rand() * spacing));
      const o = (py * width + px) * 4;
      const r = pixels[o];
      const g = pixels[o + 1];
      const b = pixels[o + 2];
      const score = canopyScore(r, g, b);
      if (score <= 0 || rand() > score) continue;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      trees.push({
        u: (px + 0.5) / width,
        v: (py + 0.5) / height,
        r,
        g,
        b,
        // Pacific Northwest canopy is mostly conifers; darker crowns even more so.
        conifer: luma < 70 || rand() < 0.55,
        size: rand(),
      });
      if (trees.length >= max) return trees;
    }
  }
  return trees;
}

/** Small deterministic PRNG so a tile always grows the same trees. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
