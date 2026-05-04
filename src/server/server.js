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
const password = process.env.MEDIA_PASSWORD || "change-me";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const cookieName = "media_wall_session";
const activeTranscodes = new Map();

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

async function transcodeCachePath(relativePath, fullPath) {
  const stats = await fs.stat(fullPath);
  const cacheKey = crypto
    .createHash("sha256")
    .update(`${relativePath}:${stats.size}:${stats.mtimeMs}`)
    .digest("hex");
  return path.join(transcodeCacheRoot, `${cacheKey}.mp4`);
}

async function transcodeToMp4(relativePath, fullPath) {
  const cachePath = await transcodeCachePath(relativePath, fullPath);
  if (await pathExists(cachePath)) return cachePath;

  const existing = activeTranscodes.get(cachePath);
  if (existing) return existing;

  const transcode = (async () => {
    await fs.mkdir(transcodeCacheRoot, { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp.mp4`;

    await new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-i", fullPath,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        tempPath
      ], { stdio: ["ignore", "ignore", "pipe"] });

      let stderr = "";
      ffmpeg.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => {
        if (code === 0) return resolve();
        return reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      });
    });

    await fs.rename(tempPath, cachePath);
    return cachePath;
  })();

  activeTranscodes.set(cachePath, transcode);
  try {
    return await transcode;
  } finally {
    activeTranscodes.delete(cachePath);
  }
}

function createServerItem({ relativePath, name, type, isVideo }) {
  return {
    id: relativePath,
    name,
    type,
    path: relativePath,
    url: mediaUrl(relativePath),
    fallbackUrl: isVideo ? transcodeUrl(relativePath) : null
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
  res.json(await loadServerFolderData());
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

app.listen(port, () => {
  console.log(`Media Wall listening on port ${port}`);
  console.log(`Serving media from ${mediaRoot}`);
});
