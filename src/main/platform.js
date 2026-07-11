const path = require('node:path');

// On Windows there is no native tmux. Tmux Desk drives tmux running inside WSL
// by prefixing every invocation with `wsl.exe`, and translates paths between the
// Windows side (what Electron dialogs and the file browser see) and the WSL side
// (what tmux stores as session/pane working directories).
//
// The default distro and in-WSL tmux command can be pinned with env vars:
//   TMUX_DESK_WSL_DISTRO  -> passed to `wsl -d <distro>` (default: WSL default)
//   TMUX_DESK_WSL_TMUX    -> the tmux command inside WSL (default: `tmux`)

function isWindows(platform = process.platform) {
  return platform === 'win32';
}

function wslConfig(env = process.env) {
  return {
    distro: typeof env.TMUX_DESK_WSL_DISTRO === 'string' && env.TMUX_DESK_WSL_DISTRO.trim()
      ? env.TMUX_DESK_WSL_DISTRO.trim()
      : null,
    tmux: typeof env.TMUX_DESK_WSL_TMUX === 'string' && env.TMUX_DESK_WSL_TMUX.trim()
      ? env.TMUX_DESK_WSL_TMUX.trim()
      : 'tmux',
  };
}

// Build the concrete { file, args } to execute `tmuxArgs` against tmux.
// mac/linux: run the tmux binary directly. windows: run it inside WSL.
function buildTmuxInvocation({ platform = process.platform, tmuxPath, env = process.env } = {}, tmuxArgs = []) {
  if (isWindows(platform)) {
    const { distro, tmux } = wslConfig(env);
    const args = [];
    if (distro) args.push('-d', distro);
    args.push('-e', tmuxPath || tmux, ...tmuxArgs);
    return { file: 'wsl.exe', args };
  }
  return { file: tmuxPath, args: tmuxArgs };
}

// Windows path -> WSL path. Pure and unambiguous:
//   C:\Users\me\proj              -> /mnt/c/Users/me/proj
//   \\wsl$\Ubuntu\home\me\proj    -> /home/me/proj
//   \\wsl.localhost\Ubuntu\home\x -> /home/x
//   /already/posix                -> unchanged
function toWslPath(input) {
  if (typeof input !== 'string' || !input) return input;
  if (input.startsWith('/')) return input;
  const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+\\?(.*)$/i.exec(input);
  if (unc) return '/' + unc[1].replace(/\\/g, '/');
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(input);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/');
    return `/mnt/${drive[1].toLowerCase()}${rest ? '/' + rest : ''}`;
  }
  return input;
}

// WSL path -> Windows path. The /mnt/<drive> case is pure; native paths
// (/home, /root, ...) become a \\wsl$\<distro>\... UNC that Explorer and the
// Node fs layer can read, which needs the distro name (env or discovered).
function toWindowsPath(input, distro) {
  if (typeof input !== 'string' || !input) return input;
  if (/^[A-Za-z]:/.test(input) || input.startsWith('\\\\')) return input;
  const mnt = /^\/mnt\/([A-Za-z])(\/.*)?$/.exec(input);
  if (mnt) {
    const rest = (mnt[2] || '').replace(/\//g, '\\');
    return `${mnt[1].toUpperCase()}:${rest || '\\'}`;
  }
  if (input.startsWith('/')) {
    if (!distro) return null; // cannot form a UNC without knowing the distro
    return `\\\\wsl$\\${distro}${input.replace(/\//g, '\\')}`;
  }
  return input;
}

// The distro whose filesystem native WSL paths (/home, /root, …) live on, needed
// to build a \\wsl$\<distro>\… UNC. Prefer the pinned env var; otherwise take the
// WSL default (first line of `wsl -l -q`). wsl.exe prints UTF-16LE, so drop NUL
// bytes to recover the ASCII distro names. Cached after the first lookup.
let cachedDistro;

function resetWslDistroCache() {
  cachedDistro = undefined;
}

async function resolveWslDistro({ execFileImpl, env = process.env } = {}) {
  const configured = wslConfig(env).distro;
  if (configured) return configured;
  if (cachedDistro !== undefined) return cachedDistro;
  try {
    const run = execFileImpl || defaultExecFile;
    const { stdout } = await run('wsl.exe', ['-l', '-q']);
    const first = String(stdout || '')
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    cachedDistro = first || null;
  } catch {
    cachedDistro = null;
  }
  return cachedDistro;
}

function defaultExecFile(file, args) {
  const { execFile } = require('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => (
      error ? reject(error) : resolve({ stdout, stderr })
    ));
  });
}

module.exports = {
  isWindows,
  wslConfig,
  buildTmuxInvocation,
  toWslPath,
  toWindowsPath,
  resolveWslDistro,
  resetWslDistroCache,
  // path is re-exported for callers that need the win32/posix split explicitly.
  path,
};
