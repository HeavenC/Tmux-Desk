const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { discoverCodebases, sessionNameFor } = require('../src/main/codebase-import');

const HOME = '/Users/tester';
const P = (...parts) => path.join(HOME, ...parts);

// A fake fs backed by a { path -> contents } file map and a set of directories.
function makeFs(files, dirs) {
  const dirSet = new Set(dirs);
  return {
    readFileSync(file) {
      if (file in files) return files[file];
      const error = new Error(`ENOENT: ${file}`);
      error.code = 'ENOENT';
      throw error;
    },
    readdirSync(dir) {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const names = new Set();
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split(path.sep)[0]);
      }
      if (!names.size) {
        const error = new Error(`ENOENT: ${dir}`);
        error.code = 'ENOENT';
        throw error;
      }
      return [...names];
    },
    statSync(target) {
      if (dirSet.has(target)) return { isDirectory: () => true };
      const error = new Error(`ENOENT: ${target}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

test('discovers, dedupes across tools, and drops non-existent directories', () => {
  const ideaXml = `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>
    <entry key="$USER_HOME$/proj/api"><value><RecentProjectMetaInfo><option name="projectOpenTimestamp" value="1"/></RecentProjectMetaInfo></value></entry>
    <entry key="$USER_HOME$/gone"><value/></entry>
  </map></option></component></application>`;
  const files = {
    [P('.claude.json')]: JSON.stringify({ projects: { [P('proj/api')]: {}, [P('proj/web')]: {}, [P('missing')]: {} } }),
    [P('.codex', '.codex-global-state.json')]: JSON.stringify({ 'project-order': [P('proj/api'), P('proj/cli')] }),
    [P('Library', 'Application Support', 'JetBrains', 'IntelliJIdea2025.3', 'options', 'recentProjects.xml')]: ideaXml,
  };
  const dirs = [P('proj/api'), P('proj/web'), P('proj/cli')];
  const result = discoverCodebases({ home: HOME, fsImpl: makeFs(files, dirs) });

  const byPath = new Map(result.map((entry) => [entry.path, entry]));
  // missing/gone dirs are filtered out
  assert.equal(byPath.has(P('missing')), false);
  assert.equal(byPath.has(P('gone')), false);
  assert.deepEqual([...byPath.keys()].sort(), [P('proj/api'), P('proj/cli'), P('proj/web')].sort());
  // proj/api is referenced by claude, codex, and idea — merged into one entry
  assert.deepEqual(byPath.get(P('proj/api')).sources.sort(), ['claude', 'codex', 'idea']);
  assert.deepEqual(byPath.get(P('proj/web')).sources, ['claude']);
  assert.deepEqual(byPath.get(P('proj/cli')).sources, ['codex']);
  assert.equal(byPath.get(P('proj/api')).name, 'api');
});

test('a broken source never blocks the others', () => {
  const files = {
    [P('.claude.json')]: '{ this is not json',
    [P('.codex', '.codex-global-state.json')]: JSON.stringify({ 'active-workspace-roots': [P('work')] }),
  };
  const result = discoverCodebases({ home: HOME, fsImpl: makeFs(files, [P('work')]) });
  assert.deepEqual(result.map((entry) => entry.path), [P('work')]);
});

test('vscode file:// URIs are decoded and filtered to real folders', () => {
  const storage = JSON.stringify({
    lastKnownMenubarData: {},
    windowsState: { openedWindows: [{ folderUri: `file://${P('code%20space/app')}` }] },
    recent: [`file://${P('code%20space/app')}`, 'file:///nonexistent'],
  });
  const files = {
    [P('Library', 'Application Support', 'Code', 'User', 'globalStorage', 'storage.json')]: storage,
  };
  const result = discoverCodebases({ home: HOME, fsImpl: makeFs(files, [P('code space/app')]) });
  assert.equal(result.length, 1);
  assert.equal(result[0].path, P('code space/app'));
  assert.deepEqual(result[0].sources, ['vscode']);
  assert.equal(result[0].name, 'app');
});

test('sessionNameFor sanitizes tmux-illegal characters', () => {
  assert.equal(sessionNameFor('/a/b/my.proj:v2'), 'my_proj_v2');
  assert.equal(sessionNameFor('/a/b/'), 'b');
  assert.equal(sessionNameFor('/'), 'session');
});
