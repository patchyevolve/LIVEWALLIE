import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GdkPixbuf from "gi://GdkPixbuf";

export interface PaletteAccent {
    hue: number; // 0..360
    sat: number; // 0..100
    lig: number; // 0..100
}

/**
 * Extracts an accent color from the current wallpaper image (sat-weighted
 * hue histogram over a 96x96 downsample, per design doc §6), and keeps it in
 * sync with org.gnome.desktop.background picture-uri changes.
 */
export class PaletteManager {
    private _backgroundSettings: Gio.Settings;
    private _changedId: number | null = null;
    private _accent: PaletteAccent | null = null;

    constructor() {
        this._backgroundSettings = new Gio.Settings({
            schema_id: "org.gnome.desktop.background",
        });
    }

    enable() {
        this._changedId = this._backgroundSettings.connect(
            "changed::picture-uri",
            () => this._refresh()
        );
        this._refresh();
    }

    getAccent(): PaletteAccent | null {
        return this._accent;
    }

    private _refresh() {
        const uri = this._backgroundSettings.get_string("picture-uri");
        this._accent = extractAccent(uri);
    }

    disable() {
        if (this._changedId !== null) {
            this._backgroundSettings.disconnect(this._changedId);
            this._changedId = null;
        }
        this._accent = null;
    }
}

function clamp(v: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, v));
}

/** Sat-weighted hue histogram over a downsampled wallpaper, returns the
 *  dominant hue plus average saturation/lightness. Null if unreadable. */
export function extractAccent(uri: string | null): PaletteAccent | null {
    if (!uri) return null;
    let path = uri;
    if (path.startsWith("file://")) path = decodeURIComponent(path.slice(7));
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;

    let pb: GdkPixbuf.Pixbuf;
    try {
        pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 96, 96, true);
    } catch (e) {
        return null;
    }

    const n = pb.get_n_channels();
    const stride = pb.get_rowstride();
    const px = pb.get_pixels();
    const w = pb.get_width();
    const h = pb.get_height();

    const bins = new Array<number>(36).fill(0);
    let totalSat = 0;
    let totalLig = 0;
    let count = 0;
    let grayLum = 0;
    let grayCount = 0;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * stride + x * n;
            const r = px[i] / 255;
            const g = px[i + 1] / 255;
            const b = px[i + 2] / 255;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const d = max - min;
            if (d < 0.08) {
                // near-gray: keep its luminance for the B&W fallback below
                grayLum += (max + min) / 2;
                grayCount++;
                continue;
            }
            const l = (max + min) / 2;
            const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            let hue = 0;
            if (max === r) hue = ((g - b) / d) % 6;
            else if (max === g) hue = (b - r) / d + 2;
            else hue = (r - g) / d + 4;
            hue = hue * 60;
            if (hue < 0) hue += 360;
            const weight = s * s * l; // sat-weighted, per doc §6
            bins[Math.floor(hue / 10) % 36] += weight;
            totalSat += s;
            totalLig += l;
            count++;
        }
    }
    if (count === 0) {
        // Black & white (or otherwise grayscale) wallpaper: the hue histogram
        // is empty, but the image still has a character — its brightness.
        // Map luminance to a cool accent: very dark -> deep indigo, bright ->
        // pale ice, so B&W wallpapers get a usable accent too.
        if (grayCount === 0) return null;
        const lum = grayLum / grayCount;
        return {
            hue: (255 - lum * 80 + 360) % 360,
            sat: clamp(20 + lum * 10, 20, 30),
            lig: clamp(lum * 100, 20, 75),
        };
    }

    // Smoothed peak: pick the bin with the most neighbors' weight.
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < 36; i++) {
        const score = bins[(i + 35) % 36] + bins[i] * 2 + bins[(i + 1) % 36];
        if (score > bestScore) {
            bestScore = score;
            best = i;
        }
    }

    return {
        hue: (best * 10 + 5) % 360,
        sat: clamp((totalSat / count) * 100, 30, 85),
        lig: clamp((totalLig / count) * 100, 30, 65),
    };
}