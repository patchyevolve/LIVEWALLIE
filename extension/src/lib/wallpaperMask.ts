/**
 * §6 cutout mask — pure computation plus a pixbuf applier.
 * GdkPixbuf/GLib are safe to import in the standalone acceptance harness.
 */

import GdkPixbuf from "gi://GdkPixbuf";
import GLib from "gi://GLib";

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

/** Produces an RGBA pixbuf with the mask applied to the alpha channel.
 *  IMPORTANT: GdkPixbuf.get_pixels() returns a COPY in modern GJS — writing
 *  into it silently does nothing. We therefore build the result from scratch
 *  into our own buffer and wrap it with Pixbuf.from_bytes(). */
export function applyMaskToPixbuf(
    src: GdkPixbuf.Pixbuf,
    alpha: number[]
): GdkPixbuf.Pixbuf {
    const w = src.get_width();
    const h = src.get_height();
    const stride = src.get_rowstride();
    const n = src.get_n_channels();
    const px = src.get_pixels();
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const si = y * stride + x * n;
            const oi = (y * w + x) * 4;
            out[oi] = px[si];
            out[oi + 1] = px[si + 1];
            out[oi + 2] = px[si + 2];
            out[oi + 3] = Math.round(255 * clamp(alpha[y * w + x], 0, 1));
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(out),
        GdkPixbuf.Colorspace.RGB,
        true,
        8,
        w,
        h,
        w * 4
    );
}