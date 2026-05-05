#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { spawn } = require("child_process");
const { VIDEO_EXTENSIONS } = require("../../src/shared/media");

const manifestVersion = 1;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join("/");
}

function normalizedSourceKey(relativePath) {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

function sourceSignature(relativePath, stats) {
  return `${relativePath}:${stats.size}:${stats.mtimeMs}`;
}

function stableCacheName(relativePath, stats) {
  const sourceHash = crypto
    .createHash("sha256")
    .update(sourceSignature(relativePath, stats))
    .digest("hex");

  const extensionlessName = relativePath
    .replace(/\.[^/.]+$/, "")
    .split("/")
    .map((part) =>
      part.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "media"
    )
    .join("__");

  return `${extensionlessName}.${sourceHash.slice(0, 16)}.mp4`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      options.onStderr?.(chunk.toString());
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}`));
      }
    });
  });
}

async function commandExists(command) {
  try {
    await run(process.platform === "win32" ? "where" : "which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function installFfmpegIfRequested(cli) {
  if (cli["install-missing"] !== "true") return;

  const hasFfmpeg = await commandExists("ffmpeg");
  const hasFfprobe = await commandExists("ffprobe");

  if (hasFfmpeg && hasFfprobe) return;

  console.log("FFmpeg or FFprobe is missing.");
  console.log("Attempting to install FFmpeg...\n");

  if (process.platform === "win32") {
    if (!(await commandExists("winget"))) {
      throw new Error(
        "winget is not available. Install FFmpeg manually from https://www.gyan.dev/ffmpeg/builds/ and add it to PATH."
      );
    }

    await run("winget", [
      "install",
      "--id",
      "Gyan.FFmpeg",
      "-e",
      "--accept-source-agreements",
      "--accept-package-agreements"
    ]);

    console.log("\nFFmpeg install attempted.");
    console.log("Close and reopen your terminal, then run the script again.");
    process.exit(0);
  }

  if (process.platform === "linux") {
    if (await commandExists("apt")) {
      await run("sudo", ["apt", "update"]);
      await run("sudo", ["apt", "install", "-y", "ffmpeg"]);
      return;
    }

    if (await commandExists("dnf")) {
      await run("sudo", ["dnf", "install", "-y", "ffmpeg"]);
      return;
    }

    if (await commandExists("pacman")) {
      await run("sudo", ["pacman", "-S", "--noconfirm", "ffmpeg"]);
      return;
    }
  }

  if (process.platform === "darwin") {
    if (!(await commandExists("brew"))) {
      throw new Error("Homebrew is missing. Install Homebrew first, then run: brew install ffmpeg");
    }

    await run("brew", ["install", "ffmpeg"]);
    return;
  }

  throw new Error("Automatic FFmpeg install is not supported on this platform.");
}

async function checkNvenc(cli) {
  await installFfmpegIfRequested(cli);

  console.log("Checking FFmpeg, FFprobe, NVIDIA driver, and NVENC...\n");

  try {
    const { stdout } = await run("ffmpeg", ["-version"]);
    console.log(stdout.split("\n")[0]);
  } catch {
    throw new Error(
      "FFmpeg is not installed or not in PATH. Run again with --install-missing true, or install FFmpeg manually."
    );
  }

  try {
    await run("ffprobe", ["-version"]);
    console.log("FFprobe found ✅");
  } catch {
    throw new Error(
      "FFprobe is not installed or not in PATH. It should come with FFmpeg."
    );
  }

  try {
    const { stdout } = await run("nvidia-smi", []);
    console.log("NVIDIA driver detected ✅");
    console.log(stdout.split("\n").slice(0, 3).join("\n"));
  } catch {
    throw new Error(
      "nvidia-smi was not found. Install or update your NVIDIA driver first. I will not auto-install GPU drivers."
    );
  }

  try {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-encoders"]);

    if (!stdout.includes("h264_nvenc")) {
      throw new Error(
        "Your FFmpeg build does not include h264_nvenc. Install a full FFmpeg build with NVIDIA NVENC support."
      );
    }

    console.log("h264_nvenc found in FFmpeg ✅");
  } catch (error) {
    throw error;
  }

  console.log("\nNVENC check passed.\n");
}

async function prompt(question, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function promptNumber(question, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  while (true) {
    const raw = await prompt(question, String(fallback));
    const value = Number(raw);

    if (Number.isFinite(value) && value >= min && value <= max) {
      return value;
    }

    console.log(`Enter a number between ${min} and ${max}.`);
  }
}

async function collectVideos(root) {
  const videos = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile() &&
        VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        videos.push({
          fullPath,
          relativePath: normalizeRelative(path.relative(root, fullPath))
        });
      }
    }
  }

  await walk(root);

  return videos.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function probeVideo(fullPath, stats) {
  try {
    const { stdout } = await run("ffprobe", [
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
    const height = Number(video?.height || 0) || null;
    const durationSeconds =
      Number(video?.duration || data.format?.duration || 0) || null;

    const bitrate =
      Number(data.format?.bit_rate || video?.bit_rate || 0) ||
      (durationSeconds ? Math.round((stats.size * 8) / durationSeconds) : null);

    const isBrowserMp4 = ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"].some((name) =>
      container.includes(name)
    );

    const isBrowserWebm = container.includes("webm");

    const supportedVideo =
      (isBrowserMp4 && ["h264", "av1"].includes(videoCodec)) ||
      (isBrowserWebm && ["vp8", "vp9", "av1"].includes(videoCodec));

    const supportedAudio =
      (isBrowserMp4 && (!audioCodec || ["aac", "mp3"].includes(audioCodec))) ||
      (isBrowserWebm && (!audioCodec || ["opus", "vorbis"].includes(audioCodec)));

    const supportedPixelFormat = !pixelFormat || pixelFormat === "yuv420p";

    return {
      browserPlayable:
        (isBrowserMp4 || isBrowserWebm) &&
        supportedVideo &&
        supportedAudio &&
        supportedPixelFormat,
      videoCodec,
      audioCodec,
      pixelFormat,
      height,
      bitrate,
      size: stats.size,
      durationSeconds
    };
  } catch (error) {
    return {
      browserPlayable: false,
      size: stats.size,
      error: error.message
    };
  }
}

function shouldOptimize(probe, settings) {
  if (settings.mode === "all") return true;
  if (!probe.browserPlayable) return true;
  if (probe.height && probe.height > settings.maxHeight) return true;

  if (
    probe.bitrate &&
    settings.minBitrateMbps > 0 &&
    probe.bitrate > settings.minBitrateMbps * 1000000
  ) {
    return true;
  }

  return false;
}

function ffmpegArgs(inputPath, outputPath, probe, settings) {
  const downscale = Boolean(probe.height && probe.height > settings.maxHeight);

  const args = [
    "-y",
    "-hide_banner",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?"
  ];

  if (downscale) {
    args.push("-vf", `scale=-2:min(${settings.maxHeight}\\,ih)`);
  }

  args.push(
    "-c:v",
    "h264_nvenc",
    "-preset",
    settings.nvencPreset,
    "-rc",
    "vbr",
    "-cq",
    String(settings.quality),
    "-b:v",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    settings.audioBitrate,
    "-movflags",
    "+faststart",
    outputPath
  );

  return args;
}

async function loadManifest(manifestPath) {
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

    if (manifest?.entries) {
      return manifest;
    }
  } catch {
    // First run.
  }

  return {
    version: manifestVersion,
    entries: {}
  };
}

async function saveManifest(manifestPath, manifest) {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function composeRecommendation(settings, paths) {
  return `# MediaWall compose generated by tools/local-optimizer/optimizer.js
# IMPORTANT:
# - Keep MEDIA_DIR pointed at your ORIGINAL media folder.
# - Mount this optimizer output folder as /optimized with OPTIMIZED_MEDIA_DIR=/optimized.
# - Do not point MEDIA_DIR at the optimized folder, or Docker will treat the optimized MP4s
#   as new originals and may optimize them again.
#
# Local original folder used for manifest signatures:
# ${paths.originalRoot}
#
# Local optimized output folder created by this script:
# ${paths.outputRoot}
#
# Copy/sync that optimized output folder to this Unraid path before starting Docker:
# ${paths.composeOptimizedPath}

services:
  media-wall:
    image: ghcr.io/karlmit/mediawall:latest
    container_name: media-wall
    ports:
      - ${yamlQuote(`${paths.composePort}:3000`)}
    environment:
      MEDIA_PASSWORD: "change-this-password"
      MEDIA_DIR: "/media"
      SESSION_SECRET: "change-this-to-a-long-random-string"
      TRANSCODE_CACHE_DIR: "/cache"
      PRECACHE_VIDEOS: "true"
      TRANSCODE_CONCURRENCY: "2"
      TRANSCODE_ACCEL: "vaapi"
      VAAPI_DEVICE: "/dev/dri/renderD128"
      LIBVA_DRIVER_NAME: "iHD"
      OPTIMIZED_MEDIA_DIR: "/optimized"
      OPTIMIZE_VIDEOS: ${yamlQuote(settings.mode)}
      OPTIMIZE_MAX_HEIGHT: ${yamlQuote(settings.maxHeight)}
      OPTIMIZE_CRF: ${yamlQuote(settings.quality)}
      OPTIMIZE_MIN_BITRATE_MBPS: ${yamlQuote(settings.minBitrateMbps)}
      OPTIMIZE_AUDIO_BITRATE: ${yamlQuote(settings.audioBitrate)}
    devices:
      - "/dev/dri:/dev/dri"
    volumes:
      - ${yamlQuote(`${paths.composeMediaPath}:/media:ro`)}
      - ${yamlQuote(`${paths.composeCachePath}:/cache`)}
      - ${yamlQuote(`${paths.composeOptimizedPath}:/optimized`)}
    restart: unless-stopped
`;
}

async function writeComposeRecommendation(settings, paths) {
  const text = composeRecommendation(settings, paths);
  const composePath = path.join(paths.outputRoot, "mediawall-compose.recommended.yml");
  await fs.writeFile(composePath, text);

  console.log("\nDocker compose recommendation for Unraid after this prewarm:");
  console.log("");
  console.log(text);
  console.log(`Saved recommendation to: ${composePath}`);
  console.log("");
  console.log("The two settings that must match this prewarm are:");
  console.log(`- OPTIMIZE_MAX_HEIGHT=${settings.maxHeight}`);
  console.log(`- OPTIMIZE_CRF=${settings.quality}`);
  console.log("");
  console.log("Use the same OPTIMIZE_VIDEOS mode if you want Docker to follow the same all/needed policy.");
  console.log("Docker can still use TRANSCODE_ACCEL=vaapi/software later; it does not need to match NVENC.");
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.help) {
    console.log("Usage: node tools/local-optimizer/optimizer.js --original <folder> --output <folder> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --mode needed|all");
    console.log("  --max-height 720");
    console.log("  --min-bitrate-mbps 8");
    console.log("  --quality 23");
    console.log("  --audio-bitrate 128k");
    console.log("  --concurrency 2");
    console.log("  --limit 500");
    console.log("  --compose-media-path /mnt/user/Media");
    console.log("  --compose-optimized-path /mnt/user/appdata/mediawall-optimized");
    console.log("  --compose-cache-path /mnt/user/appdata/mediawall-cache");
    console.log("  --compose-port 3060");
    console.log("  --install-missing true");
    console.log("");
    console.log("Encoder is forced to NVENC. No fallback is used.");
    return;
  }

  console.log("MediaWall Local Optimizer");
  console.log("NVENC required mode - no fallback\n");

  console.log(
    "Tip: point the original folder at the same SMB share Unraid uses so file modified times match MediaWall's manifest.\n"
  );

  const originalRoot = path.resolve(
    cli.original || await prompt("Original media folder")
  );

  const outputRoot = path.resolve(
    cli.output || await prompt("Optimized output folder")
  );

  const modeRaw = cli.mode || await prompt("Optimize mode: all or needed", "needed");
  const mode = modeRaw.toLowerCase() === "all" ? "all" : "needed";

  const maxHeight = cli["max-height"]
    ? Number(cli["max-height"])
    : await promptNumber("Max output height, usually 720 or 1080", 720, 240, 4320);

  const minBitrateMbps = cli["min-bitrate-mbps"]
    ? Number(cli["min-bitrate-mbps"])
    : await promptNumber("Only in needed mode: optimize above bitrate Mbps", 8, 0, 1000);

  const quality = cli.quality
    ? Number(cli.quality)
    : await promptNumber("NVENC CQ quality, lower is better", 23, 16, 34);

  const audioBitrate = cli["audio-bitrate"] || await prompt("Audio bitrate", "128k");

  const concurrency = cli.concurrency
    ? Number(cli.concurrency)
    : await promptNumber("Concurrent FFmpeg jobs", 2, 1, 8);

  const limit = cli.limit
    ? Number(cli.limit)
    : await promptNumber("Limit files for this run, 0 means all", 0, 0, Number.MAX_SAFE_INTEGER);

  const composePaths = {
    originalRoot,
    outputRoot,
    composeMediaPath: cli["compose-media-path"] || "/mnt/user/Media",
    composeOptimizedPath: cli["compose-optimized-path"] || "/mnt/user/appdata/mediawall-optimized",
    composeCachePath: cli["compose-cache-path"] || "/mnt/user/appdata/mediawall-cache",
    composePort: cli["compose-port"] || "3060"
  };

  const settings = {
    mode,
    maxHeight,
    minBitrateMbps,
    encoder: "nvenc",
    quality,
    audioBitrate,
    concurrency,
    nvencPreset: "p5"
  };

  await checkNvenc(cli);

  await fs.mkdir(outputRoot, { recursive: true });

  const manifestPath = path.join(outputRoot, "manifest.json");
  const manifest = await loadManifest(manifestPath);
  const videos = await collectVideos(originalRoot);
  const candidates = limit > 0 ? videos.slice(0, limit) : videos;

  let currentIndex = 0;
  let completed = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`\nFound ${videos.length} videos. Processing ${candidates.length}.\n`);

  async function worker() {
    while (currentIndex < candidates.length) {
      const video = candidates[currentIndex++];

      const stats = await fs.stat(video.fullPath);
      const sourceKey = normalizedSourceKey(video.relativePath);
      const signature = sourceSignature(video.relativePath, stats);
      const cacheFile = stableCacheName(video.relativePath, stats);
      const outputPath = path.join(outputRoot, cacheFile);
      const entry = manifest.entries[sourceKey];

      if (
        entry?.status === "ready" &&
        entry.sourceSignature === signature &&
        entry.maxHeight === maxHeight &&
        entry.crf === quality
      ) {
        try {
          await fs.access(path.join(outputRoot, entry.cacheFile));
          skipped += 1;
          console.log(`[skip] ${video.relativePath}`);
          continue;
        } catch {
          // Rebuild missing output.
        }
      }

      const probe = await probeVideo(video.fullPath, stats);

      if (!shouldOptimize(probe, settings)) {
        skipped += 1;
        console.log(`[skip] ${video.relativePath} already fits settings`);
        continue;
      }

      const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.mp4`;

      manifest.entries[sourceKey] = {
        sourcePath: video.relativePath,
        sourceSignature: signature,
        cacheFile,
        status: "transcoding",
        maxHeight,
        crf: quality,
        updatedAt: new Date().toISOString()
      };

      await saveManifest(manifestPath, manifest);

      console.log(`[start] ${video.relativePath}`);

      try {
        await run("ffmpeg", ffmpegArgs(video.fullPath, tempPath, probe, settings));

        await fs.rename(tempPath, outputPath);

        const optimizedStats = await fs.stat(outputPath);

        manifest.entries[sourceKey] = {
          ...manifest.entries[sourceKey],
          status: "ready",
          transcodeMode: "nvenc",
          originalSize: stats.size,
          optimizedSize: optimizedStats.size,
          updatedAt: new Date().toISOString()
        };

        await saveManifest(manifestPath, manifest);

        completed += 1;
        console.log(`[ready] ${video.relativePath}`);
      } catch (error) {
        await fs.rm(tempPath, { force: true });

        manifest.entries[sourceKey] = {
          ...manifest.entries[sourceKey],
          status: "failed",
          error: error.message.slice(0, 4000),
          updatedAt: new Date().toISOString()
        };

        await saveManifest(manifestPath, manifest);

        failed += 1;

        console.error(`[failed] ${video.relativePath}`);
        console.error("");
        console.error(error.message);
        console.error("");
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(`\nDone. Ready: ${completed}, skipped: ${skipped}, failed: ${failed}`);

  await writeComposeRecommendation(settings, composePaths);
}

const rl = readline.createInterface({ input, output });

main()
  .catch((error) => {
    console.error("\nFatal error:");
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
