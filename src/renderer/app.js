const wall = document.querySelector("#wall");
const emptyState = document.querySelector("#emptyState");
const emptyMessage = document.querySelector("#emptyMessage");
const topBar = document.querySelector("#topBar");
const debugPanel = document.querySelector("#debugPanel");
const panelTitle = document.querySelector("#panelTitle");
const chooseFolderButton = document.querySelector("#chooseFolderButton");
const menuButton = document.querySelector("#menuButton");
const debugChooseFolderButton = document.querySelector("#debugChooseFolderButton");
const pauseButton = document.querySelector("#pauseButton");
const fullscreenButton = document.querySelector("#fullscreenButton");
const refreshButton = document.querySelector("#refreshButton");
const statusSplash = document.querySelector("#statusSplash");
const subfolderList = document.querySelector("#subfolderList");
const diagnosticsPanel = document.querySelector("#diagnosticsPanel");
const diagnosticsCloseButton = document.querySelector("#diagnosticsCloseButton");
const diagnosticsMeta = document.querySelector("#diagnosticsMeta");
const diagnosticsSummary = document.querySelector("#diagnosticsSummary");
const activeTranscodeList = document.querySelector("#activeTranscodeList");
const queuedTranscodeList = document.querySelector("#queuedTranscodeList");
const recentTranscodeList = document.querySelector("#recentTranscodeList");
const diagnosticsLogList = document.querySelector("#diagnosticsLogList");
const hostDesktopElements = document.querySelectorAll(".host-desktop");
const hostWebElements = document.querySelectorAll(".host-web");

const controls = {
  itemCount: document.querySelector("#itemCount"),
  averageSize: document.querySelector("#averageSize"),
  swapSeconds: document.querySelector("#swapSeconds"),
  fadeSeconds: document.querySelector("#fadeSeconds"),
  cropMedia: document.querySelector("#cropMedia"),
  videoDebug: document.querySelector("#videoDebug")
};

const STORAGE_KEY = "mediaWall.settings.v2";
const REFRESH_MS = 10000;
const WEB_VIDEO_LOAD_LIMIT = 4;
const queryHost = new URLSearchParams(window.location.search).get("host");
const host = window.mediaWall?.mode === "desktop" || queryHost === "desktop" ? "desktop" : "web";

const state = {
  folder: null,
  allMedia: [],
  media: [],
  subfolders: [],
  excludedSubfolders: new Set(),
  active: [],
  selectedItems: new Set(),
  shownThisSession: new Set(),
  completedVideos: new Set(),
  ratios: new Map(),
  tiles: new Map(),
  swapTimer: null,
  refreshTimer: null,
  statusSplashTimer: null,
  videoWatchTimer: null,
  diagnosticsTimer: null,
  activeVideoLoads: 0,
  videoLoadQueue: [],
  paused: false
};

function loadSavedSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  const saved = {
    folder: host === "desktop" ? state.folder : null,
    itemCount: controls.itemCount.value,
    averageSize: controls.averageSize.value,
    swapSeconds: controls.swapSeconds.value,
    fadeSeconds: controls.fadeSeconds.value,
    cropMedia: controls.cropMedia.checked,
    videoDebug: controls.videoDebug.checked,
    paused: state.paused,
    excludedSubfolders: [...state.excludedSubfolders]
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

function applySavedSettings() {
  const saved = loadSavedSettings();
  if (saved.itemCount) controls.itemCount.value = saved.itemCount;
  if (saved.averageSize) controls.averageSize.value = saved.averageSize;
  if (saved.swapSeconds) controls.swapSeconds.value = saved.swapSeconds;
  if (saved.fadeSeconds) controls.fadeSeconds.value = saved.fadeSeconds;
  if (typeof saved.cropMedia === "boolean") controls.cropMedia.checked = saved.cropMedia;
  if (typeof saved.videoDebug === "boolean") controls.videoDebug.checked = saved.videoDebug;
  if (typeof saved.paused === "boolean") state.paused = saved.paused;
  if (Array.isArray(saved.excludedSubfolders)) {
    state.excludedSubfolders = new Set(saved.excludedSubfolders);
  }
  updatePauseButton();
  return saved;
}

function settings() {
  return {
    itemCount: Number(controls.itemCount.value),
    averageSize: Number(controls.averageSize.value),
    swapMs: Number(controls.swapSeconds.value) * 1000,
    fadeMs: Number(controls.fadeSeconds.value) * 1000,
    cropMedia: controls.cropMedia.checked
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickInitialItems() {
  state.active = shuffle(state.media).slice(0, Math.min(settings().itemCount, state.media.length));
  markShown(state.active);
}

function getRatio(item) {
  return state.ratios.get(item.id) || (item.type === "video" ? 16 / 9 : 1);
}

function markShown(items) {
  for (const item of items) {
    state.shownThisSession.add(item.id);
  }
}

function isInsideSubfolder(item, subfolderPath) {
  const normalizedItemPath = item.path.replaceAll("\\", "/").toLowerCase();
  const normalizedSubfolderPath = subfolderPath.replaceAll("\\", "/").toLowerCase();
  return normalizedItemPath === normalizedSubfolderPath || normalizedItemPath.startsWith(`${normalizedSubfolderPath}/`);
}

function visibleMediaFromFilters() {
  if (!state.excludedSubfolders.size) return state.allMedia;
  return state.allMedia.filter((item) => {
    for (const subfolderPath of state.excludedSubfolders) {
      if (isInsideSubfolder(item, subfolderPath)) return false;
    }
    return true;
  });
}

function applySubfolderFilters() {
  state.media = visibleMediaFromFilters();
  updateMediaList(state.media, false);
}

function renderSubfolderList() {
  subfolderList.textContent = "";

  if (!state.subfolders.length) {
    const empty = document.createElement("div");
    empty.className = "subfolder-empty";
    empty.textContent = "No subfolders";
    subfolderList.append(empty);
    return;
  }

  for (const subfolder of state.subfolders) {
    const row = document.createElement("label");
    row.className = "subfolder-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !state.excludedSubfolders.has(subfolder.path);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.excludedSubfolders.delete(subfolder.path);
      } else {
        state.excludedSubfolders.add(subfolder.path);
      }
      saveSettings();
      applySubfolderFilters();
    });

    const name = document.createElement("span");
    name.className = "subfolder-name";
    name.title = subfolder.path;
    name.textContent = subfolder.name;

    row.append(checkbox, name);
    subfolderList.append(row);
  }
}

function canRemoveItem(item) {
  return item.type !== "video" || state.completedVideos.has(item.id);
}

function updateTileSelection(tile, itemId) {
  tile.classList.toggle("selected", state.selectedItems.has(itemId));
}

function toggleSelectedItem(itemId) {
  if (state.selectedItems.has(itemId)) {
    state.selectedItems.delete(itemId);
  } else {
    state.selectedItems.add(itemId);
  }

  const tile = state.tiles.get(itemId);
  if (tile) updateTileSelection(tile, itemId);
}

function refreshTileSelections() {
  for (const [itemId, tile] of state.tiles.entries()) {
    updateTileSelection(tile, itemId);
  }
}

function measureMedia(item, element) {
  const width = item.type === "video" ? element.videoWidth : element.naturalWidth;
  const height = item.type === "video" ? element.videoHeight : element.naturalHeight;
  if (width && height) {
    state.ratios.set(item.id, width / height);
    layout();
  }
}

function mediaSourceLabel(item, media) {
  if (media.dataset.loadQueued === "true") return `${media.dataset.pendingSource || "video"} queued`;
  if (media.dataset.usingOptimized === "true") return "optimized";
  if (media.dataset.usingFallback === "true") return "transcoded";
  if (item.needsTranscode && item.fallbackUrl) return "transcode pending";
  return "original";
}

function videoSourceForItem(item) {
  if (item.optimizedUrl) {
    return { url: item.optimizedUrl, source: "optimized" };
  }
  if (item.needsTranscode && item.fallbackUrl) {
    return { url: item.fallbackUrl, source: "transcoded" };
  }
  return { url: item.url, source: "original" };
}

function applyVideoSource(media, source) {
  delete media.dataset.usingOptimized;
  delete media.dataset.usingFallback;
  media.dataset.pendingSource = source.source;
  if (source.source === "optimized") media.dataset.usingOptimized = "true";
  if (source.source === "transcoded") media.dataset.usingFallback = "true";
  media.src = source.url;
}

function processVideoLoadQueue() {
  if (host !== "web") return;

  state.videoLoadQueue = state.videoLoadQueue.filter(({ tile }) => tile.isConnected);
  while (state.activeVideoLoads < WEB_VIDEO_LOAD_LIMIT && state.videoLoadQueue.length) {
    const queued = state.videoLoadQueue.shift();
    if (!queued.tile.isConnected || queued.media.dataset.loadStarted === "true") continue;
    queued.media.dataset.loadQueued = "false";
    queued.media.dataset.loadStarted = "true";
    state.activeVideoLoads += 1;
    applyVideoSource(queued.media, queued.source);
    queued.media.load();
    queued.media.play().catch(() => {});
    updateVideoDebug(queued.tile, queued.item, queued.media);
  }
}

function releaseVideoLoadSlot(media) {
  if (host !== "web" || media.dataset.loadReleased === "true") return;
  media.dataset.loadReleased = "true";
  if (media.dataset.loadStarted === "true") {
    state.activeVideoLoads = Math.max(0, state.activeVideoLoads - 1);
  }
  processVideoLoadQueue();
}

function cancelVideoLoad(tile) {
  const video = tile.querySelector("video");
  if (!video) return;
  state.videoLoadQueue = state.videoLoadQueue.filter((queued) => queued.media !== video);
  releaseVideoLoadSlot(video);
}

function readyStateLabel(video) {
  return ["empty", "metadata", "current", "future", "enough"][video.readyState] || String(video.readyState);
}

function networkStateLabel(video) {
  return ["empty", "idle", "loading", "no-source"][video.networkState] || String(video.networkState);
}

function bufferedVideoText(video) {
  if (!video.buffered.length) return "buffered 0s";

  const ranges = [];
  let total = 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    total += Math.max(0, end - start);
    ranges.push(`${start.toFixed(1)}-${end.toFixed(1)}s`);
  }

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const percent = duration ? ` ${(Math.min(100, (total / duration) * 100)).toFixed(0)}%` : "";
  return `buffered ${total.toFixed(1)}s${percent} (${ranges.slice(0, 2).join(", ")})`;
}

function updateVideoDebug(tile, item, video) {
  const overlay = tile.querySelector(".video-debug");
  if (!overlay) return;

  const visible = controls.videoDebug.checked && item.type === "video";
  overlay.classList.toggle("hidden", !visible);
  tile.classList.toggle("debug-visible", visible);
  if (!visible) return;

  const source = mediaSourceLabel(item, video);
  const queueIndex = state.videoLoadQueue.findIndex((queued) => queued.media === video);
  const queueText = host === "web" && video.dataset.loadQueued === "true"
    ? `web load queue ${queueIndex >= 0 ? queueIndex + 1 : "-"} / ${state.videoLoadQueue.length}`
    : host === "web" ? `web active loads ${state.activeVideoLoads}/${WEB_VIDEO_LOAD_LIMIT}` : "desktop direct file";
  const waiting = tile.classList.contains("loading") ? "loading spinner on" : "playing/ready";
  const current = Number.isFinite(video.currentTime) ? `${video.currentTime.toFixed(1)}s` : "0s";
  const duration = Number.isFinite(video.duration) ? `${video.duration.toFixed(1)}s` : "unknown";
  const paused = video.paused ? "paused" : "playing";
  const stalled = Number(video.dataset.stuckTicks || 0) > 0 ? ` stuckTicks=${video.dataset.stuckTicks}` : "";

  overlay.textContent = [
    `${waiting} | ${source}`,
    queueText,
    `ready=${readyStateLabel(video)} network=${networkStateLabel(video)} ${paused}${stalled}`,
    `${bufferedVideoText(video)}`,
    `time ${current} / ${duration}`,
    item.path
  ].join("\n");
}

function refreshVideoDebug() {
  for (const [itemId, tile] of state.tiles.entries()) {
    const item = state.active.find((activeItem) => activeItem.id === itemId);
    const video = tile.querySelector("video");
    if (item && video) updateVideoDebug(tile, item, video);
  }
}

function createTile(item) {
  const tile = document.createElement("article");
  tile.className = `tile loading ${settings().cropMedia ? "" : "contain"}`;
  tile.dataset.id = item.id;
  tile.style.setProperty("--fade-duration", `${settings().fadeMs}ms`);

  const markReady = () => tile.classList.remove("loading");

  const media = document.createElement(item.type === "video" ? "video" : "img");
  media.draggable = false;

  if (item.type === "video") {
    const debug = document.createElement("div");
    debug.className = "video-debug hidden";
    const initialSource = videoSourceForItem(item);
    media.autoplay = true;
    media.loop = true;
    media.muted = true;
    media.playsInline = true;
    media.preload = host === "web" ? "metadata" : "auto";
    media.dataset.lastTime = "0";
    media.dataset.stuckTicks = "0";
    media.dataset.pendingSource = initialSource.source;
    media.dataset.loadQueued = host === "web" ? "true" : "false";
    if (host === "desktop") {
      media.dataset.loadStarted = "true";
      media.dataset.loadReleased = "true";
      applyVideoSource(media, initialSource);
    }
    media.addEventListener("error", () => {
      if (!item.fallbackUrl || media.dataset.usingFallback === "true") {
        tile.classList.remove("loading");
        tile.classList.add("failed");
        releaseVideoLoadSlot(media);
        updateVideoDebug(tile, item, media);
        return;
      }
      tile.classList.add("loading");
      applyVideoSource(media, { url: item.fallbackUrl, source: "transcoded" });
      media.load();
      media.play().catch(() => {});
      updateVideoDebug(tile, item, media);
    });
    media.addEventListener("loadedmetadata", () => {
      measureMedia(item, media);
      updateVideoDebug(tile, item, media);
    }, { once: true });
    media.addEventListener("loadeddata", () => {
      markReady();
      releaseVideoLoadSlot(media);
      updateVideoDebug(tile, item, media);
    });
    media.addEventListener("canplay", () => {
      markReady();
      releaseVideoLoadSlot(media);
      updateVideoDebug(tile, item, media);
      media.play().catch(() => {});
    });
    media.addEventListener("playing", () => {
      markReady();
      releaseVideoLoadSlot(media);
      media.dataset.stuckTicks = "0";
      updateVideoDebug(tile, item, media);
    });
    media.addEventListener("progress", () => updateVideoDebug(tile, item, media));
    media.addEventListener("waiting", () => {
      tile.classList.add("loading");
      updateVideoDebug(tile, item, media);
    });
    media.addEventListener("stalled", () => {
      tile.classList.add("loading");
      updateVideoDebug(tile, item, media);
    });
    media.addEventListener("timeupdate", () => {
      markReady();
      releaseVideoLoadSlot(media);
      media.dataset.stuckTicks = "0";
      updateVideoDebug(tile, item, media);
      if (media.duration && media.currentTime >= media.duration - 0.25) {
        state.completedVideos.add(item.id);
      }
    });
    tile.append(debug);
    if (host === "web") {
      state.videoLoadQueue.push({ tile, item, media, source: initialSource });
      updateVideoDebug(tile, item, media);
      processVideoLoadQueue();
    }
  } else {
    media.src = item.url;
    media.decoding = "async";
    media.addEventListener("load", () => {
      markReady();
      measureMedia(item, media);
    }, { once: true });
    media.addEventListener("error", () => {
      tile.classList.remove("loading");
      tile.classList.add("failed");
    }, { once: true });
  }

  tile.addEventListener("click", () => replaceItem(item.id, true));
  tile.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    toggleSelectedItem(item.id);
  });
  tile.append(media);
  wall.append(tile);
  updateTileSelection(tile, item.id);
  requestAnimationFrame(() => tile.classList.add("visible"));
  state.tiles.set(item.id, tile);
  return tile;
}

function syncTiles() {
  const activeIds = new Set(state.active.map((item) => item.id));

  for (const item of state.active) {
    if (!state.tiles.has(item.id)) createTile(item);
  }

  for (const [id, tile] of state.tiles.entries()) {
    if (activeIds.has(id)) continue;
    cancelVideoLoad(tile);
    tile.classList.add("fading");
    tile.classList.remove("visible");
    state.selectedItems.delete(id);
    state.tiles.delete(id);
    setTimeout(() => tile.remove(), settings().fadeMs + 80);
  }
}

function ensureVideoPlayback() {
  for (const tile of state.tiles.values()) {
    const video = tile.querySelector("video");
    if (!video || tile.classList.contains("failed")) continue;
    const item = state.active.find((activeItem) => activeItem.id === tile.dataset.id);
    const updateDebug = () => {
      if (item) updateVideoDebug(tile, item, video);
    };

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      tile.classList.remove("loading");
    }

    if (video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      video.play().catch(() => {});
      updateDebug();
      continue;
    }

    const lastTime = Number(video.dataset.lastTime || 0);
    const currentTime = video.currentTime || 0;
    const changed = Math.abs(currentTime - lastTime) > 0.02;
    video.dataset.lastTime = String(currentTime);

    if (video.paused || video.ended || changed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      video.dataset.stuckTicks = "0";
      updateDebug();
      continue;
    }

    const stuckTicks = Number(video.dataset.stuckTicks || 0) + 1;
    video.dataset.stuckTicks = String(stuckTicks);

    if (stuckTicks >= 2) {
      video.playbackRate = 1;
      video.play().catch(() => {});
    }

    updateDebug();
  }
}

function packRowsWithScale(items, width, height, averageSize, scale) {
  const area = averageSize * averageSize * scale * scale;
  const boxes = items.map((item) => {
    const ratio = Math.max(0.16, Math.min(6, getRatio(item)));
    return {
      item,
      width: Math.max(36, Math.sqrt(area * ratio)),
      height: Math.max(36, Math.sqrt(area / ratio))
    };
  });

  const rows = [];
  let row = { items: [], width: 0, height: 0 };

  for (const box of boxes) {
    if (row.items.length && row.width + box.width > width) {
      rows.push(row);
      row = { items: [], width: 0, height: 0 };
    }
    row.items.push(box);
    row.width += box.width;
    row.height = Math.max(row.height, box.height);
  }
  if (row.items.length) rows.push(row);

  const usedHeight = rows.reduce((sum, current) => sum + current.height, 0);
  if (usedHeight > height) return null;

  const rects = new Map();
  let y = Math.max(0, (height - usedHeight) / 2);

  for (const currentRow of rows) {
    const rowScale = Math.min(width / currentRow.width, height / usedHeight);
    const rowWidth = currentRow.width * rowScale;
    let x = Math.max(0, (width - rowWidth) / 2);

    for (const box of currentRow.items) {
      rects.set(box.item.id, {
        x,
        y,
        width: box.width * rowScale,
        height: currentRow.height * rowScale
      });
      x += box.width * rowScale;
    }
    y += currentRow.height * rowScale;
  }

  return rects;
}

function packColumnsWithScale(items, width, height, averageSize, scale) {
  const area = averageSize * averageSize * scale * scale;
  const boxes = items.map((item) => {
    const ratio = Math.max(0.16, Math.min(6, getRatio(item)));
    return {
      item,
      width: Math.max(36, Math.sqrt(area * ratio)),
      height: Math.max(36, Math.sqrt(area / ratio))
    };
  });

  const columns = [];
  let column = { items: [], width: 0, height: 0 };

  for (const box of boxes) {
    if (column.items.length && column.height + box.height > height) {
      columns.push(column);
      column = { items: [], width: 0, height: 0 };
    }
    column.items.push(box);
    column.height += box.height;
    column.width = Math.max(column.width, box.width);
  }
  if (column.items.length) columns.push(column);

  const usedWidth = columns.reduce((sum, current) => sum + current.width, 0);
  if (usedWidth > width) return null;

  const rects = new Map();
  let x = Math.max(0, (width - usedWidth) / 2);

  for (const currentColumn of columns) {
    const columnScale = Math.min(height / currentColumn.height, width / usedWidth);
    const columnHeight = currentColumn.height * columnScale;
    let y = Math.max(0, (height - columnHeight) / 2);

    for (const box of currentColumn.items) {
      rects.set(box.item.id, {
        x,
        y,
        width: currentColumn.width * columnScale,
        height: box.height * columnScale
      });
      y += box.height * columnScale;
    }
    x += currentColumn.width * columnScale;
  }

  return rects;
}

function scoreLayout(rects, width, height) {
  if (!rects || rects.size === 0) return 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let mediaArea = 0;

  for (const rect of rects.values()) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
    mediaArea += rect.width * rect.height;
  }

  const boundsArea = Math.max(1, (maxX - minX) * (maxY - minY));
  const screenArea = Math.max(1, width * height);
  const screenFill = boundsArea / screenArea;
  const mediaDensity = mediaArea / boundsArea;
  return screenFill * 0.65 + mediaDensity * 0.35;
}

function solveLayout(items, width, height, averageSize, orientation) {
  const sorted = [...items].sort((a, b) => {
    const ratioA = getRatio(a);
    const ratioB = getRatio(b);
    return orientation === "columns" ? ratioA - ratioB : ratioB - ratioA;
  });
  const pack = orientation === "columns" ? packColumnsWithScale : packRowsWithScale;
  let low = 0.05;
  let high = 2.5;
  let best = new Map();

  for (let i = 0; i < 18; i += 1) {
    const mid = (low + high) / 2;
    const result = pack(sorted, width, height, averageSize, mid);
    if (result) {
      best = result;
      low = mid;
    } else {
      high = mid;
    }
  }

  return best;
}

function calculateLayout(items, width, height, averageSize) {
  if (items.length === 1) {
    const ratio = Math.max(0.16, Math.min(6, getRatio(items[0])));
    const maxWidth = width * 0.92;
    const maxHeight = height * 0.92;
    let itemWidth = maxWidth;
    let itemHeight = itemWidth / ratio;
    if (itemHeight > maxHeight) {
      itemHeight = maxHeight;
      itemWidth = itemHeight * ratio;
    }
    return new Map([[items[0].id, {
      x: (width - itemWidth) / 2,
      y: (height - itemHeight) / 2,
      width: itemWidth,
      height: itemHeight
    }]]);
  }

  const rowLayout = solveLayout(items, width, height, averageSize, "rows");
  const columnLayout = solveLayout(items, width, height, averageSize, "columns");
  const screenRatio = width / Math.max(1, height);
  const rowScore = scoreLayout(rowLayout, width, height);
  const columnScore = scoreLayout(columnLayout, width, height) + (screenRatio > 2.2 ? 0.08 : 0);
  return columnScore > rowScore ? columnLayout : rowLayout;
}

function layout() {
  if (!state.active.length) return;
  const { averageSize, fadeMs, cropMedia } = settings();
  const rects = calculateLayout(state.active, window.innerWidth, window.innerHeight, averageSize);

  for (const item of state.active) {
    const tile = state.tiles.get(item.id);
    const rect = rects.get(item.id);
    if (!tile || !rect) continue;
    tile.classList.toggle("contain", !cropMedia);
    tile.style.setProperty("--fade-duration", `${fadeMs}ms`);
    tile.style.left = `${Math.round(rect.x)}px`;
    tile.style.top = `${Math.round(rect.y)}px`;
    tile.style.width = `${Math.round(rect.width)}px`;
    tile.style.height = `${Math.round(rect.height)}px`;
  }
}

function chooseReplacement(activeIds) {
  const inactive = state.media.filter((item) => !activeIds.has(item.id));
  if (!inactive.length) return null;

  let candidates = inactive.filter((item) => !state.shownThisSession.has(item.id));
  if (!candidates.length) {
    state.shownThisSession = new Set(activeIds);
    candidates = inactive;
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function replaceItem(itemId, forceIndex = false) {
  if (state.media.length <= state.active.length) return;
  const activeIds = new Set(state.active.map((active) => active.id));
  const replacement = chooseReplacement(activeIds);
  if (!replacement) return;

  let removableIndexes = state.active.map((item, index) => ({ item, index }));
  if (forceIndex) {
    removableIndexes = removableIndexes.filter(({ item }) => item.id === itemId);
  } else {
    removableIndexes = removableIndexes.filter(({ item }) => canRemoveItem(item));
  }
  if (!removableIndexes.length) return;

  const removeIndex = removableIndexes[Math.floor(Math.random() * removableIndexes.length)].index;
  state.active.splice(removeIndex, 1, replacement);
  markShown([replacement]);
  syncTiles();
  layout();
}

function randomReplacement() {
  replaceItem(null);
}

function replaceAllItems() {
  const target = Math.min(settings().itemCount, state.media.length);
  if (!target) return;

  const activeIds = new Set(state.active.map((item) => item.id));
  const unseenInactive = shuffle(state.media.filter((item) => {
    return !activeIds.has(item.id) && !state.shownThisSession.has(item.id);
  }));
  const inactive = shuffle(state.media.filter((item) => !activeIds.has(item.id)));
  const fallback = shuffle(state.media);
  const next = [];
  const nextIds = new Set();

  for (const pool of [unseenInactive, inactive, fallback]) {
    for (const item of pool) {
      if (next.length >= target) break;
      if (nextIds.has(item.id)) continue;
      next.push(item);
      nextIds.add(item.id);
    }
  }

  if (!next.length) return;
  state.active = next;
  markShown(next);
  syncTiles();
  layout();
}

function showSelectedItemsOnly() {
  const selected = state.active.filter((item) => state.selectedItems.has(item.id));
  if (!selected.length) return;

  state.paused = true;
  controls.itemCount.value = String(selected.length);
  state.active = selected;
  state.selectedItems.clear();
  markShown(selected);
  updatePauseButton();
  saveSettings();
  restartSwapTimer();
  syncTiles();
  refreshTileSelections();
  layout();
}

function restartSwapTimer() {
  clearInterval(state.swapTimer);
  if (state.paused) return;
  const { swapMs } = settings();
  if (swapMs > 0) state.swapTimer = setInterval(randomReplacement, swapMs);
}

function updatePauseButton() {
  pauseButton.textContent = state.paused ? "Resume random swaps" : "Pause random swaps";
  pauseButton.title = state.paused ? "Resume random swaps" : "Pause random swaps";
  pauseButton.setAttribute("aria-label", pauseButton.title);
}

function showStatusSplash(message) {
  clearTimeout(state.statusSplashTimer);
  statusSplash.textContent = message;
  statusSplash.classList.remove("visible");

  requestAnimationFrame(() => {
    statusSplash.classList.add("visible");
  });

  state.statusSplashTimer = setTimeout(() => {
    statusSplash.classList.remove("visible");
  }, 1150);
}

function togglePause() {
  state.paused = !state.paused;
  updatePauseButton();
  showStatusSplash(state.paused ? "Random paused" : "Random resumed");
  saveSettings();
  restartSwapTimer();
}

function changeItemCount(delta) {
  const min = Number(controls.itemCount.min) || 1;
  const max = Number(controls.itemCount.max) || 200;
  const current = Number(controls.itemCount.value) || min;
  controls.itemCount.value = String(clamp(current + delta, min, max));
  saveSettings();
  reconcileItemCount();
}

function reconcileItemCount() {
  const target = Math.min(settings().itemCount, state.media.length);
  if (state.active.length > target) {
    state.active = state.active.slice(0, target);
  }

  const activeIds = new Set(state.active.map((item) => item.id));
  const available = shuffle(state.media.filter((item) => !activeIds.has(item.id)));
  while (state.active.length < target && available.length) {
    const item = available.pop();
    state.active.push(item);
    markShown([item]);
  }

  syncTiles();
  layout();
  updateEmptyState();
}

function updateEmptyState() {
  const hasMedia = state.media.length > 0;
  emptyState.classList.toggle("hidden", hasMedia);
  topBar.classList.toggle("hidden", host !== "desktop" && !hasMedia);
  if (!hasMedia) {
    emptyMessage.textContent = state.allMedia.length
      ? "All mounted media is hidden by the subfolder filters."
      : host === "desktop" ? "Choose a media folder to start." : "No media found in the mounted folder.";
  }
}

function updateMediaList(media, replaceAllMedia = true) {
  const mediaById = new Map(media.map((item) => [item.id, item]));
  if (replaceAllMedia) state.allMedia = media;
  state.media = media;
  state.shownThisSession = new Set([...state.shownThisSession].filter((id) => mediaById.has(id)));
  state.completedVideos = new Set([...state.completedVideos].filter((id) => mediaById.has(id)));
  state.active = state.active
    .filter((item) => mediaById.has(item.id))
    .map((item) => mediaById.get(item.id));
  reconcileItemCount();
}

function loadFolderResult(result, resetWall = false) {
  state.folder = result.folder;
  state.allMedia = result.media;
  state.subfolders = result.subfolders || [];
  state.excludedSubfolders = new Set([...state.excludedSubfolders].filter((folder) => {
    return state.subfolders.some((subfolder) => subfolder.path === folder);
  }));
  state.media = visibleMediaFromFilters();
  renderSubfolderList();

  if (resetWall || !state.active.length) {
    state.active = [];
    state.selectedItems.clear();
    state.shownThisSession.clear();
    state.completedVideos.clear();
    state.ratios.clear();
    state.videoLoadQueue = [];
    state.activeVideoLoads = 0;
    state.tiles.forEach((tile) => tile.remove());
    state.tiles.clear();
    pickInitialItems();
  }

  updateMediaList(state.media, false);
  restartSwapTimer();
  saveSettings();
}

async function chooseDesktopFolder() {
  if (!window.mediaWall?.chooseFolder) {
    emptyState.classList.remove("hidden");
    emptyMessage.textContent = "The desktop bridge did not load. Restart MediaWall and try again.";
    return;
  }
  const result = await window.mediaWall.chooseFolder();
  if (!result) return;
  loadFolderResult(result, true);
  window.mediaWall.watchFolder(state.folder);
}

async function restoreDesktopFolder() {
  const saved = applySavedSettings();
  if (!saved.folder || !window.mediaWall?.scanFolder) {
    updateEmptyState();
    return;
  }

  const result = await window.mediaWall.scanFolder(saved.folder);
  if (!result) {
    updateEmptyState();
    return;
  }

  loadFolderResult(result, true);
  window.mediaWall.watchFolder(state.folder);
}

async function loadServerMedia(resetWall = false) {
  try {
    const response = await fetch("/api/media", { cache: "no-store" });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(`Failed to load media: ${response.status}`);
    const result = await response.json();
    loadFolderResult(result, resetWall);
  } catch {
    state.allMedia = [];
    state.media = [];
    state.active = [];
    syncTiles();
    updateEmptyState();
  }
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
}

function configureHostControls() {
  for (const element of hostDesktopElements) {
    element.classList.toggle("hidden", host !== "desktop");
  }
  for (const element of hostWebElements) {
    element.classList.toggle("hidden", host !== "web");
  }
}

function setPanelVersion(version) {
  panelTitle.textContent = version ? `MediaWall - v${version}` : "MediaWall";
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatLogDetails(details = {}) {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

function renderEmptyDiagnostics(container, text) {
  container.textContent = "";
  const empty = document.createElement("div");
  empty.className = "diagnostics-empty";
  empty.textContent = text;
  container.append(empty);
}

function renderDiagnosticsSummary(data) {
  const transcode = data.transcode || {};
  const optimize = data.optimize || {};
  diagnosticsMeta.textContent = data.app?.version ? `MediaWall - v${data.app.version}` : "MediaWall";
  diagnosticsSummary.textContent = "";

  const items = [
    ["Active", transcode.activeCount || 0],
    ["Queued", transcode.queueWaiting || 0],
    ["Compat cached", transcode.cachedCount || 0],
    ["Optimized", optimize.cachedCount || 0],
    ["Failed", (transcode.failedCount || 0) + (optimize.failedCount || 0)],
    ["Mode", transcode.accel || "unknown"],
    ["Optimize", optimize.enabled ? `${optimize.mode} ${optimize.maxHeight}p` : "off"]
  ];

  for (const [label, value] of items) {
    const tile = document.createElement("div");
    tile.className = "diagnostics-stat";
    const labelElement = document.createElement("span");
    labelElement.textContent = label;
    const valueElement = document.createElement("strong");
    valueElement.textContent = String(value);
    tile.append(labelElement, valueElement);
    diagnosticsSummary.append(tile);
  }
}

function renderActiveTranscodes(active = []) {
  activeTranscodeList.textContent = "";
  if (!active.length) {
    renderEmptyDiagnostics(activeTranscodeList, "No active transcodes");
    return;
  }

  for (const job of active) {
    const row = document.createElement("article");
    row.className = "diagnostics-row";

    const title = document.createElement("div");
    title.className = "diagnostics-row-title";
    title.textContent = job.source || "Unknown source";

    const detail = document.createElement("div");
    detail.className = "diagnostics-row-detail";
    const current = formatSeconds(job.currentSeconds);
    const duration = formatSeconds(job.durationSeconds);
    const percent = job.percent !== null && job.percent !== undefined ? `${job.percent}%` : "working";
    const speed = job.speed ? ` ${job.speed}` : "";
    detail.textContent = `${job.kind || "transcode"} ${job.requestedMode || "auto"} ${percent}${speed}${current ? ` ${current}${duration ? ` / ${duration}` : ""}` : ""}`;

    const progress = document.createElement("div");
    progress.className = "diagnostics-progress";
    const bar = document.createElement("span");
    bar.style.width = `${Math.max(4, Math.min(100, job.percent || 8))}%`;
    progress.append(bar);

    row.append(title, detail, progress);
    activeTranscodeList.append(row);
  }
}

function renderQueuedTranscodes(queued = []) {
  queuedTranscodeList.textContent = "";
  if (!queued.length) {
    renderEmptyDiagnostics(queuedTranscodeList, "No queued transcodes");
    return;
  }

  for (const job of queued.slice(0, 30)) {
    const row = document.createElement("article");
    row.className = "diagnostics-row compact";
    row.textContent = `${job.position}. ${job.kind || "transcode"} ${job.source}`;
    queuedTranscodeList.append(row);
  }
}

function renderRecentTranscodes(recent = []) {
  recentTranscodeList.textContent = "";
  if (!recent.length) {
    renderEmptyDiagnostics(recentTranscodeList, "No completed transcodes yet");
    return;
  }

  for (const job of recent.slice(0, 20)) {
    const row = document.createElement("article");
    row.className = `diagnostics-row ${job.status === "failed" ? "error" : ""}`;
    const title = document.createElement("div");
    title.className = "diagnostics-row-title";
    title.textContent = job.source || "Unknown source";
    const detail = document.createElement("div");
    detail.className = "diagnostics-row-detail";
    const sizeText = job.originalSize && job.optimizedSize ? ` ${Math.round(job.originalSize / 1048576)}MB -> ${Math.round(job.optimizedSize / 1048576)}MB` : "";
    detail.textContent = job.status === "failed" ? `${job.kind || "transcode"} failed ${job.error || ""}` : `${job.kind || "transcode"} ready ${job.mode || ""}${sizeText}`;
    row.append(title, detail);
    recentTranscodeList.append(row);
  }
}

function renderDiagnosticsLogs(logs = []) {
  diagnosticsLogList.textContent = "";
  if (!logs.length) {
    renderEmptyDiagnostics(diagnosticsLogList, "No log events yet");
    return;
  }

  for (const log of logs.slice().reverse()) {
    const row = document.createElement("article");
    row.className = `log-row ${log.level === "error" ? "error" : ""}`;
    const at = new Date(log.at);
    const time = Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString();
    const details = formatLogDetails(log.details);
    row.textContent = `${time} ${log.message}${details ? ` ${details}` : ""}`;
    diagnosticsLogList.append(row);
  }
}

async function refreshDiagnostics() {
  if (host !== "web") {
    diagnosticsMeta.textContent = window.mediaWall?.version ? `MediaWall - v${window.mediaWall.version}` : "MediaWall";
    diagnosticsSummary.textContent = "";
    renderEmptyDiagnostics(diagnosticsSummary, "Diagnostics are available in the Docker web app");
    renderEmptyDiagnostics(activeTranscodeList, "No server transcodes in desktop mode");
    renderEmptyDiagnostics(queuedTranscodeList, "No server queue in desktop mode");
    renderEmptyDiagnostics(recentTranscodeList, "No server cache in desktop mode");
    renderEmptyDiagnostics(diagnosticsLogList, "No server logs in desktop mode");
    return;
  }

  try {
    const response = await fetch("/api/diagnostics", { cache: "no-store" });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(`Failed to load diagnostics: ${response.status}`);
    const data = await response.json();
    renderDiagnosticsSummary(data);
    renderActiveTranscodes(data.transcode?.active || []);
    renderQueuedTranscodes(data.transcode?.queued || []);
    renderRecentTranscodes(data.transcode?.recent || []);
    renderDiagnosticsLogs(data.logs || []);
  } catch (error) {
    diagnosticsMeta.textContent = "MediaWall";
    diagnosticsSummary.textContent = "";
    renderEmptyDiagnostics(diagnosticsSummary, error.message);
  }
}

function setDiagnosticsVisible(visible) {
  diagnosticsPanel.classList.toggle("hidden", !visible);
  clearInterval(state.diagnosticsTimer);
  state.diagnosticsTimer = null;

  if (visible) {
    refreshDiagnostics();
    state.diagnosticsTimer = setInterval(refreshDiagnostics, 1500);
  }
}

function toggleDiagnostics() {
  setDiagnosticsVisible(diagnosticsPanel.classList.contains("hidden"));
}

async function loadAppInfo() {
  if (host === "desktop") {
    setPanelVersion(window.mediaWall?.version || null);
    return;
  }

  try {
    const response = await fetch("/api/app-info", { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load app info: ${response.status}`);
    const appInfo = await response.json();
    setPanelVersion(appInfo.version);
  } catch {
    setPanelVersion(null);
  }
}

function initializeHost() {
  configureHostControls();
  loadAppInfo();
  state.videoWatchTimer = setInterval(ensureVideoPlayback, 2500);

  if (host === "desktop") {
    emptyState.classList.remove("hidden");
    emptyMessage.textContent = "Choose a media folder to start.";
    topBar.classList.remove("hidden");
    restoreDesktopFolder();
    window.mediaWall?.onMediaUpdated?.(({ folder, media, subfolders }) => {
      if (folder !== state.folder) return;
      state.allMedia = media;
      state.subfolders = subfolders || [];
      state.excludedSubfolders = new Set([...state.excludedSubfolders].filter((subfolderPath) => {
        return state.subfolders.some((subfolder) => subfolder.path === subfolderPath);
      }));
      renderSubfolderList();
      updateMediaList(visibleMediaFromFilters(), false);
    });
    return;
  }

  applySavedSettings();
  loadServerMedia(true);
  state.refreshTimer = setInterval(() => loadServerMedia(false), REFRESH_MS);
}

menuButton.addEventListener("click", () => debugPanel.classList.toggle("hidden"));
diagnosticsCloseButton.addEventListener("click", () => setDiagnosticsVisible(false));
if (chooseFolderButton) chooseFolderButton.addEventListener("click", chooseDesktopFolder);
if (debugChooseFolderButton) debugChooseFolderButton.addEventListener("click", chooseDesktopFolder);
pauseButton.addEventListener("click", togglePause);
fullscreenButton.addEventListener("click", () => {
  if (host === "desktop" && window.mediaWall?.toggleFullscreen) {
    window.mediaWall.toggleFullscreen();
  } else {
    toggleFullscreen().catch(() => {});
  }
});
if (refreshButton) refreshButton.addEventListener("click", () => loadServerMedia(true));

window.addEventListener("resize", layout);

window.addEventListener("wheel", (event) => {
  if (debugPanel.contains(event.target)) return;
  if (!state.media.length) return;

  event.preventDefault();
  const step = event.shiftKey ? 5 : 1;
  changeItemCount(event.deltaY < 0 ? step : -step);
}, { passive: false });

window.addEventListener("mousedown", (event) => {
  if (event.button !== 1) return;
  if (debugPanel.contains(event.target)) return;
  event.preventDefault();
});

window.addEventListener("auxclick", (event) => {
  if (event.button !== 1) return;
  if (debugPanel.contains(event.target)) return;

  event.preventDefault();
  showSelectedItemsOnly();
});

window.addEventListener("keydown", (event) => {
  if (host === "desktop" && event.ctrlKey && event.code === "Space") {
    event.preventDefault();
    window.mediaWall?.quitApp?.();
    return;
  }
  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.code === "Space") {
    event.preventDefault();
    togglePause();
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    debugPanel.classList.toggle("hidden");
  }
  if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    toggleDiagnostics();
    return;
  }
  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key === "ArrowRight") {
    event.preventDefault();
    replaceAllItems();
    return;
  }
  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key === "ArrowUp") {
    event.preventDefault();
    changeItemCount(event.shiftKey ? 5 : 1);
    return;
  }
  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key === "ArrowDown") {
    event.preventDefault();
    changeItemCount(event.shiftKey ? -5 : -1);
    return;
  }
  if (event.key === "F11") {
    event.preventDefault();
    if (host === "desktop" && window.mediaWall?.toggleFullscreen) {
      window.mediaWall.toggleFullscreen();
    } else {
      toggleFullscreen().catch(() => {});
    }
  }
});

for (const input of Object.values(controls)) {
  input.addEventListener("input", () => {
    saveSettings();
    if (input === controls.videoDebug) {
      refreshVideoDebug();
      processVideoLoadQueue();
      return;
    }
    reconcileItemCount();
    restartSwapTimer();
  });
}

initializeHost();
