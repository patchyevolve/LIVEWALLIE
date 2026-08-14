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

/** Inverted cutout: bright areas become the foreground (particles hide
 *  behind bright objects — works on dark/black wallpapers where the
 *  normal dark-foreground reading covers the whole screen). Coverage
 *  sanity runs on the INVERTED result with a relaxed low bound so dark
 *  wallpapers with a small bright region still produce a mask. */
export function invertCutout(result: CutoutResult): CutoutResult | null {
    const alpha = new Array<number>(result.alpha.length);
    for (let i = 0; i < alpha.length; i++) alpha[i] = 1 - result.alpha[i];
    const coverage = 1 - result.coverage;
    const fade =
        clamp((coverage - 0.02) / FADE_MARGIN, 0, 1) *
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

/** Foreground mask for a display of w×h logical pixels, sampled from the
 *  source wallpaper exactly as GNOME paints it: cover-fit (scale to the
 *  larger axis, center-crop). The returned alpha array is indexed directly
 *  by layer coordinates — no per-frame coordinate math in the draw path. */
export function computeCoverMask(
    src: GdkPixbuf.Pixbuf,
    w: number,
    h: number,
    threshold: number,
    invert = false
): CutoutResult | null {
    const iw = src.get_width();
    const ih = src.get_height();
    const scale = Math.max(w / iw, h / ih);
    const dw = Math.max(1, Math.round(iw * scale));
    const dh = Math.max(1, Math.round(ih * scale));
    // Window of w×h centered on the dw×dh scaled image.
    const ox = Math.round((dw - w) / 2);
    const oy = Math.round((dh - h) / 2);

    let crop: GdkPixbuf.Pixbuf;
    if (dw === iw && dh === ih && ox === 0 && oy === 0) {
        crop = src;
    } else {
        const scaled = (dw === iw && dh === ih
            ? src
            : src.scale_simple(dw, dh, GdkPixbuf.InterpType.NEAREST))!;
        const cx = Math.max(0, ox);
        const cy = Math.max(0, oy);
        const cw = Math.min(w, dw - cx);
        const chh = Math.min(h, dh - cy);
        // copy_area asserts src/dest alpha match — the wallpaper may be a
        // PNG with alpha, so the crop must carry the same channel layout.
        crop = GdkPixbuf.Pixbuf.new(
            GdkPixbuf.Colorspace.RGB,
            scaled.get_has_alpha(),
            8,
            w,
            h
        );
        crop.fill(0);
        scaled.copy_area(cx, cy, cw, chh, crop, Math.max(0, -ox), Math.max(0, -oy));
    }

    const stride = crop.get_rowstride();
    const n = crop.get_n_channels();
    const px = crop.get_pixels();
    const raw = buildCutoutMask(w, h, (x, y) => {
        const i = y * stride + x * n;
        return (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
    }, threshold);
    return raw && invert ? invertCutout(raw) : raw;
}