'use strict';
// Secure bridge: the only surface the renderer can touch. No Node, no ipcRenderer
// leak — just these named calls.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    load:       () => ipcRenderer.invoke('timesheet:load'),
    recompute:  () => ipcRenderer.invoke('timesheet:recompute'),
    onProgress: cb => ipcRenderer.on('timesheet:progress', (_e, msg) => cb(msg)),
    minimize:   () => ipcRenderer.send('win:minimize'),
    close:      () => ipcRenderer.send('win:close'),
});
