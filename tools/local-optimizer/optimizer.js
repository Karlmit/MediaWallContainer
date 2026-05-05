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
  const sourceHash = crypto.createHash("sha256").update(sourceSignature(relativePath, stats)).digest("hex");
  const extensionlessName = relativePath
    .replace(/\.[^/.]+$/, "")
    .split("/")
    .map((part) => part.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "media")
    .join("__");
  return `${extensionlessName}.${sourceHash.slice(0, 16)}.mp4`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
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
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
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
    if (Number.isFinite(value) && value >= min && value <= max) return value;
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
      } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
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
    const durationSeconds = Number(video?.duration || data.format?.duration || 0) || null;
    const bitrate = Number(data.format?.bit_rate || video?.bit_rate || 0) || (durationSeconds ? Math.round(stats.size * 8 / durationSeconds) : null);
    const isBrowserMp4 = ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"].some((name) => container.includes(name));
    const isBrowserWebm = container.includes("webm");
    const supportedVideo = (isBrowserMp4 && ["h264", "av1"].includes(videoCodec)) || (isBrowserWebm && ["vp8", "vp9", "av1"].includes(videoCodec));
    const supportedAudio = (isBrowserMp4 && (!audioCodec || ["aac", "mp3"].includes(audioCodec))) || (isBrowserWebm && (!audioCodec || ["opus", "vorbis"].includes(audioCodec)));
    const supportedPixelFormat = !pixelFormat || pixelFormat === "yuv420p";
    return {
      browserPlayable: (isBrowserMp4 || isBrowserWebm) && supportedVideo && supportedAudio && supportedPixelFormat,
      videoCodec,
      audioCodec,
      pixelFormat,
      height,
      bitrate,
      size: stats.size,
      durationSeconds
    };
  } catch (error) {
    return { browserPlayable: false, size: stats.size, error: error.message };
  }
}

function shouldOptimize(probe, settings) {
  if (settings.mode === "all") return true;
  if (!probe.browserPlayable) return true;
  if (probe.height && probe.height > settings.maxHeight) return true;
  if (probe.bitrate && settings.minBitrateMbps > 0 && probe.bitrate > settings.minBitrateMbps * 1000000) return true;
  return false;
}

function ffmpegArgs(inputPath, outputPath, probe, settings) {
  const downscale = Boolean(probe.height && probe.height > settings.maxHeight);
  const args = ["-y", "-i", inputPath, "-map", "0:v:0", "-map", "0:a:0?"];
  if (downscale) args.push("-vf", `scale=-2:min(${settings.maxHeight}\\,ih)`);

  if (settings.encoder === "nvenc") {
    args.push(
      "-c:v", "h264_nvenc",
      "-preset", settings.nvencPreset,
      "-rc", "vbr",
      "-cq", String(settings.quality),
      "-b:v", "0",
      "-pix_fmt", "yuv420p"
    );
  } else if (settings.encoder === "copy" && !downscale && probe.browserPlayable) {
    args.push("-c:v", "copy");
  } else {
    args.push(
      "-c:v", "libx264",
      "-preset", settings.softwarePreset,
      "-crf", String(settings.quality),
      "-pix_fmt", "yuv420p"
    );
  }

  args.push(
    "-c:a", "aac",
    "-b:a", settings.audioBitrate,
    "-movflags", "+faststart",
    outputPath
  );
  return args;
}

async function loadManifest(manifestPath) {
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest?.entries) return manifest;
  } catch {
    // First run.
  }
  return { version: manifestVersion, entries: {} };
}

async function saveManifest(manifestPath, manifest) {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function printComposeRecommendation(settings, outputRoot) {
  console.log("\nDocker compose recommendation for Unraid after this prewarm:");
  console.log("");
  console.log("environment:");
  console.log('  OPTIMIZED_MEDIA_DIR: "/optimized"');
  console.log(`  OPTIMIZE_VIDEOS: "needed"`);
  console.log(`  OPTIMIZE_MAX_HEIGHT: "${settings.maxHeight}"`);
  console.log(`  OPTIMIZE_CRF: "${settings.quality}"`);
  console.log(`  OPTIMIZE_MIN_BITRATE_MBPS: "${settings.minBitrateMbps}"`);
  console.log('  OPTIMIZE_AUDIO_BITRATE: "' + settings.audioBitrate + '"');
  console.log("volumes:");
  console.log('  - "/mnt/user/appdata/mediawall-optimized:/optimized"');
  console.log("");
  console.log(`Copy or mount this optimized folder on Unraid: ${outputRoot}`);
  console.log("The Docker server can use TRANSCODE_ACCEL=vaapi/software later; it does not need to match this local encoder.");
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
    console.log("  --encoder nvenc|software|copy");
    console.log("  --quality 23");
    console.log("  --audio-bitrate 128k");
    console.log("  --concurrency 2");
    console.log("  --limit 500");
    return;
  }

  console.log("MediaWall Local Optimizer\n");
  console.log("Tip: point the original folder at the same SMB share Unraid uses so file modified times match MediaWall's manifest.\n");

  const originalRoot = path.resolve(cli.original || await prompt("Original media folder"));
  const outputRoot = path.resolve(cli.output || await prompt("Optimized output folder"));
  const modeRaw = cli.mode || await prompt("Optimize mode: all or needed", "needed");
  const mode = modeRaw.toLowerCase() === "all" ? "all" : "needed";
  const maxHeight = cli["max-height"] ? Number(cli["max-height"]) : await promptNumber("Max output height, usually 720 or 1080", 720, 240, 4320);
  const minBitrateMbps = cli["min-bitrate-mbps"] ? Number(cli["min-bitrate-mbps"]) : await promptNumber("Only in needed mode: optimize above bitrate Mbps", 8, 0, 1000);
  const encoderRaw = (cli.encoder || await prompt("Encoder: nvenc, software, or copy", "nvenc")).toLowerCase();
  const encoder = ["nvenc", "software", "copy"].includes(encoderRaw) ? encoderRaw : "software";
  const quality = cli.quality ? Number(cli.quality) : await promptNumber(encoder === "nvenc" ? "NVENC CQ quality, lower is better" : "CRF quality, lower is better", 23, 16, 34);
  const audioBitrate = cli["audio-bitrate"] || await prompt("Audio bitrate", "128k");
  const concurrency = cli.concurrency ? Number(cli.concurrency) : await promptNumber("Concurrent FFmpeg jobs", encoder === "nvenc" ? 2 : 1, 1, 8);
  const limit = cli.limit ? Number(cli.limit) : await promptNumber("Limit files for this run, 0 means all", 0, 0, Number.MAX_SAFE_INTEGER);

  const settings = {
    mode,
    maxHeight,
    minBitrateMbps,
    encoder,
    quality,
    audioBitrate,
    concurrency,
    softwarePreset: "veryfast",
    nvencPreset: "p5"
  };

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

      if (entry?.status === "ready" && entry.sourceSignature === signature && entry.maxHeight === maxHeight && entry.crf === quality) {
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
          transcodeMode: encoder,
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
          error: error.message.slice(0, 2000),
          updatedAt: new Date().toISOString()
        };
        await saveManifest(manifestPath, manifest);
        failed += 1;
        console.error(`[failed] ${video.relativePath}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`\nDone. Ready: ${completed}, skipped: ${skipped}, failed: ${failed}`);
  printComposeRecommendation(settings, outputRoot);
}

const rl = readline.createInterface({ input, output });
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
