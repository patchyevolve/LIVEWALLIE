import GdkPixbuf from "gi://GdkPixbuf";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { computeCoverMask, type MaskMode } from "./wallpaperMask.js";

/**
 * §6 wallpaper layering — the particle-suppression technique.
 *
 * v1.1: the original approach repainted the wallpaper as a masked front
 * actor. That could never match GNOME's own background rendering (cover
 * crop, zoom mode, per-monitor geometry), so on some monitors the cutout
 * was visibly misaligned — "wallpaper looks double". Instead of painting
 * anything, we now compute a foreground mask in the layer's own coordinate
 * space (cover-fit sampling, exactly like the desktop paints it) and the
 * particle layer simply fades particles over foreground pixels. The
 * wallpaper itself is never touched, so double-imaging is impossible by
 * construction.
 *
 * Contract: opt-in (schema key "wallpaper-layering", default false).
 * Mask computation runs once per wallpaper/geometry/threshold change and
 * is cached; failures return null (particles stay flat). This module uses
 * only GI bindings — no shell resources — so it loads in the standalone
 * acceptance harness.
 */

export type ForegroundMask = number[] | null;

export class WallpaperForeground {
    private _settings: Gio.Settings | null;
    private _backgroundSettings: Gio.Settings;
    private _width: number;
    private _height: number;
    private _srcCache: { uri: string; pb: GdkPixbuf.Pixbuf | null } | null =
        null;
    private _maskCache: {
        uri: string;
        w: number;
        h: number;
        threshold: number;
        invert: boolean;
        mode: MaskMode;
        alpha: ForegroundMask;
    } | null = null;
    private _ids: number[] = [];
    private _onChange: (mask: ForegroundMask) => void = () => {};
    private _destroyed = false;

    constructor(width: number, height: number, settings: Gio.Settings | null) {
        this._width = width;
        this._height = height;
        this._settings = settings;
        this._backgroundSettings = new Gio.Settings({
            schema_id: "org.gnome.desktop.background",
        });
    }

    /** Called whenever the effective mask changes (wallpaper or cutoff). */
    onChange(cb: (mask: ForegroundMask) => void) {
        this._onChange = cb;
    }

    enable() {
        if (this._destroyed) return;
        this._ids.push(
            this._backgroundSettings.connect("changed::picture-uri", () =>
                this._refresh()
            )
        );
        if (this._settings) {
            this._ids.push(
                this._settings.connect("changed::layering-threshold", () =>
                    this._refresh()
                )
            );
            this._ids.push(
                this._settings.connect("changed::layering-invert", () =>
                    this._refresh()
                )
            );
            this._ids.push(
                this._settings.connect("changed::layering-mode", () =>
                    this._refresh()
                )
            );
        }
    }

    private _refresh() {
        this._srcCache = null;
        this._maskCache = null;
        this._onChange(this.getMask());
    }

    /** Foreground alpha in layer coordinates (row-major, w*h entries), or
     *  null when layering is off / the image has no clean split. Cached. */
    getMask(): ForegroundMask {
        const s = this._settings;
        if (this._destroyed || !s || !s.get_boolean("wallpaper-layering")) {
            return null;
        }
        const uri = this._backgroundSettings.get_string("picture-uri");
        const threshold = s.get_double("layering-threshold");
        const invert = s.get_boolean("layering-invert");
        const mode = (s.get_string("layering-mode") ?? "auto") as MaskMode;
        if (
            this._maskCache &&
            this._maskCache.uri === uri &&
            this._maskCache.w === this._width &&
            this._maskCache.h === this._height &&
            this._maskCache.threshold === threshold &&
            this._maskCache.invert === invert &&
            this._maskCache.mode === mode
        ) {
            return this._maskCache.alpha;
        }
        if (!this._srcCache || this._srcCache.uri !== uri) {
            this._srcCache = { uri, pb: WallpaperForeground._loadPixbuf(uri) };
        }
        const pb = this._srcCache.pb;
        const result =
            pb === null
                ? null
                : computeCoverMask(
                      pb,
                      this._width,
                      this._height,
                      threshold,
                      invert,
                      mode
                  );
        const alpha: ForegroundMask = result?.alpha ?? null;
        log(
            `[live-wallpaper] layering mask ${this._width}x${this._height}: ${
                result ? `coverage=${result.coverage.toFixed(2)}` : "null"
            }`
        );
        this._maskCache = {
            uri,
            w: this._width,
            h: this._height,
            threshold,
            invert,
            mode,
            alpha,
        };
        return alpha;
    }

    private static _loadPixbuf(uri: string): GdkPixbuf.Pixbuf | null {
        let path = uri || "";
        if (path.startsWith("file://")) {
            path = decodeURIComponent(path.slice(7));
        }
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
        try {
            return GdkPixbuf.Pixbuf.new_from_file(path);
        } catch (e) {
            return null;
        }
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._ids) {
            this._backgroundSettings.disconnect(id);
        }
        this._ids = [];
        this._srcCache = null;
        this._maskCache = null;
    }
}