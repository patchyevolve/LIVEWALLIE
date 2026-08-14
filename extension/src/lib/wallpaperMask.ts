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
    return finishCutout(alpha, covered);
}

/** Shared coverage sanity: reject degenerate masks (almost nothing or
 *  almost everything) and fade the whole mask toward transparent as the
 *  coverage approaches the bounds so crossing them never pops abruptly. */
function finishCutout(alpha: number[], covered: number): CutoutResult | null {
    const coverage = covered / alpha.length;
    const fade =
        clamp((coverage - MIN_COVERAGE) / FADE_MARGIN, 0, 1) *
        clamp((MAX_COVERAGE - coverage) / FADE_MARGIN, 0, 1);
    if (fade <= 0.02) return null;
    if (fade < 1) {
        for (let i = 0; i < alpha.length; i++) alpha[i] *= fade;
    }
    return { alpha, coverage };
}

/** Edge-based silhouette mask — works where the luminance split fails.
 *  Sobel gradient -> barrier walls (50% of the gradient range, dilated 1px
 *  for continuity) -> flood fill from the TOP row through non-barrier
 *  pixels: everything unreachable from the sky is foreground, regardless
 *  of whether the foreground is darker or brighter than the background.
 *  The hard mask is softened with a cheap separable box blur. Runs once
 *  per wallpaper change, so the ~50-100ms cost is acceptable. */
export function buildEdgeMask(
    width: number,
    height: number,
    luminance: (x: number, y: number) => number
): CutoutResult | null {
    const w = width;
    const h = height;
    const lum = new Float32Array(w * h);
    const grad = new Float32Array(w * h);
    let maxG = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            lum[y * w + x] = luminance(x, y);
        }
    }
    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(h - 1, y + 1);
        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - 1);
            const x1 = Math.min(w - 1, x + 1);
            const gx =
                lum[y0 * w + x1] +
                2 * lum[y * w + x1] +
                lum[y1 * w + x1] -
                (lum[y0 * w + x0] + 2 * lum[y * w + x0] + lum[y1 * w + x0]);
            const gy =
                lum[y1 * w + x0] +
                2 * lum[y1 * w + x] +
                lum[y1 * w + x1] -
                (lum[y0 * w + x0] + 2 * lum[y0 * w + x] + lum[y0 * w + x1]);
            const g = Math.sqrt(gx * gx + gy * gy);
            grad[y * w + x] = g;
            if (g > maxG) maxG = g;
        }
    }
    if (maxG < 1e-4) return finishCutout(new Array<number>(w * h).fill(0), 0);
    // Otsu's method on the gradient histogram: finds the natural split
    // between smooth areas and real edges, so both sharp boundaries
    // (synthetic) and soft horizons (photos) produce barrier walls.
    const hist = new Float64Array(256);
    for (let i = 0; i < grad.length; i++) {
        hist[Math.min(255, Math.floor(grad[i] * 255))]++;
    }
    let sum = 0;
    for (let b = 0; b < 256; b++) sum += b * hist[b];
    const total = w * h;
    let sumB = 0;
    let wB = 0;
    let best = -1;
    let otsu = 128;
    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const v = wB * wF * (mB - mF) * (mB - mF);
        if (v > best) {
            best = v;
            otsu = t;
        }
    }
    const barrierThr = Math.max(otsu, 6) / 255;
    const barrier = new Uint8Array(w * h);
    const dilated = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (grad[y * w + x] > barrierThr) barrier[y * w + x] = 1;
        }
    }
    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(h - 1, y + 1);
        for (let x = 0; x < w; x++) {
            if (barrier[y * w + x]) {
                dilated[y * w + x] = 1;
                continue;
            }
            const x0 = Math.max(0, x - 1);
            const x1 = Math.min(w - 1, x + 1);
            if (
                barrier[y0 * w + x0] || barrier[y0 * w + x] ||
                barrier[y0 * w + x1] || barrier[y * w + x0] ||
                barrier[y * w + x1] || barrier[y1 * w + x0] ||
                barrier[y1 * w + x] || barrier[y1 * w + x1]
            ) {
                dilated[y * w + x] = 1;
            }
        }
    }
    const reach = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    for (let x = 0; x < w; x++) {
        if (!dilated[x]) {
            reach[x] = 1;
            stack[sp++] = x;
        }
    }
    while (sp > 0) {
        const i = stack[--sp];
        const y = (i / w) | 0;
        const x = i - y * w;
        if (x > 0 && !dilated[i - 1] && !reach[i - 1]) { reach[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < w - 1 && !dilated[i + 1] && !reach[i + 1]) { reach[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0 && !dilated[i - w] && !reach[i - w]) { reach[i - w] = 1; stack[sp++] = i - w; }
        if (y < h - 1 && !dilated[i + w] && !reach[i + w]) { reach[i + w] = 1; stack[sp++] = i + w; }
    }
    const alpha = new Array<number>(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = reach[i] ? 0 : 1;
    const tmp = new Float32Array(w * h);
    for (let iter = 0; iter < 2; iter++) {
        for (let y = 0; y < h; y++) {
            const row = y * w;
            let acc = 0;
            for (let k = -2; k <= 2; k++) acc += alpha[row + Math.min(w - 1, Math.max(0, k))];
            for (let x = 0; x < w; x++) {
                tmp[row + x] = acc / 5;
                acc += alpha[row + Math.min(w - 1, x + 3)] - alpha[row + Math.max(0, x - 2)];
            }
        }
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let k = -2; k <= 2; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
            for (let y = 0; y < h; y++) {
                alpha[y * w + x] = acc / 5;
                acc += tmp[Math.min(h - 1, y + 3) * w + x] - tmp[Math.max(0, y - 2) * w + x];
            }
        }
    }
    let covered = 0;
    for (let i = 0; i < alpha.length; i++) {
        if (alpha[i] > 0.5) covered++;
    }
    return finishCutout(alpha, covered);
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

export type MaskMode = "auto" | "luminance" | "edges";

/** Foreground mask for a display of w×h logical pixels, sampled from the
 *  source wallpaper exactly as GNOME paints it: cover-fit (scale to the
 *  larger axis, center-crop). The returned alpha array is indexed directly
 *  by layer coordinates — no per-frame coordinate math in the draw path.
 *  mode: "luminance" = brightness split, "edges" = silhouette boundaries,
 *  "auto" = luminance first, edges as fallback (so existing tuned setups
 *  keep working and low-contrast images still get a cutout). */
export function computeCoverMask(
    src: GdkPixbuf.Pixbuf,
    w: number,
    h: number,
    threshold: number,
    invert = false,
    mode: MaskMode = "auto"
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
    const lum = (x: number, y: number) => {
        const i = y * stride + x * n;
        return (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
    };
    let raw: CutoutResult | null;
    if (mode === "luminance") {
        raw = buildCutoutMask(w, h, lum, threshold);
    } else if (mode === "edges") {
        raw = buildEdgeMask(w, h, lum);
    } else {
        raw = buildCutoutMask(w, h, lum, threshold) ?? buildEdgeMask(w, h, lum);
    }
    return raw && invert ? invertCutout(raw) : raw;
}