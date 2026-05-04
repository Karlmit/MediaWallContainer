const fs = require("fs/promises");
const path = require("path");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogg", ".ogv", ".mkv"]);

async function scanMedia(folder, createItem) {
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

      media.push(createItem({
        fullPath,
        relativePath: path.relative(folder, fullPath).split(path.sep).join("/"),
        name: entry.name,
        type: isImage ? "image" : "video",
        isVideo
      }));
    }));
  }

  await walk(folder);
  return media.sort((a, b) => a.path.localeCompare(b.path));
}

async function listTopSubfolders(folder, createSubfolder) {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => createSubfolder({
        fullPath: path.join(folder, entry.name),
        relativePath: entry.name,
        name: entry.name
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function loadFolderData(folder, createItem, createSubfolder) {
  const [media, subfolders] = await Promise.all([
    scanMedia(folder, createItem),
    listTopSubfolders(folder, createSubfolder)
  ]);
  return { folder, media, subfolders };
}

module.exports = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  loadFolderData
};
