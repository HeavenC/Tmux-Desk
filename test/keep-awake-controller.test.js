'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { KeepAwakeController } = require('../src/main/keep-awake-controller');

function createFixture() {
  const powerMonitor = new EventEmitter();
  const calls = [];
  let nextId = 10;
  const powerSaveBlocker = {
    start: (type) => {
      const id = nextId++;
      calls.push(['start', type, id]);
      return id;
    },
    stop: (id) => calls.push(['stop', id]),
  };
  const controller = new KeepAwakeController({ powerSaveBlocker, powerMonitor });
  return { calls, controller, powerMonitor };
}

test('keep-awake uses the display-sleep blocker and restores defaults when disabled', () => {
  const { calls, controller } = createFixture();
  controller.initialize(false);
  assert.deepEqual(calls, []);

  controller.setEnabled(true);
  controller.setEnabled(true);
  assert.deepEqual(calls, [['start', 'prevent-display-sleep', 10]]);

  controller.setEnabled(false);
  assert.deepEqual(calls, [['start', 'prevent-display-sleep', 10], ['stop', 10]]);
});

test('manual screen lock releases the blocker and unlock restores an enabled preference', () => {
  const { calls, controller, powerMonitor } = createFixture();
  controller.initialize(true);
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('unlock-screen');
  assert.deepEqual(calls, [
    ['start', 'prevent-display-sleep', 10],
    ['stop', 10],
    ['start', 'prevent-display-sleep', 11],
  ]);
});

test('resume does not restart the blocker while the screen remains locked', () => {
  const { calls, controller, powerMonitor } = createFixture();
  controller.initialize(true);
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('suspend');
  powerMonitor.emit('resume');
  assert.equal(calls.length, 2);
  powerMonitor.emit('unlock-screen');
  assert.deepEqual(calls.at(-1), ['start', 'prevent-display-sleep', 11]);
});

test('dispose stops the blocker and removes power event listeners', () => {
  const { calls, controller, powerMonitor } = createFixture();
  controller.initialize(true);
  controller.dispose();
  powerMonitor.emit('unlock-screen');
  powerMonitor.emit('resume');
  assert.deepEqual(calls, [
    ['start', 'prevent-display-sleep', 10],
    ['stop', 10],
  ]);
  assert.equal(powerMonitor.listenerCount('lock-screen'), 0);
  assert.equal(powerMonitor.listenerCount('resume'), 0);
});
