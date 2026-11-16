(() => {
if (globalThis.__MENTARI_QUIZ_PILOT_LOADED__) return;
globalThis.__MENTARI_QUIZ_PILOT_LOADED__ = true;

const runner = {
  running: false,
  processing: false,
  runId: 0,
  config: {
    autoFinish: false,
    delayMs: 3000,
    stopLowConfidence: false,
    usePkkmbRules: true,
    maxMeeting: 21
  }
};

const ACTIVITY_KINDS = [
  { name: "Pretest", pattern: /\bpre\s*test\b/i },
  { name: "Posttest", pattern: /\bpost\s*test\b/i },
  { name: "Kuesioner", pattern: /\bkuesioner\b/i },
  { name: "Forum", pattern: /\bforum\b/i },
  { name: "Tugas", pattern: /\btugas\b|\bassignment\b|\bpenugasan\b/i }
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SCRAPE_TASKS") {
    if (runner.running || runner.processing) {
      sendResponse({ ok: false, error: "Automasi lain sedang berjalan. Tekan Stop dulu." });
      return false;
    }
    runner.running = true;
    runner.runId += 1;
    const runId = runner.runId;
    const maxMeeting = clamp(Number(message.config?.maxMeeting) || 21, 1, 60);
    scrapeMentariTasks(runId, maxMeeting).catch((error) => {
      if (runId !== runner.runId) return;
      runner.running = false;
      setStatus("error", error instanceof Error ? error.message : String(error));
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "START") {
    runner.running = true;
    runner.runId += 1;
    runner.config = {
      autoFinish: Boolean(message.config?.autoFinish),
      delayMs: clamp(Number(message.config?.delayMs) || 3000, 1000, 30000),
      stopLowConfidence: Boolean(message.config?.stopLowConfidence),
      usePkkmbRules: message.config?.usePkkmbRules !== false
    };
    setStatus("running", "Membaca soal pertama…");
    if (!runner.processing) runQuiz(runner.runId);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "RUN_PENDING") {
    if (runner.running || runner.processing) {
      sendResponse({ ok: false, error: "Automasi lain sedang berjalan. Tekan Stop dulu." });
      return false;
    }
    const config = {
      autoFinish: true,
      delayMs: clamp(Number(message.config?.delayMs) || 3000, 1000, 30000),
      stopLowConfidence: Boolean(message.config?.stopLowConfidence),
      usePkkmbRules: message.config?.usePkkmbRules !== false,
      maxMeeting: clamp(Number(message.config?.maxMeeting) || 21, 1, 60)
    };
    const onCourseList = getCourseCards().length > 0 && getLessonElements().length === 0;
    const initialCards = getCourseCards();
    const courseNames = initialCards.length ? initialCards.map((card) => card.name) : [];
    let homeUrl = onCourseList ? location.href : "";
    if (!homeUrl) {
      const dashboardLink = findDashboardButton()?.closest("a")?.href;
      if (dashboardLink) homeUrl = dashboardLink;
    }

    runner.running = true;
    runner.runId += 1;
    const runId = runner.runId;
    runner.config = config;

    chrome.storage.local.set({
      pendingJob: {
        active: true,
        origin: location.origin,
        config,
        courseNames,
        courseIndex: 0,
        done: [],
        phase: "scan",
        current: "",
        homeUrl,
        startedAt: Date.now(),
        updatedAt: Date.now()
      }
    }).then(() => runPendingQuizzes(runId)).catch((error) => {
      if (runId !== runner.runId) return;
      runner.running = false;
      setStatus("error", error instanceof Error ? error.message : String(error));
    });

    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "STOP") {
    runner.running = false;
    runner.runId += 1;
    runner.processing = false;
    deactivateJob();
    chrome.runtime.sendMessage({ type: "CANCEL_DEEPSEEK" }).catch(() => {});
    setStatus("stopped", "Dihentikan oleh pengguna.");
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "GET_STATUS") {
    sendResponse({
      ok: true,
      running: runner.running,
      processing: runner.processing
    });
    return false;
  }

  if (message?.type === "RESUME_PENDING") {
    resumePendingJob().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function scrapeMentariTasks(runId, maxMeeting) {
  runner.processing = true;
  const result = {
    source: location.origin,
    scrapedAt: new Date().toISOString(),
    maxMeeting,
    courseCount: 0,
    courses: []
  };

  try {
    let courseCards = getCourseCards();
    if (courseCards.length === 0 && !getLessonElements().length) {
      throw new Error("Kartu matkul tidak ditemukan. Mulai dari dashboard Mentari setelah login.");
    }

    if (courseCards.length === 0) {
      const course = scrapeCurrentCourse(runId, maxMeeting);
      result.courses.push(await course);
      result.courseCount = 1;
    } else {
      const courseNames = courseCards.map((card) => card.name);
      result.courseCount = courseNames.length;
      for (let index = 0; index < courseNames.length; index += 1) {
        if (!runner.running || runId !== runner.runId) break;
        courseCards = getCourseCards();
        const card = courseCards.find((candidate) => candidate.name === courseNames[index]);
        if (!card) continue;

        setStatus("running", `Membuka matkul ${index + 1}/${courseNames.length}: ${card.name}`);
        card.element.click();
        await waitForPage(runId, () => getLessonElements().length > 0, 15000);
        result.courses.push(await scrapeCurrentCourse(runId, maxMeeting, card.name));

        if (!runner.running || runId !== runner.runId) break;
        const dashboardButton = findDashboardButton();
        if (!dashboardButton) {
          throw new Error(`Tombol Dashboard tidak ditemukan setelah scrape ${card.name}.`);
        }
        dashboardButton.click();
        await waitForPage(runId, () => getLessonElements().length === 0 && getCourseCards().length > 0, 15000);
      }
    }

    if (!runner.running || runId !== runner.runId) return;
    const pendingResult = buildPendingResult(result);
    await chrome.storage.local.set({ scrapeResults: pendingResult });
    runner.running = false;
    setStatus("done", `Selesai. Ada ${pendingResult.totalPending} aktivitas belum dikerjakan dari ${result.courseCount} matkul.`);
  } finally {
    if (runId === runner.runId) runner.processing = false;
  }
}

function getCourseCards() {
  const courseDrawer = [...document.querySelectorAll(".MuiDrawer-root")]
    .find((drawer) => [...drawer.querySelectorAll(".MuiListSubheader-root")]
      .some((header) => cleanText(header.innerText).toLowerCase() === "courses list"));

  if (courseDrawer) {
    const courses = [...courseDrawer.querySelectorAll(".MuiListItemButton-root")]
      .filter((element) => isVisible(element) && element.querySelector(".MuiListItemText-multiline"))
      .map((element) => ({
        element,
        name: cleanText(element.querySelector(".MuiListItemText-primary")?.innerText || "")
      }))
      .filter((item) => item.name);
    if (courses.length) return courses;
  }

  return [...document.querySelectorAll(".card")]
    .filter(isVisible)
    .map((element) => ({
      element,
      name: cleanText((element.querySelector("p")?.innerText || element.innerText).split("\n")[0])
    }))
    .filter((item) => item.name && !/^course index$/i.test(item.name));
}

function findDashboardButton() {
  return [...document.querySelectorAll("button, a, [role=button]")]
    .filter(isVisible)
    .find((element) => cleanText(element.innerText || element.textContent).toLowerCase() === "dashboard" && element.closest("nav"));
}

function getLessonElements() {
  return [...document.querySelectorAll('#main_outlet [id^="PERTEMUAN_"]')]
    .filter((element) => {
      if (!/^PERTEMUAN_\d+$/.test(element.id)) return false;
      const title = cleanText(element.querySelector(":scope > .op-accordion-summary")?.innerText || "");
      return /^Pertemuan\s+\d+/i.test(title);
    });
}

async function scrapeCurrentCourse(runId, maxMeeting, selectedCourseName = "") {
  const courseName = cleanText(
    selectedCourseName ||
    document.querySelector("#main_outlet h6.MuiTypography-subtitle1")?.innerText ||
    document.querySelector("#main_outlet")?.innerText?.split("\n")[0] || "Matkul tidak diketahui"
  );
  const lessons = getLessonElements()
    .map((element) => ({ element, number: Number(element.id.match(/\d+$/)?.[0]) }))
    .filter((lesson) => lesson.number > 0 && lesson.number <= maxMeeting)
    .sort((a, b) => a.number - b.number);
  const course = { name: courseName, url: location.href, meetings: [] };

  for (let index = 0; index < lessons.length; index += 1) {
    if (!runner.running || runId !== runner.runId) break;
    const { element, number } = lessons[index];
    setStatus("running", `${courseName}: membaca pertemuan ${number}/${maxMeeting}`);
    const meeting = document.querySelector(`#${CSS.escape(element.id)}`) || element;
    let detail = meeting.querySelector(":scope > .op-accordion-detail");
    let summary = meeting.querySelector(":scope > .op-accordion-summary");
    if (!detail) continue;

    const wasExpanded = isAccordionExpanded(summary, detail);
    if (!wasExpanded || !isMeetingReady(detail)) {
      if (!wasExpanded) summary?.click();
      detail = await waitForMeetingDetail(runId, element);
      summary = document.querySelector(`#${CSS.escape(element.id)} > .op-accordion-summary`) || summary;
    }

    course.meetings.push({
      number,
      title: cleanText(meeting.querySelector(".op-accordion-summary")?.innerText || `Pertemuan ${number}`),
      activities: extractActivities(detail)
    });

    if (isAccordionExpanded(summary, detail)) {
      summary?.click();
      await wait(400);
    }
  }

  return course;
}

function extractActivities(detail) {
  const kinds = ACTIVITY_KINDS;

  const activityCards = getMeetingCards(detail);
  const cardActivities = activityCards.flatMap((card) => {
    const headings = [...card.querySelectorAll("h1,h2,h3,h4,h5,h6,p")]
      .map((element) => cleanText(element.innerText || element.textContent));
    const label = headings.find((text) => text && text.length < 80 && kinds.some((kind) => kind.pattern.test(text)));
    if (!label) return [];

    const kind = kinds.find((candidate) => candidate.pattern.test(label));
    const content = cleanText(card.innerText || card.textContent);
    const unavailable = isUnavailableActivityText(content);
    const completed = Boolean(card.querySelector(
      'svg[data-testid="CheckCircleIcon"], svg.MuiSvgIcon-colorSuccess'
    ));
    const status = completed ? "completed" : unavailable ? "unavailable" : "pending";
    const unavailableText = card.querySelector('[role="alert"]')?.innerText;

    return [{
      type: kind.name,
      title: status === "unavailable" ? cleanText(unavailableText || label) : label,
      status,
      completed
    }];
  });
  if (cardActivities.length) return cardActivities;

  const candidates = [];
  const walker = document.createTreeWalker(detail, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    const text = cleanText(textNode.nodeValue);
    if (!text) continue;
    for (const kind of kinds) {
      if (kind.pattern.test(text) && textNode.parentElement) {
        candidates.push({ kind, element: textNode.parentElement });
      }
    }
  }

  return kinds.flatMap((kind) => {
    const labels = candidates
      .filter((candidate) => candidate.kind === kind)
      .map((candidate) => candidate.element);
    const seen = new Set();
    return labels.map((label) => {
      let node = label;
      let row = label;
      let status = "pending";

      while (node && node !== detail) {
        const text = cleanText(node.innerText || node.textContent);
        const containsOtherKind = kinds.some((other) => other.name !== kind.name && other.pattern.test(text));
        if (kind.pattern.test(text) && !containsOtherKind) {
          row = node;
          const hasSuccess = Boolean(node.querySelector(
            'svg[data-testid="CheckCircleIcon"], svg.MuiSvgIcon-colorSuccess'
          ));
          if (hasSuccess) {
            status = "completed";
            break;
          }

          const unavailable = isUnavailableActivityText(text);
          if (unavailable) {
            status = "unavailable";
            break;
          }
        }

        const parent = node.parentElement;
        if (!parent || parent === detail) break;
        node = parent;
      }

      const text = cleanText(row.innerText || row.textContent);
      const key = text.toLowerCase();
      if (seen.has(key)) return null;
      seen.add(key);
      return { type: kind.name, title: text.slice(0, 240), status, completed: status === "completed" };
    }).filter(Boolean);
  });
}

async function waitForPage(runId, predicate, timeoutMs, throwOnTimeout = true) {
  const deadline = Date.now() + timeoutMs;
  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    if (predicate()) return true;
    await wait(200);
  }
  if (!runner.running || runId !== runner.runId) return false;
  if (throwOnTimeout) throw new Error("Halaman Mentari tidak berubah sesuai yang diharapkan. Scrape dihentikan.");
  return false;
}

function buildPendingResult(result) {
  let totalPending = 0;
  const courses = result.courses.flatMap((course) => {
    const meetings = course.meetings.flatMap((meeting) => {
      const forumPending = meeting.activities.some((activity) => {
        return activity.type === "Forum" && activity.status === "pending";
      });
      const activities = meeting.activities.filter((activity) => {
        if (activity.status !== "pending") return false;
        return !(activity.type === "Posttest" && forumPending);
      });
      if (!activities.length) return [];
      totalPending += activities.length;
      return [{ number: meeting.number, activities }];
    });
    return meetings.length ? [{ name: course.name, meetings }] : [];
  });

  return {
    scrapedAt: result.scrapedAt,
    maxMeeting: result.maxMeeting,
    courseCount: result.courseCount,
    totalPending,
    courses
  };
}

async function runQuiz(runId, options = {}) {
  const keepRunning = Boolean(options.keepRunning);
  if (!keepRunning) runner.processing = true;

  try {
    let previousSignature = "";

    await ensureQuizStarted(runId);

    while (runner.running && runId === runner.runId) {
      const snapshot = await waitForQuestion(runId, previousSignature);
      if (!snapshot) break;

      previousSignature = snapshot.signature;
      setStatus("thinking", `Soal ${snapshot.number || "aktif"}: mengirim ${snapshot.options.length} pilihan ke AI…`);

      const answerResponse = await askDeepSeek(snapshot);
      if (!answerResponse.ok) throw new Error(answerResponse.error);

      const answer = parseAnswer(answerResponse.content, snapshot.options);
      if (!answer) {
        throw new Error("Jawaban DeepSeek tidak cocok dengan pilihan yang tersedia.");
      }

      if (runner.config.stopLowConfidence && Number.isFinite(answer.confidence) && answer.confidence < 0.65) {
        runner.running = false;
        showReviewNotice(snapshot, answer);
        setStatus("review", `Soal ${snapshot.number || "aktif"} dihentikan: confidence di bawah 65%.`);
        break;
      }

      setStatus("answering", `Memilih opsi ${answer.letter}…`);
      await clickOption(answer.option);
      showAnswerNotice(snapshot, answer);
      setStatus("answering", `Soal ${snapshot.number || "aktif"}: opsi ${answer.letter} dipilih.`);
      await wait(runner.config.delayMs);

      const navigation = getNavigationButtons();
      const nextButton = navigation.next;

      if (nextButton && !nextButton.disabled) {
        setStatus("moving", "Lanjut ke soal berikutnya…");
        nextButton.click();
        await waitForQuestion(runId, snapshot.signature, true);
        continue;
      }

      if (navigation.finish) {
        if (!runner.config.autoFinish) {
          runner.running = false;
          setStatus("ready", "Soal terakhir terjawab. Klik “Selesai Quiz” secara manual.");
          break;
        }

        if (runner.running && runId === runner.runId) {
          navigation.finish.click();
          setStatus("finishing", "Menunggu konfirmasi Selesai Quiz…");
          const finishDialog = await waitForYesDialog(runId);
          if (!finishDialog) {
            throw new Error("Popup konfirmasi Selesai Quiz tidak ditemukan.");
          }

          const finishYesButton = findYesButton(finishDialog);
          if (!finishYesButton) {
            throw new Error("Tombol Ya pada konfirmasi Selesai Quiz tidak ditemukan.");
          }

          finishYesButton.click();
          setStatus("finishing", "Menunggu 5 detik setelah konfirmasi…");
          await wait(5000);

          const validationAlert = [...document.querySelectorAll('[role="alert"], .MuiAlert-message')]
            .map((element) => cleanText(element.innerText || element.textContent))
            .find((text) => text && /masih ada|belum dijawab|wajib dijawab|harus dijawab|belum lengkap/i.test(text));
          if (validationAlert) throw new Error(`Selesai Quiz gagal dikonfirmasi: ${validationAlert}`);

          if (keepRunning) return { completed: true };
          runner.running = false;
          setStatus("done", "Quiz selesai dikirim.");
        }
        break;
      }

      throw new Error("Tombol Next atau Selesai Quiz tidak ditemukan.");
    }
  } catch (error) {
    if (keepRunning) throw error;
    if (runId !== runner.runId || !runner.running) return;
    runner.running = false;
    setStatus("error", error instanceof Error ? error.message : String(error));
  } finally {
    if (!keepRunning && runId === runner.runId) runner.processing = false;
  }
}

async function runPendingQuizzes(runId) {
  runner.processing = true;

  try {
    let job = await loadJob();
    if (!job?.active) {
      runner.running = false;
      return;
    }
    runner.config = { ...runner.config, ...job.config };

    if (job.phase === "taking") {
      const startButton = findVisibleButton((text) => text === "mulai quiz");
      const snapshot = getQuizSnapshot();
      const navigation = snapshot ? getNavigationButtons() : { next: null, finish: null };
      const hasQuizNav = Boolean(navigation.next || navigation.finish);
      const alreadySubmitted = Boolean(snapshot && snapshot.options.length && snapshot.options.every((option) => option.input.disabled));
      const inQuiz = (snapshot && hasQuizNav && !alreadySubmitted) || startButton;
      if (inQuiz) {
        setStatus("running", "Melanjutkan quiz yang belum selesai…");
        await runQuiz(runId, { keepRunning: true });
        if (!runner.running || runId !== runner.runId) return;
      }
      if (job.current && !job.done.includes(job.current)) job.done.push(job.current);
      job.phase = "scan";
      job.current = "";
      job.updatedAt = Date.now();
      await saveJob(job);
    }

    while (runner.running && runId === runner.runId) {
      await ensureCourseList(runId, job);
      job = await loadJob();
      if (!job?.active) {
        runner.running = false;
        return;
      }

      const cards = getCourseCards();
      if (cards.length) {
        const names = cards.map((card) => card.name);
        if (JSON.stringify(names) !== JSON.stringify(job.courseNames) || !job.homeUrl || job.navAttempts) {
          job.courseNames = names;
          job.homeUrl = location.href;
          job.navAttempts = 0;
          await saveJob(job);
        }
      }

      if (!job.courseNames.length) {
        throw new Error("Daftar matkul tidak ditemukan di halaman dashboard Mentari.");
      }
      if (job.courseIndex >= job.courseNames.length) {
        if (job.blocked && job.done.length !== job.retryStart) {
          job.blocked = false;
          job.retryStart = job.done.length;
          job.courseIndex = 0;
          await saveJob(job);
          continue;
        }
        break;
      }

      const courseName = job.courseNames[job.courseIndex];
      const courseLabel = courseName || "Matkul aktif";

      setStatus("running", `Membuka matkul ${job.courseIndex + 1}/${job.courseNames.length}: ${courseLabel}`);
      if (!(await openCourse(runId, courseName))) {
        job.courseIndex += 1;
        await saveJob(job);
        continue;
      }

      const target = await findNextPendingQuiz(runId, runner.config.maxMeeting, new Set(job.done), courseName);
      if (!target) {
        job.courseIndex += 1;
        await saveJob(job);
        continue;
      }
      if (target.blocked) {
        job.blocked = true;
        job.courseIndex += 1;
        await saveJob(job);
        continue;
      }

      const signature = `${courseName}|${target.number}|${target.type}`;
      job.phase = "taking";
      job.current = signature;
      job.updatedAt = Date.now();
      await saveJob(job);
      setStatus("running", `${courseLabel}: mengerjakan ${target.type} pekan ${target.number}`);
      const started = await clickKerjakanQuiz(runId, target.quizButton);
      if (!started) {
        await deactivateJob();
        runner.running = false;
        setStatus("error", `Tombol “Kerjakan Quiz” untuk ${target.type} pekan ${target.number} tidak muncul.`);
        return;
      }

      if (!(await waitForQuizReady(runId))) {
        setStatus("running", `${courseLabel}: ${target.type} pekan ${target.number} dilewati (quiz tidak terbuka).`);
        job.done.push(signature);
        job.phase = "scan";
        job.current = "";
        await saveJob(job);
        await ensureCourseList(runId, job);
        continue;
      }

      await runQuiz(runId, { keepRunning: true });
      if (!runner.running || runId !== runner.runId) return;

      job.done.push(signature);
      job.phase = "scan";
      job.current = "";
      job.updatedAt = Date.now();
      await saveJob(job);

      setStatus("moving", `${courseLabel}: ${target.type} pekan ${target.number} selesai, balik ke daftar pertemuan untuk lanjut…`);
      await ensureCourseList(runId, job);
      job = (await loadJob()) || job;
      if (!job.active) {
        runner.running = false;
        return;
      }
      if (!(await openCourse(runId, courseName))) job.courseIndex += 1;
      await saveJob(job);
    }

    job.active = false;
    job.updatedAt = Date.now();
    await saveJob(job);
    runner.running = false;
    setStatus("done", "Selesai mengerjakan Pretest/Posttest yang belum dikerjakan.");
  } catch (error) {
    if (runId !== runner.runId) return;
    await deactivateJob();
    runner.running = false;
    setStatus("error", error instanceof Error ? error.message : String(error));
  } finally {
    if (runId === runner.runId) runner.processing = false;
  }
}

async function ensureCourseList(runId, job) {
  if (getCourseCards().length && !getLessonElements().length) return;

  const dashboardButton = findDashboardButton();
  if (dashboardButton) {
    setStatus("moving", "Kembali ke daftar matkul…");
    dashboardButton.click();
    const reached = await waitForPage(runId, () => getCourseCards().length > 0 && getLessonElements().length === 0, 15000, false);
    if (reached) return;
  }

  if (job.homeUrl && location.href === job.homeUrl) {
    const reached = await waitForPage(runId, () => getCourseCards().length > 0 && getLessonElements().length === 0, 12000, false);
    if (reached) return;
    throw new Error("Halaman daftar matkul tidak muncul. Buka dashboard lalu jalankan ulang.");
  }

  if (job.homeUrl) {
    await waitForDomSettle(runId);
    const fresh = (await loadJob()) || job;
    fresh.navAttempts = (fresh.navAttempts || 0) + 1;
    await saveJob(fresh);
    if (fresh.navAttempts > 2) {
      throw new Error("Gagal kembali ke daftar matkul Mentari. Buka dashboard lalu jalankan ulang.");
    }
    setStatus("moving", "Kembali ke daftar matkul…");
    location.href = job.homeUrl;
    return;
  }

  if (history.length > 1) {
    history.back();
    await wait(1500);
    if (getCourseCards().length) return;
  }

  throw new Error("Tidak bisa kembali ke daftar matkul Mentari. Buka dashboard lalu jalankan ulang.");
}

async function waitForDomSettle(runId, stableMs = 2000, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stableSince = Date.now();

  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    const current = `${location.href}|${document.querySelectorAll("button").length}|${(document.body?.innerText || "").length}`;
    if (current !== last) {
      last = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return true;
    }
    await wait(400);
  }

  return true;
}

async function saveJob(job) {
  await chrome.storage.local.set({ pendingJob: job });
}

async function loadJob() {
  const { pendingJob } = await chrome.storage.local.get("pendingJob");
  return pendingJob || null;
}

async function deactivateJob() {
  const job = await loadJob();
  if (!job) return;
  job.active = false;
  job.updatedAt = Date.now();
  await chrome.storage.local.set({ pendingJob: job });
}


function getSortedLessons(maxMeeting) {
  return getLessonElements()
    .map((element) => ({ element, number: Number(element.id.match(/\d+$/)?.[0]) }))
    .filter((lesson) => lesson.number > 0 && lesson.number <= maxMeeting)
    .sort((a, b) => a.number - b.number);
}

function getCurrentCourseName() {
  return cleanText(
    document.querySelector("#main_outlet h6.MuiTypography-subtitle1")?.innerText ||
    document.querySelector("#main_outlet")?.innerText?.split("\n")[0] || ""
  );
}

async function openCourse(runId, name) {
  if (getLessonElements().length) {
    const current = getCurrentCourseName();
    if (!name || current === name) return true;
    const dashboardButton = findDashboardButton();
    if (dashboardButton) {
      dashboardButton.click();
      await waitForPage(runId, () => getLessonElements().length === 0 && getCourseCards().length > 0, 15000, false);
    }
  }

  const card = getCourseCards().find((candidate) => candidate.name === name);
  if (!card) return getLessonElements().length > 0 && (!name || getCurrentCourseName() === name);

  card.element.click();
  return waitForPage(runId, () => getLessonElements().length > 0, 15000, false);
}

async function ensureMeetingOpen(runId, element) {
  const meeting = document.querySelector(`#${CSS.escape(element.id)}`) || element;
  const detail = meeting.querySelector(":scope > .op-accordion-detail");
  const summary = meeting.querySelector(":scope > .op-accordion-summary");
  if (!detail || !summary) return detail;
  if (isAccordionExpanded(summary, detail) && isMeetingReady(detail)) return detail;

  if (!isAccordionExpanded(summary, detail)) summary.click();
  return waitForMeetingDetail(runId, element);
}

function getMeetingCards(detail) {
  if (!detail) return [];
  return [...detail.querySelectorAll('.MuiPaper-root[id^="PERTEMUAN_"]')];
}

function isMeetingLoading(detail) {
  if (!detail) return true;
  if (detail.getAttribute("aria-busy") === "true") return true;
  if (detail.querySelector(
    '[aria-busy="true"], .MuiSkeleton-root'
  )) return true;

  const text = cleanText(detail.innerText || detail.textContent).toLowerCase();
  return text.length > 0 && text.length < 40 &&
    /^(memuat|loading|mohon tunggu|harap tunggu|sedang memuat)\b/.test(text);
}

function isMeetingReady(detail) {
  if (!detail || isMeetingLoading(detail)) return false;
  return getMeetingCards(detail).some((card) => cleanText(card.innerText || card.textContent).length > 0);
}

function isAccordionExpanded(summary, detail) {
  const aria = summary?.getAttribute("aria-expanded");
  if (aria === "true") return true;
  if (aria === "false") return false;
  if (!detail) return false;
  return detail.getBoundingClientRect().height > 8;
}

async function waitForMeetingDetail(runId, element) {
  await wait(1600);

  let detail = getMeetingDetail(element);
  if (hasMeetingContent(detail) && !isMeetingLoading(detail)) return detail;

  const deadline = Date.now() + 1500;
  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    await wait(300);
    detail = getMeetingDetail(element);
    if (hasMeetingContent(detail) && !isMeetingLoading(detail)) return detail;
  }

  return detail;
}

function getMeetingDetail(element) {
  return document.querySelector(`#${CSS.escape(element.id)} > .op-accordion-detail`);
}

function hasMeetingContent(detail) {
  if (!detail) return false;
  return getMeetingCards(detail).length > 0 || cleanText(detail.innerText || detail.textContent).length > 0;
}

async function findNextPendingQuiz(runId, maxMeeting, processed, courseName) {
  const lessons = getSortedLessons(maxMeeting);
  let blocked = false;

  for (const { element, number } of lessons) {
    if (!runner.running || runId !== runner.runId) return null;
    setStatus("running", `${courseName}: memeriksa pertemuan ${number}/${maxMeeting}`);
    const detail = await ensureMeetingOpen(runId, element);
    if (!detail) continue;

    const cards = getMeetingCards(detail);
    const forumPending = hasPendingForum(cards);
    for (const card of cards) {
      const type = detectActivityType(card);
      if (type !== "Pretest" && type !== "Posttest") continue;
      if (isActivityCompleted(card) || isActivityUnavailable(card)) continue;
      if (type === "Posttest" && forumPending) {
        blocked = true;
        continue;
      }
      if (processed.has(`${courseName}|${number}|${type}`)) continue;

      await ensureActivityOpen(runId, card);
      const quizButton = findActivityQuizButton(card);
      if (!quizButton) continue;
      return { number, type, card, quizButton };
    }
  }

  return blocked ? { blocked: true } : null;
}

function hasPendingForum(cards) {
  return cards.some((card) => {
    return detectActivityType(card) === "Forum" &&
      !isActivityCompleted(card) &&
      !isActivityUnavailable(card);
  });
}

function detectActivityType(card) {
  const headings = [...card.querySelectorAll("h1,h2,h3,h4,h5,h6,p")]
    .map((element) => cleanText(element.innerText || element.textContent))
    .filter(Boolean);
  const label = headings.find((text) => text.length < 80 && ACTIVITY_KINDS.some((kind) => kind.pattern.test(text)));
  return ACTIVITY_KINDS.find((kind) => kind.pattern.test(label || ""))?.name || "";
}

function isUnavailableActivityText(value) {
  const text = cleanText(value);
  return /no\s+content/i.test(text) ||
    /soal\s+(?:forum(?:\s+diskusi)?|post\s*test|pre\s*test|kuesioner|tugas)\s+belum\s+tersedia/i.test(text);
}

function isActivityCompleted(card) {
  return Boolean(card.querySelector('svg[data-testid="CheckCircleIcon"], svg.MuiSvgIcon-colorSuccess'));
}

function isActivityUnavailable(card) {
  return isUnavailableActivityText(card.innerText || card.textContent);
}

async function ensureActivityOpen(runId, card) {
  if (findActivityQuizButton(card)) return true;

  const toggle = card.querySelector(".MuiAccordionSummary-root, .MuiListItemButton-root, [aria-expanded]");
  if (!toggle) return false;
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();

  const deadline = Date.now() + 3000;
  let retried = false;
  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    if (findActivityQuizButton(card)) return true;
    if (!retried && toggle.getAttribute("aria-expanded") === "false") {
      toggle.click();
      retried = true;
    }
    await wait(300);
  }

  return Boolean(findActivityQuizButton(card));
}

function findActivityQuizButton(card) {
  const scopes = [card];
  const parent = card.parentElement;
  if (parent && !parent.classList.contains("op-accordion-detail")) scopes.push(parent);
  for (const scope of scopes) {
    const button = [...scope.querySelectorAll("button")]
      .filter(isVisible)
      .find((candidate) => /^quiz$/i.test(cleanText(candidate.innerText || candidate.textContent)));
    if (button) return button;
  }
  return null;
}

async function waitForQuizReady(runId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    if (getQuizSnapshot() || findVisibleButton((text) => text === "mulai quiz")) return true;
    await wait(250);
  }
  return false;
}

async function clickKerjakanQuiz(runId, quizButton) {
  quizButton.scrollIntoView({ behavior: "smooth", block: "center" });
  quizButton.click();

  const deadline = Date.now() + 12000;
  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    const button = [...document.querySelectorAll("button")]
      .filter(isVisible)
      .find((candidate) => /^kerjakan\s+quiz$/i.test(cleanText(candidate.innerText || candidate.textContent)));
    if (button) {
      setStatus("starting", "Menekan Kerjakan Quiz…");
      button.click();
      await wait(400);
      return true;
    }
    await wait(250);
  }

  return false;
}

async function ensureQuizStarted(runId) {
  if (getQuizSnapshot()) return;

  const startButton = findVisibleButton((text) => text === "mulai quiz");
  if (!startButton) return;

  setStatus("starting", "Menekan Mulai Quiz…");
  startButton.click();

  const dialog = await waitForConfirmationDialog(runId);
  if (!dialog) {
    if (getQuizSnapshot()) return;
    throw new Error("Dialog konfirmasi Mulai Quiz tidak ditemukan.");
  }

  const yesButton = findYesButton(dialog);

  if (!yesButton) throw new Error("Tombol Ya pada konfirmasi Mulai Quiz tidak ditemukan.");

  setStatus("starting", "Konfirmasi diterima, menunggu soal…");
  yesButton.click();
  await wait(300);
}

async function waitForConfirmationDialog(runId) {
  const deadline = Date.now() + 8000;

  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    const dialog = [...document.querySelectorAll('[role="dialog"], #GLOBAL-SWAL')]
      .find((element) => {
        if (!isVisible(element)) return false;
        const text = cleanText(element.innerText || element.textContent).toLowerCase();
        return text.includes("apakah anda yakin ingin memulai quiz ini");
      });

    if (dialog) return dialog;
    await wait(200);
  }

  if (!runner.running || runId !== runner.runId) return null;
  return null;
}

async function waitForYesDialog(runId) {
  const deadline = Date.now() + 10000;
  let fallback = null;

  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    const dialogs = [...document.querySelectorAll('[role="dialog"], #GLOBAL-SWAL')]
      .filter((element) => isVisible(element) && findYesButton(element));

    for (const dialog of dialogs) {
      const text = cleanText(dialog.innerText || dialog.textContent).toLowerCase();
      if (text.includes("memulai quiz")) continue;
      if (!fallback) fallback = dialog;
      if (/selesai|menyelesaikan|mengakhiri|akhiri|selesaikan|kirim|submit/.test(text)) return dialog;
    }

    if (fallback && Date.now() > deadline - 7000) return fallback;
    await wait(200);
  }

  return fallback;
}

async function askDeepSeek(snapshot) {
  return chrome.runtime.sendMessage({
    type: "ASK_DEEPSEEK",
    question: snapshot.question,
    options: snapshot.options.map(({ letter, text }) => ({ letter, text })),
    usePkkmbRules: runner.config.usePkkmbRules
  });
}

function getQuizSnapshot() {
  const card = findQuizCard();
  if (!card) return null;

  const questionBlock = [...card.querySelectorAll(".ck-content")]
    .find((element) => !element.closest("label") && isVisible(element));
  const questionElement = questionBlock?.querySelector("h1, h2, h3, h4, h5, h6, p") || questionBlock;
  const question = cleanText(questionElement?.innerText || questionElement?.textContent);
  const labels = [...card.querySelectorAll("label")]
    .filter((label) => label.querySelector('input[type="radio"], input[type="checkbox"]'));

  const options = labels.map((label, index) => {
    const input = label.querySelector('input[type="radio"], input[type="checkbox"]');
    const labelText = cleanText(
      label.querySelector(".MuiFormControlLabel-label")?.innerText || label.innerText
    );
    const match = labelText.match(/^([A-Z])\.?\s*(.*)$/s);

    return {
      letter: match?.[1] || String.fromCharCode(65 + index),
      text: cleanText(match?.[2] || labelText),
      label,
      input
    };
  });

  if (!question || options.length === 0) return null;

  const number = cleanText(
    card.querySelector(".MuiTypography-subtitle1")?.innerText || ""
  ).replace(/^Soal\s*/i, "");

  return {
    question,
    number,
    options,
    signature: `${card.id}|${number}|${question}|${options.map((o) => `${o.letter}:${o.text}`).join("|")}`
  };
}

function findQuizCard() {
  const controls = [...document.querySelectorAll(
    '#main_outlet input[type="radio"], #main_outlet input[type="checkbox"], input[type="radio"], input[type="checkbox"]'
  )].filter(isVisible);

  for (const control of controls) {
    let candidate = control.closest("div[id]") || control.closest(".MuiPaper-root");
    while (candidate && candidate !== document.body) {
      const hasQuestionText = [...candidate.querySelectorAll(".ck-content")]
        .some((element) => !element.closest("label") && cleanText(element.innerText || element.textContent));
      const hasOptions = candidate.querySelectorAll('label input[type="radio"], label input[type="checkbox"]').length > 0;

      if (hasQuestionText && hasOptions) return candidate;
      candidate = candidate.parentElement?.closest("div[id]") || candidate.parentElement?.closest(".MuiPaper-root");
    }
  }

  return null;
}

function getNavigationButtons() {
  const buttons = [...document.querySelectorAll("button")].filter(isVisible);
  const textOf = (button) => cleanText(button.innerText || button.textContent).toLowerCase();

  return {
    next: buttons.find((button) => textOf(button) === "next" || textOf(button).startsWith("next ")),
    finish: buttons.find((button) => textOf(button).includes("selesai quiz"))
  };
}

function findVisibleButton(predicate) {
  return [...document.querySelectorAll("button")]
    .filter(isVisible)
    .find((button) => predicate(cleanText(button.innerText || button.textContent).toLowerCase()));
}

function findYesButton(dialog) {
  return [...dialog.querySelectorAll("button")]
    .find((button) => {
      if (!isVisible(button)) return false;
      const text = cleanText(button.innerText || button.textContent).toLowerCase();
      return text === "ya" || /^ya[\s,.]/.test(text);
    });
}

function parseAnswer(rawContent, options) {
  let value = rawContent;
  let parsed = null;

  try {
    const jsonText = rawContent.match(/\{[\s\S]*\}/)?.[0];
    if (jsonText) {
      parsed = JSON.parse(jsonText);
      value = parsed.answer;
    }
  } catch {
    value = rawContent;
  }

  const normalized = cleanText(String(value || "")).toUpperCase();
  const letter = normalized.match(/\b([A-Z])\b/)?.[1] || normalized.match(/^([A-Z])\.?/)?.[1];
  if (letter) {
    const option = options.find((item) => item.letter.toUpperCase() === letter);
    if (option) return {
      letter,
      option,
      confidence: Number(parsed?.confidence),
      reason: parsed?.reason
    };
  }

  const byText = options.find((item) => normalized.includes(item.text.toUpperCase()));
  return byText ? {
    letter: byText.letter,
    option: byText,
    confidence: Number(parsed?.confidence),
    reason: parsed?.reason
  } : null;
}

function showAnswerNotice(snapshot, answer) {
  document.querySelector("#mentari-quiz-pilot-notice")?.remove();

  const notice = document.createElement("aside");
  notice.id = "mentari-quiz-pilot-notice";
  notice.setAttribute("role", "status");
  notice.innerHTML = `
    <div class="mqpn-kicker">MENTARI / JAWABAN DIPILIH</div>
    <div class="mqpn-title">Soal ${escapeHtml(snapshot.number || "aktif")} · Opsi ${escapeHtml(answer.letter)}</div>
    <div class="mqpn-answer">${escapeHtml(answer.option.text)}</div>
    ${answer.confidence != null ? `<div class="mqpn-confidence">Keyakinan AI: ${Math.round(Number(answer.confidence) * 100)}%</div>` : ""}
  `;

  Object.assign(notice.style, {
    position: "fixed",
    zIndex: "2147483647",
    top: "18px",
    right: "18px",
    width: "min(360px, calc(100vw - 36px))",
    padding: "14px 16px",
    border: "1px solid #cfc7b9",
    borderLeft: "4px solid #d6533d",
    borderRadius: "6px",
    background: "#fffdf8",
    color: "#1f2421",
    boxShadow: "0 12px 32px rgba(31,36,33,.18)",
    font: "13px/1.45 Segoe UI, system-ui, sans-serif",
    pointerEvents: "none"
  });

  const style = document.createElement("style");
  style.textContent = `
    #mentari-quiz-pilot-notice .mqpn-kicker { color:#a83a2b; font-size:10px; font-weight:800; letter-spacing:.12em; margin-bottom:6px; }
    #mentari-quiz-pilot-notice .mqpn-title { font-weight:800; margin-bottom:6px; }
    #mentari-quiz-pilot-notice .mqpn-answer { color:#4e554f; }
    #mentari-quiz-pilot-notice .mqpn-confidence { color:#6e756e; font-size:11px; margin-top:8px; }
  `;
  notice.append(style);
  document.body.append(notice);
  setTimeout(() => notice.remove(), 5000);
}

function showReviewNotice(snapshot, answer) {
  document.querySelector("#mentari-quiz-pilot-notice")?.remove();

  const notice = document.createElement("aside");
  notice.id = "mentari-quiz-pilot-notice";
  notice.setAttribute("role", "alert");
  notice.innerHTML = `
    <div class="mqpn-kicker">PERLU CEK MANUAL</div>
    <div class="mqpn-title">Soal ${escapeHtml(snapshot.number || "aktif")} belum dipilih</div>
    <div class="mqpn-answer">Saran AI: opsi ${escapeHtml(answer.letter)} — ${escapeHtml(answer.option.text)}</div>
    <div class="mqpn-confidence">Confidence: ${Math.round(Number(answer.confidence) * 100)}%. Tidak ada radio button yang dicentang.</div>
  `;

  Object.assign(notice.style, {
    position: "fixed",
    zIndex: "2147483647",
    top: "18px",
    right: "18px",
    width: "min(360px, calc(100vw - 36px))",
    padding: "14px 16px",
    border: "1px solid #d4b36e",
    borderLeft: "4px solid #b78118",
    borderRadius: "6px",
    background: "#fffaf0",
    color: "#3d3321",
    boxShadow: "0 12px 32px rgba(31,36,33,.18)",
    font: "13px/1.45 Segoe UI, system-ui, sans-serif",
    pointerEvents: "none"
  });

  const style = document.createElement("style");
  style.textContent = `
    #mentari-quiz-pilot-notice .mqpn-kicker { color:#8d6412; font-size:10px; font-weight:800; letter-spacing:.12em; margin-bottom:6px; }
    #mentari-quiz-pilot-notice .mqpn-title { font-weight:800; margin-bottom:6px; }
    #mentari-quiz-pilot-notice .mqpn-answer { color:#5b4c31; }
    #mentari-quiz-pilot-notice .mqpn-confidence { color:#806d48; font-size:11px; margin-top:8px; }
  `;
  notice.append(style);
  document.body.append(notice);
  setTimeout(() => notice.remove(), 8000);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  }[character]));
}

async function clickOption(option) {
  option.label.scrollIntoView({ behavior: "smooth", block: "center" });
  option.label.click();
  await wait(250);

  if (!option.input.checked) {
    option.input.click();
    await wait(250);
  }

  if (!option.input.checked) {
    throw new Error(`Opsi ${option.letter} gagal dipilih.`);
  }
}

async function waitForQuestion(runId, differentFrom = "", allowSame = false) {
  const deadline = Date.now() + 15000;

  while (runner.running && runId === runner.runId && Date.now() < deadline) {
    const snapshot = getQuizSnapshot();
    if (snapshot && (allowSame || snapshot.signature !== differentFrom)) return snapshot;
    await wait(250);
  }

  if (!runner.running || runId !== runner.runId) return null;
  throw new Error("Soal berikutnya tidak muncul dalam 15 detik.");
}

function setStatus(status, message) {
  chrome.storage.local.set({
    runnerStatus: { status, message, updatedAt: Date.now() }
  });
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameSite(a, b) {
  try {
    const siteA = new URL(a).hostname.split(".").slice(-3).join(".");
    const siteB = new URL(b).hostname.split(".").slice(-3).join(".");
    return siteA === siteB;
  } catch {
    return a === b;
  }
}

let resuming = false;

async function resumePendingJob() {
  if (resuming || runner.running || runner.processing) return;
  resuming = true;

  try {
    const job = await loadJob();
    if (!job?.active) return;
    if (job.origin && !sameSite(job.origin, location.origin)) return;
    if (runner.running || runner.processing) return;

    runner.running = true;
    runner.runId += 1;
    runner.config = { ...runner.config, ...job.config };
    setStatus("running", "Melanjutkan otomasi…");
    runPendingQuizzes(runner.runId);
  } catch {
    runner.running = false;
  } finally {
    resuming = false;
  }
}

resumePendingJob().catch(() => {});
setInterval(() => {
  if (!document.querySelector("#main_outlet, .MuiDrawer-root")) return;
  resumePendingJob().catch(() => {});
}, 4000);
})();
