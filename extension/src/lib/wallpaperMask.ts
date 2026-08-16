/**
 * §6 cutout mask — pure computation plus a pixbuf applier.
 * GdkPixbuf/GLib are safe to import in the standalone acceptance harness.
 */

import GdkPixbuf from "gi://GdkPixbuf";
import GLib from "gi://GLib";

const MIN_COVERAGE = 0.0005;
const MAX_COVERAGE = 0.95;
// Different margins per side: the low side must be tight so a small but
// genuine foreground (an icon, a boat on a lake) gets the full effect,
// while the high side stays wide so a mask covering almost everything
// fades out gracefully instead of popping.
const LOW_FADE_MARGIN = 0.002;
const HIGH_FADE_MARGIN = 0.02;

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
        clamp((coverage - MIN_COVERAGE) / LOW_FADE_MARGIN, 0, 1) *
        clamp((MAX_COVERAGE - coverage) / HIGH_FADE_MARGIN, 0, 1);
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
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (grad[y * w + x] > barrierThr) barrier[y * w + x] = 1;
        }
    }
    // Dilate the barrier with horizontal then vertical span sweeps (radius
    // 3). A single 1px dilation left gaps in edge rings once the wallpaper
    // is downscaled to screen size — the flood fill leaked through them and
    // the foreground collapsed to a few percent. Span sweeps are O(w·h)
    // and cheap on the sparse barrier.
    const DILATE = 3;
    const dilated = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (!barrier[row + x]) continue;
            const x0 = Math.max(0, x - DILATE);
            const x1 = Math.min(w - 1, x + DILATE);
            for (let k = x0; k <= x1; k++) dilated[row + k] = 1;
        }
    }
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            if (!dilated[y * w + x]) continue;
            const y0 = Math.max(0, y - DILATE);
            const y1 = Math.min(h - 1, y + DILATE);
            for (let k = y0; k <= y1; k++) dilated[k * w + x] = 1;
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
 *  normal dark-foreground reading covers the whole screen). The low
 *  coverage bound is shared with the normal reading, so a small bright
 *  object on black still produces a mask. */
export function invertCutout(result: CutoutResult): CutoutResult | null {
    const alpha = new Array<number>(result.alpha.length);
    for (let i = 0; i < alpha.length; i++) alpha[i] = 1 - result.alpha[i];
    const coverage = 1 - result.coverage;
    const fade =
        clamp((coverage - MIN_COVERAGE) / LOW_FADE_MARGIN, 0, 1) *
        clamp((MAX_COVERAGE - coverage) / HIGH_FADE_MARGIN, 0, 1);
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

/** Cover-fit crop of src to exactly w×h, matching how GNOME paints the
 *  wallpaper (scale to cover, center-crop). The mask and the preview must
 *  sample the same pixels, so the crop is NEAREST like the extension's
 *  mask computation. */
export function coverCropPixbuf(
    src: GdkPixbuf.Pixbuf,
    w: number,
    h: number
): GdkPixbuf.Pixbuf {
    const iw = src.get_width();
    const ih = src.get_height();
    const scale = Math.max(w / iw, h / ih);
    const dw = Math.max(1, Math.round(iw * scale));
    const dh = Math.max(1, Math.round(ih * scale));
    // Window of w×h centered on the dw×dh scaled image.
    const ox = Math.round((dw - w) / 2);
    const oy = Math.round((dh - h) / 2);

    if (dw === iw && dh === ih && ox === 0 && oy === 0) return src;
    const scaled = (dw === iw && dh === ih
        ? src
        : src.scale_simple(dw, dh, GdkPixbuf.InterpType.NEAREST))!;
    const cx = Math.max(0, ox);
    const cy = Math.max(0, oy);
    const cw = Math.min(w, dw - cx);
    const chh = Math.min(h, dh - cy);
    // copy_area asserts src/dest alpha match — the wallpaper may be a
    // PNG with alpha, so the crop must carry the same channel layout.
    const crop = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB,
        scaled.get_has_alpha(),
        8,
        w,
        h
    );
    crop.fill(0);
    scaled.copy_area(cx, cy, cw, chh, crop, Math.max(0, -ox), Math.max(0, -oy));
    return crop;
}

export type MaskMode = "auto" | "luminance" | "edges";

/** Edge analysis cap: the flood fill is only stable over a range of
 *  analysis scales. Too small and the barrier rings breach (foreground
 *  collapses to a few percent); too large and busy textures overgrow
 *  the barriers (foreground becomes the whole frame). Both failure
 *  modes are gone in the ~512-960px range across every wallpaper we
 *  have tested, so edges are always analyzed at ≤1024px and the mask is
 *  bilinearly upscaled to the layer size. */
const EDGE_ANALYSIS_MAX = 1024;

/** Cover-fit crop of src at w×h, then a luminance sampler over it. */
function cropLuminance(
    src: GdkPixbuf.Pixbuf,
    w: number,
    h: number
): (x: number, y: number) => number {
    const crop = coverCropPixbuf(src, w, h);
    const stride = crop.get_rowstride();
    const n = crop.get_n_channels();
    const px = crop.get_pixels();
    return (x: number, y: number) => {
        const i = y * stride + x * n;
        return (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
    };
}

/** Bilinear upscale of a mask from sw×sh to dw×dh. */
function upscaleMask(
    alpha: number[],
    sw: number,
    sh: number,
    dw: number,
    dh: number
): number[] {
    if (sw === dw && sh === dh) return alpha;
    const out = new Array<number>(dw * dh);
    const fx = (sw - 1) / (dw - 1);
    const fy = (sh - 1) / (dh - 1);
    for (let y = 0; y < dh; y++) {
        const sy = y * fy;
        const y0 = Math.floor(sy);
        const y1 = Math.min(sh - 1, y0 + 1);
        const wy = sy - y0;
        for (let x = 0; x < dw; x++) {
            const sx = x * fx;
            const x0 = Math.floor(sx);
            const x1 = Math.min(sw - 1, x0 + 1);
            const wx = sx - x0;
            const a00 = alpha[y0 * sw + x0];
            const a10 = alpha[y0 * sw + x1];
            const a01 = alpha[y1 * sw + x0];
            const a11 = alpha[y1 * sw + x1];
            out[y * dw + x] =
                (a00 * (1 - wx) + a10 * wx) * (1 - wy) +
                (a01 * (1 - wx) + a11 * wx) * wy;
        }
    }
    return out;
}

/** Edge-silhouette mask at the layer geometry, analyzed at a capped
 *  scale (see EDGE_ANALYSIS_MAX) so the flood fill never sees the
 *  texture-overgrowth or ring-breach failure modes. */
function buildEdgeMaskScaled(
    src: GdkPixbuf.Pixbuf,
    w: number,
    h: number
): CutoutResult | null {
    const EW = Math.min(w, EDGE_ANALYSIS_MAX);
    const EH = Math.max(1, Math.round((EW * h) / w));
    const raw = buildEdgeMask(EW, EH, cropLuminance(src, EW, EH));
    if (!raw) return null;
    return { alpha: upscaleMask(raw.alpha, EW, EH, w, h), coverage: raw.coverage };
}

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
    const lum = cropLuminance(src, w, h);
    let raw: CutoutResult | null;
    if (invert && mode !== "edges") {
        // Inverted luminance reading: count the BRIGHT pixels as foreground
        // and apply the coverage sanity to that fraction. This must run
        // directly — computing the normal reading first is useless on a
        // dark wallpaper, where it is rejected (>95% dark) and the inverted
        // reading (a small bright object) never gets a chance.
        raw = buildCutoutMask(w, h, (x, y) => 1 - lum(x, y), threshold);
        if (!raw) return null;
        const alpha = new Array<number>(raw.alpha.length);
        for (let i = 0; i < alpha.length; i++) alpha[i] = 1 - raw.alpha[i];
        return { alpha, coverage: raw.coverage };
    }
    if (mode === "luminance") {
        raw = buildCutoutMask(w, h, lum, threshold);
    } else if (mode === "edges") {
        raw = buildEdgeMaskScaled(src, w, h);
    } else {
        raw = buildCutoutMask(w, h, lum, threshold) ?? buildEdgeMaskScaled(src, w, h);
    }
    return raw && invert ? invertCutout(raw) : raw;
}