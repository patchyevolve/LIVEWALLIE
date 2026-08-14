/* Preferences for the Live Wallpaper extension (GNOME 50 contract:
 * default-exported class, constructed with {dir, path, ...metadata},
 * then `await prefs.fillPreferencesWindow(window)` is called with the
 * Adw.PreferencesWindow. Every control binds to GSettings, so changes apply
 * to the running extension immediately.
 */

import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import GdkPixbuf from "gi://GdkPixbuf?version=2.0";
import { extractAccent } from "./lib/paletteManager.js";
import { applyMaskToPixbuf, buildCutoutMask } from "./lib/wallpaperMask.js";

const SCHEMA_ID = "org.gnome.shell.extensions.live-wallpaper@codeworks2";

const ORIENTATION_OPTIONS = [
    ["auto", "Auto (follow system)"],
    ["0", "Landscape"],
    ["90", "Portrait"],
    ["180", "Inverted landscape"],
    ["270", "Inverted portrait"],
];

function hueToRgba(hue) {
    // HSV->RGB for a fully saturated, mid-lightness swatch of the given hue.
    const c = 0.7;
    const hp = ((hue % 360) + 360) % 360 / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return new Gdk.RGBA({ red: r, green: g, blue: b, alpha: 1 });
}

function rgbaToHue(rgba) {
    const r = rgba.red, g = rgba.green, b = rgba.blue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    if (d < 1e-6) return 0;
    let h = 0;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return h;
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function addScale(group, settings, title, key, lo, hi, step) {
    const row = new Adw.ActionRow({ title });
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        valign: Gtk.Align.CENTER,
        hexpand: true,
    });
    scale.set_range(lo, hi);
    scale.set_increments(step, 0);
    scale.set_value(1);
    row.add_suffix(scale);
    group.add(row);
    if (settings) {
        // GTK4 GtkScale has no bindable "value" property — sync manually.
        scale.connect("value-changed", () => {
            settings.set_double(key, scale.get_value());
        });
        settings.connect(`changed::${key}`, () => {
            scale.set_value(settings.get_double(key));
        });
    }
    return scale;
}

function addSwitch(group, settings, title, subtitle, key) {
    const row = new Adw.ActionRow({ title, subtitle });
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    row.add_suffix(sw);
    row.set_activatable_widget(sw);
    group.add(row);
    if (settings) settings.bind(key, sw, "active", Gio.SettingsBindFlags.DEFAULT);
    return sw;
}

function monitorsFromShell() {
    try {
        // The Meta typelib is only available inside the shell or on systems
        // with the gir installed; never fatal, the file fallback covers it.
        const Meta = imports.gi.Meta;
        if (!Meta?.MonitorManager) return [];
        const mgr = Meta.MonitorManager.get();
        const monitors = mgr.get_monitors();
        const out = [];
        for (let i = 0; i < monitors.get_length(); i++) {
            const m = monitors.item(i);
            out.push({ connector: m.get_connector() || `monitor-${i}` });
        }
        return out;
    } catch (e) {
        return [];
    }
}

function monitorsFromFile() {
    try {
        const p = `${GLib.getenv("XDG_RUNTIME_DIR") || "/tmp"}/live-wallpaper/monitors.json`;
        const [ok, contents] = GLib.file_get_contents(p);
        if (!ok || contents === null) return [];
        return JSON.parse(new TextDecoder().decode(contents)).map((m) => ({ connector: m.connector }));
    } catch (e) {
        return [];
    }
}

export default class LiveWallpaperPrefs {
    constructor(options) {
        this._dir = options?.dir ?? null;
    }

    _settings() {
        const dir = this._dir;
        if (dir) {
            try {
                const src = Gio.SettingsSchemaSource.new_from_directory(
                    dir.get_child("schemas").get_path() ?? "",
                    Gio.SettingsSchemaSource.get_default(),
                    false
                );
                const schema = src.lookup(SCHEMA_ID, true);
                if (schema) return new Gio.Settings({ settings_schema: schema });
            } catch (e) {}
        }
        const fallback = Gio.SettingsSchemaSource.get_default().lookup(SCHEMA_ID, true);
        return fallback ? new Gio.Settings({ settings_schema: fallback }) : null;
    }

    async fillPreferencesWindow(window) {
        const settings = this._settings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        if (!settings) {
            page.add(
                new Adw.PreferencesGroup({
                    title: "Schema not found",
                    description:
                        "The extension schema could not be loaded. Try reinstalling the extension.",
                })
            );
            return;
        }

        // ---- General ---------------------------------------------------
        const general = new Adw.PreferencesGroup({ title: "General" });
        addSwitch(
            general,
            settings,
            "Enable wallpaper",
            "Master switch for the particle field",
            "master-enabled"
        );
        addSwitch(
            general,
            settings,
            "Pause in fullscreen",
            "Stop the animation while a window covers a screen",
            "pause-fullscreen"
        );
        page.add(general);

        // ---- System mode -----------------------------------------------
        const system = new Adw.PreferencesGroup({
            title: "System mode (idle)",
            description:
                "The parallax starfield that runs when no music is playing. Near stars drift faster than far ones.",
        });
        addScale(system, settings, "Drift speed", "idle-speed", 0, 5, 0.1);
        addSwitch(system, settings, "Shimmer", "Subtle vertical wave on the field", "shimmer");
        page.add(system);

        // ---- Music mode ------------------------------------------------
        const music = new Adw.PreferencesGroup({
            title: "Music mode",
            description:
                "Behaviors that react to audio: bass, beats, and network/pan streams.",
        });
        addScale(music, settings, "Music speed", "music-speed", 0, 5, 0.1);
        addSwitch(music, settings, "Bass rain", "Bass pulls particles downward", "bass-gravity");
        addScale(music, settings, "Bass strength", "bass-strength", 0, 3, 0.1);
        addSwitch(
            music,
            settings,
            "Beat surge",
            "Beats accelerate the field along its drift direction",
            "beat-surge"
        );
        addScale(music, settings, "Beat strength", "beat-strength", 0, 3, 0.1);
        addSwitch(music, settings, "Beat flash", "Beats flash particles white", "beat-flash");
        addSwitch(
            music,
            settings,
            "Stream drift",
            "Network / stereo-pan activity pushes the field sideways",
            "stream-drift"
        );
        addScale(music, settings, "Stream strength", "stream-strength", 0, 3, 0.1);
        page.add(music);

        // ---- Colors ----------------------------------------------------
        const colors = new Adw.PreferencesGroup({
            title: "Colors",
            description:
                "Where the particle hue comes from. In every mode, activity sweeps a small arc around the chosen base.",
        });
        page.add(colors);

        {
            const row = new Adw.ActionRow({ title: "Palette source" });
            const combo = Gtk.DropDown.new_from_strings([
                "Built-in arc (indigo → magenta → ember)",
                "My hue (color picker)",
                "From wallpaper (auto accent)",
            ]);
            combo.valign = Gtk.Align.CENTER;
            row.add_suffix(combo);
            row.set_activatable_widget(combo);
            colors.add(row);
            const modeMap = ["arc", "fixed", "wallpaper"];
            combo.connect("notify::selected", () => {
                if (combo.selected >= 0 && combo.selected < modeMap.length) {
                    settings.set_string("palette-mode", modeMap[combo.selected]);
                }
            });

            // Fixed hue: real color button (opens the GTK color chooser
            // window), synced both ways with the fixed-hue setting.
            const hueRow = new Adw.ActionRow({
                title: "My hue",
                subtitle: "Open the color picker, or drag the slider",
            });
            const colorBtn = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.START,
                rgba: hueToRgba(settings.get_double("fixed-hue")),
            });
            hueRow.add_suffix(colorBtn);
            const hueScale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                valign: Gtk.Align.CENTER,
                hexpand: true,
            });
            hueScale.set_range(0, 360);
            hueScale.set_increments(5, 0);
            hueScale.set_value(settings.get_double("fixed-hue"));
            hueRow.add_suffix(hueScale);
            colors.add(hueRow);

            let applying = false;
            colorBtn.connect("notify::rgba", () => {
                if (applying) return;
                settings.set_double("fixed-hue", rgbaToHue(colorBtn.get_rgba()));
            });
            hueScale.connect("value-changed", () => {
                settings.set_double("fixed-hue", hueScale.get_value());
            });
            const sync = () => {
                const mode = settings.get_string("palette-mode");
                const idx = modeMap.indexOf(mode);
                combo.selected = idx < 0 ? 0 : idx;
                hueRow.sensitive = mode === "fixed";
                hueScale.sensitive = mode === "fixed";
                if (mode === "fixed") {
                    applying = true;
                    colorBtn.set_rgba(hueToRgba(settings.get_double("fixed-hue")));
                    hueScale.set_value(settings.get_double("fixed-hue"));
                    applying = false;
                }
            };
            sync();
            settings.connect("changed::palette-mode", sync);
            settings.connect("changed::fixed-hue", sync);

            // Wallpaper accent: live swatch + hue-shift control.
            const accentRow = new Adw.ActionRow({
                title: "Wallpaper accent",
                subtitle: "Auto-extracted from the current wallpaper",
            });
            const accentBtn = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                halign: Gtk.Align.START,
            });
            accentRow.add_suffix(accentBtn);
            // Purely a swatch: if the user opens the picker from it, restore
            // the extracted color. The flag stops the set_rgba -> notify::rgba
            // -> refreshAccent loop.
            let accentSyncing = false;
            accentBtn.connect("notify::rgba", () => {
                if (accentSyncing) return;
                refreshAccent();
            });
            const shiftScale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                valign: Gtk.Align.CENTER,
                hexpand: true,
            });
            shiftScale.set_range(-180, 180);
            shiftScale.set_increments(5, 0);
            shiftScale.set_value(0);
            accentRow.add_suffix(shiftScale);
            colors.add(accentRow);

            const bgSettings = Gio.Settings.new("org.gnome.desktop.background");
            // Cache the extraction: re-decoding the full-res wallpaper on every
            // shift-slider tick froze the dialog. Extract once per wallpaper;
            // slider moves only recompute the color from the cached accent.
            let cachedAccent = null;
            const refreshAccent = () => {
                const mode = settings.get_string("palette-mode");
                const shift = settings.get_double("accent-shift");
                if (cachedAccent === null) {
                    cachedAccent = extractAccent(bgSettings.get_string("picture-uri"));
                }
                const accent = cachedAccent;
                if (accent) {
                    accentSyncing = true;
                    accentBtn.set_rgba(
                        hueToRgba((accent.hue + shift + 360) % 360)
                    );
                    accentSyncing = false;
                    if (accent.sat <= 30)
                        accentRow.subtitle =
                            "B&W wallpaper — accent follows its brightness";
                    else
                        accentRow.subtitle =
                            `Extracted hue ${Math.round(accent.hue)}° — shift adjusts it`;
                } else {
                    accentSyncing = true;
                    accentBtn.set_rgba(new Gdk.RGBA({ red: 0.2, green: 0.2, blue: 0.2, alpha: 1 }));
                    accentSyncing = false;
                    accentRow.subtitle = "Could not read the wallpaper image";
                }
                shiftScale.sensitive = mode === "wallpaper";
                accentBtn.sensitive = false;
            };
            refreshAccent();
            shiftScale.connect("value-changed", () => {
                settings.set_double("accent-shift", shiftScale.get_value());
                refreshAccent();
            });
            settings.connect("changed::accent-shift", () => {
                shiftScale.set_value(settings.get_double("accent-shift"));
                refreshAccent();
            });
            settings.connect("changed::palette-mode", refreshAccent);
            bgSettings.connect("changed::picture-uri", () => {
                cachedAccent = null;
                refreshAccent();
            });
        }

        // ---- Wallpaper layering (§6) ------------------------------------
        const layering = new Adw.PreferencesGroup({
            title: "Wallpaper layering",
            description:
                "Optional depth effect: particles pass behind the dark foreground of your wallpaper (mountains, skylines). Off by default; fades out automatically when the image has no clean split.",
        });
        const layeringRow = new Adw.ActionRow({
            title: "Enable layering",
        });
        const layeringSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active: settings.get_boolean("wallpaper-layering"),
        });
        layeringRow.add_suffix(layeringSwitch);
        layeringRow.set_activatable_widget(layeringSwitch);
        layering.add(layeringRow);
        settings.bind(
            "wallpaper-layering",
            layeringSwitch,
            "active",
            Gio.SettingsBindFlags.DEFAULT
        );
        addScale(layering, settings, "Silhouette cutoff", "layering-threshold", 0.1, 0.9, 0.05);
        page.add(layering);

        // Cutout preview — the actual wallpaper picture with the current
        // mask applied, always visible so the cutoff slider is tunable.
        // Computed at preview size from a cached downsample; the slider
        // never re-decodes the full-resolution wallpaper.
        const preview = new Adw.PreferencesGroup({
            title: "Cutout preview",
        });
        const picture = new Gtk.Picture({
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.FILL,
            hexpand: true,
            height_request: 240,
            margin_top: 6,
            margin_bottom: 6,
            can_shrink: true,
        });
        preview.add(picture);
        const previewLabel = new Gtk.Label({
            label: "",
            halign: Gtk.Align.START,
            wrap: true,
            xalign: 0,
            margin_bottom: 6,
        });
        preview.add(previewLabel);
        page.add(preview);

        let previewCache = null; // {pb: Pixbuf, w, h, uri}
        const bgSettings = Gio.Settings.new("org.gnome.desktop.background");
        const loadPreview = () => {
            const uri = bgSettings.get_string("picture-uri");
            if (previewCache && previewCache.uri === uri) return previewCache;
            previewCache = null;
            let path = uri || "";
            if (path.startsWith("file://")) path = decodeURIComponent(path.slice(7));
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
            try {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 640, 640, true);
                previewCache = { pb, w: pb.get_width(), h: pb.get_height(), uri };
                return previewCache;
            } catch (e) {
                return null;
            }
        };
        const renderPreview = () => {
            const cached = loadPreview();
            if (!cached) {
                picture.paintable = null;
                previewLabel.label = "Could not read the wallpaper image";
                return;
            }
            const { pb, w, h } = cached;
            const stride = pb.get_rowstride();
            const n = pb.get_n_channels();
            const px = pb.get_pixels();
            const threshold = settings.get_double("layering-threshold");
            const mask = buildCutoutMask(w, h, (x, y) => {
                const i = y * stride + x * n;
                return (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
            }, threshold);
            const pct = mask ? Math.round(mask.coverage * 100) : null;
            if (mask === null) {
                picture.paintable = null;
                previewLabel.label =
                    `No clean split at this cutoff (foreground ${pct ?? "—"}%) — effect off. ` +
                    "Drag the cutoff toward the other end.";
                return;
            }
            let out = applyMaskToPixbuf(pb, mask.alpha);
            picture.paintable = Gdk.Texture.new_for_pixbuf(out);
            previewLabel.label =
                `Foreground covers ${pct}% of the image — the masked area is painted ` +
                "on top of the particles; the rest stays transparent.";
        };
        renderPreview();
        settings.connect("changed::layering-threshold", renderPreview);
        bgSettings.connect("changed::picture-uri", () => {
            previewCache = null;
            renderPreview();
        });
        addScale(layering, settings, "Silhouette cutoff", "layering-threshold", 0.1, 0.9, 0.05);
        page.add(layering);

        // ---- Screens ---------------------------------------------------
        const screens = new Adw.PreferencesGroup({
            title: "Screens",
            description:
                "Hide the wallpaper on a screen, or tell it how that screen is physically rotated.",
        });
        page.add(screens);

        const monitors = monitorsFromShell();
        const monitorList = monitors.length > 0 ? monitors : monitorsFromFile();
        if (monitorList.length === 0) {
            screens.add(
                new Adw.ActionRow({
                    title: "No screens detected",
                    subtitle:
                        "If you just enabled the extension, log out and back in once to sync the screen list.",
                })
            );
        }

        for (const mon of monitorList) {
            const row = new Adw.ActionRow({ title: mon.connector });
            const combo = Gtk.DropDown.new_from_strings(
                ORIENTATION_OPTIONS.map((o) => o[1])
            );
            combo.valign = Gtk.Align.CENTER;
            row.add_suffix(combo);

            const hiddenSw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
            row.add_suffix(hiddenSw);
            row.set_activatable_widget(hiddenSw);

            const sync = () => {
                const hidden = settings
                    .get_strv("disabled-screens")
                    .includes(mon.connector);
                hiddenSw.active = hidden;
                let sel = 0;
                for (const entry of settings.get_strv("screen-orientations")) {
                    const eq = entry.indexOf("=");
                    if (eq > 0 && entry.slice(0, eq) === mon.connector) {
                        const v = entry.slice(eq + 1);
                        const i = ORIENTATION_OPTIONS.findIndex((o) => o[0] === v);
                        if (i >= 0) sel = i;
                    }
                }
                combo.selected = sel;
                combo.sensitive = !hidden;
                row.subtitle = hidden ? "Hidden" : "Rotation for this screen";
            };
            sync();

            hiddenSw.connect("notify::active", () => {
                let list = settings.get_strv("disabled-screens").slice();
                if (hiddenSw.active) {
                    if (!list.includes(mon.connector)) list.push(mon.connector);
                } else {
                    list = list.filter((c) => c !== mon.connector);
                }
                settings.set_strv("disabled-screens", list);
                sync();
            });

            combo.connect("notify::selected", () => {
                if (combo.selected < 0 || combo.selected >= ORIENTATION_OPTIONS.length) return;
                const value = ORIENTATION_OPTIONS[combo.selected][0];
                const overrides = settings
                    .get_strv("screen-orientations")
                    .filter((e) => !e.startsWith(`${mon.connector}=`));
                if (value !== "auto") overrides.push(`${mon.connector}=${value}`);
                settings.set_strv("screen-orientations", overrides);
            });

            screens.add(row);
        }

        window.set_default_size(560, 720);
    }
}