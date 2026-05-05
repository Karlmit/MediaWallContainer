const $ = (id) => document.getElementById(id);

const state = {
  running: false,
  total: 0,
  processed: 0,
  ready: 0,
  skipped: 0,
  failed: 0,
  active: new Map(),
  activity: []
};

function value(id) {
  return $(id).value.trim();
}

function numberValue(id) {
  const numeric = Number(value(id));
  return Number.isFinite(numeric) ? numeric : 0;
}

function setRunning(running) {
  state.running = running;
  $("start").disabled = running;
  $("stop").disabled = !running;
  $("stateBadge").textContent = running ? "Running" : "Idle";
  $("stateBadge").classList.toggle("running", running);
}

function addLog(message) {
  const logs = $("logs");
  logs.textContent += `${message.trimEnd()}\n`;
  logs.scrollTop = logs.scrollHeight;
}

function addActivity(message) {
  state.activity.unshift(message);
  state.activity = state.activity.slice(0, 8);
  $("activity").innerHTML = state.activity.map((item) => `<div>${escapeHtml(item)}</div>`).join("");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "working";
  return `${Math.max(0, Math.min(100, Number(value))).toFixed(0)}%`;
}

function render() {
  $("total").textContent = state.total;
  $("processed").textContent = state.processed;
  $("ready").textContent = state.ready;
  $("skipped").textContent = state.skipped;
  $("failed").textContent = state.failed;

  const percent = state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0;
  $("overallBar").style.width = `${Math.max(0, Math.min(100, percent))}%`;

  const jobs = $("activeJobs");
  if (state.active.size === 0) {
    jobs.className = "jobs empty";
    jobs.textContent = "No active transcodes";
    return;
  }

  jobs.className = "jobs";
  jobs.innerHTML = Array.from(state.active.values()).map((job) => `
    <article class="job">
      <div class="job-title" title="${escapeHtml(job.path)}">${escapeHtml(job.path)}</div>
      <div class="job-meta">
        ${formatPercent(job.percent)}
        ${job.speed ? ` · ${escapeHtml(job.speed)}` : ""}
        ${job.fps ? ` · ${Math.round(job.fps)} fps` : ""}
      </div>
      <div class="mini-shell"><div class="mini-bar" style="width:${job.percent || 0}%"></div></div>
    </article>
  `).join("");
}

function settingsFromForm() {
  return {
    original: value("original"),
    output: value("output"),
    mode: value("mode"),
    maxHeight: numberValue("maxHeight"),
    minBitrateMbps: numberValue("minBitrateMbps"),
    quality: numberValue("quality"),
    nvencPreset: value("nvencPreset"),
    audioBitrate: value("audioBitrate"),
    concurrency: numberValue("concurrency"),
    limit: numberValue("limit"),
    composeMediaPath: value("composeMediaPath"),
    composeOptimizedPath: value("composeOptimizedPath"),
    composeCachePath: value("composeCachePath"),
    composePort: numberValue("composePort")
  };
}

function resetRun() {
  state.total = 0;
  state.processed = 0;
  state.ready = 0;
  state.skipped = 0;
  state.failed = 0;
  state.active.clear();
  state.activity = [];
  $("activity").innerHTML = "";
  $("logs").textContent = "";
  render();
}

function handleEvent(event) {
  switch (event.type) {
    case "scan-complete":
      state.total = event.queuedVideos || 0;
      addActivity(`Found ${event.totalVideos} videos, processing ${event.queuedVideos}`);
      addLog(`Settings: ${JSON.stringify(event.settings)}`);
      break;
    case "job-started":
      state.active.set(event.path, { path: event.path, percent: 0 });
      addActivity(`Started ${event.path}`);
      break;
    case "job-progress":
      state.active.set(event.path, {
        path: event.path,
        percent: event.percent,
        speed: event.speed,
        fps: event.fps
      });
      break;
    case "job-ready":
      state.active.delete(event.path);
      state.ready = event.completed || state.ready + 1;
      state.skipped = event.skipped || state.skipped;
      state.failed = event.failed || state.failed;
      state.processed = event.processed || state.ready + state.skipped + state.failed;
      addActivity(`Ready ${event.path}`);
      break;
    case "job-skipped":
      state.skipped = event.skipped || state.skipped + 1;
      state.processed = event.processed || state.ready + state.skipped + state.failed;
      addActivity(`Skipped ${event.path}`);
      break;
    case "job-failed":
      state.active.delete(event.path);
      state.failed = event.failed || state.failed + 1;
      state.processed = event.processed || state.ready + state.skipped + state.failed;
      addActivity(`Failed ${event.path}`);
      addLog(event.error || "Unknown error");
      break;
    case "summary":
      state.ready = event.completed || 0;
      state.skipped = event.skipped || 0;
      state.failed = event.failed || 0;
      state.processed = event.processed || state.ready + state.skipped + state.failed;
      state.active.clear();
      addActivity(`Done: ${state.ready} ready, ${state.skipped} skipped, ${state.failed} failed`);
      break;
    case "fatal":
      addLog(`Fatal: ${event.error}`);
      setRunning(false);
      break;
    case "process-exit":
      addLog(`Optimizer exited with code ${event.code}`);
      setRunning(false);
      break;
    default:
      addLog(JSON.stringify(event));
      break;
  }

  render();
}

$("chooseOriginal").addEventListener("click", async () => {
  const folder = await window.optimizer.chooseFolder("Choose original media folder");
  if (folder) $("original").value = folder;
});

$("chooseOutput").addEventListener("click", async () => {
  const folder = await window.optimizer.chooseFolder("Choose optimized output folder");
  if (folder) $("output").value = folder;
});

$("start").addEventListener("click", async () => {
  const settings = settingsFromForm();
  if (!settings.original || !settings.output) {
    addLog("Choose original and optimized output folders first.");
    return;
  }

  resetRun();
  setRunning(true);
  const result = await window.optimizer.start(settings);
  if (!result.ok) {
    addLog(result.error);
    setRunning(false);
  }
});

$("stop").addEventListener("click", async () => {
  await window.optimizer.stop();
  setRunning(false);
  addLog("Stop requested.");
});

window.optimizer.onEvent(handleEvent);
window.optimizer.onLog(addLog);
render();
