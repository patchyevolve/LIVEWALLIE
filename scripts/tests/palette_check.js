// GJS module-load + palette acceptance tests.
// Usage: gjs palette_check.js <extensionDir>

const EXT = ARGV[0];
const system = imports.system;

let failures = 0;
function check(name, ok, detail = "") {
    print(`  [${ok ? "PASS" : "FAIL"}] ${name}` + (detail ? ` (${detail})` : ""));
    if (!ok) failures++;
}

// monitorManager imports shell resources (org/gnome/shell/ui/main.js) and is
// only loadable inside gnome-shell — covered by tsc + live deployment.
const modules = [
    "lib/sceneState.js",
    "lib/sceneClient.js",
    "lib/paletteManager.js",
    "prefs.js",
];

function importMod(rel) {
    return import("file://" + EXT + "/" + rel);
}

async function main() {
    const results = await Promise.allSettled(modules.map(importMod));
    modules.forEach((m, i) => {
        check(`module loads: ${m}`, results[i].status === "fulfilled",
            results[i].status === "fulfilled" ? "" : String(results[i].reason));
    });

    const { extractAccent } = await importMod("lib/paletteManager.js");

    // Solid red -> hue must be ~0 (deterministic).
    const red = extractAccent("file:///tmp/opencode/test_red.png");
    check("solid red wallpaper -> accent extracted", red !== null,
        red ? `hue=${red.hue.toFixed(0)}` : "");
    check("solid red accent hue ~0",
        red !== null && (red.hue < 10 || red.hue > 350),
        red ? `hue=${red.hue.toFixed(0)}` : "");

    // B&W gradient -> luminance fallback (desaturated accent).
    const bw = extractAccent("file:///tmp/opencode/test_bw.png");
    check("B&W wallpaper -> luminance fallback accent", bw !== null,
        bw ? `hue=${bw.hue.toFixed(0)} sat=${bw.sat.toFixed(0)} lig=${bw.lig.toFixed(0)}` : "");
    check("B&W fallback is desaturated (sat <= 30)",
        bw !== null && bw.sat <= 30, bw ? `sat=${bw.sat.toFixed(0)}` : "");

    check("missing file -> null", extractAccent("file:///nonexistent.png") === null);
    check("null uri -> null", extractAccent(null) === null);

    if (failures) {
        print(`PALETTE/MODULE: ${failures} FAILED`);
        system.exit(1);
    }
    print("PALETTE/MODULE: all checks passed");
    system.exit(0);
}

main().catch((e) => {
    print("PALETTE/MODULE: exception: " + e);
    system.exit(1);
});