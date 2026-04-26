const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogg", ".ogv", ".mkv"]);

const app = express();
const port = Number(process.env.PORT || 3000);
const mediaRoot = path.resolve(process.env.MEDIA_DIR || "/media");
const password = process.env.MEDIA_PASSWORD || "change-me";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const cookieName = "media_wall_session";

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

function safeMediaPath(relativePath) {
  const resolved = path.resolve(mediaRoot, relativePath);
  if (resolved !== mediaRoot && !resolved.startsWith(`${mediaRoot}${path.sep}`)) return null;
  return resolved;
}

async function scanMedia(folder) {
  const media = [];

  async function walk(currentFolder) {
    let entries;
    try {
      entries = await fs.readdir(currentFolder, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(currentFolder, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        return;
      }

      if (!entry.isFile()) return;

      const ext = path.extname(entry.name).toLowerCase();
      const isImage = IMAGE_EXTENSIONS.has(ext);
      const isVideo = VIDEO_EXTENSIONS.has(ext);
      if (!isImage && !isVideo) return;

      const relativePath = path.relative(folder, fullPath).split(path.sep).join("/");
      media.push({
        id: relativePath,
        name: entry.name,
        type: isImage ? "image" : "video",
        path: relativePath,
        url: mediaUrl(relativePath)
      });
    }));
  }

  await walk(folder);
  return media.sort((a, b) => a.path.localeCompare(b.path));
}

async function listTopSubfolders(folder) {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: entry.name
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
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

app.use("/login.css", express.static(path.join(__dirname, "renderer", "login.css")));
app.use(requireAuth);
app.use(express.static(path.join(__dirname, "renderer")));

app.get("/api/media", async (_req, res) => {
  const [media, subfolders] = await Promise.all([
    scanMedia(mediaRoot),
    listTopSubfolders(mediaRoot)
  ]);
  res.json({ folder: mediaRoot, media, subfolders });
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
