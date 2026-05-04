const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const { version } = require("../../package.json");
const { VIDEO_EXTENSIONS, loadFolderData } = require("../shared/media");

const app = express();
const port = Number(process.env.PORT || 3000);
const mediaRoot = path.resolve(process.env.MEDIA_DIR || "/media");
const transcodeCacheRoot = path.resolve(process.env.TRANSCODE_CACHE_DIR || "/cache");
const transcodeManifestPath = path.join(transcodeCacheRoot, "manifest.json");
const transcodeEnabled = process.env.TRANSCODE_ENABLED !== "false";
const precacheVideos = process.env.PRECACHE_VIDEOS !== "false";
const transcodeConcurrency = Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY || 1));
const transcodeAccel = (process.env.TRANSCODE_ACCEL || "software").toLowerCase();
const vaapiDevice = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";
const password = process.env.MEDIA_PASSWORD || "change-me";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const cookieName = "media_wall_session";
const activeTranscodes = new Map();
const probeCache = new Map();
const transcodeQueue = [];
const queuedTranscodes = new Set();
let activeTranscodeCount = 0;
let manifest = { version: 1, entries: {} };
let manifestWriteTimer = null;

app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("=") || "")];
  }).filter(([key]) => key));
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function createSessionCookie() {
  const value = "authenticated";
  return `${value}.${sign(value)}`;
}

function isAuthenticated(req) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  if (!token) return false;

  const [value, providedSignature] = token.split(".");
  if (!value || !providedSignature) return false;

  const expectedSignature = sign(value);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  return res.redirect("/login");
}

function sendLogin(res, error = false) {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Media Wall Login</title>
    <link rel="stylesheet" href="/login.css">
  </head>
  <body>
    <main class="login">
      <form method="post" action="/login">
        <h1>Media Wall</h1>
        ${error ? '<p class="error">Wrong password</p>' : ""}
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" autofocus>
        <button type="submit">Unlock</button>
      </form>
    </main>
  </body>
</html>`);
}

function mediaUrl(relativePath) {
  return `/media/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function transcodeUrl(relativePath) {
  return `/transcode/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function safeMediaPath(relativePath) {
  const resolved = path.resolve(mediaRoot, relativePath);
  if (resolved !== mediaRoot && !resolved.startsWith(`${mediaRoot}${path.sep}`)) return null;
  return resolved;
}

function isVideoPath(relativePath) {
  return VIDEO_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizedSourceKey(relativePath) {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

function sourceSignature(relativePath, stats) {
  return `${relativePath}:${stats.size}:${stats.mtimeMs}`;
}

function stableCacheName(relativePath, stats) {
  const sourceHash = crypto.createHash("sha256").update(sourceSignature(relativePath, stats)).digest("hex");
  const extensionlessName = relativePath
    .replace(/\.[^/.]+$/, "")
    .split("/")
    .map((part) => part.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "media")
    .join("__");
  return `${extensionlessName}.${sourceHash.slice(0, 16)}.mp4`;
}

async function loadManifest() {
  try {
    manifest = JSON.parse(await fs.readFile(transcodeManifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || !manifest.entries) {
      manifest = { version: 1, entries: {} };
    }
  } catch {
    manifest = { version: 1, entries: {} };
  }
}

async function writeManifestNow() {
  clearTimeout(manifestWriteTimer);
  manifestWriteTimer = null;
  await fs.mkdir(transcodeCacheRoot, { recursive: true });
  await fs.writeFile(transcodeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function scheduleManifestWrite() {
  clearTimeout(manifestWriteTimer);
  manifestWriteTimer = setTimeout(() => {
    writeManifestNow().catch((error) => {
      console.error("Failed to write transcode manifest:", error.message);
    });
  }, 350);
}

async function transcodeCacheInfo(relativePath, fullPath) {
  const stats = await fs.stat(fullPath);
  const sourceKey = normalizedSourceKey(relativePath);
  const signature = sourceSignature(relativePath, stats);
  let entry = manifest.entries[sourceKey];

  if (!entry || entry.sourceSignature !== signature) {
    if (entry?.cacheFile) {
      await fs.rm(path.join(transcodeCacheRoot, entry.cacheFile), { force: true });
    }
    entry = {
      sourcePath: relativePath,
      sourceSignature: signature,
      cacheFile: stableCacheName(relativePath, stats),
      status: "pending",
      updatedAt: new Date().toISOString()
    };
    manifest.entries[sourceKey] = entry;
    scheduleManifestWrite();
  }

  return {
    sourceKey,
    entry,
    cachePath: path.join(transcodeCacheRoot, entry.cacheFile)
  };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1000000) stdout = stdout.slice(-1000000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      return reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

function softwareTranscodeArgs(inputPath, outputPath) {
  return [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    outputPath
  ];
}

function vaapiTranscodeArgs(inputPath, outputPath) {
  return [
    "-y",
    "-vaapi_device", vaapiDevice,
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", "format=nv12,hwupload",
    "-c:v", "h264_vaapi",
    "-qp", "23",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    outputPath
  ];
}

function qsvTranscodeArgs(inputPath, outputPath) {
  return [
    "-y",
    "-init_hw_device", `qsv=hw:${vaapiDevice}`,
    "-filter_hw_device", "hw",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", "format=nv12,hwupload=extra_hw_frames=64",
    "-c:v", "h264_qsv",
    "-global_quality", "23",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    outputPath
  ];
}

async function runFfmpeg(args) {
  await runProcess("ffmpeg", args);
}

async function transcodeWithFallback(fullPath, tempPath) {
  const accelModes = [];
  if (transcodeAccel === "vaapi" || transcodeAccel === "auto") accelModes.push("vaapi");
  if (transcodeAccel === "qsv") accelModes.push("qsv");

  for (const mode of accelModes) {
    try {
      const args = mode === "qsv" ? qsvTranscodeArgs(fullPath, tempPath) : vaapiTranscodeArgs(fullPath, tempPath);
      await runFfmpeg(args);
      return mode;
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      console.error(`${mode.toUpperCase()} transcode failed, falling back to software:`, error.message);
    }
  }

  await runFfmpeg(softwareTranscodeArgs(fullPath, tempPath));
  return "software";
}

async function probeVideo(relativePath, fullPath) {
  const stats = await fs.stat(fullPath);
  const signature = sourceSignature(relativePath, stats);
  const cached = probeCache.get(relativePath);
  if (cached?.signature === signature) return cached.probe;

  try {
    const { stdout } = await runProcess("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      fullPath
    ]);
    const data = JSON.parse(stdout);
    const video = (data.streams || []).find((stream) => stream.codec_type === "video");
    const audio = (data.streams || []).find((stream) => stream.codec_type === "audio");
    const container = (data.format?.format_name || "").split(",");
    const videoCodec = (video?.codec_name || "").toLowerCase();
    const audioCodec = (audio?.codec_name || "").toLowerCase();
    const pixelFormat = (video?.pix_fmt || "").toLowerCase();
    const isBrowserMp4 = container.includes("mov") || container.includes("mp4") || container.includes("m4a") || container.includes("3gp") || container.includes("3g2") || container.includes("mj2");
    const isBrowserWebm = container.includes("webm");
    const supportedMp4Video = ["h264", "av1"].includes(videoCodec);
    const supportedWebmVideo = ["vp8", "vp9", "av1"].includes(videoCodec);
    const supportedVideo = (isBrowserMp4 && supportedMp4Video) || (isBrowserWebm && supportedWebmVideo);
    const supportedMp4Audio = !audioCodec || ["aac", "mp3"].includes(audioCodec);
    const supportedWebmAudio = !audioCodec || ["opus", "vorbis"].includes(audioCodec);
    const supportedAudio = (isBrowserMp4 && supportedMp4Audio) || (isBrowserWebm && supportedWebmAudio);
    const supportedPixelFormat = !pixelFormat || pixelFormat === "yuv420p";
    const browserPlayable = (isBrowserMp4 || isBrowserWebm) && supportedVideo && supportedAudio && supportedPixelFormat;
    const probe = { browserPlayable, videoCodec, audioCodec, pixelFormat, container };
    probeCache.set(relativePath, { signature, probe });
    return probe;
  } catch (error) {
    const probe = { browserPlayable: false, error: error.message };
    probeCache.set(relativePath, { signature, probe });
    return probe;
  }
}

async function transcodeToMp4(relativePath, fullPath) {
  if (!transcodeEnabled) throw new Error("Transcoding is disabled");

  const { sourceKey, entry, cachePath } = await transcodeCacheInfo(relativePath, fullPath);
  if (entry.status === "ready" && await pathExists(cachePath)) return cachePath;

  const existing = activeTranscodes.get(cachePath);
  if (existing) return existing;

  const transcode = (async () => {
    await fs.mkdir(transcodeCacheRoot, { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp.mp4`;
    entry.status = "transcoding";
    entry.error = null;
    entry.updatedAt = new Date().toISOString();
    scheduleManifestWrite();

    const transcodeMode = await transcodeWithFallback(fullPath, tempPath);

    await fs.rename(tempPath, cachePath);
    entry.status = "ready";
    entry.cacheFile = path.basename(cachePath);
    entry.transcodeMode = transcodeMode;
    entry.updatedAt = new Date().toISOString();
    scheduleManifestWrite();
    return cachePath;
  })();

  activeTranscodes.set(cachePath, transcode);
  try {
    return await transcode;
  } catch (error) {
    const failedEntry = manifest.entries[sourceKey];
    if (failedEntry) {
      failedEntry.status = "failed";
      failedEntry.error = error.message;
      failedEntry.updatedAt = new Date().toISOString();
      scheduleManifestWrite();
    }
    throw error;
  } finally {
    activeTranscodes.delete(cachePath);
  }
}

function processTranscodeQueue() {
  while (activeTranscodeCount < transcodeConcurrency && transcodeQueue.length) {
    const job = transcodeQueue.shift();
    queuedTranscodes.delete(job.relativePath);
    activeTranscodeCount += 1;
    transcodeToMp4(job.relativePath, job.fullPath)
      .catch((error) => console.error(`Background transcode failed for ${job.relativePath}:`, error.message))
      .finally(() => {
        activeTranscodeCount -= 1;
        processTranscodeQueue();
      });
  }
}

function queueTranscode(relativePath, fullPath) {
  if (!transcodeEnabled || queuedTranscodes.has(relativePath)) return;
  queuedTranscodes.add(relativePath);
  transcodeQueue.push({ relativePath, fullPath });
  processTranscodeQueue();
}

function createServerItem({ relativePath, name, type, isVideo }) {
  return {
    id: relativePath,
    name,
    type,
    path: relativePath,
    url: mediaUrl(relativePath),
    fallbackUrl: isVideo && transcodeEnabled ? transcodeUrl(relativePath) : null
  };
}

function createServerSubfolder({ relativePath, name }) {
  return {
    name,
    path: relativePath
  };
}

function loadServerFolderData() {
  return loadFolderData(mediaRoot, createServerItem, createServerSubfolder);
}

async function enrichServerMedia(folderData) {
  await Promise.all(folderData.media.map(async (item) => {
    if (item.type !== "video") return;
    const fullPath = safeMediaPath(item.path);
    if (!fullPath) return;

    const probe = await probeVideo(item.path, fullPath);
    item.browserPlayable = probe.browserPlayable;
    item.videoCodec = probe.videoCodec;
    item.audioCodec = probe.audioCodec;
    item.needsTranscode = transcodeEnabled && !probe.browserPlayable;

    if (item.needsTranscode && precacheVideos) {
      queueTranscode(item.path, fullPath);
    }
  }));
  cleanupTranscodeCache(folderData.media).catch((error) => {
    console.error("Failed to clean transcode cache:", error.message);
  });
  return folderData;
}

async function cleanupTranscodeCache(media) {
  const validSourceKeys = new Set(media.filter((item) => item.type === "video").map((item) => normalizedSourceKey(item.path)));
  let changed = false;

  for (const [sourceKey, entry] of Object.entries(manifest.entries)) {
    if (validSourceKeys.has(sourceKey)) {
      continue;
    }

    if (entry.cacheFile) {
      await fs.rm(path.join(transcodeCacheRoot, entry.cacheFile), { force: true });
    }
    delete manifest.entries[sourceKey];
    changed = true;
  }

  if (changed) scheduleManifestWrite();
}

app.get("/login", (req, res) => {
  if (isAuthenticated(req)) return res.redirect("/");
  return sendLogin(res);
});

app.post("/login", (req, res) => {
  if (req.body.password !== password) return sendLogin(res, true);
  res.cookie(cookieName, createSessionCookie(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    maxAge: 1000 * 60 * 60 * 24 * 30
  });
  return res.redirect("/");
});

app.post("/logout", (req, res) => {
  res.clearCookie(cookieName);
  res.redirect("/login");
});

app.use("/login.css", express.static(path.join(__dirname, "..", "renderer", "login.css")));
app.use(requireAuth);
app.use(express.static(path.join(__dirname, "..", "renderer")));

app.get("/api/app-info", async (_req, res) => {
  res.json({ name: "MediaWall", version });
});

app.get("/api/media", async (_req, res) => {
  res.json(await enrichServerMedia(await loadServerFolderData()));
});

app.get("/transcode/*path", async (req, res) => {
  const relativePath = req.params.path.join("/");
  if (!isVideoPath(relativePath)) return res.sendStatus(404);

  const fullPath = safeMediaPath(relativePath);
  if (!fullPath) return res.sendStatus(404);

  try {
    const cachePath = await transcodeToMp4(relativePath, fullPath);
    res.type("mp4");
    return res.sendFile(cachePath);
  } catch (error) {
    console.error(`Failed to transcode ${relativePath}:`, error.message);
    return res.sendStatus(500);
  }
});

app.get("/media/*path", async (req, res) => {
  const relativePath = req.params.path.join("/");
  const fullPath = safeMediaPath(relativePath);
  if (!fullPath) return res.sendStatus(404);
  return res.sendFile(fullPath);
});

async function start() {
  await loadManifest();
  app.listen(port, () => {
    console.log(`Media Wall listening on port ${port}`);
    console.log(`Serving media from ${mediaRoot}`);
    console.log(`Transcode cache at ${transcodeCacheRoot}`);
    console.log(`Transcode acceleration: ${transcodeAccel}`);
  });
}

start().catch((error) => {
  console.error("Failed to start Media Wall:", error);
  process.exit(1);
});
