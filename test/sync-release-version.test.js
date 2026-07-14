const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  syncReleaseVersion,
  versionFromReleaseTag,
} = require('../scripts/sync-release-version');

test('release tags are parsed without depending on shell escaping', () => {
  assert.equal(versionFromReleaseTag('v0.4.4'), '0.4.4');
  assert.equal(versionFromReleaseTag('v2.0.0-beta.1+build.7'), '2.0.0-beta.1+build.7');
  assert.throws(() => versionFromReleaseTag('0.4.4'), /Invalid release tag/);
  assert.throws(() => versionFromReleaseTag('v0.4'), /Invalid release tag/);
  assert.throws(() => versionFromReleaseTag(undefined), /Invalid release tag/);
});

test('release version sync updates package metadata used by npm and electron-builder', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'tmux-desk-release-'));
  try {
    await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'tmux-desk',
      version: '0.4.0',
      private: true,
    }));
    await writeFile(path.join(projectDir, 'package-lock.json'), JSON.stringify({
      name: 'tmux-desk',
      version: '0.3.2',
      lockfileVersion: 3,
      packages: {
        '': { name: 'tmux-desk', version: '0.3.2' },
        'node_modules/example': { version: '1.0.0' },
      },
    }));

    const version = await syncReleaseVersion({ projectDir, releaseTag: 'v0.4.4' });
    const packageJson = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(await readFile(path.join(projectDir, 'package-lock.json'), 'utf8'));

    assert.equal(version, '0.4.4');
    assert.equal(packageJson.version, '0.4.4');
    assert.equal(packageLock.version, '0.4.4');
    assert.equal(packageLock.packages[''].version, '0.4.4');
    assert.equal(packageLock.packages['node_modules/example'].version, '1.0.0');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
