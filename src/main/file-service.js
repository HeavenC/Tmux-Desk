const fs = require('node:fs/promises');
const path = require('node:path');
const { isWindows, toWindowsPath, resolveWslDistro } = require('./platform');

function validatePath(target) {
  if (typeof target !== 'string' || !target || target.length > 4096 || target.includes('\0') || !path.isAbsolute(target)) {
    throw new Error('路径无效');
  }
  return target;
}

// tmux hands back WSL paths (/home/…, /mnt/c/…). Before the Windows fs can read
// them they must become a Windows path — a drive path for /mnt or a \\wsl$ UNC
// for native paths. Windows paths and already-translated children pass through.
async function toBrowsablePath(target, { platform } = {}) {
  if (!isWindows(platform)) return validatePath(target);
  if (/^[A-Za-z]:/.test(target) || target.startsWith('\\\\')) return validatePath(target);
  const distro = await resolveWslDistro();
  const win = toWindowsPath(target, distro);
  if (!win) throw new Error('无法定位该 WSL 目录，请设置 TMUX_DESK_WSL_DISTRO 环境变量');
  return validatePath(win);
}

// A read-only directory listing used by the Finder-style side panel. Folders
// sort before files; symlinks are resolved so a linked directory still expands.
async function listDirectory(dirPath, { fsImpl = fs, platform } = {}) {
  const dir = await toBrowsablePath(dirPath, { platform });
  const dirents = await fsImpl.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(dirents.map(async (dirent) => {
    const full = path.join(dir, dirent.name);
    let isDir = dirent.isDirectory();
    const isSymlink = dirent.isSymbolicLink();
    let size = 0;
    try {
      const stat = isSymlink ? await fsImpl.stat(full) : await fsImpl.lstat(full);
      isDir = isSymlink ? stat.isDirectory() : isDir;
      size = stat.isFile() ? stat.size : 0;
    } catch {
      // Broken symlink or permission denied — surface the entry, just without a size.
    }
    return { name: dirent.name, path: full, isDir, isSymlink, hidden: dirent.name.startsWith('.'), size };
  }));
  entries.sort((left, right) => (
    left.isDir === right.isDir
      ? left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
      : left.isDir ? -1 : 1
  ));
  return { path: dir, entries };
}

module.exports = { listDirectory, validatePath, toBrowsablePath };
