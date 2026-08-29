const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile, access, utimes } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');
const { DEFAULT_TMUX_SETTINGS } = require('../src/shared/tmux-settings');
const { DEFAULT_TERMINAL_APPEARANCE } = require('../src/shared/terminal-appearance');
const { DEFAULT_PASTE_GUARD } = require('../src/shared/paste-guard');
const { DEFAULT_SESSION_RESTORE } = require('../src/main/session-snapshot');

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
      theme: 'light', favorites: ['api'], tags: [], sessionTags: {}, tabOrders: {}, lastSession: null, windowBounds: null,
      sidebarWidth: null, tagRailExpanded: false, tagRailWidth: null, keepAwake: false, autoShare: false, webQuickKeys: [], remoteConnections: [],
      tmuxSettings: { ...DEFAULT_TMUX_SETTINGS },
      terminalAppearance: { ...DEFAULT_TERMINAL_APPEARANCE },
      pasteProtection: { ...DEFAULT_PASTE_GUARD },
      sessionRestore: { ...DEFAULT_SESSION_RESTORE },
    });
  });
});

test('tmux settings use iTerm-style defaults, persist validated values, and migrate legacy toggles', async () => {
  await withStore(async (store, filePath) => {
    assert.deepEqual((await store.load()).tmuxSettings, DEFAULT_TMUX_SETTINGS);
    const saved = await store.save({
      tmuxSettings: { ...DEFAULT_TMUX_SETTINGS, mouse: false, modeKeys: 'vi', historyLimit: 120000 },
    });
    assert.equal(saved.tmuxSettings.mouse, false);
    assert.equal(saved.tmuxSettings.modeKeys, 'vi');
    assert.equal(saved.tmuxSettings.historyLimit, 120000);
    await writeFile(filePath, JSON.stringify({
      tmuxDefaults: { mouse: false, history: false, detachOnDestroy: false, windowNumbering: false, extendedKeys: false },
    }), 'utf8');
    const migrated = (await store.load()).tmuxSettings;
    assert.equal(migrated.mouse, false);
    assert.equal(migrated.historyLimit, 2000);
    assert.equal(migrated.detachOnDestroy, true);
    assert.equal(migrated.baseIndex, 0);
    assert.equal(migrated.paneBaseIndex, 0);
    assert.equal(migrated.renumberWindows, false);
    assert.equal(migrated.extendedKeys, false);
  });
});

test('keep-awake preference defaults off and only accepts persisted booleans', async () => {
  await withStore(async (store, filePath) => {
    assert.equal((await store.load()).keepAwake, false);
    assert.equal((await store.save({ keepAwake: true })).keepAwake, true);
    await writeFile(filePath, JSON.stringify({ keepAwake: 'yes' }), 'utf8');
    assert.equal((await store.load()).keepAwake, false);
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

test('tag rail width is rounded, clamped, reset, and restored from disk', async () => {
  await withStore(async (store) => {
    assert.equal((await store.save({ tagRailWidth: 239.6 })).tagRailWidth, 240);
    assert.equal((await store.save({ tagRailWidth: 80 })).tagRailWidth, 180);
    assert.equal((await store.save({ tagRailWidth: 900 })).tagRailWidth, 420);
    assert.equal((await store.load()).tagRailWidth, 420);
    assert.equal((await store.save({ tagRailWidth: null })).tagRailWidth, null);
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

test('tab order preferences normalize view keys, dedupe names, and drop invalid entries', async () => {
  await withStore(async (store, filePath) => {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      tags: [{ id: 'tag-one', name: 'DMS', color: 'blue' }],
      tabOrders: {
        favorites: ['api', 'api', '  worker  ', '', 4],
        'tag-one': ['db'],
        'tag-missing': ['db'],
        'not-a-view': 'nope',
      },
    }), 'utf8');
    const preferences = await store.load();
    assert.deepEqual(preferences.tabOrders, {
      favorites: ['api', 'worker'],
      'tag-one': ['db'],
    });
  });
});

test('deleting a tag also discards its stored tab order', async () => {
  await withStore(async (store) => {
    let preferences = await store.createTag('DMS');
    const tag = preferences.tags[0];
    preferences = await store.save({ tabOrders: { favorites: ['api', 'worker'], [tag.id]: ['api'] } });
    assert.deepEqual(preferences.tabOrders, { favorites: ['api', 'worker'], [tag.id]: ['api'] });
    preferences = await store.deleteTag(tag.id);
    assert.deepEqual(preferences.tabOrders, { favorites: ['api', 'worker'] });
  }, { createId: () => 'one' });
});

test('renaming a session updates its position in every stored tab order', async () => {
  await withStore(async (store) => {
    await store.save({ tabOrders: { favorites: ['api', 'worker'] } });
    const renamed = await store.renameSessionReferences('api', 'backend');
    assert.deepEqual(renamed.tabOrders, { favorites: ['backend', 'worker'] });
  });
});

test('renaming a session onto an existing name dedupes its tab order entry', async () => {
  await withStore(async (store) => {
    await store.save({ tabOrders: { favorites: ['api', 'worker'] } });
    const renamed = await store.renameSessionReferences('worker', 'api');
    assert.deepEqual(renamed.tabOrders, { favorites: ['api'] });
  });
});

test('tag lifecycle persists associations and migrates session references', async () => {
  const ids = ['one', 'two'];
  await withStore(async (store) => {
    let preferences = await store.createTag('DMS');
    const first = preferences.tags[0];
    preferences = await store.createTag('K8S');
    const second = preferences.tags.find((tag) => tag.name === 'K8S');
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

test('new and recently used tags move to the front', async () => {
  const ids = ['one', 'two', 'three'];
  await withStore(async (store) => {
    await store.createTag('DMS');
    await store.createTag('K8S');
    let preferences = await store.createTag('PROD');
    assert.deepEqual(preferences.tags.map((tag) => tag.name), ['PROD', 'K8S', 'DMS']);

    preferences = await store.touchTag('tag-one');
    assert.deepEqual(preferences.tags.map((tag) => tag.name), ['DMS', 'PROD', 'K8S']);
    assert.deepEqual((await store.touchTag('tag-one')).tags, preferences.tags);
    await assert.rejects(() => store.touchTag('tag-missing'), /Tag 不存在/);
  }, { createId: () => ids.shift() });
});

test('pinning holds order above the recency list and supports manual reorder', async () => {
  const ids = ['one', 'two', 'three', 'four'];
  await withStore(async (store) => {
    await store.createTag('DMS');   // tag-one
    await store.createTag('K8S');   // tag-two
    await store.createTag('PROD');  // tag-three
    await store.createTag('APP');   // tag-four -> order [APP, PROD, K8S, DMS]

    // Pin the topmost tag, then the next: both collect at the top in order.
    let prefs = await store.setTagPinned('tag-four', true);
    assert.equal(prefs.tags[0].pinned, true);
    prefs = await store.setTagPinned('tag-three', true);
    assert.deepEqual(prefs.tags.filter((tag) => tag.pinned).map((tag) => tag.name), ['APP', 'PROD']);
    assert.deepEqual(prefs.tags.map((tag) => tag.name), ['APP', 'PROD', 'K8S', 'DMS']);

    // Touching a pinned tag is a no-op; touching an unpinned one rises only to
    // the top of the unpinned region, never above the pinned block.
    assert.deepEqual((await store.touchTag('tag-four')).tags, prefs.tags);
    prefs = await store.touchTag('tag-one');
    assert.deepEqual(prefs.tags.map((tag) => tag.name), ['APP', 'PROD', 'DMS', 'K8S']);

    // Reorder the pinned block; only a permutation of exactly the pinned set is allowed.
    prefs = await store.reorderPinnedTags(['tag-three', 'tag-four']);
    assert.deepEqual(prefs.tags.map((tag) => tag.name), ['PROD', 'APP', 'DMS', 'K8S']);
    await assert.rejects(() => store.reorderPinnedTags(['tag-three']), /Tag 顺序无效/);
    await assert.rejects(() => store.reorderPinnedTags(['tag-three', 'tag-one']), /Tag 顺序无效/);

    // Unpinning drops the tag to the top of the recency list.
    prefs = await store.setTagPinned('tag-three', false);
    assert.deepEqual(prefs.tags.filter((tag) => tag.pinned).map((tag) => tag.name), ['APP']);
    assert.deepEqual(prefs.tags.map((tag) => tag.name), ['APP', 'PROD', 'DMS', 'K8S']);
    assert.equal(prefs.tags.find((tag) => tag.name === 'PROD').pinned, undefined);
  }, { createId: () => ids.shift() });
});

test('web quick keys persist and normalize preset and text entries', async () => {
  await withStore(async (store) => {
    const saved = await store.setWebQuickKeys([
      { type: 'preset', id: 'esc' },
      { type: 'text', label: 'usage', text: '/usage', enter: true },
      { type: 'text', label: '', text: 'dropped' }, // no label → dropped
      { type: 'bogus' }, // unknown → dropped
    ]);
    assert.deepEqual(saved.webQuickKeys, [
      { type: 'preset', id: 'esc' },
      { type: 'text', label: 'usage', text: '/usage', enter: true },
    ]);
    assert.deepEqual((await store.load()).webQuickKeys, saved.webQuickKeys);
  });
});

test('persisted pinned tags are partitioned above the rest on load', async () => {
  await withStore(async (store, filePath) => {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      tags: [
        { id: 'tag-a', name: 'A', color: 'blue' },
        { id: 'tag-b', name: 'B', color: 'green', pinned: true },
        { id: 'tag-c', name: 'C', color: 'gold' },
      ],
    }), 'utf8');
    const prefs = await store.load();
    assert.deepEqual(prefs.tags.map((tag) => tag.name), ['B', 'A', 'C']);
    assert.equal(prefs.tags[0].pinned, true);
    assert.equal(prefs.tags[1].pinned, undefined);
  });
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
    const second = preferences.tags.find((tag) => tag.name === 'K8S');
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

test('concurrent tag mutations on one store are serialized', async () => {
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
    const second = preferences.tags.find((tag) => tag.name === 'K8S');
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

test('concurrent mutations from desktop and web store instances preserve both updates', async () => {
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
  await withStore(async (desktopStore, filePath) => {
    let preferences = await desktopStore.createTag('DMS');
    const dms = preferences.tags[0];
    preferences = await desktopStore.createTag('K8S');
    const k8s = preferences.tags[0];
    const webStore = new PreferencesStore({ filePath, fsImpl: delayedFs });
    maximumWrites = 0;

    await Promise.all([
      desktopStore.touchTag(dms.id),
      webStore.setSessionTags('api', [k8s.id]),
    ]);

    preferences = await desktopStore.load();
    assert.equal(maximumWrites, 1);
    assert.deepEqual(preferences.tags.map((tag) => tag.id), [dms.id, k8s.id]);
    assert.deepEqual(preferences.sessionTags, { api: [k8s.id] });
  }, { createId: () => ids.shift(), fsImpl: delayedFs });
});

test('multiple store instances safely recover one stale cross-process lock', async () => {
  const ids = ['one', 'two'];
  await withStore(async (desktopStore, filePath) => {
    let preferences = await desktopStore.createTag('DMS');
    const dms = preferences.tags[0];
    preferences = await desktopStore.createTag('K8S');
    const k8s = preferences.tags[0];
    const staleLockPath = `${filePath}.lock`;
    await mkdir(staleLockPath);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(staleLockPath, staleTime, staleTime);

    const firstWebStore = new PreferencesStore({ filePath });
    const secondWebStore = new PreferencesStore({ filePath });
    await Promise.all([
      firstWebStore.touchTag(dms.id),
      secondWebStore.setSessionTags('api', [k8s.id]),
    ]);

    preferences = await desktopStore.load();
    assert.deepEqual(preferences.tags.map((tag) => tag.id), [dms.id, k8s.id]);
    assert.deepEqual(preferences.sessionTags, { api: [k8s.id] });
  }, { createId: () => ids.shift() });
});
