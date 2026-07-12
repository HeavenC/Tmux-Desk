const { execFileSync } = require('node:child_process');
const path = require('node:path');

// When a real "Developer ID Application" certificate is available, electron-builder
// signs (and, for release builds, notarizes) the app itself — an ad-hoc signature
// here would just be thrown away or, worse, leave nested helpers inconsistent. So
// skip ad-hoc signing whenever a Developer ID identity exists in the keychain.
function hasDeveloperIdIdentity() {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    return /Developer ID Application/.test(out);
  } catch {
    return false;
  }
}

// Ad-hoc sign the packaged .app so it runs on OTHER Macs.
//
// Without a paid Developer ID we can't notarize, but Apple Silicon still refuses
// to launch a bundle that has no valid signature — and once such an app is
// transferred (AirDrop / zip / download) it gets a quarantine flag and macOS
// reports it as "已损坏，无法打开". electron-builder's "skip signing" path only
// leaves the linker's partial signature (Sealed Resources=none), which is exactly
// that broken state. A proper ad-hoc signature (`codesign --sign -`) makes the
// app launch after the recipient simply clears quarantine (right-click → Open, or
// `xattr -cr`). This runs after packing and before the DMG/zip are assembled, so
// the distributed artifacts contain the signed app.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (hasDeveloperIdIdentity()) {
    console.log('  • Developer ID identity present — skipping ad-hoc signing (electron-builder will sign)');
    return;
  }
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appName}`);
};
