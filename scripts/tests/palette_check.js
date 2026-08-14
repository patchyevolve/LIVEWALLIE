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

    // §6 cutout mask: pure function, testable standalone.
    const { buildCutoutMask, applyMaskToPixbuf } = await importMod("lib/wallpaperMask.js");
    const GdkPixbuf = imports.gi.GdkPixbuf;

    // Regression: get_pixels() returns a COPY in modern GJS — mask writes
    // must land in the pixbuf, or the front layer renders fully opaque.
    const src = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 8, 8);
    src.fill(0x808080ff);
    const alpha = new Array(64).fill(1);
    for (let i = 0; i < 32; i++) alpha[i] = 0;
    const masked = applyMaskToPixbuf(src, alpha);
    const mPx = masked.get_pixels();
    const mN = masked.get_n_channels();
    check("masked pixbuf has alpha channel", masked.get_has_alpha(), `channels=${mN}`);
    check("masked pixbuf alpha lands (0 in top half)",
        mPx[3] === 0, `a=${mPx[3]}`);
    check("masked pixbuf alpha lands (255 in bottom half)",
        mPx[(7 * masked.get_rowstride()) + 3] === 255,
        `a=${mPx[(7 * masked.get_rowstride()) + 3]}`);

    // Sky (bright) top half, dark silhouette bottom half -> valid split.
    const split = buildCutoutMask(64, 64, (x, y) => (y < 32 ? 0.8 : 0.2), 0.5);
    check("mask: sky/silhouette split valid", split !== null,
        split ? `coverage=${split.coverage.toFixed(2)}` : "");
    check("mask: bottom half masked foreground (coverage ~0.5)",
        split !== null && Math.abs(split.coverage - 0.5) < 0.1,
        split ? `coverage=${split.coverage.toFixed(2)}` : "");
    check("mask: dark pixels alpha=1, bright alpha=0",
        split !== null &&
            split.alpha[10 * 64 + 10] === 0 && // bright top-left
            split.alpha[40 * 64 + 10] === 1, // dark bottom-left
        split ? `top=${split.alpha[10 * 64 + 10]} bottom=${split.alpha[40 * 64 + 10]}` : "");

    check("mask: all-bright image -> null (no split)",
        buildCutoutMask(64, 64, () => 0.9, 0.5) === null);
    check("mask: all-dark image -> null (no split)",
        buildCutoutMask(64, 64, () => 0.1, 0.5) === null);
    check("mask: threshold respected (dark cutoff moves)",
        buildCutoutMask(64, 64, (x, y) => (y < 32 ? 0.4 : 0.15), 0.3) !== null);

    // Fade near the coverage bounds: the effect must not pop on/off.
    const nearFloor = buildCutoutMask(100, 100,
        (x, y) => (x < 14 && y < 14 ? 0.05 : 0.9), 0.5); // ~2% foreground
    check("mask: coverage below floor -> null (faded out)",
        nearFloor === null, nearFloor ? `coverage=${nearFloor.coverage.toFixed(3)}` : "");
    const midFade = buildCutoutMask(100, 100,
        (x, y) => (x < 28 && y < 28 ? 0.05 : 0.9), 0.5); // ~8% foreground
    check("mask: near-floor coverage scales alpha down",
        midFade !== null && midFade.coverage > 0.07 && midFade.coverage < 0.09 &&
            midFade.alpha[0] < 1.0,
        midFade
            ? `coverage=${midFade.coverage.toFixed(3)} alpha0=${midFade.alpha[0].toFixed(2)}`
            : "");

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