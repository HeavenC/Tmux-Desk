const {
  DEFAULT_PORT, createSessionShareToken, loadToken, listAccessUrls, startWebServer, probeExternalServer,
} = require('../server/web-server');

function sessionShareUrls(urls, shareToken) {
  return urls.map((entry) => {
    const url = new URL(entry.url);
    url.search = '';
    url.searchParams.set('share', shareToken);
    return { ...entry, url: url.toString() };
  });
}

// Controls the in-process mobile web server. A daemon started from the CLI
// (`npm run serve:web`) may already own the port — treat it as "running
// (external)" and surface its URLs instead of failing to bind.
function createWebControl({
  port = Number(process.env.TMUX_DESK_WEB_PORT) || DEFAULT_PORT,
  preferencesStore,
  loadWebToken = loadToken,
  listUrls = listAccessUrls,
  createShareToken = createSessionShareToken,
  probeServer = probeExternalServer,
  startServer = startWebServer,
} = {}) {
  let handle = null;

  async function describe(running, external, sessionName = null) {
    const token = loadWebToken();
    const urls = running ? await listUrls({ port, token }) : [];
    return {
      running,
      external,
      port,
      urls: sessionName
        ? sessionShareUrls(urls, createShareToken(token, sessionName))
        : urls,
    };
  }

  async function status(sessionName = null) {
    if (handle) return describe(true, false, sessionName);
    const token = loadWebToken();
    const running = await probeServer({ port, token });
    if (running && sessionName) await requireExternalSessionShare(token, sessionName);
    return describe(running, true, sessionName);
  }

  async function start(sessionName = null) {
    if (!handle) {
      const token = loadWebToken();
      if (await probeServer({ port, token })) {
        if (sessionName) await requireExternalSessionShare(token, sessionName);
        return describe(true, true, sessionName);
      }
      handle = await startServer({ port, token, preferencesStore });
    }
    return describe(true, false, sessionName);
  }

  async function requireExternalSessionShare(token, sessionName) {
    const share = createShareToken(token, sessionName);
    if (await probeServer({ port, share })) return;
    throw new Error(
      `端口 ${port} 由旧版 Web 服务占用，暂不支持单会话分享。`
      + '请在终端停止并重新运行 npm run serve:web，或退出旧版 Tmux Desk 后重试。',
    );
  }

  async function stop() {
    if (handle) {
      await handle.close();
      handle = null;
      return describe(false, false);
    }
    if (await probeServer({ port, token: loadWebToken() })) {
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

module.exports = { createWebControl, sessionShareUrls };
