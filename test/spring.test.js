const test = require('node:test');
const assert = require('node:assert/strict');

const { createSpring, createVelocityTracker, project, rubberband } = require('../src/shared/spring');

/** Drives a spring on a synthetic 60fps clock so the tests stay deterministic. */
function drive(options, { frames = 600 } = {}) {
  let clock = 0;
  const queue = [];
  const spring = createSpring({
    ...options,
    now: () => clock,
    raf: (fn) => { queue.push(fn); return queue.length; },
    cancelRaf: () => { queue.length = 0; },
  });
  const run = (count = frames) => {
    for (let i = 0; i < count && queue.length; i += 1) {
      const fn = queue.shift();
      clock += 1000 / 60;
      fn(clock);
    }
  };
  return { spring, run };
}

test('momentum projection uses the exponential-decay form iOS ships', () => {
  // 1000px/s with the standard deceleration rate lands ~499px away.
  assert.ok(Math.abs(project(1000) - 499) < 1, `got ${project(1000)}`);
  // A snappier rate travels less, and direction follows the sign.
  assert.ok(project(1000, 0.99) < project(1000));
  assert.ok(project(-1000) < 0);
  assert.equal(project(0), 0);
});

test('rubberband resists progressively and never exceeds the boundary linearly', () => {
  const small = rubberband(10, 400);
  const large = rubberband(200, 400);
  assert.ok(small < 10, 'even a small overshoot is damped');
  assert.ok(large < 200, 'a large overshoot is damped much harder');
  assert.ok(large / 200 < small / 10, 'resistance increases with distance');
  assert.equal(rubberband(0, 400), 0);
});

test('a critically damped spring settles on target without overshooting', () => {
  const seen = [];
  const { spring, run } = drive({
    from: 0, damping: 1, response: 0.3, onFrame: (v) => seen.push(v),
  });
  spring.target(100);
  run();
  assert.equal(spring.running, false, 'spring came to rest');
  assert.equal(spring.value, 100);
  assert.ok(Math.max(...seen) <= 100.5, `no overshoot, peaked at ${Math.max(...seen)}`);
});

test('an underdamped spring overshoots — reserved for momentum interactions', () => {
  const seen = [];
  const { spring, run } = drive({
    from: 0, damping: 0.6, response: 0.3, onFrame: (v) => seen.push(v),
  });
  spring.target(100);
  run();
  assert.ok(Math.max(...seen) > 101, `expected overshoot, peaked at ${Math.max(...seen)}`);
  assert.equal(spring.value, 100, 'still settles exactly on target');
});

test('release velocity is handed off, so a flick keeps travelling', () => {
  const withFlick = drive({ from: 0, damping: 1, response: 0.4, onFrame() {} });
  withFlick.spring.target(100, 2000);
  // One frame of a 2000px/s handoff must move much further than a cold start.
  withFlick.run(1);
  const flicked = withFlick.spring.value;
  const cold = drive({ from: 0, damping: 1, response: 0.4, onFrame() {} });
  cold.spring.target(100);
  cold.run(1);
  assert.ok(flicked > cold.spring.value, `${flicked} should exceed ${cold.spring.value}`);
});

test('re-targeting mid-flight continues from the live value, never jumps', () => {
  const { spring, run } = drive({ from: 0, damping: 1, response: 0.4, onFrame() {} });
  spring.target(300);
  // Stop partway, then reverse — the value must not snap anywhere.
  for (let i = 0; i < 6; i += 1) run(1);
  const mid = spring.value;
  assert.ok(mid > 0 && mid < 300, `mid-flight at ${mid}`);
  spring.target(0);
  run(1);
  assert.ok(Math.abs(spring.value - mid) < 60, 'continuous across the reversal');
  run();
  assert.equal(spring.value, 0);
});

test('velocity tracker reads the flick, not the whole-gesture average', () => {
  const tracker = createVelocityTracker(100);
  // Slow drag for 500ms, then a fast flick in the last 60ms.
  tracker.add(0, 0);
  tracker.add(10, 500);
  tracker.add(70, 530);
  tracker.add(130, 560);
  const v = tracker.velocity();
  assert.ok(v > 1500, `flick velocity ${v} should reflect the last samples only`);
  tracker.reset();
  assert.equal(tracker.velocity(), 0);
});
