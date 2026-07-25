/**
 * Springs and momentum projection — the two pieces of Apple's fluid-interface
 * model that CSS cannot express.
 *
 * Why not a CSS transition: a transition has a fixed duration and animates from
 * wherever it *started*, so grabbing a moving element mid-flight either jumps or
 * has to wait. A spring is defined by its current value + velocity, so it can be
 * re-targeted at any frame and stays continuous. Anything the user can touch
 * should be driven from here.
 *
 * Parameters are Apple's two knobs, not the physics triplet:
 *   damping  — damping ratio. 1 = critically damped (no overshoot, the default
 *              for UI). ~0.8 = a little bounce, and ONLY earned when the motion
 *              continues a gesture the user threw.
 *   response — seconds to reach the target. Not a duration: the settle time
 *              emerges from the parameters.
 */

/**
 * Where a flick would come to rest, using iOS's exponential scroll decay.
 * Snap targets must be chosen from this projection, not from the release point —
 * that's what makes a flick feel thrown rather than nudged.
 *
 * decelerationRate 0.998 ≈ normal scroll feel; 0.99 is snappier.
 */
function project(initialVelocity, decelerationRate = 0.998) {
  if (!Number.isFinite(initialVelocity) || initialVelocity === 0) return 0;
  return (initialVelocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/**
 * Progressive resistance past a boundary: the further out, the less the element
 * follows. A hard stop reads as frozen; this reads as "responsive, but there's
 * nothing more here".
 */
function rubberband(overshoot, dimension, constant = 0.55) {
  if (!overshoot) return 0;
  const limit = Math.max(dimension, 1);
  return (overshoot * limit * constant) / (limit + constant * Math.abs(overshoot));
}

/**
 * A single-axis spring integrated per frame. Decompose 2D motion into two of
 * these — one spring on a 2D distance desyncs when the axes carry different
 * velocities.
 *
 * `target(to, velocity?)` re-targets from the CURRENT value and velocity, which
 * is what makes an interrupted gesture reverse without a visible discontinuity.
 */
function createSpring({
  from = 0,
  velocity = 0,
  damping = 1,
  response = 0.35,
  onFrame,
  onRest,
  restDistance = 0.35,
  restVelocity = 12,
  now = () => performance.now(),
  raf = (fn) => requestAnimationFrame(fn),
  cancelRaf = (handle) => cancelAnimationFrame(handle),
} = {}) {
  let value = from;
  let speed = velocity;
  let goal = from;
  let handle = null;
  let last = 0;
  let running = false;

  function step(clampedDt) {
    // stiffness = (2π/response)², damping coefficient = 4πζ/response
    const omega = (2 * Math.PI) / Math.max(response, 0.0001);
    const acceleration = -(omega * omega) * (value - goal) - 2 * damping * omega * speed;
    speed += acceleration * clampedDt;
    value += speed * clampedDt;
  }

  function frame(timestamp) {
    if (!running) return;
    const dt = Math.min((timestamp - last) / 1000, 1 / 30);
    last = timestamp;
    // Sub-step so a dropped frame can't make the integration explode.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < steps; i += 1) step(dt / steps);
    if (Math.abs(value - goal) < restDistance && Math.abs(speed) < restVelocity) {
      value = goal;
      speed = 0;
      running = false;
      onFrame?.(value);
      onRest?.(value);
      return;
    }
    onFrame?.(value);
    handle = raf(frame);
  }

  return {
    get value() { return value; },
    get velocity() { return speed; },
    get running() { return running; },
    /** Jump without animating (e.g. while the finger is down and tracking 1:1). */
    set(next, nextVelocity = 0) {
      this.stop();
      value = next;
      goal = next;
      speed = nextVelocity;
    },
    /** Animate to `to`, optionally handing off the gesture's release velocity. */
    target(to, nextVelocity) {
      goal = to;
      if (nextVelocity !== undefined) speed = nextVelocity;
      if (running) return;
      running = true;
      last = now();
      handle = raf(frame);
    },
    stop() {
      running = false;
      if (handle !== null) { cancelRaf(handle); handle = null; }
    },
  };
}

/**
 * Rolling pointer history → velocity in px/s. Velocity at release must come from
 * the last few moves, not from (end − start) / total time, which averages away
 * the flick.
 */
function createVelocityTracker(windowMs = 100) {
  let samples = [];
  return {
    reset() { samples = []; },
    add(position, timestamp) {
      samples.push({ position, timestamp });
      const cutoff = timestamp - windowMs;
      while (samples.length > 2 && samples[0].timestamp < cutoff) samples.shift();
    },
    velocity() {
      if (samples.length < 2) return 0;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (last.timestamp - first.timestamp) / 1000;
      if (dt <= 0) return 0;
      return (last.position - first.position) / dt;
    },
  };
}

module.exports = { createSpring, createVelocityTracker, project, rubberband };
