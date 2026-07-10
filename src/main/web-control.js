const {
  DEFAULT_PORT, loadToken, listAccessUrls, startWebServer, probeExternalServer,
} = require('../server/web-server');

// Controls the in-process mobile web server. A daemon started from the CLI
// (`npm run serve:web`) may already own the port — treat it as "running
// (external)" and surface its URLs instead of failing to bind.
function createWebControl({
  port = Number(process.env.TMUX_DESK_WEB_PORT) || DEFAULT_PORT,
  preferencesStore,
} = {}) {
  let handle = null;

  async function describe(running, external) {
    const token = loadToken();
    return {
      running,
      external,
      port,
      urls: running ? await listAccessUrls({ port, token }) : [],
    };
  }

  async function status() {
    if (handle) return describe(true, false);
    return describe(await probeExternalServer({ port, token: loadToken() }), true);
  }

  async function start() {
    if (!handle) {
      const token = loadToken();
      if (await probeExternalServer({ port, token })) return describe(true, true);
      handle = await startWebServer({ port, token, preferencesStore });
    }
    return describe(true, false);
  }

  async function stop() {
    if (handle) {
      await handle.close();
      handle = null;
      return describe(false, false);
    }
    if (await probeExternalServer({ port, token: loadToken() })) {
      throw new Error('Web 服务由外部进程启动，请在终端里停止它（如 kill 该 node 进程）');
    }
    return describe(false, false);
  }

  async function dispose() {
    if (!handle) return;
    await handle.close();
    handle = null;
  }

  return { status, start, stop, dispose };
}

module.exports = { createWebControl };
