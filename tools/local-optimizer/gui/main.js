const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let optimizerProcess = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    title: "MediaWall Local Optimizer",
    backgroundColor: "#0b0d10",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

function optimizerScriptPath() {
  return path.join(__dirname, "..", "optimizer.js");
}

function appendArg(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

ipcMain.handle("choose-folder", async (_event, title) => {
  const result = await dialog.showOpenDialog({
    title,
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("optimizer-start", (event, settings) => {
  if (optimizerProcess) {
    return { ok: false, error: "Optimizer is already running." };
  }

  const args = [optimizerScriptPath()];
  appendArg(args, "--original", settings.original);
  appendArg(args, "--output", settings.output);
  appendArg(args, "--mode", settings.mode);
  appendArg(args, "--max-height", settings.maxHeight);
  appendArg(args, "--min-bitrate-mbps", settings.minBitrateMbps);
  appendArg(args, "--quality", settings.quality);
  appendArg(args, "--nvenc-preset", settings.nvencPreset);
  appendArg(args, "--audio-bitrate", settings.audioBitrate);
  appendArg(args, "--concurrency", settings.concurrency);
  appendArg(args, "--limit", settings.limit);
  appendArg(args, "--compose-media-path", settings.composeMediaPath);
  appendArg(args, "--compose-optimized-path", settings.composeOptimizedPath);
  appendArg(args, "--compose-cache-path", settings.composeCachePath);
  appendArg(args, "--compose-port", settings.composePort);
  args.push("--json", "true");

  optimizerProcess = spawn(process.execPath, args, {
    cwd: path.join(__dirname, "..", "..", ".."),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  optimizerProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        event.sender.send("optimizer-event", JSON.parse(line));
      } catch {
        event.sender.send("optimizer-log", line);
      }
    }
  });

  optimizerProcess.stderr.on("data", (chunk) => {
    event.sender.send("optimizer-log", chunk.toString());
  });

  optimizerProcess.on("error", (error) => {
    event.sender.send("optimizer-event", {
      type: "fatal",
      error: error.message,
      at: new Date().toISOString()
    });
  });

  optimizerProcess.on("close", (code) => {
    event.sender.send("optimizer-event", {
      type: "process-exit",
      code,
      at: new Date().toISOString()
    });
    optimizerProcess = null;
  });

  return { ok: true };
});

ipcMain.handle("optimizer-stop", () => {
  if (!optimizerProcess) return false;
  optimizerProcess.kill("SIGTERM");
  optimizerProcess = null;
  return true;
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (optimizerProcess) optimizerProcess.kill("SIGTERM");
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
