/**
 * §6 cutout mask — pure computation, no GI imports, so it runs in the
 * standalone acceptance harness as well as inside gnome-shell.
 */

const MIN_COVERAGE = 0.05;
const MAX_COVERAGE = 0.95;
const FADE_MARGIN = 0.04;

export interface CutoutResult {
    /** 0..1 per-pixel foreground opacity, row-major, width*height entries. */
    alpha: number[];
    coverage: number;
}

/** Luminance threshold with a soft edge. The whole mask fades toward
 *  transparent as coverage approaches the bounds, so crossing them doesn't
 *  pop the effect on/off abruptly. Returns null when coverage is fully
 *  outside the valid range — the caller must then fall back to flat. */
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
    const fade =
        clamp((coverage - MIN_COVERAGE) / FADE_MARGIN, 0, 1) *
        clamp((MAX_COVERAGE - coverage) / FADE_MARGIN, 0, 1);
    if (fade <= 0.02) return null;
    if (fade < 1) {
        for (let i = 0; i < alpha.length; i++) alpha[i] *= fade;
    }
    return { alpha, coverage };
}

function clamp(v: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, v));
}