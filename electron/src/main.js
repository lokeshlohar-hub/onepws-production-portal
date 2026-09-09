'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');

const PORTAL_URL = 'https://onepws-portal-409434899744.asia-south1.run.app';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow;

// ---- Window-open policy -----------------------------------------------------
// Called whenever the portal invokes window.open(). PDF preview / print / export
// windows all go through here. Anything same-origin, blob:, data:, about:blank
// stays inside Electron so Chromium's built-in PDF viewer + print dialog + save
// prompt can do their jobs. Only truly external URLs get punted to the OS shell.
function isInternalUrl(url) {
  if (!url) return false;
  if (url === 'about:blank') return true;
  if (url.startsWith('blob:')) return true;
  if (url.startsWith('data:')) return true;
  try {
    const u = new URL(url);
    const p = new URL(PORTAL_URL);
    return u.origin === p.origin;
  } catch (_) {
    return false;
  }
}

const childWindowOptions = {
  width: 1200,
  height: 900,
  minWidth: 800,
  minHeight: 600,
  title: 'ONEPWS Production Portal',
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    partition: 'persist:onepws',
  },
};

// Apply the handler to every webContents Electron creates, including child
// windows spawned by window.open(). Otherwise a PDF preview window could
// itself open a "download this file" popup that fell back to the OS shell.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: childWindowOptions,
      };
    }
    shell.openExternal(url).catch((err) => log.warn('shell.openExternal failed:', err));
    return { action: 'deny' };
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'ONEPWS Production Portal',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:onepws',
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('page-title-updated', (e, title) => {
    e.preventDefault();
    mainWindow.setTitle(`${title} | Desktop v${app.getVersion()}`);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return;
    log.warn(`Load failed: ${code} ${desc} ${url}`);
    mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  });

  mainWindow.loadURL(PORTAL_URL);
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Reload Portal', accelerator: 'F5', click: () => mainWindow?.loadURL(PORTAL_URL) },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow?.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Print...', accelerator: 'CmdOrCtrl+P', click: () => mainWindow?.webContents.print() },
        { type: 'separator' },
        { label: 'Check for Updates...', click: () => checkForUpdates(true) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: 'F11' },
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About',
              message: 'ONEPWS Production Portal',
              detail: `Version ${app.getVersion()}\nServer: ${PORTAL_URL}\nLog: ${log.transports.file.getFile().path}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function checkForUpdates(interactive = false) {
  autoUpdater.checkForUpdates()
    .then((res) => {
      if (interactive && (!res || !res.updateInfo || res.updateInfo.version === app.getVersion())) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'No Updates',
          message: `You're on the latest version (${app.getVersion()}).`,
        });
      }
    })
    .catch((err) => {
      log.error('Update check failed:', err);
      if (interactive) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Update Check Failed',
          message: 'Could not reach the update server.',
          detail: String(err.message || err),
        });
      }
    });
}

autoUpdater.on('update-available', (info) => log.info('Update available:', info.version));
autoUpdater.on('update-not-available', () => log.info('No updates.'));
autoUpdater.on('error', (err) => log.error('Updater error:', err));
autoUpdater.on('download-progress', (p) => log.info(`Downloading update: ${Math.round(p.percent)}%`));
autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded:', info.version);
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Ready',
    message: `Version ${info.version} is ready to install.`,
    detail: 'The app will restart to apply the update.',
  }).then((r) => {
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  setTimeout(() => checkForUpdates(false), 10000);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});