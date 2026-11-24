// ============================================================================
// SKYBOUND — desktop shell.
//
// The game is static files (HTML + ES modules + a vendored Three.js build), so
// they are served over a privileged `app://` protocol. That keeps ES module
// MIME/CORS checks happy without opening an HTTP port or shipping a server.
// ============================================================================
const { app, BrowserWindow, Menu, protocol, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');

// Only the types the packaged game actually contains.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function serveFile(requestPath) {
  const decoded = decodeURIComponent(requestPath || '/');
  const candidate = path.normalize(path.join(ROOT, decoded === '/' ? 'index.html' : decoded));
  if (!candidate.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    if (!fs.statSync(candidate).isFile()) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(fs.readFileSync(candidate)), {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(candidate).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // Sofa play: the game comes up on the whole screen. F11 still toggles out.
    fullscreen: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#06080f',
    title: 'SKYBOUND',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep animating at full rate when the window loses focus.
      backgroundThrottling: false,
    },
  });

  // The renderer cannot see the window's fullscreen state through the browser
  // API, so it asks here. One window, so these are registered exactly once.
  ipcMain.handle('shell:fullscreen', () => win.isFullScreen());
  ipcMain.handle('shell:set-fullscreen', (_event, on) => {
    win.setFullScreen(!!on);
    // Report what was asked for: the setter is asynchronous on some platforms,
    // and the transition events below carry the settled truth anyway.
    return !!on;
  });
  // F11 and the OS can change it too, so tell the game whenever it moves.
  // enter/leave-full-screen fire *before* isFullScreen() flips, so the event
  // name is the state — sampling the getter here reports the previous one.
  const announce = (on) => {
    if (!win.isDestroyed()) win.webContents.send('shell:fullscreen-changed', on);
  };
  win.on('enter-full-screen', () => announce(true));
  win.on('leave-full-screen', () => announce(false));

  // F11 toggles fullscreen, F12 opens dev tools.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.loadURL('app://bundle/index.html');
  return win;
}

// Build verification: `SKYBOUND.exe --smoke` starts level 1, writes a JSON
// report to %TEMP% and exits. Inert unless that flag is passed.
const SMOKE_PROBE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(800);
  const g = window.SKYBOUND;
  if (!g) return { ok: false, reason: 'no SKYBOUND global' };
  g.startLevel(0);
  await wait(1200);
  const canvas = document.getElementById('game');
  return {
    ok: g.game.mode === 'playing',
    webgl: !!(canvas.getContext('webgl2') || canvas.getContext('webgl')),
    level: g.game.level,
    platforms: g.game.world ? g.game.world.platformObjs.length : 0,
    crystals: document.getElementById('obj-crystals-text').textContent,
  };
})()`;

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    try {
      return serveFile(new URL(request.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });

  app.setAppUserModelId('com.skybound.game');
  Menu.setApplicationMenu(null);
  const win = createWindow();

  if (process.argv.includes('--smoke')) {
    win.webContents.once('did-finish-load', async () => {
      const report = await Promise.race([
        win.webContents.executeJavaScript(SMOKE_PROBE, true),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 30000)),
      ]).catch((err) => ({ ok: false, error: String(err) }));
      fs.writeFileSync(path.join(os.tmpdir(), 'skybound-smoke.json'), JSON.stringify(report, null, 2));
      app.exit(report.ok ? 0 : 1);
    });
  }
});

app.on('window-all-closed', () => app.quit());
