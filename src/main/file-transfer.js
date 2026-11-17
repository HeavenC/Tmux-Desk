'use strict';

/*
 * Cross-device file transfer for the files under a tmux session's working
 * directories.
 *
 * Serving side (used by the web server): list / stream-download / stream-upload,
 * confined to the session's pane directories. Client side (used by the desktop
 * main process and by the web server's relay): stream the same endpoints of
 * another Tmux Desk host to and from local disk.
 *
 * Bodies are streamed both ways, never buffered or base64'd: a transfer is
 * whatever the user drags in, and a multi-GB build artifact must not have to fit
 * in memory on any of the hops.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { listDirectory, toBrowsablePath } = require('./file-service');

// Disk, not memory, is what a streamed upload consumes; the cap only stops a
// runaway client from filling the session host's disk.
const MAX_TRANSFER_BYTES = 4 * 1024 * 1024 * 1024;
// A stalled peer (host asleep mid-transfer, network gone) is detected by
// inactivity rather than total duration, so a slow-but-moving transfer of a big
// file never times out.
const IDLE_TIMEOUT_MS = 30000;
const PART_SUFFIX = '.tmux-desk-part';

class TransferError extends Error {
  constructor(status, message) {
    super(message);
    // name stays 'Error': Electron serializes a rejected IPC call as
    // "<name>: <message>", and the renderer strips only the plain "Error:" prefix.
    this.status = status;
  }
}

// ── Session path confinement ────────────────────────────────────────────────
// tmux reports pane directories in its own (POSIX) namespace — on Windows that
// is WSL — so containment is decided there, and only the final filesystem call
// translates to a native path.

function normalizeSessionPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !value.startsWith('/')) {
    return null;
  }
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function isWithin(root, target) {
  if (root === '/') return true;
  return target === root || target.startsWith(`${root}/`);
}

/**
 * Directories a client may reach for this session: every pane's cwd, the
 * focused pane of the active window first (it is where the file panel opens).
 * A shell in any of those panes can already read them, so this is the scope the
 * token holder had anyway — the confinement keeps a transfer endpoint from being
 * a wider door than the terminal it sits next to.
 */
function sessionRoots(detail) {
  const windows = Array.isArray(detail?.windows) ? detail.windows : [];
  const panes = Array.isArray(detail?.panes) ? detail.panes : [];
  const activeWindow = windows.find((window) => window.active);
  const focused = panes.find((pane) => pane.active && (!activeWindow || pane.windowId === activeWindow.id))
    || panes.find((pane) => pane.active)
    || panes[0];
  const roots = [];
  for (const pane of [focused, ...panes]) {
    const normalized = normalizeSessionPath(pane?.path);
    if (normalized && !roots.includes(normalized)) roots.push(normalized);
  }
  return { root: roots[0] || null, roots };
}

function resolveSessionPath(detail, requested) {
  const { root, roots } = sessionRoots(detail);
  if (!root) throw new TransferError(404, '会话没有可访问的工作目录');
  if (requested === undefined || requested === null || requested === '') return { path: root, root, roots };
  const target = normalizeSessionPath(requested);
  if (!target) throw new TransferError(400, '路径无效');
  if (!roots.some((candidate) => isWithin(candidate, target))) {
    throw new TransferError(403, '只能访问会话工作目录下的文件');
  }
  return { path: target, root, roots };
}

function parentWithin(target, roots) {
  const parent = path.posix.dirname(target);
  if (parent === target) return null;
  return roots.some((root) => isWithin(root, parent)) ? parent : null;
}

function fsError(error) {
  if (error instanceof TransferError) return error;
  switch (error?.code) {
    case 'ENOENT': return new TransferError(404, '文件或目录不存在');
    case 'EACCES':
    case 'EPERM': return new TransferError(403, '没有权限访问');
    case 'ENOTDIR': return new TransferError(400, '不是文件夹');
    case 'EISDIR': return new TransferError(400, '这是一个文件夹');
    case 'ENOSPC': return new TransferError(507, '目标磁盘空间不足');
    default: return error;
  }
}

// ── Names ───────────────────────────────────────────────────────────────────

/**
 * A received file keeps the name the user gave it (spaces, CJK and all — it is
 * landing in their project, not being typed as an `@token`); only what would
 * escape the target directory or confuse a filesystem is refused.
 */
function validateTransferName(raw) {
  if (typeof raw !== 'string') throw new TransferError(400, '文件名无效');
  const name = raw.normalize('NFC').trim();
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255) {
    throw new TransferError(400, '文件名无效');
  }
  return name;
}

/** Make a remote name safe to create on THIS machine's filesystem. */
function localFileName(raw, { platform = process.platform } = {}) {
  let name = String(raw || '').normalize('NFC').replace(/[/\\\x00-\x1f\x7f]/g, '_').trim();
  if (platform === 'win32') name = name.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'download';
  return name;
}

function splitName(name) {
  const ext = path.extname(name);
  // `.env` has no extension; `archive.tar.gz` numbers before `.gz`, which is
  // what Finder and browsers do too.
  return ext && ext !== name ? { stem: name.slice(0, -ext.length), ext } : { stem: name, ext: '' };
}

/**
 * Claim a free name in `dir` (`name`, `name (1)`, …) by actually creating it —
 * an exclusive create is the only check that can't race another upload of the
 * same name. The caller then renames its finished temp file over the claim.
 */
async function reserveUniquePath(dir, name, { directory = false } = {}) {
  const { stem, ext } = splitName(name);
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(dir, index ? `${stem} (${index})${ext}` : name);
    try {
      if (directory) await fsp.mkdir(candidate);
      else await (await fsp.open(candidate, 'wx')).close();
      return candidate;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw fsError(error);
    }
  }
  throw new TransferError(409, '同名文件过多');
}

function tempPathFor(dir, name) {
  return path.join(dir, `.${name.slice(0, 120)}.${crypto.randomBytes(4).toString('hex')}${PART_SUFFIX}`);
}

function byteCounter(limit, onChunk) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (limit && total > limit) {
        callback(new TransferError(413, '文件过大'));
        return;
      }
      onChunk?.(total);
      callback(null, chunk);
    },
  });
}

// ── Serving side ────────────────────────────────────────────────────────────

async function listSessionDirectory(detail, requested, { platform } = {}) {
  const { path: dir, root, roots } = resolveSessionPath(detail, requested);
  let listing;
  try {
    listing = await listDirectory(dir, { platform });
  } catch (error) {
    throw fsError(error);
  }
  return {
    path: dir,
    root,
    parent: parentWithin(dir, roots),
    // Entry paths stay in the session's namespace, so they can be handed back
    // as-is (on Windows the listing itself works on the translated path).
    entries: listing.entries.map((entry) => ({
      name: entry.name,
      path: path.posix.join(dir, entry.name),
      isDir: entry.isDir,
      isSymlink: entry.isSymlink,
      hidden: entry.hidden,
      size: entry.size,
      mtime: entry.mtime || 0,
    })),
  };
}

async function openSessionFile(detail, requested, { platform } = {}) {
  if (!requested) throw new TransferError(400, '缺少文件路径');
  const { path: target } = resolveSessionPath(detail, requested);
  try {
    const fsPath = await toBrowsablePath(target, { platform });
    const stat = await fsp.stat(fsPath);
    if (stat.isDirectory()) throw new TransferError(400, '暂不支持下载文件夹');
    if (!stat.isFile()) throw new TransferError(400, '不是普通文件');
    return { fsPath, name: path.posix.basename(target), size: stat.size };
  } catch (error) {
    throw fsError(error);
  }
}

// RFC 6266 / 5987: a plain-ASCII fallback for old clients plus the exact UTF-8
// name, so a Chinese filename survives the trip instead of becoming `____.md`.
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Only types worth a better default than octet-stream on a phone (iOS picks the
// preview from it). Never text/html or SVG — files are served from the app's own
// origin, and a type the browser would execute must not get one.
const DOWNLOAD_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
};

async function sendSessionFile(res, file, { headOnly = false } = {}) {
  res.writeHead(200, {
    'Content-Type': DOWNLOAD_TYPES[path.extname(file.name).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(file.size),
    'Content-Disposition': contentDisposition(file.name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Belt and braces for the attachment disposition: even if something renders
    // the body, it runs with no script and no access to this origin.
    'Content-Security-Policy': 'sandbox',
  });
  if (headOnly) {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(file.fsPath), res);
}

/**
 * Stream a request body into `dir` under `name`. The bytes land in a hidden
 * temp file first, and only a complete upload is renamed into place — an
 * aborted transfer never leaves a truncated file that looks real.
 */
async function receiveSessionUpload(req, detail, { dir, name, platform, limit = MAX_TRANSFER_BYTES } = {}) {
  const { path: targetDir } = resolveSessionPath(detail, dir);
  const cleanName = validateTransferName(name);
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new TransferError(413, '文件过大');

  let fsDir;
  try {
    fsDir = await toBrowsablePath(targetDir, { platform });
    if (!(await fsp.stat(fsDir)).isDirectory()) throw new TransferError(400, '目标不是文件夹');
  } catch (error) {
    throw fsError(error);
  }

  const temp = tempPathFor(fsDir, cleanName);
  let size = 0;
  let finalPath = null;
  try {
    await pipeline(req, byteCounter(limit, (total) => { size = total; }), fs.createWriteStream(temp, { flags: 'wx' }));
    finalPath = await reserveUniquePath(fsDir, cleanName);
    await fsp.rename(temp, finalPath);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    if (finalPath) await fsp.rm(finalPath, { force: true }).catch(() => {});
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') throw new TransferError(400, '上传中断');
    throw fsError(error);
  }
  const finalName = path.basename(finalPath);
  return { name: finalName, path: path.posix.join(targetDir, finalName), size };
}

// ── Client side ─────────────────────────────────────────────────────────────

function hostUrl(base, pathname, params = {}) {
  const url = new URL(`${String(base || '').replace(/\/+$/, '')}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * One HTTP exchange with a peer host, body streamed in and response handed back
 * unread. Plain http/https rather than fetch: both directions need a Node stream
 * with byte-level progress, and an idle timer that resets on every packet.
 */
function streamRequest(target, { method = 'GET', headers = {}, body = null, signal, idleTimeout = IDLE_TIMEOUT_MS } = {}) {
  const url = target instanceof URL ? target : new URL(target);
  const transport = url.protocol === 'https:' ? https : (url.protocol === 'http:' ? http : null);
  if (!transport) return Promise.reject(new Error('仅支持 http / https 远程地址'));
  if (signal?.aborted) return Promise.reject(new TransferError(499, '已取消'));
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method, headers });
    const onAbort = () => req.destroy(new TransferError(499, '已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(idleTimeout, () => req.destroy(new TransferError(504, '远程主机无响应（超时）')));
    req.on('response', (res) => {
      res.on('close', () => signal?.removeEventListener('abort', onAbort));
      resolve(res);
    });
    req.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      if (error instanceof TransferError) reject(error);
      else if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ECONNRESET'].includes(error?.code)) {
        reject(new TransferError(502, '无法连接远程主机'));
      } else reject(error);
    });
    if (body) {
      body.on('error', (error) => req.destroy(error));
      body.pipe(req);
    } else {
      req.end();
    }
  });
}

async function readBody(res, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A host that predates these endpoints answers the generic 404 — say so, rather
// than relaying "未知接口" as if the app itself were broken.
function peerError(status, payload, label) {
  const message = payload?.error;
  if (status === 404 && (!message || /未知接口/.test(message))) {
    return new TransferError(501, `远程主机${label ? `「${label}」` : ''}版本较旧，不支持文件传输`);
  }
  return new TransferError(status >= 400 ? status : 502, message || `远程请求失败（${status}）`);
}

async function readJsonResponse(res, { label } = {}) {
  const text = await readBody(res);
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (res.statusCode < 200 || res.statusCode >= 300 || !payload || payload.ok === false) {
    throw peerError(res.statusCode, payload, label);
  }
  return payload;
}

function throttle(fn, intervalMs = 120) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    fn(...args);
  };
}

/**
 * Download a peer host's session file to local disk. With `destPath` the file
 * goes exactly there (a save dialog already confirmed any overwrite); otherwise
 * it gets a free name in `destDir`, the way a browser fills ~/Downloads.
 */
async function downloadToFile({ url, destDir, destPath, name, onProgress, signal, label }) {
  const res = await streamRequest(url, { signal });
  if (res.statusCode !== 200) {
    const text = await readBody(res);
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* non-JSON */ }
    throw peerError(res.statusCode, payload, label);
  }
  const total = Number(res.headers['content-length']) || 0;
  const targetDir = destPath ? path.dirname(destPath) : destDir;
  const fileName = destPath ? path.basename(destPath) : localFileName(name);
  const temp = tempPathFor(targetDir, fileName);
  const report = onProgress ? throttle(onProgress) : null;
  let received = 0;
  let finalPath = null;
  try {
    await pipeline(res, byteCounter(0, (count) => { received = count; report?.(count, total); }), fs.createWriteStream(temp, { flags: 'wx' }));
    if (total && received !== total) throw new TransferError(502, '下载不完整，连接中断');
    finalPath = destPath || await reserveUniquePath(targetDir, fileName);
    await fsp.rename(temp, finalPath);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    if (finalPath && !destPath) await fsp.rm(finalPath, { force: true }).catch(() => {});
    if (signal?.aborted) throw new TransferError(499, '已取消');
    if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE' || error?.code === 'ECONNRESET') {
      throw new TransferError(502, '下载中断，连接已断开');
    }
    throw fsError(error);
  }
  onProgress?.(received, total || received);
  return { path: finalPath, name: path.basename(finalPath), size: received };
}

/** Upload one local file to a peer host's session directory. */
async function uploadFromFile({ url, filePath, onProgress, signal, label }) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch (error) { throw fsError(error); }
  if (stat.isDirectory()) throw new TransferError(400, '暂不支持上传文件夹');
  if (!stat.isFile()) throw new TransferError(400, '不是普通文件');
  if (stat.size > MAX_TRANSFER_BYTES) throw new TransferError(413, '文件过大');
  const report = onProgress ? throttle(onProgress) : null;
  const body = fs.createReadStream(filePath).pipe(byteCounter(0, (count) => report?.(count, stat.size)));
  const res = await streamRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size) },
    body,
    signal,
  });
  const payload = await readJsonResponse(res, { label });
  onProgress?.(stat.size, stat.size);
  return { name: payload.name, path: payload.path, size: payload.size ?? stat.size };
}

/**
 * The local-session counterpart of an upload: the session shares this
 * filesystem, so dropping files on its folder is a plain copy (folders
 * included), never clobbering what is already there.
 */
async function copyIntoDirectory(sources, destDir) {
  let destStat;
  try { destStat = await fsp.stat(destDir); } catch (error) { throw fsError(error); }
  if (!destStat.isDirectory()) throw new TransferError(400, '目标不是文件夹');
  const resolvedDest = path.resolve(destDir);
  const copied = [];
  for (const source of sources) {
    let stat;
    try { stat = await fsp.stat(source); } catch (error) { throw fsError(error); }
    const resolvedSource = path.resolve(source);
    if (stat.isDirectory() && (resolvedDest === resolvedSource || resolvedDest.startsWith(`${resolvedSource}${path.sep}`))) {
      throw new TransferError(400, '不能把文件夹复制到它自己里面');
    }
    const target = await reserveUniquePath(destDir, path.basename(resolvedSource), { directory: stat.isDirectory() });
    try {
      // The target folder is our own fresh (empty) claim, so filling it can't
      // overwrite anything; errorOnExist would refuse the claim itself.
      if (stat.isDirectory()) await fsp.cp(resolvedSource, target, { recursive: true, errorOnExist: false, force: false });
      else await fsp.copyFile(resolvedSource, target);
    } catch (error) {
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      throw fsError(error);
    }
    copied.push({ name: path.basename(target), path: target });
  }
  return copied;
}

module.exports = {
  MAX_TRANSFER_BYTES,
  TransferError,
  contentDisposition,
  copyIntoDirectory,
  downloadToFile,
  hostUrl,
  isWithin,
  listSessionDirectory,
  localFileName,
  normalizeSessionPath,
  openSessionFile,
  readJsonResponse,
  peerError,
  receiveSessionUpload,
  reserveUniquePath,
  resolveSessionPath,
  sendSessionFile,
  sessionRoots,
  streamRequest,
  uploadFromFile,
  validateTransferName,
};
