const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// --- helpers ----------------------------------------------------------------

function getDeveloperIdIdentity() {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    const m = /"?(Developer ID Application:[^"]+)"?/.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Walk dir and collect every leaf Mach-O binary. */
function collectLeafBinaries(dir, collected = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return collected; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip locale dirs only — they contain .pak resource files (220+ of them).
      // We DO walk into .framework and .app bundles to find binaries in
      // non-standard locations (Electron's Libraries/, Squirrel's ShipIt, etc.)
      if (e.name.endsWith('.lproj')) continue;
      collectLeafBinaries(full, collected);
    } else if (e.isFile()) {
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        // Mach-O magic numbers (big + little endian)
        const magics = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca, 0xcffaedfe];
        if (magics.includes(buf.readUInt32BE(0)) || magics.includes(buf.readUInt32LE(0))) {
          collected.push(full);
        }
      } catch { /* skip unreadable */ }
    }
  }
  return collected;
}

// --- main hook --------------------------------------------------------------

// electron-builder's default signing iterates over every individual file,
// spawning a separate `codesign` for each (220+ lproj locale.pak files alone).
//
// We bypass that: CSC_IDENTITY_AUTO_DISCOVERY=false skips electron-builder
// signing.  This hook does a two-pass sign:
//   1. Collect ALL leaf Mach-O binaries (dylibs, .node, helpers) and sign them
//      in ONE `codesign` invocation.
//   2. Sign the top-level .app with `--deep` (bundles, helpers, main exe).
//
// Two invocations total instead of 220+.  ~15–30 s for the entire bundle.

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const entitlements = path.resolve(context.packager.projectDir, 'build', 'entitlements.mac.plist');

  const devId = getDeveloperIdIdentity();
  const signIdentity = devId || '-';

  const label = devId ? `Developer ID: ${devId}` : 'ad-hoc';

  if (devId) {
    // ── Pass 1: leaf Mach-O binaries ──────────────────────────────────────
    console.log('  • scanning for leaf Mach-O binaries …');
    console.time('  • scan');
    const leafBinaries = collectLeafBinaries(appPath);
    console.timeEnd('  • scan');
    console.log(`    found ${leafBinaries.length} leaf binaries`);

    if (leafBinaries.length > 0) {
      // Sign innermost code WITHOUT entitlements (entitlements only on
      // the top-level bundle).  Exception: node-pty spawn-helper needs
      // the same entitlements as the main app.
      const noEntitlement = [];
      const withEntitlement = [];
      for (const p of leafBinaries) {
        if (p.includes('node-pty') || p.includes('spawn-helper')) {
          withEntitlement.push(p);
        } else {
          noEntitlement.push(p);
        }
      }

      const signFiles = (files, extraArgs = []) => {
        if (files.length === 0) return;
        console.log(`  • signing ${files.length} leaf binary(s) …`);
        console.time('    leaf');
        execFileSync('codesign', [
          '--force', '--sign', devId, '--timestamp',
          '--options', 'runtime',
          ...extraArgs,
          ...files,
        ], { stdio: 'inherit', maxBuffer: 50 * 1024 * 1024 });
        console.timeEnd('    leaf');
      };

      signFiles(noEntitlement);
      signFiles(withEntitlement, ['--entitlements', entitlements]);
    }

    // ── Pass 2: top-level .app with --deep (bundles, helpers, main exe) ──
    console.log(`  • signing ${appName} (deep) …`);
    console.time('  • codesign');
    execFileSync('codesign', [
      '--force', '--deep', '--sign', devId,
      '--timestamp', '--options', 'runtime',
      '--entitlements', entitlements,
      appPath,
    ], { stdio: 'inherit' });
    console.timeEnd('  • codesign');
    console.log(`  • ${appName} signed`);
  } else {
    // Ad-hoc signing — no Developer ID certificate available
    console.log(`  • ad-hoc signing ${appName} …`);
    console.time('  • codesign');
    execFileSync('codesign', [
      '--force', '--deep', '--sign', '-',
      '--timestamp',
      appPath,
    ], { stdio: 'inherit' });
    console.timeEnd('  • codesign');
    console.log(`  • ${appName} signed`);
  }
};
