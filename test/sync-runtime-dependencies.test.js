const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('deployment copies missing production dependencies without replacing bundled packages', async () => {
  let syncMissingRuntimeDependencies;
  assert.doesNotThrow(() => {
    ({ syncMissingRuntimeDependencies } = require('../scripts/sync-runtime-dependencies'));
  });

  const root = await mkdtemp(path.join(os.tmpdir(), 'tmux-desk-deploy-'));
  const projectDir = path.join(root, 'project');
  const bundleDir = path.join(root, 'bundle');
  try {
    await mkdir(path.join(projectDir, 'node_modules', 'new-runtime'), { recursive: true });
    await mkdir(path.join(projectDir, 'node_modules', 'existing-native'), { recursive: true });
    await mkdir(path.join(projectDir, 'node_modules', 'dev-only'), { recursive: true });
    await mkdir(path.join(bundleDir, 'node_modules', 'existing-native'), { recursive: true });
    await writeFile(path.join(projectDir, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/new-runtime': { version: '1.0.0' },
        'node_modules/existing-native': { version: '2.0.0' },
        'node_modules/dev-only': { version: '3.0.0', dev: true },
      },
    }));
    await writeFile(path.join(projectDir, 'node_modules', 'new-runtime', 'marker'), 'new');
    await writeFile(path.join(projectDir, 'node_modules', 'existing-native', 'marker'), 'project');
    await writeFile(path.join(projectDir, 'node_modules', 'dev-only', 'marker'), 'dev');
    await writeFile(path.join(bundleDir, 'node_modules', 'existing-native', 'marker'), 'bundle');

    const copied = await syncMissingRuntimeDependencies({ projectDir, bundleDir });

    assert.deepEqual(copied, ['node_modules/new-runtime']);
    assert.equal(await readFile(path.join(bundleDir, 'node_modules', 'new-runtime', 'marker'), 'utf8'), 'new');
    assert.equal(await readFile(path.join(bundleDir, 'node_modules', 'existing-native', 'marker'), 'utf8'), 'bundle');
    await assert.rejects(readFile(path.join(bundleDir, 'node_modules', 'dev-only', 'marker')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
