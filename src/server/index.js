const { DEFAULT_PORT, loadToken, listAccessUrls, startWebServer } = require('./web-server');

const PORT = Number(process.env.TMUX_DESK_WEB_PORT) || DEFAULT_PORT;
const HOST = process.env.TMUX_DESK_WEB_HOST || '0.0.0.0';

async function main() {
  const token = loadToken();
  const handle = await startWebServer({ port: PORT, host: HOST, token, log: console.log });

  console.log('Tmux Desk Web 已启动（token 存于 ~/.config/tmux-desk/web-token）');
  console.log(`  本机: http://127.0.0.1:${handle.port}/?token=${token}`);
  const labels = { tailscale: 'Tailscale', lan: '局域网  ', other: '其他网卡' };
  for (const { kind, url } of await listAccessUrls({ port: handle.port, token })) {
    console.log(`  ${labels[kind]}: ${url}`);
  }

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
