const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile, access } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const {
  PreferencesStore,
  DEFAULT_PREFERENCES,
  defaultPreferencesFilePath,
} = require('../src/main/preferences-store');

async function withStore(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-preferences-'));
  const filePath = join(root, 'nested', 'preferences.json');
  try {
    return await run(new PreferencesStore({ filePath, ...options }), filePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('first run defaults to light theme', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.load(), DEFAULT_PREFERENCES);
  });
});

test('malformed and invalid preferences fall back to normalized defaults', async () => {
  await withStore(async (store, filePath) => {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, '{broken', 'utf8');
    assert.deepEqual(await store.load(), DEFAULT_PREFERENCES);

    await writeFile(filePath, JSON.stringify({
      theme: 'sepia', favorites: ['api', '', 4, 'api'], lastSession: 99,
      windowBounds: { x: 10, y: 10, width: 'wide', height: 700 },
    }), 'utf8');
    assert.deepEqual(await store.load(), {
      theme: 'light', favorites: ['api'], tags: [], sessionTags: {}, lastSession: null, windowBounds: null,
      sidebarWidth: null,
    });
  });
});

test('sidebar width is rounded and clamped to the supported desktop range', async () => {
  await withStore(async (store) => {
    assert.equal((await store.save({ sidebarWidth: 279.6 })).sidebarWidth, 280);
    assert.equal((await store.save({ sidebarWidth: 80 })).sidebarWidth, 200);
    assert.equal((await store.save({ sidebarWidth: 500 })).sidebarWidth, 420);
    assert.equal((await store.save({ sidebarWidth: null })).sidebarWidth, null);
  });
});

test('save merges preferences atomically and leaves no temporary file', async () => {
  await withStore(async (store, filePath) => {
    const saved = await store.save({ theme: 'dark', lastSession: 'api' });
    assert.equal(saved.theme, 'dark');
    assert.equal(saved.lastSession, 'api');
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), saved);
    await assert.rejects(() => access(`${filePath}.tmp`));
  });
});

test('toggleFavorite and renameSessionReferences keep favorites unique and migrate last session', async () => {
  await withStore(async (store) => {
    await store.save({ favorites: ['api'], lastSession: 'api' });
    assert.deepEqual((await store.toggleFavorite('worker')).favorites, ['api', 'worker']);
    assert.deepEqual((await store.toggleFavorite('api')).favorites, ['worker']);
    await store.toggleFavorite('api');
    const renamed = await store.renameSessionReferences('api', 'backend');
    assert.deepEqual(renamed.favorites, ['worker', 'backend']);
    assert.equal(renamed.lastSession, 'backend');
  });
});

test('tag preferences normalize definitions and remove duplicate or stale associations', async () => {
  await withStore(async (store, filePath) => {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      tags: [
        { id: 'tag-one', name: ' DMS ', color: 'blue' },
        { id: 'tag-one', name: 'duplicate id', color: 'green' },
        { id: 'tag-two', name: 'dms', color: 'gold' },
        { id: 'tag-three', name: 'K8S', color: 'invalid' },
      ],
      sessionTags: { api: ['tag-one', 'tag-one', 'missing'], empty: ['missing'] },
    }), 'utf8');
    const preferences = await store.load();
    assert.deepEqual(preferences.tags, [{ id: 'tag-one', name: 'DMS', color: 'blue' }]);
    assert.deepEqual(preferences.sessionTags, { api: ['tag-one'] });
  });
});

test('tag lifecycle persists associations and migrates session references', async () => {
  const ids = ['one', 'two'];
  await withStore(async (store) => {
    let preferences = await store.createTag('DMS');
    const first = preferences.tags[0];
    preferences = await store.createTag('K8S');
    const second = preferences.tags[1];
    assert.deepEqual([first.id, first.color, second.id, second.color], ['tag-one', 'blue', 'tag-two', 'green']);

    await store.setSessionTags('api', [first.id, second.id, first.id]);
    await store.copySessionTags('api', 'api-copy');
    await store.renameSessionReferences('api', 'backend');
    await store.renameTag(first.id, '渠道');
    await store.deleteTag(second.id);
    preferences = await store.removeSessionTags('api-copy');

    assert.equal(preferences.tags[0].name, '渠道');
    assert.deepEqual(preferences.sessionTags, { backend: [first.id] });
  }, { createId: () => ids.shift() });
});

test('tag lifecycle rejects duplicate names and unknown tag associations', async () => {
  await withStore(async (store) => {
    const preferences = await store.createTag('DMS');
    const tag = preferences.tags[0];
    await assert.rejects(() => store.createTag(' dms '), /已存在同名 Tag/);
    await assert.rejects(() => store.renameTag(tag.id, 'x'.repeat(41)), /Tag 名称无效/);
    await assert.rejects(() => store.setSessionTags('api', ['tag-missing']), /Tag 不存在/);
  }, { createId: () => 'one' });
});

test('renaming a session merges tag references already stored on the target name', async () => {
  const ids = ['one', 'two'];
  await withStore(async (store) => {
    let preferences = await store.createTag('DMS');
    const first = preferences.tags[0];
    preferences = await store.createTag('K8S');
    const second = preferences.tags[1];
    await store.setSessionTags('api', [first.id]);
    await store.setSessionTags('backend', [second.id]);
    preferences = await store.renameSessionReferences('api', 'backend');
    assert.deepEqual(preferences.sessionTags, { backend: [second.id, first.id] });
  }, { createId: () => ids.shift() });
});

test('default preference path matches Electron userData across supported platforms', () => {
  assert.equal(defaultPreferencesFilePath({
    platform: 'darwin',
    home: '/Users/me',
    env: {},
  }), '/Users/me/Library/Application Support/tmux-desk/preferences.json');
  assert.equal(defaultPreferencesFilePath({
    platform: 'linux',
    home: '/home/me',
    env: {},
  }), '/home/me/.config/tmux-desk/preferences.json');
  assert.equal(defaultPreferencesFilePath({
    platform: 'win32',
    home: 'C:\\Users\\me',
    env: { APPDATA: 'D:\\Profiles\\me\\AppData\\Roaming' },
  }), 'D:\\Profiles\\me\\AppData\\Roaming\\tmux-desk\\preferences.json');
  assert.equal(defaultPreferencesFilePath({
    platform: 'darwin',
    home: '/Users/me',
    env: { TMUX_DESK_PREFERENCES_FILE: '/tmp/shared-tmux-desk.json' },
  }), '/tmp/shared-tmux-desk.json');
});

test('concurrent tag mutations on one store preserve updates from multiple devices', async () => {
  let activeWrites = 0;
  let maximumWrites = 0;
  const delayedFs = {
    readFile,
    mkdir,
    rename: require('node:fs/promises').rename,
    unlink: require('node:fs/promises').unlink,
    writeFile: async (...args) => {
      activeWrites += 1;
      maximumWrites = Math.max(maximumWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        return await writeFile(...args);
      } finally {
        activeWrites -= 1;
      }
    },
  };
  const ids = ['one', 'two'];
  await withStore(async (store) => {
    let preferences = await store.createTag('DMS');
    const first = preferences.tags[0];
    preferences = await store.createTag('K8S');
    const second = preferences.tags[1];
    maximumWrites = 0;

    await Promise.all([
      store.setSessionTags('api', [first.id]),
      store.setSessionTags('worker', [second.id]),
    ]);

    assert.equal(maximumWrites, 1);
    assert.deepEqual((await store.load()).sessionTags, {
      api: [first.id],
      worker: [second.id],
    });
  }, { createId: () => ids.shift(), fsImpl: delayedFs });
});
