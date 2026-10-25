// Agent Floor desktop app (Electron).
//
// Opens the floor in its own window, with no browser involved. The floor server
// runs inside this process unless one is already running. The window can be
// closed; the app keeps listening from the menu bar / system tray so hooks
// never have to relaunch it. "Quit" pauses auto-launch for a while.
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, nativeTheme } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { markPng } = require('./icon.cjs');
const { snooze } = require('./state.cjs');

const PORT = Number(process.env.AGENT_FLOOR_PORT) || 4317;
const URL = `http://127.0.0.1:${PORT}/?app=1`;
const startedByHook = process.argv.includes('--from-hook');

app.setName('Agent Floor');

if (!app.requestSingleInstanceLock()) {
  // Another window is already open; it will focus itself (see second-instance).
  app.quit();
} else {
  let win = null;
  let tray = null;
  let floor = null;
  let quitting = false;

  async function serverIsUp() {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(600) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function ensureServer() {
    if (await serverIsUp()) return;
    const { startServer } = await import(pathToFileURL(path.join(__dirname, '../server/index.mjs')).href);
    floor = await startServer({ port: PORT, log: () => {}, useHome: true });
  }

  function createWindow() {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 720,
      minHeight: 480,
      title: 'Agent Floor',
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0e13' : '#e7ebf0',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      autoHideMenuBar: true,
      icon: nativeImage.createFromBuffer(markPng(256, { background: true })),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true },
    });
    win.once('ready-to-show', () => {
      // Opened by an agent hook: show without stealing focus from your editor.
      if (startedByHook && process.platform === 'darwin') win.showInactive();
      else win.show();
    });
    // Links (like the GitHub button) open in the real browser; the window stays on the floor.
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(`http://127.0.0.1:${PORT}`)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
    win.on('close', (e) => {
      // Closing the window keeps the floor listening in the tray.
      if (!quitting) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => (win = null));
    win.loadURL(URL);
  }

  function createTray() {
    const image =
      process.platform === 'darwin'
        ? nativeImage.createFromBuffer(markPng(32, { template: true }), { scaleFactor: 2 })
        : nativeImage.createFromBuffer(markPng(32));
    if (process.platform === 'darwin') image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip('Agent Floor');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Agent Floor', click: createWindow },
        { type: 'separator' },
        {
          label: 'Quit (pause auto-open for 6 hours)',
          click: () => {
            snooze(6);
            quitting = true;
            app.quit();
          },
        },
        {
          label: 'Quit',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', createWindow);
  }

  app.on('second-instance', createWindow);
  app.on('activate', createWindow);
  app.on('before-quit', () => (quitting = true));
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });
  app.on('will-quit', () => floor?.close());

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromBuffer(markPng(512, { background: true })));
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
        { role: 'windowMenu' },
      ]),
    );
    await ensureServer();
    createTray();
    createWindow();
  });
}
