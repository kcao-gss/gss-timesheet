'use strict';
// Electron main process. Owns the frameless glass window, runs the existing
// Playwright scrape + model build (in Get-Timesheet.js) off the renderer, and
// streams progress + the final data back over a secure IPC bridge (preload.js).

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { loadTimesheetForApp } = require('./Get-Timesheet.js');

let win;

function createWindow() {
    win = new BrowserWindow({
        width: 480,
        height: 780,
        minWidth: 400,
        minHeight: 560,
        title: 'GSS Timesheet',
        backgroundColor: '#10162b', // matches the CSS gradient base; no white flash
        frame: false,               // custom glass chrome (see the .titlebar in index.html)
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    win.once('ready-to-show', () => win.show());
}

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => app.quit());

// Renderer requests a load; we scrape + build models, pushing progress lines as we go.
ipcMain.handle('timesheet:load', async () => {
    const send = msg => { if (win && !win.isDestroyed()) win.webContents.send('timesheet:progress', msg); };
    try {
        const data = await loadTimesheetForApp({ log: send });
        return { ok: true, data };
    } catch (err) {
        return { ok: false, code: err.code || 'ERROR', message: err.message };
    }
});

// Frameless window controls.
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:close',    () => win && win.close());
