import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { SceneClient } from "./lib/sceneClient.js";
import { MonitorManager } from "./lib/monitorManager.js";
import { PaletteManager } from "./lib/paletteManager.js";

const SAMPLER_BINARY = "live-wallpaper-sampler";
const MAX_SAMPLER_SPAWNS_PER_SESSION = 3;
const SETTINGS_SCHEMA = "org.gnome.shell.extensions.live-wallpaper@codeworks2";

export default class LiveWallpaperExtension extends Extension {
    private _client: SceneClient | null = null;
    private _monitors: MonitorManager | null = null;
    private _palette: PaletteManager | null = null;
    private _settings: Gio.Settings | null = null;
    private _subprocess: Gio.Subprocess | null = null;
    private _spawnAttempts = 0;
    private _respawnId: number | null = null;
    private _connectedOnce = false;

    private _getSettings(): Gio.Settings | null {
        if (this._settings) return this._settings;
        try {
            // Schema ships in the extension dir; falls back to null if the
            // schemas dir wasn't compiled, and every behavior keeps its
            // built-in default in that case.
            const schema = Gio.SettingsSchemaSource.new_from_directory(
                this.dir.get_child("schemas").get_path() ?? "",
                Gio.SettingsSchemaSource.get_default(),
                false
            );
            const resolved = schema.lookup(SETTINGS_SCHEMA, true);
            if (resolved) {
                this._settings = new Gio.Settings({
                    settings_schema: resolved,
                });
            }
        } catch (e) {}
        return this._settings;
    }

    enable() {
        const runtimeDir = GLib.getenv("XDG_RUNTIME_DIR") ?? "/tmp";
        const socketPath = `${runtimeDir}/live-wallpaper/scene.sock`;

        this._settings = this._getSettings();

        this._palette = new PaletteManager();
        this._palette.enable();

        this._client = new SceneClient(socketPath);
        this._client.setOnConnectionChange((connected) => {
            if (connected && !this._connectedOnce) {
                this._connectedOnce = true;
                console.log(
                    "[live-wallpaper] connected to sampler over IPC"
                );
            }
        });
        this._client.connect();

        this._monitors = new MonitorManager(
            this._client,
            this._settings,
            () => this._palette?.getAccent() ?? null
        );
        this._monitors.enable();

        this._spawnSampler();
    }

    private _samplerBinaryPath(): string | null {
        try {
            return this.dir
                .get_child("sampler")
                .get_child(SAMPLER_BINARY)
                .get_path();
        } catch (e) {
            return null;
        }
    }

    private _spawnSampler() {
        if (this._subprocess) return;

        const binaryPath = this._samplerBinaryPath();
        if (!binaryPath) {
            console.error(
                "[live-wallpaper] sampler binary not found; rendering static idle field"
            );
            return;
        }

        try {
            this._subprocess = new Gio.Subprocess({
                argv: [binaryPath],
                flags: Gio.SubprocessFlags.NONE,
            });
            this._subprocess.init(null);
        } catch (e) {
            console.error(
                `[live-wallpaper] failed to start sampler: ${e}`
            );
            this._subprocess = null;
            return;
        }

        // If the sampler exits before we ever connected, retry (max 3/session).
        this._subprocess.wait_async(null, (proc, res) => {
            try {
                proc?.wait_finish(res);
            } catch (e) {}
            this._subprocess = null;
            if (!this._connectedOnce && this._spawnAttempts < MAX_SAMPLER_SPAWNS_PER_SESSION) {
                this._spawnAttempts++;
                console.warn(
                    `[live-wallpaper] sampler exited before connecting; respawning (${this._spawnAttempts}/${MAX_SAMPLER_SPAWNS_PER_SESSION})`
                );
                this._respawnId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    2,
                    () => {
                        this._respawnId = null;
                        this._spawnSampler();
                        return GLib.SOURCE_REMOVE;
                    }
                );
            } else if (this._spawnAttempts >= MAX_SAMPLER_SPAWNS_PER_SESSION) {
                console.error(
                    "[live-wallpaper] sampler failed repeatedly; rendering static idle field"
                );
            }
        });
    }

    disable() {
        if (this._respawnId !== null) {
            GLib.source_remove(this._respawnId);
            this._respawnId = null;
        }
        this._monitors?.disable();
        this._monitors = null;

        this._palette?.disable();
        this._palette = null;

        this._client?.destroy();
        this._client = null;

        if (this._subprocess) {
            try {
                this._subprocess.force_exit();
                this._subprocess.wait(null);
            } catch (e) {}
            this._subprocess = null;
        }
        this._spawnAttempts = 0;
        this._connectedOnce = false;
    }
}