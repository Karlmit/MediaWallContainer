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
const optimizedMediaRoot = process.env.OPTIMIZED_MEDIA_DIR ? path.resolve(process.env.OPTIMIZED_MEDIA_DIR) : null;
const optimizedManifestPath = optimizedMediaRoot ? path.join(optimizedMediaRoot, "manifest.json") : null;
const transcodeEnabled = process.env.TRANSCODE_ENABLED !== "false";
const precacheVideos = process.env.PRECACHE_VIDEOS !== "false";
const transcodeConcurrency = Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY || 1));
const transcodeAccel = (process.env.TRANSCODE_ACCEL || "software").toLowerCase();
const optimizeMode = (process.env.OPTIMIZE_VIDEOS || "off").toLowerCase();
const optimizeEnabled = Boolean(optimizedMediaRoot) && ["all", "needed"].includes(optimizeMode);
const optimizeMaxHeight = Math.max(240, Number(process.env.OPTIMIZE_MAX_HEIGHT || 1080));
const optimizeMinBitrate = Math.max(0, Number(process.env.OPTIMIZE_MIN_BITRATE_MBPS || 8)) * 1000000;
const optimizeCrf = Math.max(18, Math.min(32, Number(process.env.OPTIMIZE_CRF || 24)));
const optimizeAudioBitrate = process.env.OPTIMIZE_AUDIO_BITRATE || "128k";
const vaapiDevice = process.env.VAAPI_DEVICE || "/dev/dri/renderD128";
const password = process.env.MEDIA_PASSWORD || "change-me";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const cookieName = "media_wall_session";
const activeTranscodes = new Map();
const activeTranscodeDetails = new Map();
const probeCache = new Map();
const transcodeQueue = [];
const queuedTranscodes = new Set();
const optimizeQueue = [];
const queuedOptimizations = new Set();
const recentLogEvents = [];
let activeTranscodeCount = 0;
let activeOptimizeCount = 0;
let manifest = { version: 1, entries: {} };
let optimizedManifest = { version: 1, entries: {} };
let manifestWriteTimer = null;
let optimizedManifestWriteTimer = null;

function formatLogDetails(details) {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

function rememberLogEvent(level, message, details) {
  recentLogEvents.push({
    at: new Date().toISOString(),
    level,
    message,
    details
  });
  if (recentLogEvents.length > 200) recentLogEvents.splice(0, recentLogEvents.length - 200);
}

function logInfo(message, details = {}) {
  rememberLogEvent("info", message, details);
  const detailText = formatLogDetails(details);
  console.log(`[mediawall] ${message}${detailText ? ` ${detailText}` : ""}`);
}

function logError(message, details = {}) {
  rememberLogEvent("error", message, details);
  const detailText = formatLogDetails(details);
  console.error(`[mediawall] ${message}${detailText ? ` ${detailText}` : ""}`);
}

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

function optimizedUrl(relativePath) {
  return `/optimized/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function safeMediaPath(relativePath) {
  const resolved = path.resolve(mediaRoot, relativePath);
  if (resolved !== mediaRoot && !resolved.startsWith(`${mediaRoot}${path.sep}`)) return null;
  return resolved;
}

function safeOptimizedPath(cacheFile) {
  if (!optimizedMediaRoot || !cacheFile) return null;
  const resolved = path.resolve(optimizedMediaRoot, cacheFile);
  if (resolved !== optimizedMediaRoot && !resolved.startsWith(`${optimizedMediaRoot}${path.sep}`)) return null;
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

  if (!optimizedManifestPath) return;

  try {
    optimizedManifest = JSON.parse(await fs.readFile(optimizedManifestPath, "utf8"));
    if (!optimizedManifest || typeof optimizedManifest !== "object" || !optimizedManifest.entries) {
      optimizedManifest = { version: 1, entries: {} };
    }
  } catch {
    optimizedManifest = { version: 1, entries: {} };
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
      logError("manifest_write_failed", { error: error.message });
    });
  }, 350);
}

async function writeOptimizedManifestNow() {
  if (!optimizedManifestPath || !optimizedMediaRoot) return;
  clearTimeout(optimizedManifestWriteTimer);
  optimizedManifestWriteTimer = null;
  await fs.mkdir(optimizedMediaRoot, { recursive: true });
  await fs.writeFile(optimizedManifestPath, `${JSON.stringify(optimizedManifest, null, 2)}\n`);
}

function scheduleOptimizedManifestWrite() {
  if (!optimizedManifestPath) return;
  clearTimeout(optimizedManifestWriteTimer);
  optimizedManifestWriteTimer = setTimeout(() => {
    writeOptimizedManifestNow().catch((error) => {
      logError("optimized_manifest_write_failed", { error: error.message });
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

async function optimizedCacheInfo(relativePath, fullPath) {
  if (!optimizedMediaRoot) return null;

  const stats = await fs.stat(fullPath);
  const sourceKey = normalizedSourceKey(relativePath);
  const signature = sourceSignature(relativePath, stats);
  let entry = optimizedManifest.entries[sourceKey];

  if (!entry || entry.sourceSignature !== signature || entry.maxHeight !== optimizeMaxHeight || entry.crf !== optimizeCrf) {
    if (entry?.cacheFile) {
      const existingPath = safeOptimizedPath(entry.cacheFile);
      if (existingPath) await fs.rm(existingPath, { force: true });
    }
    entry = {
      sourcePath: relativePath,
      sourceSignature: signature,
      cacheFile: stableCacheName(relativePath, stats),
      status: "pending",
      maxHeight: optimizeMaxHeight,
      crf: optimizeCrf,
      updatedAt: new Date().toISOString()
    };
    optimizedManifest.entries[sourceKey] = entry;
    scheduleOptimizedManifestWrite();
  }

  return {
    sourceKey,
    entry,
    cachePath: path.join(optimizedMediaRoot, entry.cacheFile)
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

function videoFilterForMaxHeight() {
  return `scale=-2:min(${optimizeMaxHeight}\\,ih)`;
}

function softwareTranscodeArgs(inputPath, outputPath, options = {}) {
  const args = [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?"
  ];
  if (options.downscale) args.push("-vf", videoFilterForMaxHeight());
  args.push(
    "-c:v", "libx264",
    "-preset", options.preset || "veryfast",
    "-crf", String(options.crf || 23),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", options.audioBitrate || "160k",
    "-movflags", "+faststart",
    outputPath
  );
  return args;
}

function vaapiTranscodeArgs(inputPath, outputPath, options = {}) {
  const filter = options.downscale ? `${videoFilterForMaxHeight()},format=nv12,hwupload` : "format=nv12,hwupload";
  return [
    "-y",
    "-vaapi_device", vaapiDevice,
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", filter,
    "-c:v", "h264_vaapi",
    "-qp", String(options.qp || 23),
    "-c:a", "aac",
    "-b:a", options.audioBitrate || "160k",
    "-movflags", "+faststart",
    outputPath
  ];
}

function qsvTranscodeArgs(inputPath, outputPath, options = {}) {
  return [
    "-y",
    "-init_hw_device", `qsv=hw:${vaapiDevice}`,
    "-filter_hw_device", "hw",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", options.downscale ? `${videoFilterForMaxHeight()},format=nv12,hwupload=extra_hw_frames=64` : "format=nv12,hwupload=extra_hw_frames=64",
    "-c:v", "h264_qsv",
    "-global_quality", String(options.globalQuality || 23),
    "-c:a", "aac",
    "-b:a", options.audioBitrate || "160k",
    "-movflags", "+faststart",
    outputPath
  ];
}

async function runFfmpeg(args) {
  await runFfmpegWithProgress(args);
}

function parseFfmpegTimestamp(value) {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function runFfmpegWithProgress(args, onProgress) {
  return new Promise((resolve, reject) => {
    const progressArgs = [args[0], "-progress", "pipe:1", "-nostats", ...args.slice(1)];
    const child = spawn("ffmpeg", progressArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    function handleProgressLine(line) {
      const [key, rawValue] = line.trim().split("=");
      if (!key || rawValue === undefined) return;

      if (key === "out_time_ms") {
        onProgress?.({ currentSeconds: Number(rawValue) / 1000000 });
      } else if (key === "out_time") {
        const currentSeconds = parseFfmpegTimestamp(rawValue);
        if (currentSeconds !== null) onProgress?.({ currentSeconds });
      } else if (key === "speed") {
        onProgress?.({ speed: rawValue });
      } else if (key === "progress") {
        onProgress?.({ progress: rawValue });
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) handleProgressLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      return reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

async function transcodeWithFallback(fullPath, tempPath, onProgress, options = {}) {
  const accelModes = [];
  if (transcodeAccel === "vaapi" || transcodeAccel === "auto") accelModes.push("vaapi");
  if (transcodeAccel === "qsv") accelModes.push("qsv");

  for (const mode of accelModes) {
    try {
      const args = mode === "qsv" ? qsvTranscodeArgs(fullPath, tempPath, options) : vaapiTranscodeArgs(fullPath, tempPath, options);
      await runFfmpegWithProgress(args, onProgress);
      return mode;
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      logError("transcode_accel_failed_falling_back", {
        mode,
        device: vaapiDevice,
        error: error.message
      });
    }
  }

  await runFfmpegWithProgress(softwareTranscodeArgs(fullPath, tempPath, options), onProgress);
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
    const width = Number(video?.width || 0) || null;
    const height = Number(video?.height || 0) || null;
    const durationSeconds = Number(video?.duration || data.format?.duration || 0) || null;
    const bitrate = Number(data.format?.bit_rate || video?.bit_rate || 0) || (durationSeconds ? Math.round(stats.size * 8 / durationSeconds) : null);
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
    const probe = { browserPlayable, videoCodec, audioCodec, pixelFormat, container, durationSeconds, width, height, bitrate, size: stats.size };
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
    const startedAt = Date.now();
    const probe = await probeVideo(relativePath, fullPath);
    await fs.mkdir(transcodeCacheRoot, { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp.mp4`;
    entry.status = "transcoding";
    entry.error = null;
    entry.updatedAt = new Date().toISOString();
    scheduleManifestWrite();
    const activeDetails = {
      kind: "compatibility",
      source: relativePath,
      cacheFile: entry.cacheFile,
      requestedMode: transcodeAccel,
      status: "transcoding",
      startedAt: new Date(startedAt).toISOString(),
      durationSeconds: probe.durationSeconds,
      currentSeconds: 0,
      speed: null,
      percent: null
    };
    activeTranscodeDetails.set(cachePath, activeDetails);
    logInfo("transcode_start", {
      source: relativePath,
      requestedMode: transcodeAccel,
      cacheFile: entry.cacheFile,
      queueActive: activeTranscodeCount,
      queueWaiting: transcodeQueue.length
    });

    let transcodeMode;
    try {
      transcodeMode = await transcodeWithFallback(fullPath, tempPath, (progress) => {
        if (progress.currentSeconds !== undefined) {
          activeDetails.currentSeconds = Math.max(activeDetails.currentSeconds || 0, progress.currentSeconds);
          if (activeDetails.durationSeconds) {
            activeDetails.percent = Math.min(99, Math.round((activeDetails.currentSeconds / activeDetails.durationSeconds) * 100));
          }
        }
        if (progress.speed !== undefined) activeDetails.speed = progress.speed;
        activeDetails.updatedAt = new Date().toISOString();
      });
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }

    await fs.rename(tempPath, cachePath);
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    entry.status = "ready";
    entry.cacheFile = path.basename(cachePath);
    entry.transcodeMode = transcodeMode;
    entry.updatedAt = new Date().toISOString();
    scheduleManifestWrite();
    logInfo("transcode_success", {
      source: relativePath,
      mode: transcodeMode,
      cacheFile: entry.cacheFile,
      durationSeconds
    });
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
    logError("transcode_failed", {
      source: relativePath,
      requestedMode: transcodeAccel,
      error: error.message
    });
    throw error;
  } finally {
    activeTranscodes.delete(cachePath);
    activeTranscodeDetails.delete(cachePath);
  }
}

function shouldOptimizeVideo(probe) {
  if (!optimizeEnabled) return false;
  if (optimizeMode === "all") return true;
  if (!probe.browserPlayable) return true;
  if (probe.height && probe.height > optimizeMaxHeight) return true;
  if (probe.bitrate && optimizeMinBitrate && probe.bitrate > optimizeMinBitrate) return true;
  return false;
}

async function optimizeToMp4(relativePath, fullPath, probe) {
  if (!optimizeEnabled) throw new Error("Video optimization is disabled");

  const info = await optimizedCacheInfo(relativePath, fullPath);
  if (!info) throw new Error("Optimized media directory is not configured");
  const { sourceKey, entry, cachePath } = info;
  if (entry.status === "ready" && await pathExists(cachePath)) return cachePath;

  const existing = activeTranscodes.get(cachePath);
  if (existing) return existing;

  const optimization = (async () => {
    const startedAt = Date.now();
    const currentProbe = probe || await probeVideo(relativePath, fullPath);
    await fs.mkdir(optimizedMediaRoot, { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp.mp4`;
    entry.status = "transcoding";
    entry.error = null;
    entry.updatedAt = new Date().toISOString();
    scheduleOptimizedManifestWrite();

    const activeDetails = {
      kind: "optimized",
      source: relativePath,
      cacheFile: entry.cacheFile,
      requestedMode: transcodeAccel,
      status: "transcoding",
      startedAt: new Date(startedAt).toISOString(),
      durationSeconds: currentProbe.durationSeconds,
      currentSeconds: 0,
      speed: null,
      percent: null
    };
    activeTranscodeDetails.set(cachePath, activeDetails);
    logInfo("optimize_start", {
      source: relativePath,
      requestedMode: transcodeAccel,
      cacheFile: entry.cacheFile,
      sourceHeight: currentProbe.height,
      sourceBitrate: currentProbe.bitrate,
      maxHeight: optimizeMaxHeight,
      queueActive: activeOptimizeCount,
      queueWaiting: optimizeQueue.length
    });

    const options = {
      downscale: Boolean(currentProbe.height && currentProbe.height > optimizeMaxHeight),
      crf: optimizeCrf,
      qp: optimizeCrf,
      globalQuality: optimizeCrf,
      audioBitrate: optimizeAudioBitrate
    };
    let transcodeMode;
    try {
      transcodeMode = await transcodeWithFallback(fullPath, tempPath, (progress) => {
        if (progress.currentSeconds !== undefined) {
          activeDetails.currentSeconds = Math.max(activeDetails.currentSeconds || 0, progress.currentSeconds);
          if (activeDetails.durationSeconds) {
            activeDetails.percent = Math.min(99, Math.round((activeDetails.currentSeconds / activeDetails.durationSeconds) * 100));
          }
        }
        if (progress.speed !== undefined) activeDetails.speed = progress.speed;
        activeDetails.updatedAt = new Date().toISOString();
      }, options);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }

    await fs.rename(tempPath, cachePath);
    const optimizedStats = await fs.stat(cachePath);
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    entry.status = "ready";
    entry.cacheFile = path.basename(cachePath);
    entry.transcodeMode = transcodeMode;
    entry.originalSize = currentProbe.size;
    entry.optimizedSize = optimizedStats.size;
    entry.updatedAt = new Date().toISOString();
    scheduleOptimizedManifestWrite();
    logInfo("optimize_success", {
      source: relativePath,
      mode: transcodeMode,
      cacheFile: entry.cacheFile,
      originalSize: currentProbe.size,
      optimizedSize: optimizedStats.size,
      durationSeconds
    });
    return cachePath;
  })();

  activeTranscodes.set(cachePath, optimization);
  try {
    return await optimization;
  } catch (error) {
    const failedEntry = optimizedManifest.entries[sourceKey];
    if (failedEntry) {
      failedEntry.status = "failed";
      failedEntry.error = error.message;
      failedEntry.updatedAt = new Date().toISOString();
      scheduleOptimizedManifestWrite();
    }
    logError("optimize_failed", {
      source: relativePath,
      requestedMode: transcodeAccel,
      error: error.message
    });
    throw error;
  } finally {
    activeTranscodes.delete(cachePath);
    activeTranscodeDetails.delete(cachePath);
  }
}

function processTranscodeQueue() {
  while (activeTranscodeCount + activeOptimizeCount < transcodeConcurrency && transcodeQueue.length) {
    const job = transcodeQueue.shift();
    queuedTranscodes.delete(job.relativePath);
    activeTranscodeCount += 1;
    transcodeToMp4(job.relativePath, job.fullPath)
      .catch((error) => logError("background_transcode_failed", { source: job.relativePath, error: error.message }))
      .finally(() => {
        activeTranscodeCount -= 1;
        processTranscodeQueue();
        processOptimizeQueue();
      });
  }
}

function processOptimizeQueue() {
  while (activeTranscodeCount + activeOptimizeCount < transcodeConcurrency && optimizeQueue.length) {
    const job = optimizeQueue.shift();
    queuedOptimizations.delete(job.relativePath);
    activeOptimizeCount += 1;
    optimizeToMp4(job.relativePath, job.fullPath, job.probe)
      .catch((error) => logError("background_optimize_failed", { source: job.relativePath, error: error.message }))
      .finally(() => {
        activeOptimizeCount -= 1;
        processTranscodeQueue();
        processOptimizeQueue();
      });
  }
}

function queueTranscode(relativePath, fullPath) {
  if (!transcodeEnabled || queuedTranscodes.has(relativePath)) return;
  queuedTranscodes.add(relativePath);
  transcodeQueue.push({ relativePath, fullPath });
  logInfo("transcode_queued", {
    source: relativePath,
    queueWaiting: transcodeQueue.length,
    queueActive: activeTranscodeCount
  });
  processTranscodeQueue();
}

function queueOptimize(relativePath, fullPath, probe) {
  if (!optimizeEnabled || queuedOptimizations.has(relativePath)) return;
  queuedOptimizations.add(relativePath);
  optimizeQueue.push({ relativePath, fullPath, probe });
  logInfo("optimize_queued", {
    source: relativePath,
    queueWaiting: optimizeQueue.length,
    queueActive: activeOptimizeCount,
    mode: optimizeMode,
    maxHeight: optimizeMaxHeight
  });
  processOptimizeQueue();
}

function diagnosticsSnapshot() {
  const entries = Object.values(manifest.entries);
  const ready = entries.filter((entry) => entry.status === "ready");
  const failed = entries.filter((entry) => entry.status === "failed");
  const pending = entries.filter((entry) => entry.status === "pending");
  const optimizedEntries = Object.values(optimizedManifest.entries);
  const optimizedReady = optimizedEntries.filter((entry) => entry.status === "ready");
  const optimizedFailed = optimizedEntries.filter((entry) => entry.status === "failed");
  const optimizedPending = optimizedEntries.filter((entry) => entry.status === "pending");

  return {
    app: {
      name: "MediaWall",
      version
    },
    transcode: {
      enabled: transcodeEnabled,
      precache: precacheVideos,
      concurrency: transcodeConcurrency,
      accel: transcodeAccel,
      vaapiDevice,
      libvaDriver: process.env.LIBVA_DRIVER_NAME || "",
      activeCount: activeTranscodeDetails.size,
      workerSlotsActive: activeTranscodeCount,
      queueWaiting: transcodeQueue.length + optimizeQueue.length,
      cachedCount: ready.length,
      failedCount: failed.length,
      pendingCount: pending.length,
      queued: transcodeQueue.map((job, index) => ({
        kind: "compatibility",
        source: job.relativePath,
        position: index + 1
      })).concat(optimizeQueue.map((job, index) => ({
        kind: "optimized",
        source: job.relativePath,
        position: transcodeQueue.length + index + 1
      }))),
      active: [...activeTranscodeDetails.values()].map((job) => ({
        ...job,
        elapsedSeconds: Math.round((Date.now() - Date.parse(job.startedAt)) / 1000)
      })),
      recent: entries
        .filter((entry) => entry.status === "ready" || entry.status === "failed")
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, 20)
        .map((entry) => ({
          source: entry.sourcePath,
          status: entry.status,
          mode: entry.transcodeMode,
          error: entry.error,
          updatedAt: entry.updatedAt,
          cacheFile: entry.cacheFile
        })).concat(optimizedEntries
        .filter((entry) => entry.status === "ready" || entry.status === "failed")
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, 20)
        .map((entry) => ({
          kind: "optimized",
          source: entry.sourcePath,
          status: entry.status,
          mode: entry.transcodeMode,
          error: entry.error,
          updatedAt: entry.updatedAt,
          cacheFile: entry.cacheFile,
          originalSize: entry.originalSize,
          optimizedSize: entry.optimizedSize
        })))
    },
    optimize: {
      enabled: optimizeEnabled,
      mode: optimizeMode,
      directory: optimizedMediaRoot,
      maxHeight: optimizeMaxHeight,
      minBitrate: optimizeMinBitrate,
      cachedCount: optimizedReady.length,
      failedCount: optimizedFailed.length,
      pendingCount: optimizedPending.length,
      queueWaiting: optimizeQueue.length,
      activeCount: activeOptimizeCount
    },
    logs: recentLogEvents.slice(-80)
  };
}

function createServerItem({ relativePath, name, type, isVideo }) {
  return {
    id: relativePath,
    name,
    type,
    path: relativePath,
    url: mediaUrl(relativePath),
    optimizedUrl: null,
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
    item.needsOptimize = shouldOptimizeVideo(probe);
    item.sourceHeight = probe.height;
    item.sourceBitrate = probe.bitrate;

    if (optimizeEnabled) {
      const optimizeInfo = await optimizedCacheInfo(item.path, fullPath);
      if (optimizeInfo?.entry.status === "ready" && await pathExists(optimizeInfo.cachePath)) {
        item.optimizedUrl = optimizedUrl(item.path);
        item.usingOptimized = true;
        item.needsTranscode = false;
      } else if (item.needsOptimize && precacheVideos) {
        logInfo("video_needs_optimize", {
          source: item.path,
          height: probe.height,
          bitrate: probe.bitrate,
          browserPlayable: probe.browserPlayable,
          mode: optimizeMode,
          maxHeight: optimizeMaxHeight
        });
        queueOptimize(item.path, fullPath, probe);
      }
    }

    if (item.needsTranscode && precacheVideos && !item.needsOptimize) {
      logInfo("video_needs_transcode", {
        source: item.path,
        videoCodec: item.videoCodec,
        audioCodec: item.audioCodec,
        accel: transcodeAccel
      });
      queueTranscode(item.path, fullPath);
    }
  }));
  cleanupTranscodeCache(folderData.media).catch((error) => {
    logError("cache_cleanup_failed", { error: error.message });
  });
  cleanupOptimizedCache(folderData.media).catch((error) => {
    logError("optimized_cache_cleanup_failed", { error: error.message });
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
      logInfo("cache_removed_missing_source", {
        source: entry.sourcePath,
        cacheFile: entry.cacheFile
      });
    }
    delete manifest.entries[sourceKey];
    changed = true;
  }

  if (changed) scheduleManifestWrite();
}

async function cleanupOptimizedCache(media) {
  if (!optimizedMediaRoot) return;
  const validSourceKeys = new Set(media.filter((item) => item.type === "video").map((item) => normalizedSourceKey(item.path)));
  let changed = false;

  for (const [sourceKey, entry] of Object.entries(optimizedManifest.entries)) {
    if (validSourceKeys.has(sourceKey)) {
      continue;
    }

    if (entry.cacheFile) {
      const cachePath = safeOptimizedPath(entry.cacheFile);
      if (cachePath) await fs.rm(cachePath, { force: true });
      logInfo("optimized_cache_removed_missing_source", {
        source: entry.sourcePath,
        cacheFile: entry.cacheFile
      });
    }
    delete optimizedManifest.entries[sourceKey];
    changed = true;
  }

  if (changed) scheduleOptimizedManifestWrite();
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

app.get("/api/diagnostics", async (_req, res) => {
  res.json(diagnosticsSnapshot());
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
    logError("request_transcode_failed", { source: relativePath, error: error.message });
    return res.sendStatus(500);
  }
});

app.get("/optimized/*path", async (req, res) => {
  const relativePath = req.params.path.join("/");
  if (!isVideoPath(relativePath) || !optimizeEnabled) return res.sendStatus(404);

  const fullPath = safeMediaPath(relativePath);
  if (!fullPath) return res.sendStatus(404);

  try {
    const cachePath = await optimizeToMp4(relativePath, fullPath);
    res.type("mp4");
    return res.sendFile(cachePath);
  } catch (error) {
    logError("request_optimize_failed", { source: relativePath, error: error.message });
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
  const vaapiDeviceVisible = await pathExists(vaapiDevice);
  app.listen(port, () => {
    logInfo("server_started", {
      version,
      port,
      mediaRoot,
      transcodeCacheRoot,
      optimizedMediaRoot,
      transcodeEnabled,
      precacheVideos,
      transcodeConcurrency,
      transcodeAccel,
      optimizeEnabled,
      optimizeMode,
      optimizeMaxHeight,
      optimizeMinBitrate,
      vaapiDevice,
      vaapiDeviceVisible,
      libvaDriver: process.env.LIBVA_DRIVER_NAME || ""
    });
  });
}

start().catch((error) => {
  logError("server_start_failed", { error: error.message });
  process.exit(1);
});
