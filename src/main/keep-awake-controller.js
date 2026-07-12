'use strict';

class KeepAwakeController {
  constructor({ powerSaveBlocker, powerMonitor }) {
    if (!powerSaveBlocker || typeof powerSaveBlocker.start !== 'function' || typeof powerSaveBlocker.stop !== 'function') {
      throw new Error('系统保持唤醒能力不可用');
    }
    if (!powerMonitor || typeof powerMonitor.on !== 'function' || typeof powerMonitor.removeListener !== 'function') {
      throw new Error('系统电源状态监听不可用');
    }
    this.powerSaveBlocker = powerSaveBlocker;
    this.powerMonitor = powerMonitor;
    this.enabled = false;
    this.screenLocked = false;
    this.systemSuspended = false;
    this.blockerId = null;
    this.initialized = false;
    this.onLockScreen = () => {
      this.screenLocked = true;
      this.sync();
    };
    this.onUnlockScreen = () => {
      this.screenLocked = false;
      this.sync();
    };
    this.onSuspend = () => {
      this.systemSuspended = true;
      this.sync();
    };
    this.onResume = () => {
      this.systemSuspended = false;
      this.sync();
    };
  }

  initialize(enabled = false) {
    if (!this.initialized) {
      this.powerMonitor.on('lock-screen', this.onLockScreen);
      this.powerMonitor.on('unlock-screen', this.onUnlockScreen);
      this.powerMonitor.on('suspend', this.onSuspend);
      this.powerMonitor.on('resume', this.onResume);
      this.initialized = true;
    }
    this.setEnabled(enabled);
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    this.sync();
  }

  sync() {
    const shouldBlockIdleSleep = this.enabled && !this.screenLocked && !this.systemSuspended;
    if (shouldBlockIdleSleep && this.blockerId === null) {
      this.blockerId = this.powerSaveBlocker.start('prevent-display-sleep');
    } else if (!shouldBlockIdleSleep && this.blockerId !== null) {
      this.powerSaveBlocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }

  dispose() {
    if (this.initialized) {
      this.powerMonitor.removeListener('lock-screen', this.onLockScreen);
      this.powerMonitor.removeListener('unlock-screen', this.onUnlockScreen);
      this.powerMonitor.removeListener('suspend', this.onSuspend);
      this.powerMonitor.removeListener('resume', this.onResume);
      this.initialized = false;
    }
    this.enabled = false;
    this.sync();
  }
}

module.exports = { KeepAwakeController };
