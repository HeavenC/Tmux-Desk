'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// The phone downscales before uploading, so anything past a few MB is either a
// client that skipped the resize or someone poking the endpoint.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

// Pasted images are kept on disk, not deleted after the clipboard write: the
// path is the fallback when the clipboard route fails, and an agent that reads
// the file later still needs it there.
const KEEP_MS = 24 * 60 * 60 * 1000;

const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim() || `${file} 执行失败`));
      else resolve(String(stdout || ''));
    });
  });
}

/* Deliberately NOT os.tmpdir(): deploy.sh used to overwrite the exported TMPDIR
   with a staging dir it then deleted, and `open` handed that environment to the
   app — so os.tmpdir() pointed at a directory that no longer existed and the
   first mkdtemp died with ENOENT. A path we derive ourselves can't be poisoned
   by whatever launched us, and it also gives the fallback a stable location. */
function pasteDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'tmux-desk', 'pasted-images');
  }
  return path.join(os.homedir(), '.cache', 'tmux-desk', 'pasted-images');
}

async function prunePasted(dir) {
  const cutoff = Date.now() - KEEP_MS;
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => {});
  }));
}

/**
 * Write an uploaded image next to the session host and try to put it on that
 * host's system clipboard.
 *
 * No escape sequence carries image bytes into a pane, so a phone pick can't be
 * "typed" into the terminal. What Claude Code does on macOS is read the *system*
 * clipboard when it sees the paste key, so the image goes on this machine's
 * clipboard and the caller then sends \x16 down the normal input path. When that
 * can't work (non-macOS host, no GUI session, osascript refused) the caller gets
 * the absolute path back instead and types that — an agent reads the file just
 * as happily.
 *
 * Clipboard image data has to be a known picture class; `«class PNGf»` is the
 * one every consumer understands, so non-PNG uploads go through sips first.
 *
 * @returns {Promise<{path: string, clipboard: boolean}>}
 */
async function stageImageForPaste(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片内容为空');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片过大');

  const dir = pasteDir();
  await fs.mkdir(dir, { recursive: true });
  await prunePasted(dir).catch(() => {});

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const base = `paste-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const source = path.join(dir, base + (EXTENSIONS[mime] || '.png'));
  await fs.writeFile(source, buffer);

  if (process.platform !== 'darwin') return { path: source, clipboard: false };

  try {
    let png = source;
    if (mime !== 'image/png') {
      png = path.join(dir, `${base}.png`);
      await run('sips', ['-s', 'format', 'png', source, '--out', png]);
    }
    // JSON.stringify produces an AppleScript-compatible quoted string (same
    // escaping for " and \), and the path is one we generated.
    await run('osascript', [
      '-e',
      `set the clipboard to (read (POSIX file ${JSON.stringify(png)}) as «class PNGf»)`,
    ]);
    return { path: png, clipboard: true };
  } catch {
    // Keep the file and let the caller fall back to sending its path.
    return { path: source, clipboard: false };
  }
}

/** Decode a base64 payload, rejecting anything that isn't a plausible image. */
function decodeImagePayload({ data, mime }) {
  if (typeof data !== 'string' || !data) throw new Error('缺少图片数据');
  if (typeof mime !== 'string' || !mime.startsWith('image/')) throw new Error('不支持的图片类型');
  // 4/3 is base64's expansion factor; reject before allocating the buffer.
  if (data.length > MAX_IMAGE_BYTES * 1.4) throw new Error('图片过大');
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  return { buffer, mime };
}

module.exports = { stageImageForPaste, decodeImagePayload, pasteDir, MAX_IMAGE_BYTES };
