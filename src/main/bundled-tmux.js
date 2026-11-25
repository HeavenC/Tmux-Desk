const fs = require('node:fs');
const path = require('node:path');

// The tmux shipped inside the .app is copied to a per-user directory and run
// from there, never from the bundle itself. The server it starts outlives the
// app, so running it in place would pin wherever the app happened to be opened
// from: a mounted DMG could no longer be ejected (and force-ejecting it kills
// every session), and a translocated or replaced app would leave the server
// running from a path that no longer exists.
//
// Returns the path to run, or null when the app carries no tmux.
async function installBundledTmux({ source, targetDir, fsImpl = fs.promises } = {}) {
  if (!source) return null;
  let wanted;
  try {
    wanted = await fsImpl.readFile(source);
  } catch {
    return null;
  }

  const target = path.join(targetDir, 'tmux');
  const staging = `${target}.${process.pid}.tmp`;
  try {
    const current = await fsImpl.readFile(target).catch(() => null);
    if (current && current.equals(wanted)) {
      await fsImpl.chmod(target, 0o755);
      return target;
    }
    await fsImpl.mkdir(targetDir, { recursive: true });
    // Write beside it and rename over: a tmux server may be running from the
    // old file, and rewriting an executing binary in place can crash it. The
    // rename leaves that server on the old (now unlinked) inode.
    await fsImpl.writeFile(staging, wanted, { mode: 0o755 });
    await fsImpl.rename(staging, target);
    return target;
  } catch {
    await fsImpl.unlink(staging).catch(() => {});
    // Unwritable home directory: running from the bundle beats having no tmux.
    return source;
  }
}

module.exports = { installBundledTmux };
