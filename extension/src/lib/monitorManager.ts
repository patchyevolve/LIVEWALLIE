import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { ParticleLayer } from "./particleLayer.js";
import { WallpaperLayer } from "./wallpaperLayer.js";
import type { SceneClient } from "./sceneClient.js";
import type { PaletteAccent } from "./paletteManager.js";

interface MonitorEntry {
    monitor: any; // Meta.Monitor
    layer: ParticleLayer;
    /** §6 optional front cutout, only when enabled and non-fatal. */
    layering: WallpaperLayer | null;
}

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
            () => this._updateFullscreen()
        );
        this._settingsChangedId = this._settings?.connect(
            "changed",
            (_s: Gio.Settings, key: string) => {
                if (
                    key === "disabled-screens" ||
                    key === "master-enabled" ||
                    key === "wallpaper-layering" ||
                    key === "layering-threshold"
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

            const layer = new ParticleLayer(
                this._client,
                w,
                h,
                this._settings,
                this._getAccent
            );
            const actor = layer.getActor();
            actor.set_position(
                monitor.x + Math.round((monitor.width - w) / 2),
                monitor.y + Math.round((monitor.height - h) / 2)
            );
            group.add_child(actor);

            layer.start();

            // §6 optional layering: front cutout painted ABOVE the particles
            // (added later = on top). Any failure inside leaves it empty and
            // the particle layer untouched — it can never break the wallpaper.
            let layering: WallpaperLayer | null = null;
            if (layeringOn) {
                layering = new WallpaperLayer(w, h, this._settings);
                const front = layering.getActor();
                front.set_position(
                    monitor.x + Math.round((monitor.width - w) / 2),
                    monitor.y + Math.round((monitor.height - h) / 2)
                );
                group.add_child(front);
                layering.enable();
            }

            this._entries.push({ monitor, layer, layering });
        }
    }

    private _pauseOnFullscreen(): boolean {
        const s = this._settings;
        return s ? s.get_boolean("pause-fullscreen") : true;
    }

    private _updateFullscreen() {
        const pause = this._pauseOnFullscreen();
        for (const entry of this._entries) {
            const inFullscreen = global.display.get_monitor_in_fullscreen(
                entry.monitor.index
            );
            if (pause && inFullscreen) {
                entry.layer.pause();
            } else {
                entry.layer.resume();
            }
        }
    }

    private _destroyEntries() {
        for (const entry of this._entries) {
            entry.layering?.destroy();
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
        if (this._settingsChangedId !== null) {
            this._settings?.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._destroyEntries();
    }
}