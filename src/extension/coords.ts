/**
 * Reverse mapping: engine pixel positions -> colonist.io wire coordinates.
 * Needed to SEND placement actions.
 *
 * Colonist corners: (x, y, z) = face (x, y) with z=0 its top corner, z=1 its
 * bottom corner. Every vertex of the pointy-top grid is the top corner of
 * exactly one face and the bottom corner of exactly one face (faces may lie
 * outside the 19 land tiles — colonist addresses sea faces too).
 *
 * Colonist edges: (x, y, z) = face (x, y) with z 0..2 its top-left, left,
 * bottom-left edge. Every edge is a left-edge of exactly one face.
 */

const SQRT3 = Math.sqrt(3);

function faceFromCenter(cx: number, cy: number): { x: number; y: number } | null {
  const y = cy / 1.5;
  const x = (cx - (SQRT3 / 2) * y) / SQRT3;
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (Math.abs(x - xi) > 0.02 || Math.abs(y - yi) > 0.02) return null;
  return { x: xi, y: yi };
}

export function pixelToColonistCorner(
  px: number,
  py: number,
): { x: number; y: number; z: number } | null {
  // z=0: vertex is the TOP corner (center is 1 unit below: cy = py + 1)
  const top = faceFromCenter(px, py + 1);
  if (top) return { x: top.x, y: top.y, z: 0 };
  // z=1: vertex is the BOTTOM corner (center 1 unit above)
  const bottom = faceFromCenter(px, py - 1);
  if (bottom) return { x: bottom.x, y: bottom.y, z: 1 };
  return null;
}

/** corner index pairs for left edges, matching hex_math: z -> (5-z, 4-z) */
const EDGE_CORNER_ANGLES: Array<[number, number]> = [0, 1, 2].map((z) => [
  60 * (5 - z) - 30,
  60 * (4 - z) - 30,
]);

export function pixelsToColonistEdge(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): { x: number; y: number; z: number } | null {
  // For each z, the face center is offset from the edge midpoint by the
  // inverse of the two corner vectors' mean.
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  for (let z = 0; z < 3; z++) {
    const [a1, a2] = EDGE_CORNER_ANGLES[z];
    const ox = (Math.cos((Math.PI / 180) * a1) + Math.cos((Math.PI / 180) * a2)) / 2;
    const oy = (Math.sin((Math.PI / 180) * a1) + Math.sin((Math.PI / 180) * a2)) / 2;
    const face = faceFromCenter(mx - ox, my - oy);
    if (face) {
      // verify: the face's z-left-edge endpoints match p1/p2 (either order)
      const c1 = {
        x: SQRT3 * face.x + (SQRT3 / 2) * face.y + Math.cos((Math.PI / 180) * a1),
        y: 1.5 * face.y + Math.sin((Math.PI / 180) * a1),
      };
      const c2 = {
        x: SQRT3 * face.x + (SQRT3 / 2) * face.y + Math.cos((Math.PI / 180) * a2),
        y: 1.5 * face.y + Math.sin((Math.PI / 180) * a2),
      };
      const close = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y) < 0.05;
      if ((close(c1, p1) && close(c2, p2)) || (close(c1, p2) && close(c2, p1))) {
        return { x: face.x, y: face.y, z };
      }
    }
  }
  return null;
}
