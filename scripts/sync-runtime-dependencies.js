const fs = require('node:fs/promises');
const path = require('node:path');

async function syncMissingRuntimeDependencies({ projectDir, bundleDir }) {
  const lockPath = path.join(projectDir, 'package-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  const copied = [];
  for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
    if (!packagePath.startsWith('node_modules/') || packagePath.includes('..')) continue;
    if (metadata?.dev === true || metadata?.link === true) continue;
    const source = path.join(projectDir, packagePath);
    const destination = path.join(bundleDir, packagePath);
    try {
      await fs.access(source);
    } catch {
      continue;
    }
    try {
      await fs.access(destination);
      continue;
    } catch {}
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true });
    copied.push(packagePath);
  }
  return copied;
}

if (require.main === module) {
  const [, , projectDir, bundleDir] = process.argv;
  if (!projectDir || !bundleDir) {
    console.error('Usage: sync-runtime-dependencies.js <project-dir> <bundle-dir>');
    process.exitCode = 1;
  } else {
    syncMissingRuntimeDependencies({ projectDir, bundleDir })
      .then((copied) => {
        if (copied.length) console.log(`  Added runtime dependencies: ${copied.join(', ')}`);
        else console.log('  Runtime dependencies already present');
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}

module.exports = { syncMissingRuntimeDependencies };
