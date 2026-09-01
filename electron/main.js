// Slow Light desktop shell. The app itself is app.html + app.js, unchanged.
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#1B1F28',
    title: 'Slow Light',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'app.html'));

  // Exports: ask where to save instead of dropping into Downloads silently.
  win.webContents.session.on('will-download', (event, item) => {
    item.setSaveDialogOptions({
      title: 'Save loop',
      defaultPath: path.join(app.getPath('videos'), item.getFilename()),
      filters: [{ name: 'Video', extensions: ['webm', 'mp4'] }],
    });
    item.once('done', (_e, state) => {
      if (state === 'completed') shell.showItemInFolder(item.getSavePath());
    });
  });

  // Links (e.g. the About link) open in the system browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
