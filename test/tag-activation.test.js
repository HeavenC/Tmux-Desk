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

function fakeElement(animationCalls = []) {
  const element = {
    animations: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    _children: [],
    _top: 0,
    append(...children) {
      for (const child of children) {
        child._top = this._children.length * 40;
        this._children.push(child);
      }
    },
    addEventListener() {},
    animate(keyframes, options) {
      const call = { element: this, keyframes, options };
      this.animations.push(call);
      animationCalls.push(call);
      return { cancel() {} };
    },
    replaceChildren(...children) {
      this._children = [];
      this.append(...children);
    },
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '[data-tag-id]') return this._children.filter((child) => child.dataset.tagId);
      return [];
    },
    getBoundingClientRect() { return { top: this._top, width: 284 }; },
  };
  return new Proxy(element, {
    get(target, key) {
      if (!(key in target)) target[key] = '';
      return target[key];
    },
  });
}

async function loadTagController(api, { animationCalls = [], reduceMotion = false } = {}) {
  const appPath = join(__dirname, '..', 'src', 'renderer', 'app.js');
  const source = await readFile(appPath, 'utf8');
  const instrumented = source.replace(
    /initialize\(\);\s*$/,
    'module.exports = { activateTag, renderTagRail, state, refs };',
  );
  const localRequire = createRequire(appPath);
  const testRequire = (request) => (
    request === './terminal-view' ? { TerminalView: class {} } : localRequire(request)
  );
  const module = { exports: {} };
  const document = {
    documentElement: fakeElement(animationCalls),
    querySelector() { return fakeElement(animationCalls); },
    querySelectorAll() { return []; },
    createElement() { return fakeElement(animationCalls); },
  };
  const context = vm.createContext({
    clearInterval,
    clearTimeout,
    console,
    document,
    module,
    navigator: { clipboard: { writeText: async () => {} } },
    require: testRequire,
    setInterval,
    setTimeout,
    window: {
      matchMedia: (query) => ({ matches: reduceMotion && query.includes('prefers-reduced-motion') }),
      tmuxDesk: api,
    },
  });
  const script = new vm.Script(`(function (require, module) { ${instrumented}\n})`);
  script.runInContext(context)(testRequire, module);
  for (const match of source.matchAll(/'([A-Za-z][A-Za-z0-9]+)'/g)) {
    module.exports.refs[match[1]] = fakeElement(animationCalls);
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

test('recently used tag reorder animates changed positions with a short eased transition', async () => {
  const animationCalls = [];
  const first = { id: 'first', name: 'First', color: 'blue' };
  const second = { id: 'second', name: 'Second', color: 'green' };
  const third = { id: 'third', name: 'Third', color: 'gold' };
  const api = {
    touchTag: async () => ({ tags: [second, first, third] }),
  };
  const controller = await loadTagController(api, { animationCalls });
  controller.state.preferences = {
    ...controller.state.preferences,
    tags: [first, second, third],
    sessionTags: {},
  };
  controller.renderTagRail();

  await controller.activateTag(second);

  assert.equal(animationCalls.length, 2);
  assert.equal(
    controller.refs.tagRail.querySelectorAll('[data-tag-id]')
      .filter((button) => button.animations.length).length,
    2,
  );
  assert.deepEqual(animationCalls.map((call) => call.options.duration), [180, 180]);
  assert.deepEqual(animationCalls.map((call) => call.options.easing), [
    'cubic-bezier(.2, .8, .2, 1)', 'cubic-bezier(.2, .8, .2, 1)',
  ]);
  assert.deepEqual(animationCalls.map((call) => call.keyframes[0].transform).sort(), [
    'translateY(-40px)', 'translateY(40px)',
  ]);
});

test('recently used tag reorder skips animation when reduced motion is requested', async () => {
  const animationCalls = [];
  const first = { id: 'first', name: 'First', color: 'blue' };
  const second = { id: 'second', name: 'Second', color: 'green' };
  const controller = await loadTagController({
    touchTag: async () => ({ tags: [second, first] }),
  }, { animationCalls, reduceMotion: true });
  controller.state.preferences = {
    ...controller.state.preferences,
    tags: [first, second],
    sessionTags: {},
  };
  controller.renderTagRail();

  await controller.activateTag(second);

  assert.deepEqual(animationCalls, []);
});
