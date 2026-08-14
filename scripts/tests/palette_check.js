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
    const { buildCutoutMask, applyMaskToPixbuf, computeCoverMask, invertCutout } = await importMod("lib/wallpaperMask.js");
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

    // Cover-fit sampling: portrait source (8 wide × 16 tall) onto a
    // 4×4 layer. scale = max(4/8, 4/16) = 0.5 -> 4×8 scaled; the center
    // window is scaled rows 2..5 = src rows 4..11. Source: bright rows
    // 0-3 and 8-15, dark rows 4-7 -> window = dark, dark, bright, bright.
    // Built via new_from_bytes: get_pixels() returns a copy, so direct
    // writes would silently vanish.
    const GLib = imports.gi.GLib;
    const coverBuf = new Uint8Array(8 * 16 * 3);
    for (let y = 0; y < 16; y++) {
        const v = y < 4 || y >= 8 ? 0xee : 0x11;
        for (let x = 0; x < 8; x++) {
            const i = (y * 8 + x) * 3;
            coverBuf[i] = v; coverBuf[i + 1] = v; coverBuf[i + 2] = v;
        }
    }
    const coverSrc = GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(coverBuf), GdkPixbuf.Colorspace.RGB, false, 8, 8, 16, 8 * 3
    );
    const cm = computeCoverMask(coverSrc, 4, 4, 0.5);
    check("cover mask computed on portrait crop", cm !== null, `c=${cm ? cm.coverage : "null"}`);
    if (cm) {
        check("cover mask length = w*h", cm.alpha.length === 16, `len=${cm.alpha.length}`);
        const rows = [0, 1, 2, 3].map((y) => cm.alpha[y * 4] > 0.5);
        check("cover mask rows 0-1 dark window (foreground)",
            rows[0] && rows[1], `rows=${rows.join(",")}`);
        check("cover mask rows 2-3 bright window (flat)",
            !rows[2] && !rows[3], `rows=${rows.join(",")}`);
    }

    // Alpha-channel wallpaper (PNG): copy_area asserts src/dest alpha match —
    // the crop must carry the same channel layout or it fails silently and
    // the mask becomes all-black (coverage 1.0 -> null). RGBA 4×8 onto a
    // 4×4 layer: scale = 1, window = src rows 2..5 -> dark, dark, bright,
    // bright (rows 0-1 and 4-5 bright).
    const alphaBuf = new Uint8Array(4 * 8 * 4);
    for (let y = 0; y < 8; y++) {
        const v = y < 2 || (y >= 4 && y < 6) ? 0xee : 0x11;
        for (let x = 0; x < 4; x++) {
            const i = (y * 4 + x) * 4;
            alphaBuf[i] = v; alphaBuf[i + 1] = v; alphaBuf[i + 2] = v;
            alphaBuf[i + 3] = 255;
        }
    }
    const alphaSrc = GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(alphaBuf), GdkPixbuf.Colorspace.RGB, true, 8, 4, 8, 4 * 4
    );
    const cmA = computeCoverMask(alphaSrc, 4, 4, 0.5);
    check("alpha wallpaper mask computed", cmA !== null, `c=${cmA ? cmA.coverage : "null"}`);
    if (cmA) {
        check("alpha wallpaper mask in range", cmA.coverage > 0.4 && cmA.coverage < 0.9,
            `c=${cmA.coverage.toFixed(3)}`);
    }

    // Inversion: bright areas become foreground. Invert the portrait cover
    // mask (coverage 0.5): alpha flips, coverage stays 0.5.
    const inv = invertCutout(cm);
    check("invert keeps mask valid", inv !== null, `c=${inv ? inv.coverage : "null"}`);
    if (inv) {
        const iRows = [0, 1, 2, 3].map((y) => inv.alpha[y * 4] > 0.5);
        check("invert flips rows (0-1 dark -> flat)",
            !iRows[0] && !iRows[1], `rows=${iRows.join(",")}`);
        check("invert flips rows (2-3 bright -> foreground)",
            iRows[2] && iRows[3], `rows=${iRows.join(",")}`);
        check("invert coverage symmetric", Math.abs(inv.coverage - cm.coverage) < 1e-9,
            `c=${inv.coverage}`);
    }
    // computeCoverMask(invert=true) matches the manual inversion.
    const cmInv = computeCoverMask(coverSrc, 4, 4, 0.5, true);
    check("cover mask inverted via computeCoverMask", cmInv !== null && Math.abs(cmInv.coverage - 0.5) < 0.01,
        `c=${cmInv ? cmInv.coverage : "null"}`);
    // Black screen: all-dark source -> normal reading covers everything
    // (null), and inversion finds nothing bright either (null).
    const blackBuf = new Uint8Array(4 * 4 * 3);
    const blackSrc = GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(blackBuf), GdkPixbuf.Colorspace.RGB, false, 8, 4, 4, 12
    );
    check("pure black: normal mask null", computeCoverMask(blackSrc, 4, 4, 0.5) === null, "");
    check("pure black: inverted mask null", computeCoverMask(blackSrc, 4, 4, 0.5, true) === null, "");
    // Dark wallpaper with a bright moon (top-right 2x2 of 4x4): normal
    // reading covers 75% (valid), inverted covers the moon (25%).
    const darkBuf = new Uint8Array(4 * 4 * 3);
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            const i = (y * 4 + x) * 3;
            const v = x >= 2 && y < 2 ? 0xee : 0x11;
            darkBuf[i] = v; darkBuf[i + 1] = v; darkBuf[i + 2] = v;
        }
    }
    const darkSrc = GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(darkBuf), GdkPixbuf.Colorspace.RGB, false, 8, 4, 4, 12
    );
    const darkNormal = computeCoverMask(darkSrc, 4, 4, 0.5);
    const darkInv = computeCoverMask(darkSrc, 4, 4, 0.5, true);
    check("dark wallpaper: normal mask valid (75% dark)",
        darkNormal !== null && Math.abs(darkNormal.coverage - 0.75) < 0.05,
        `c=${darkNormal ? darkNormal.coverage : "null"}`);
    check("dark wallpaper: inverted finds bright moon",
        darkInv !== null && Math.abs(darkInv.coverage - 0.25) < 0.05,
        `c=${darkInv ? darkInv.coverage : "null"}`);

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