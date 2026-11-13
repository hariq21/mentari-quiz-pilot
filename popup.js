const apiKeyInput = document.querySelector("#apiKey");
const delayInput = document.querySelector("#delaySeconds");
const maxMeetingInput = document.querySelector("#maxMeeting");
const autoFinishInput = document.querySelector("#autoFinish");
const stopLowConfidenceInput = document.querySelector("#stopLowConfidence");
const pkkmbRulesInput = document.querySelector("#pkkmbRules");
const statusEl = document.querySelector("#status");
const startButton = document.querySelector("#start");
const pendingButton = document.querySelector("#pending");
const scrapeButton = document.querySelector("#scrape");
const stopButton = document.querySelector("#stop");
const scrapeResultsEl = document.querySelector("#scrapeResults");
const resultCountEl = document.querySelector("#resultCount");
const resultMetaEl = document.querySelector("#resultMeta");
const resultListEl = document.querySelector("#resultList");

loadSettings();
loadScrapeResults();
refreshStatus();
setInterval(refreshStatus, 800);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.scrapeResults) {
    renderScrapeResults(changes.scrapeResults.newValue);
  }
});

startButton.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus("Isi API key DeepSeek terlebih dahulu.", "error");
    apiKeyInput.focus();
    return;
  }

  const config = {
    autoFinish: autoFinishInput.checked,
    delayMs: clamp(Number(delayInput.value) || 3, 1, 30) * 1000,
    delaySeconds: clamp(Number(delayInput.value) || 3, 1, 30),
    stopLowConfidence: stopLowConfidenceInput.checked,
    usePkkmbRules: pkkmbRulesInput.checked
  };

  await chrome.storage.local.set({
    deepseekApiKey: apiKey,
    quizConfig: config,
    runnerStatus: { status: "starting", message: "Menghubungkan ke halaman aktif…", updatedAt: Date.now() }
  });

  const result = await sendToActiveTab({ type: "START", config });
  if (!result?.ok) {
    setStatus(result?.error || "Tidak bisa menghubungkan ke halaman aktif. Refresh halaman lalu coba lagi.", "error");
  }
});

pendingButton.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus("Isi API key DeepSeek terlebih dahulu.", "error");
    apiKeyInput.focus();
    return;
  }

  const maxMeeting = clamp(Number(maxMeetingInput.value) || 21, 1, 60);
  maxMeetingInput.value = maxMeeting;
  const config = {
    autoFinish: true,
    delayMs: clamp(Number(delayInput.value) || 3, 1, 30) * 1000,
    delaySeconds: clamp(Number(delayInput.value) || 3, 1, 30),
    stopLowConfidence: stopLowConfidenceInput.checked,
    usePkkmbRules: pkkmbRulesInput.checked,
    maxMeeting
  };

  await chrome.storage.local.set({
    deepseekApiKey: apiKey,
    quizConfig: { ...(await chrome.storage.local.get("quizConfig")).quizConfig, ...config },
    runnerStatus: { status: "starting", message: "Menyiapkan Pretest/Posttest…", updatedAt: Date.now() }
  });

  const result = await sendToActiveTab({ type: "RUN_PENDING", config });
  if (!result?.ok) {
    setStatus(result?.error || "Tidak bisa memulai di tab aktif. Refresh halaman lalu coba lagi.", "error");
  }
});

scrapeButton.addEventListener("click", async () => {
  const maxMeeting = clamp(Number(maxMeetingInput.value) || 21, 1, 60);
  maxMeetingInput.value = maxMeeting;
  await chrome.storage.local.set({
    quizConfig: { ...(await chrome.storage.local.get("quizConfig")).quizConfig, maxMeeting },
    scrapeResults: null,
    runnerStatus: { status: "starting", message: "Menyiapkan scrape tugas Mentari…", updatedAt: Date.now() }
  });

  const result = await sendToActiveTab({ type: "SCRAPE_TASKS", config: { maxMeeting } });
  if (!result?.ok) setStatus(result?.error || "Tidak bisa memulai scrape di tab aktif.", "error");
});

stopButton.addEventListener("click", async () => {
  const result = await sendToActiveTab({ type: "STOP" });
  if (!result?.ok) setStatus(result?.error || "Extension tidak aktif di tab ini.", "error");
});

async function loadSettings() {
  const saved = await chrome.storage.local.get(["deepseekApiKey", "quizConfig"]);
  apiKeyInput.value = saved.deepseekApiKey || "";
  const savedSeconds = saved.quizConfig?.delaySeconds;
  const legacySeconds = Number(saved.quizConfig?.delayMs || 3000) / 1000;
  delayInput.value = savedSeconds ?? Math.max(1, Math.min(30, Math.round(legacySeconds)));
  maxMeetingInput.value = clamp(Number(saved.quizConfig?.maxMeeting) || 21, 1, 60);
  autoFinishInput.checked = Boolean(saved.quizConfig?.autoFinish);
  stopLowConfidenceInput.checked = Boolean(saved.quizConfig?.stopLowConfidence);
  pkkmbRulesInput.checked = saved.quizConfig?.usePkkmbRules !== false;
}

async function refreshStatus() {
  const saved = await chrome.storage.local.get("runnerStatus");
  const status = saved.runnerStatus;
  if (!status) return;

  const tone = ["running", "thinking", "answering", "moving", "finishing", "starting"].includes(status.status)
    ? "active"
    : ["done", "ready"].includes(status.status) ? "success" : ["error", "review"].includes(status.status) ? "error" : "neutral";
  setStatus(status.message || "Siap.", tone);
}

async function loadScrapeResults() {
  const saved = await chrome.storage.local.get("scrapeResults");
  renderScrapeResults(saved.scrapeResults);
}

function renderScrapeResults(result) {
  if (!result) {
    scrapeResultsEl.hidden = true;
    return;
  }

  scrapeResultsEl.hidden = false;
  resultCountEl.textContent = String(result.totalPending || 0);
  resultMetaEl.textContent = result.scrapedAt
    ? `Sampai pertemuan ${result.maxMeeting} · ${new Date(result.scrapedAt).toLocaleString("id-ID")}`
    : `Sampai pertemuan ${result.maxMeeting || "—"}`;
  resultListEl.replaceChildren();

  if (!result.totalPending) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent = `Sampai pertemuan ${result.maxMeeting}, tidak ada aktivitas yang belum dikerjakan.`;
    resultListEl.append(empty);
    return;
  }

  for (const course of result.courses || []) {
    const courseSection = document.createElement("section");
    courseSection.className = "result-course";
    const courseTitle = document.createElement("h3");
    courseTitle.textContent = course.name;
    courseSection.append(courseTitle);

    for (const meeting of course.meetings || []) {
      const week = document.createElement("div");
      week.className = "result-week";
      const weekTitle = document.createElement("strong");
      weekTitle.className = "week-label";
      weekTitle.textContent = `Pekan ${meeting.number}`;
      const activityList = document.createElement("ul");
      for (const activity of meeting.activities || []) {
        const item = document.createElement("li");
        item.textContent = activity.type;
        activityList.append(item);
      }
      week.append(weekTitle, activityList);
      courseSection.append(week);
    }

    resultListEl.append(courseSection);
  }
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    return { ok: false, error: "Buka halaman kuis Mentari di tab aktif." };
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    try {
      // Tab yang sudah terbuka sebelum extension di-Reload belum tentu mendapat content script.
      // Inject otomatis agar pengguna tidak perlu refresh halaman.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      return { ok: false, error: "Tidak bisa terhubung ke halaman aktif. Pastikan ini halaman web biasa, bukan tab Chrome internal." };
    }
  }
}

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
