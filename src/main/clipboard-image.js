'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// The phone downscales before uploading, so anything past a few MB is either a
// client that skipped the resize or someone poking the endpoint.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

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

/**
 * Put an image on the system clipboard, the way ⌘C on a file in Finder would.
 *
 * There is no escape sequence that carries image bytes into a pane, so a phone
 * pick can't be "typed" into the terminal. What Claude Code (and anything else
 * that handles Ctrl-V) actually does on macOS is read the *system* clipboard
 * when it sees the paste key — so the image goes on this machine's clipboard
 * first, and the caller then sends \x16 through the normal input path.
 *
 * Clipboard image data has to be a known picture class; `«class PNGf»` is the
 * one every consumer understands, so non-PNG uploads go through sips first
 * rather than being handed over as-is.
 */
async function putImageOnClipboard(buffer, mime) {
  if (process.platform !== 'darwin') {
    throw new Error('贴图目前只支持 macOS 主机');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片内容为空');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片过大');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmux-desk-paste-'));
  const source = path.join(dir, `image${EXTENSIONS[mime] || '.png'}`);
  try {
    await fs.writeFile(source, buffer);
    let png = source;
    if (mime !== 'image/png') {
      png = path.join(dir, 'image-converted.png');
      await run('sips', ['-s', 'format', 'png', source, '--out', png]);
    }
    // JSON.stringify gives an AppleScript-compatible quoted string (same
    // escaping rules for " and \), and the path is one we generated.
    await run('osascript', [
      '-e',
      `set the clipboard to (read (POSIX file ${JSON.stringify(png)}) as «class PNGf»)`,
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
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

module.exports = { putImageOnClipboard, decodeImagePayload, MAX_IMAGE_BYTES };
