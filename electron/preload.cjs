"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("cleanmark", {
  openFile: () => ipcRenderer.invoke("dialog:open-file"),
  openFolder: () => ipcRenderer.invoke("dialog:open-folder"),
  scanFolderForTest: (directory) => ipcRenderer.invoke("test:scan-folder", directory),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  saveFile: (filePath, content) => ipcRenderer.invoke("file:save", { filePath, content }),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  setDirty: (dirty) => ipcRenderer.send("window:set-dirty", Boolean(dirty)),
  setTitle: (title) => ipcRenderer.send("window:set-title", title),
  finishClose: (saved) => ipcRenderer.send("window:finish-close", Boolean(saved)),
  pathForDroppedFile: (file) => webUtils.getPathForFile(file),
  onCommand: (callback) => subscribe("app:command", callback),
  onSaveBeforeClose: (callback) => subscribe("app:save-before-close", callback),
  onE2eRun: (callback) => subscribe("app:e2e-run", callback),
  reportE2e: (result) => ipcRenderer.send("app:e2e-result", result),
});
