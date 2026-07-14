const fs = require('node:fs/promises');
const path = require('node:path');

const RELEASE_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function versionFromReleaseTag(tag) {
  if (typeof tag !== 'string' || !RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid release tag: ${tag || '(missing)'}`);
  }
  return tag.slice(1);
}

async function syncReleaseVersion({ projectDir, releaseTag }) {
  const version = versionFromReleaseTag(releaseTag);
  const packagePath = path.join(projectDir, 'package.json');
  const lockPath = path.join(projectDir, 'package-lock.json');
  const [packageJson, packageLock] = await Promise.all([
    readJson(packagePath),
    readJson(lockPath),
  ]);

  packageJson.version = version;
  packageLock.version = version;
  if (packageLock.packages?.['']) packageLock.packages[''].version = version;

  await Promise.all([
    writeJson(packagePath, packageJson),
    writeJson(lockPath, packageLock),
  ]);
  return version;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

if (require.main === module) {
  syncReleaseVersion({
    projectDir: process.cwd(),
    releaseTag: process.env.RELEASE_TAG,
  })
    .then((version) => console.log(`Using release version ${version}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { syncReleaseVersion, versionFromReleaseTag };
