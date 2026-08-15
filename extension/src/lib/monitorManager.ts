import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { ParticleLayer } from "./particleLayer.js";
import { WallpaperForeground } from "./wallpaperLayer.js";
import type { SceneClient } from "./sceneClient.js";
import type { PaletteAccent } from "./paletteManager.js";

interface MonitorEntry {
    monitor: any; // Meta.Monitor
    layer: ParticleLayer;
    /** §6 optional foreground mask provider (never paints anything). */
    foreground: WallpaperForeground | null;
    /** Layer origin/size in global coordinates (orientation-adjusted). */
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Obscured-window grid granularity (layer pixels per cell). */
const GRID_CELL = 48;

function monitorConnector(monitor: any): string {
    try {
        return monitor.connector ?? monitor.get_connector?.() ?? String(monitor.index);
    } catch (e) {
        return String(monitor.index);
    }
}

/**
 * One particle layer per monitor, inserted into the background group.
 * - Fullscreen: stop the layer's timeline entirely (not hide), unless the
 *   user disabled pause-on-fullscreen in settings.
 * - Per-screen: monitors whose connector is in settings "disabled-screens"
 *   get no layer (live, on schema change).
 * - Monitor churn: full rebuild on monitors-changed (destroy all, recreate).
 */
export class MonitorManager {
    private _client: SceneClient;
    private _settings: Gio.Settings | null;
    private _getAccent: () => PaletteAccent | null;
    private _entries: MonitorEntry[] = [];
    private _monitorsChangedId: number | null = null;
    private _fullscreenChangedId: number | null = null;
    private _settingsChangedId: number | null = null;
    private _obscuredPollId: number | null = null;
    /** Last covered/none band per layer size, for transition logging. */
    private _lastGridBand = new Map<string, number>();

    constructor(
        client: SceneClient,
        settings: Gio.Settings | null,
        getAccent: () => PaletteAccent | null
    ) {
        this._client = client;
        this._settings = settings;
        this._getAccent = getAccent;
    }

    enable() {
        this._monitorsChangedId = Main.layoutManager.connect(
            "monitors-changed",
            () => this._rebuild()
        );
        this._fullscreenChangedId = global.display.connect(
            "in-fullscreen-changed",
            () => this._updatePaused()
        );
        // Light poll (1.4Hz): pause a monitor's layer whenever any real
        // window covers part of it — covers fullscreen (even if the
        // signal missed it) and smaller windows, which the signal never
        // reports. Cost is negligible; the wall of window actors is small.
        this._obscuredPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            700,
            () => {
                this._updatePaused();
                return GLib.SOURCE_CONTINUE;
            }
        );
        this._settingsChangedId = this._settings?.connect(
            "changed",
            (_s: Gio.Settings, key: string) => {
                if (
                    key === "disabled-screens" ||
                    key === "master-enabled" ||
                    key === "wallpaper-layering" ||
                    key === "layering-threshold" ||
                    key === "pause-obscured"
                ) {
                    this._rebuild();
                }
            }
        ) ?? null;
        this._rebuild();
    }

    private _backgroundGroup() {
        const lm = Main.layoutManager as any;
        return lm.backgroundGroup ?? lm._backgroundGroup;
    }

    private _disabledConnectors(): Set<string> {
        const s = this._settings;
        if (!s) return new Set();
        return new Set(s.get_strv("disabled-screens"));
    }

    /** Screen list for the preferences window (it runs outside the shell
     *  and cannot see the compositor's monitors). */
    private _writeMonitorList(monitors: any[]) {
        try {
            const dir = `${GLib.getenv("XDG_RUNTIME_DIR") ?? "/tmp"}/live-wallpaper`;
            GLib.mkdir_with_parents(dir, 0o755);
            const list = monitors.map((m) => ({
                connector: monitorConnector(m),
                width: m.width,
                height: m.height,
            }));
            GLib.file_set_contents(`${dir}/monitors.json`, JSON.stringify(list));
        } catch (e) {}
    }

    private _orientationOverride(connector: string): string {
        const s = this._settings;
        if (!s) return "auto";
        for (const entry of s.get_strv("screen-orientations")) {
            const eq = entry.indexOf("=");
            if (eq > 0 && entry.slice(0, eq) === connector) {
                return entry.slice(eq + 1);
            }
        }
        return "auto";
    }

    private _rebuild() {
        // Full rebuild per contract §10: destroy everything, recreate.
        this._destroyEntries();
        const monitors = Main.layoutManager.monitors;
        const group = this._backgroundGroup();
        this._writeMonitorList(monitors);
        if (!group) return;

        const disabled = this._disabledConnectors();
        const s = this._settings;
        const masterOn = s ? s.get_boolean("master-enabled") : true;
        const layeringOn = s ? s.get_boolean("wallpaper-layering") : false;

        for (const monitor of monitors) {
            const connector = monitorConnector(monitor);
            if (disabled.has(connector)) continue;
            if (!masterOn) continue;

            // Orientation override: the user tells us how the screen is
            // physically rotated, and we shape the layer box accordingly
            // (centered within the monitor's layout box).
            let w = monitor.width;
            let h = monitor.height;
            const rot = this._orientationOverride(connector);
            if (rot === "90" || rot === "270") {
                if (w > h) [w, h] = [h, w];
            } else if (rot === "0" || rot === "180") {
                if (h > w) [w, h] = [h, w];
            }

            const actorX = monitor.x + Math.round((monitor.width - w) / 2);
            const actorY = monitor.y + Math.round((monitor.height - h) / 2);

            const layer = new ParticleLayer(
                this._client,
                w,
                h,
                this._settings,
                this._getAccent,
                () => {
                    // Cursor position in layer coordinates.
                    try {
                        const [gx, gy] = global.get_pointer();
                        return {
                            x: gx - actorX,
                            y: gy - actorY,
                        };
                    } catch (e) {
                        return null;
                    }
                }
            );
            const actor = layer.getActor();
            actor.set_position(actorX, actorY);
            group.add_child(actor);

            layer.start();

            // §6 optional layering: particle-suppression technique — the
            // foreground mask fades particles over the wallpaper's dark
            // regions. Nothing is repainted, so no double-image is possible.
            // Any failure yields a null mask and the layer stays flat.
            let foreground: WallpaperForeground | null = null;
            if (layeringOn) {
                foreground = new WallpaperForeground(w, h, this._settings);
                foreground.onChange((mask) =>
                    layer.setForegroundMask(mask, w, h)
                );
                foreground.enable();
                layer.setForegroundMask(foreground.getMask(), w, h);
            }

            this._entries.push({
                monitor,
                layer,
                foreground,
                x: actorX,
                y: actorY,
                w,
                h,
            });
        }
    }

    private _pauseOnFullscreen(): boolean {
        const s = this._settings;
        return s ? s.get_boolean("pause-fullscreen") : true;
    }

    /** Obscured-window grid in LAYER coordinates (orientation-adjusted):
     *  cell = 1 where any real window covers it. Windows spanning monitors
     *  mark cells on both. */
    private _coveredGrid(
        layerX: number,
        layerY: number,
        layerW: number,
        layerH: number
    ): Uint8Array {
        const cell = GRID_CELL;
        const cols = Math.ceil(layerW / cell);
        const rows = Math.ceil(layerH / cell);
        const grid = new Uint8Array(cols * rows);
        let actors = 0;
        let windows = 0;
        let covered = 0;
        try {
            for (const actor of global.get_window_actors()) {
                actors++;
                const win =
                    actor.metaWindow ??
                    actor.get_meta_window?.() ??
                    (actor as any).meta_window;
                if (!win || !win.get_visible()) continue;
                const type = win.get_window_type();
                if (type === 1 /* Meta.WindowType.DESKTOP */) continue;
                if (type === 2 /* Meta.WindowType.DOCK */) continue;
                windows++;
                const r = win.get_frame_rect();
                const ix0 = Math.max(r.x, layerX);
                const iy0 = Math.max(r.y, layerY);
                const ix1 = Math.min(r.x + r.width, layerX + layerW);
                const iy1 = Math.min(r.y + r.height, layerY + layerH);
                if (ix1 <= ix0 || iy1 <= iy0) continue;
                const gx0 = Math.max(0, Math.floor((ix0 - layerX) / cell));
                const gy0 = Math.max(0, Math.floor((iy0 - layerY) / cell));
                const gx1 = Math.min(
                    cols - 1,
                    Math.floor((ix1 - 1 - layerX) / cell)
                );
                const gy1 = Math.min(
                    rows - 1,
                    Math.floor((iy1 - 1 - layerY) / cell)
                );
                for (let gy = gy0; gy <= gy1; gy++) {
                    for (let gx = gx0; gx <= gx1; gx++) {
                        if (grid[gy * cols + gx] === 0) {
                            grid[gy * cols + gx] = 1;
                            covered++;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(
                `[live-wallpaper] grid scan failed: ${e}`
            );
            return grid;
        }
        // Diagnostic: report only on covered/none transitions (no spam).
        const key = `${layerW}x${layerH}`;
        const band = covered > 0 ? 1 : 0;
        if (this._lastGridBand.get(key) !== band) {
            this._lastGridBand.set(key, band);
            console.log(
                `[live-wallpaper] grid: ${windows}/${actors} windows, ` +
                    `${covered}/${grid.length} cells covered (${key})`
            );
        }
        return grid;
    }

    private _updatePaused() {
        const pauseFull = this._pauseOnFullscreen();
        const s = this._settings;
        const pauseObscured = s ? s.get_boolean("pause-obscured") : true;
        const inOverview = Main.overview?.visible ?? false;
        for (const entry of this._entries) {
            const fullscreen = global.display.get_monitor_in_fullscreen(
                entry.monitor.index
            );
            // Grid-based hiding: while enabled and not browsing the
            // overview, covered cells freeze+hide particles behind windows
            // of any size. Fullscreen still pauses the whole layer.
            let grid: Uint8Array | null = null;
            if (pauseObscured && !inOverview) {
                grid = this._coveredGrid(entry.x, entry.y, entry.w, entry.h);
            }
            entry.layer.setCoveredGrid(
                grid,
                Math.ceil(entry.w / GRID_CELL),
                GRID_CELL
            );
            if (pauseFull && fullscreen) {
                entry.layer.pause();
            } else {
                entry.layer.resume();
            }
        }
    }

    private _destroyEntries() {
        for (const entry of this._entries) {
            entry.foreground?.destroy();
            entry.layer.destroy();
        }
        this._entries = [];
    }

    disable() {
        if (this._monitorsChangedId !== null) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._fullscreenChangedId !== null) {
            global.display.disconnect(this._fullscreenChangedId);
            this._fullscreenChangedId = null;
        }
        if (this._obscuredPollId !== null) {
            GLib.source_remove(this._obscuredPollId);
            this._obscuredPollId = null;
        }
        if (this._settingsChangedId !== null) {
            this._settings?.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._destroyEntries();
    }
}