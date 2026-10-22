const { app, BrowserWindow, ipcMain, WebContentsView, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win;
let tabs = [];
let activeTab = null;
let bookmarks = [];
let downloads = [];
let nextDownloadId = 1;

const BAR_HEIGHT = 126;
const HOME_URL = require('url').pathToFileURL(path.join(__dirname, 'home.html')).href;
const dataFile = () => path.join(app.getPath('userData'), 'astrava-bookmarks.json');

function loadBookmarks() {
  try {
    bookmarks = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    if (!Array.isArray(bookmarks)) bookmarks = [];
  } catch {
    bookmarks = [];
  }
}

function saveBookmarks() {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    fs.writeFileSync(dataFile(), JSON.stringify(bookmarks, null, 2));
  } catch (error) {
    console.error('Could not save bookmarks:', error.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 850,
    minHeight: 600,
    backgroundColor: '#090612',
    title: 'Astrava Browser',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile('index.html');
  win.on('resize', layoutTabs);
  win.on('closed', () => {
    for (const tab of tabs) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    tabs = [];
    activeTab = null;
    win = null;
  });
}

function layoutTabs() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  if (activeTab) {
    activeTab.view.setBounds({
      x: 0,
      y: BAR_HEIGHT,
      width,
      height: Math.max(100, height - BAR_HEIGHT)
    });
  }
}

function normalizeAddress(value) {
  const input = String(value || '').trim();
  if (!input) return HOME_URL;
  if (/^astrava:\/\/home\/?$/i.test(input)) return HOME_URL;
  if (/^https?:\/\//i.test(input)) return input;

  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(input) && !input.includes(' ')) {
    return 'https://' + input;
  }

  return 'https://www.google.com/search?q=' + encodeURIComponent(input);
}

function sendState() {
  if (!win || win.isDestroyed()) return;

  win.webContents.send('browser:state', {
    tabs: tabs.map(t => ({
      id: t.id,
      title: t.title || 'New Tab',
      url: t.url || ''
    })),
    activeId: activeTab?.id || null,
    url: activeTab?.url || '',
    canBack: activeTab ? activeTab.view.webContents.canGoBack() : false,
    canForward: activeTab ? activeTab.view.webContents.canGoForward() : false,
    bookmarks,
    downloads
  });
}

function createTab(url = HOME_URL) {
  if (!win) return;

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const tab = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    view,
    title: 'New Tab',
    url
  };

  tabs.push(tab);
  win.contentView.addChildView(view);

  view.webContents.setWindowOpenHandler(({ url: target }) => {
    createTab(target);
    return { action: 'deny' };
  });

  // Keep Astrava's local start page from navigating away.
  view.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('file:') && target !== HOME_URL) {
      event.preventDefault();
    }
  });

  view.webContents.on('page-title-updated', (_event, title) => {
    tab.title = title;
    sendState();
  });

  view.webContents.on('did-navigate', (_event, url) => {
    tab.url = url;
    sendState();
  });

  view.webContents.on('did-navigate-in-page', (_event, url) => {
    tab.url = url;
    sendState();
  });

  view.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      tab.title = 'Unable to load page';
      sendState();
    }
  });

  activateTab(tab.id);
  view.webContents.loadURL(url === HOME_URL ? HOME_URL : normalizeAddress(url)).catch(error => {
    console.error('Navigation failed:', error.message);
  });
}

function activateTab(id) {
  if (!win) return;

  if (activeTab) win.contentView.removeChildView(activeTab.view);
  activeTab = tabs.find(t => t.id === id) || null;

  if (activeTab) {
    win.contentView.addChildView(activeTab.view);
    layoutTabs();
  }
  sendState();
}

function closeTab(id) {
  const index = tabs.findIndex(t => t.id === id);
  if (index < 0) return;

  const tab = tabs[index];
  if (win) win.contentView.removeChildView(tab.view);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  tabs.splice(index, 1);

  if (activeTab === tab) {
    activeTab = null;
    if (tabs.length) activateTab(tabs[Math.min(index, tabs.length - 1)].id);
    else createTab();
  } else {
    sendState();
  }
}

function uniqueDownloadPath(filename) {
  const dir = app.getPath('downloads');
  fs.mkdirSync(dir, { recursive: true });

  const name = path.basename(filename || 'download');
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let destination = path.join(dir, name);
  let n = 1;

  while (fs.existsSync(destination)) {
    destination = path.join(dir, `${base} (${n++})${ext}`);
  }

  return destination;
}

function startDownloadHandling() {
  session.defaultSession.on('will-download', (_event, item) => {
    const id = nextDownloadId++;
    const savePath = uniqueDownloadPath(item.getFilename());

    item.setSavePath(savePath);

    const record = {
      id,
      filename: path.basename(savePath),
      path: savePath,
      received: 0,
      total: item.getTotalBytes(),
      state: 'Downloading'
    };

    downloads.unshift(record);
    sendState();

    item.on('updated', (_event, state) => {
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.state = state === 'interrupted'
        ? 'Interrupted' : 'Downloading';
      sendState();
    });

    item.once('done', (_event, state) => {
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.path = item.getSavePath() || savePath;
      record.state = state === 'completed' ? 'Completed'
        : state === 'cancelled' ? 'Cancelled' : 'Failed';
      sendState();
    });
  });
}

ipcMain.on('panel:visibility', (_event, visible) => {
  if (!activeTab || activeTab.view.webContents.isDestroyed()) return;
  activeTab.view.setVisible(!visible);
});

ipcMain.on('tab:new', () => createTab());
ipcMain.on('tab:activate', (_event, id) => activateTab(id));
ipcMain.on('tab:close', (_event, id) => closeTab(id));

ipcMain.on('nav:go', (_event, value) => {
  if (!activeTab) return;
  const url = normalizeAddress(value);
  activeTab.url = url;
  activeTab.view.webContents.loadURL(url).catch(() => {});
  sendState();
});

ipcMain.on('nav:back', () => {
  if (activeTab?.view.webContents.canGoBack()) activeTab.view.webContents.goBack();
});

ipcMain.on('nav:forward', () => {
  if (activeTab?.view.webContents.canGoForward()) activeTab.view.webContents.goForward();
});

ipcMain.on('nav:reload', () => {
  if (activeTab) activeTab.view.webContents.reload();
});

ipcMain.on('home:search', (_event, value) => {
  if (!activeTab) return;
  const input = String(value || '').trim();
  if (!input || /^file:/i.test(input)) {
    console.error('Ignored invalid home search:', input);
    return;
  }
  const url = normalizeAddress(input);
  console.log('Home search navigation:', url);
  activeTab.url = url;
  activeTab.view.webContents.loadURL(url).catch(error => {
    console.error('Home search navigation failed:', error.message);
  });
});

ipcMain.on('home:open', (_event, value) => {
  if (!activeTab) return;
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    console.error('Ignored invalid home shortcut:', url);
    return;
  }
  console.log('Home shortcut navigation:', url);
  activeTab.url = url;
  activeTab.view.webContents.loadURL(url).catch(error => {
    console.error('Home shortcut navigation failed:', error.message);
  });
});

ipcMain.on('nav:home', () => {
  if (activeTab) {
    activeTab.view.webContents.loadURL(HOME_URL).catch(() => {});
  }
});

ipcMain.on('bookmark:add', () => {
  if (!activeTab) return;
  const url = activeTab.url || '';
  if (!/^https?:\/\//i.test(url)) return;
  if (bookmarks.some(b => b.url === url)) return;

  bookmarks.unshift({
    title: activeTab.title || url,
    url
  });
  saveBookmarks();
  sendState();
});

ipcMain.on('bookmark:remove', (_event, url) => {
  bookmarks = bookmarks.filter(b => b.url !== url);
  saveBookmarks();
  sendState();
});

ipcMain.on('bookmark:open', (_event, url) => createTab(url));

ipcMain.on('download:open', async (_event, filePath) => {
  if (!filePath) return;
  const record = downloads.find(d => d.path === filePath && d.state === 'Completed');
  if (!record) return;
  const result = await shell.openPath(filePath);
  if (result) console.error('Could not open file:', result);
});

ipcMain.on('download:folder', () => {
  shell.openPath(app.getPath('downloads'));
});

app.whenReady().then(() => {
  loadBookmarks();

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowedPermissions = new Set([
        'fullscreen',
        'media'
      ]);

      let isSecureOrigin = false;
      try {
        isSecureOrigin =
          new URL(webContents.getURL()).protocol === 'https:';
      } catch {}

      callback(
        isSecureOrigin && allowedPermissions.has(permission)
      );
    }
  );

  startDownloadHandling();
  createWindow();
  createTab();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createTab();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
