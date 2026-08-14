/**
 * §6 cutout mask — pure computation, no GI imports, so it runs in the
 * standalone acceptance harness as well as inside gnome-shell.
 */

const MIN_COVERAGE = 0.05;
const MAX_COVERAGE = 0.95;

export interface CutoutResult {
    /** 0..1 per-pixel foreground opacity, row-major, width*height entries. */
    alpha: number[];
    coverage: number;
}

/** Luminance threshold with a soft edge. Returns null when the split is
 *  degenerate (mask covers almost none or almost all of the image) — the
 *  caller must then fall back to a flat overlay. */
export function buildCutoutMask(
    width: number,
    height: number,
    luminance: (x: number, y: number) => number,
    threshold: number
): CutoutResult | null {
    const feather = 0.12;
    const alpha = new Array<number>(width * height);
    let covered = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const lum = luminance(x, y);
            // a = 1 where lum < threshold (foreground), feathering over
            // +/- feather around the cutoff so the edge isn't jagged.
            let a = (threshold - lum) / feather + 0.5;
            if (a < 0) a = 0;
            else if (a > 1) a = 1;
            alpha[y * width + x] = a;
            if (a > 0.5) covered++;
        }
    }
    const coverage = covered / (width * height);
    if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return null;
    return { alpha, coverage };
}