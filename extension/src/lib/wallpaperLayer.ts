import Cogl from "gi://Cogl";
import Clutter from "gi://Clutter";
import GdkPixbuf from "gi://GdkPixbuf";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import { buildCutoutMask, type CutoutResult } from "./wallpaperMask.js";

/**
 * §6 wallpaper layering — optional depth effect, strictly additive.
 *
 * Renders the wallpaper's foreground (dark regions: silhouettes, mountains,
 * skylines) as a masked image painted ABOVE the particle layer, so particles
 * appear to pass BEHIND the foreground while showing through the bright
 * background (sky).
 *
 * Contract: this module must never degrade the v1 wallpaper. It is opt-in
 * (schema key "wallpaper-layering", default false) and every failure path
 * simply removes the front actor — the particle layer is never touched.
 * The mask is computed once per wallpaper change (design doc: "runs once
 * per wallpaper change, so it can afford to be a little expensive"), at
 * display resolution, with a sanity check: if the mask covers almost none
 * or almost all of the image, layering is not meaningful — fall back to
 * flat (no front actor) instead of forcing a broken cutout.
 */

function clamp(v: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, v));
}

export class WallpaperLayer {
    private _actor: St.Widget;
    private _content: St.ImageContent | null = null;
    private _backgroundSettings!: Gio.Settings;
    private _settings: Gio.Settings | null;
    private _backgroundId: number | null = null;
    private _settingsId: number | null = null;
    private _width: number;
    private _height: number;
    private _threshold: number;
    private _enabled = true;
    private _destroyed = false;

    constructor(width: number, height: number, settings: Gio.Settings | null) {
        this._width = width;
        this._height = height;
        this._settings = settings;
        this._threshold = settings ? settings.get_double("layering-threshold") : 0.5;
        this._actor = new St.Widget({ reactive: false });
        this._actor.set_size(width, height);
    }

    getActor() {
        return this._actor;
    }

    enable() {
        if (this._destroyed) return;
        this._backgroundSettings = new Gio.Settings({
            schema_id: "org.gnome.desktop.background",
        });
        this._backgroundId = this._backgroundSettings.connect(
            "changed::picture-uri",
            () => this._rebuild()
        );
        if (this._settings) {
            this._settingsId = this._settings.connect(
                "changed::layering-threshold",
                () => {
                    this._threshold = this._settings?.get_double("layering-threshold") ?? 0.5;
                    this._rebuild();
                }
            );
        }
        this._rebuild();
    }

    resize(width: number, height: number) {
        this._width = width;
        this._height = height;
        this._actor.set_size(width, height);
        this._rebuild();
    }

    /** Opt-out on command (settings toggle off): removes the front actor. */
    setActive(active: boolean) {
        this._enabled = active;
        if (!active) this._clearContent();
    }

    /** Failure-safe: any exception in mask generation leaves the front
     *  actor empty — visually identical to v1 (no layering). */
    private _rebuild() {
        if (this._destroyed || !this._enabled) return;
        try {
            const uri = this._backgroundSettings.get_string("picture-uri");
            const pixbuf = this._loadScaled(uri);
            if (!pixbuf) {
                this._clearContent();
                return;
            }
            const mask = this._computeMask(pixbuf);
            if (!mask) {
                // Degenerate split (flat image, no clean silhouette): fall
                // back to flat overlay — never force a broken cutout.
                this._clearContent();
                return;
            }
            const masked = this._applyMask(pixbuf, mask);
            const w = masked.get_width();
            const h = masked.get_height();
            const stride = masked.get_rowstride();
            if (!this._content) {
                this._content = new St.ImageContent();
                this._actor.set_content(this._content);
            }
            this._content.set_bytes(
                Clutter.get_default_backend().get_cogl_context(),
                masked.get_pixels(),
                Cogl.PixelFormat.RGBA_8888,
                w,
                h,
                stride
            );
        } catch (e) {
            console.error(`[live-wallpaper] layering failed, flat fallback: ${e}`);
            this._clearContent();
        }
    }

    private _loadScaled(uri: string | null): GdkPixbuf.Pixbuf | null {
        if (!uri) return null;
        let path = uri;
        if (path.startsWith("file://")) path = decodeURIComponent(path.slice(7));
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
        try {
            return GdkPixbuf.Pixbuf.new_from_file_at_scale(
                path,
                this._width,
                this._height,
                true
            );
        } catch (e) {
            return null;
        }
    }

    private _computeMask(pb: GdkPixbuf.Pixbuf): CutoutResult | null {
        const n = pb.get_n_channels();
        const stride = pb.get_rowstride();
        const px = pb.get_pixels();
        const w = pb.get_width();
        const h = pb.get_height();
        return buildCutoutMask(w, h, (x, y) => {
            const i = y * stride + x * n;
            return (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
        }, this._threshold);
    }

    /** Applies the mask to the pixbuf's alpha channel (in-place when possible;
 *  if the source had no alpha channel, returns a new alpha-added pixbuf). */
    private _applyMask(pb: GdkPixbuf.Pixbuf, mask: CutoutResult): GdkPixbuf.Pixbuf {
        let target = pb;
        if (!target.get_has_alpha()) {
            target = target.add_alpha(false, 0, 0, 0)!;
        }
        const n = target.get_n_channels();
        const stride = target.get_rowstride();
        const px = target.get_pixels();
        const w = target.get_width();
        const h = target.get_height();
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * stride + x * n;
                px[i + 3] = Math.round(255 * clamp(mask.alpha[y * w + x], 0, 1));
            }
        }
        return target;
    }

    private _clearContent() {
        this._content = null;
        this._actor.set_content(null);
    }

    destroy() {
        this._destroyed = true;
        if (this._backgroundId !== null && this._backgroundSettings) {
            this._backgroundSettings.disconnect(this._backgroundId);
            this._backgroundId = null;
        }
        if (this._settingsId !== null) {
            this._settings?.disconnect(this._settingsId);
            this._settingsId = null;
        }
        try {
            this._actor.destroy();
        } catch (e) {}
    }
}