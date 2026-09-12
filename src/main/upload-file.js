'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { cacheDir, pruneOld } = require('./clipboard-image');

// Phones upload over the share link, so this is both a memory guard (the body
// is buffered whole, base64-inflated) and a sanity bound on what anyone would
// hand an agent.
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

// Longer than the pasted-image window: an uploaded file is referenced by path
// in the prompt, and a session can come back to it days later.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Make a filename that survives being typed into a terminal.
 *
 * The path is sent as `@<path>`, and whitespace or shell metacharacters end
 * that token — so spaces collapse to `_` and anything that isn't a letter,
 * digit, `.`, `-` or `_` is dropped. Letters stay unicode-aware: Chinese
 * filenames are the common case here and they quote fine.
 */
function sanitizeName(raw) {
  const base = path.basename(String(raw || '')).normalize('NFC');
  const rawExt = path.extname(base);
  const stem = rawExt ? base.slice(0, base.length - rawExt.length) : base;
  let ext = rawExt
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}.]/gu, '')
    .slice(0, 16);
  // `...` extnames to `.`; a bare dot is a trailing-dot filename, not a suffix.
  if (!/[\p{L}\p{N}]/u.test(ext)) ext = '';
  const clean = stem
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/^[._-]+/, '')
    .slice(0, 64);
  return { stem: clean || 'file', ext };
}

/**
 * Write an uploaded file into the session host's cache dir and report where it
 * landed.
 *
 * Unlike an image there is nothing to put on the clipboard — the whole point is
 * the absolute path, which the caller types into the prompt as `@<path>` so the
 * foreground agent reads the file itself.
 *
 * @returns {Promise<{path: string, name: string, size: number}>}
 */
async function stageUploadedFile(buffer, name) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('文件内容为空');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('文件过大');

  const dir = cacheDir('uploads');
  await fs.mkdir(dir, { recursive: true });
  await pruneOld(dir, KEEP_MS).catch(() => {});

  const { stem, ext } = sanitizeName(name);
  // Keep the original stem visible (an agent reasons about `deploy.log` far
  // better than about an opaque id) and make it unique with a short suffix so
  // re-uploading the same name never clobbers an earlier reference.
  const target = path.join(dir, `${stem}-${crypto.randomBytes(3).toString('hex')}${ext}`);
  await fs.writeFile(target, buffer);
  return { path: target, name: path.basename(target), size: buffer.length };
}

/** Decode a base64 upload payload. */
function decodeFilePayload({ data }) {
  if (typeof data !== 'string' || !data) throw new Error('缺少文件数据');
  // 4/3 is base64's expansion factor; reject before allocating the buffer.
  if (data.length > MAX_UPLOAD_BYTES * 1.4) throw new Error('文件过大');
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) throw new Error('文件内容为空');
  return { buffer };
}

module.exports = { stageUploadedFile, decodeFilePayload, sanitizeName, MAX_UPLOAD_BYTES };
