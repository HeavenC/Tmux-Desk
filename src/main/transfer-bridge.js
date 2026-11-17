'use strict';

/*
 * The desktop end of cross-device file transfer. The renderer never holds the
 * bytes: it names a saved remote connection plus a session path, and this side
 * streams the file between that host's file API and local disk — so a large
 * transfer costs neither renderer memory nor a base64 round trip, and the remote
 * token never has to leave the main process.
 *
 * Electron specifics (save dialog, opening a file, where Downloads is, pushing
 * progress to the window) are injected, which keeps this testable in plain Node.
 */

const path = require('node:path');

const {
  TransferError,
  copyIntoDirectory,
  downloadToFile,
  hostUrl,
  localFileName,
  uploadFromFile,
} = require('./file-transfer');
const { toBrowsablePath } = require('./file-service');

function createTransferBridge({ preferencesStore, downloadsDir, chooseSavePath, openPath, onProgress }) {
  const active = new Map();

  async function connectionFor(id) {
    const preferences = await preferencesStore.load();
    const connection = (preferences.remoteConnections || []).find((candidate) => candidate.id === id);
    if (!connection || !connection.base || !connection.token) throw new TransferError(404, '远程主机不存在或已被删除');
    return connection;
  }

  async function track(transferId, run) {
    const controller = new AbortController();
    if (transferId) active.set(transferId, controller);
    const progress = (loaded, total) => {
      if (transferId) onProgress?.({ id: transferId, loaded, total });
    };
    try {
      return await run(controller.signal, progress);
    } finally {
      if (transferId) active.delete(transferId);
    }
  }

  return {
    async download({ connectionId, session, path: remotePath, mode = 'download', transferId }) {
      const connection = await connectionFor(connectionId);
      const name = localFileName(path.posix.basename(remotePath));
      let destPath = null;
      if (mode === 'save-as') {
        destPath = await chooseSavePath(path.join(downloadsDir(), name));
        if (!destPath) return { canceled: true };
      }
      const url = hostUrl(connection.base, '/api/files/download', { token: connection.token, session, path: remotePath });
      const result = await track(transferId, (signal, progress) => downloadToFile({
        url,
        destDir: downloadsDir(),
        destPath,
        name,
        onProgress: progress,
        signal,
        label: connection.label,
      }));
      if (mode === 'open') await openPath(result.path);
      return { canceled: false, ...result };
    },

    async upload({ connectionId, session, dir, source, transferId }) {
      const connection = await connectionFor(connectionId);
      const url = hostUrl(connection.base, '/api/files/upload', {
        token: connection.token,
        session,
        dir,
        name: path.basename(source),
      });
      return track(transferId, (signal, progress) => uploadFromFile({
        url,
        filePath: source,
        onProgress: progress,
        signal,
        label: connection.label,
      }));
    },

    // A local session's directory is on this disk: "upload" is a copy.
    async copyInto({ sources, dir }) {
      return copyIntoDirectory(sources, await toBrowsablePath(dir));
    },

    cancel(transferId) {
      const controller = active.get(transferId);
      if (!controller) return false;
      controller.abort();
      return true;
    },

    dispose() {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}

module.exports = { createTransferBridge };
