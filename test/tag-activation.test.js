const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeElement() {
  const element = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: { setProperty() {}, removeProperty() {} },
    append() {},
    addEventListener() {},
    replaceChildren() {},
    setAttribute() {},
    querySelector() { return null; },
    getBoundingClientRect() { return { width: 284 }; },
  };
  return new Proxy(element, {
    get(target, key) {
      if (!(key in target)) target[key] = '';
      return target[key];
    },
  });
}

async function loadTagController(api) {
  const appPath = join(__dirname, '..', 'src', 'renderer', 'app.js');
  const source = await readFile(appPath, 'utf8');
  const instrumented = source.replace(
    /initialize\(\);\s*$/,
    'module.exports = { activateTag, state, refs };',
  );
  const localRequire = createRequire(appPath);
  const module = { exports: {} };
  const document = {
    documentElement: fakeElement(),
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
    createElement() { return fakeElement(); },
  };
  const context = vm.createContext({
    clearInterval,
    clearTimeout,
    console,
    document,
    module,
    navigator: { clipboard: { writeText: async () => {} } },
    require: localRequire,
    setInterval,
    setTimeout,
    window: { matchMedia: () => ({ matches: false }), tmuxDesk: api },
  });
  const script = new vm.Script(`(function (require, module) { ${instrumented}\n})`);
  script.runInContext(context)(localRequire, module);
  for (const match of source.matchAll(/'([A-Za-z][A-Za-z0-9]+)'/g)) {
    module.exports.refs[match[1]] = fakeElement();
  }
  return module.exports;
}

test('touch success restores server tag order after an older preference save response', async () => {
  const touch = deferred();
  const first = { id: 'first', name: 'First', color: 'blue' };
  const second = { id: 'second', name: 'Second', color: 'green' };
  const api = {
    touchTag: () => touch.promise,
  };
  const controller = await loadTagController(api);
  controller.state.preferences = {
    ...controller.state.preferences,
    tags: [first, second],
    sessionTags: {},
  };

  const activation = controller.activateTag(second);
  controller.state.preferences = {
    ...controller.state.preferences,
    tags: [first, second],
  };
  touch.resolve({
    ...controller.state.preferences,
    tags: [second, first],
  });
  await activation;

  assert.deepEqual(
    controller.state.preferences.tags.map((tag) => tag.id),
    ['second', 'first'],
  );
});
