import { parseBookingSuccess } from "./success-log.js";

const ALL_COURTS = Array.from({ length: 20 }, (_, index) => index + 1);
const DEFAULT_BACK_ROW_COURTS = [12, 13, 14, 15, 16, 17, 18, 19, 20];
const PRICE_OPTIONS = [10, 15, 60, 120];
const DEFAULT_MAX_ATTEMPTS = 999999;
const DEFAULT_FIRST_HOUR = "08:00";
const DEFAULT_SECOND_HOUR = "18:00";
const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const state = {
  config: null,
  running: false,
  abortController: null
};

const els = {
  date: document.querySelector("#date"),
  bookingPageUrl: document.querySelector("#booking-page-url"),
  startTime: document.querySelector("#start-time"),
  endTime: document.querySelector("#end-time"),
  startTime2: document.querySelector("#start-time-2"),
  endTime2: document.querySelector("#end-time-2"),
  courts: document.querySelector("#courts"),
  blockedPrices: document.querySelector("#blocked-prices"),
  releaseAt: document.querySelector("#release-at"),
  maxAttempts: document.querySelector("#max-attempts"),
  allowSingleSlot: document.querySelector("#allow-single-slot"),
  scanLoops: document.querySelector("#scan-loops"),
  scanIntervalMs: document.querySelector("#scan-interval-ms"),
  commandPreview: document.querySelector("#command-preview"),
  appVersion: document.querySelector("#app-version"),
  instanceName: document.querySelector("#instance-name"),
  manualOverrideWarning: document.querySelector("#manual-override-warning"),
  successBanner: document.querySelector("#success-banner"),
  output: document.querySelector("#output"),
  courtMap: document.querySelector("#court-map"),
  refreshMap: document.querySelector("#refresh-map"),
  mapStatus: document.querySelector("#map-status"),
  saveConfig: document.querySelector("#save-config"),
  clearOutput: document.querySelector("#clear-output"),
  preferBackRow: document.querySelector("#prefer-back-row"),
  cancelRun: document.querySelector("#cancel-run"),
  actionButtons: Array.from(document.querySelectorAll("[data-mode]"))
};

bootstrap().catch((error) => {
  writeOutput(`初始化失败: ${error.message}`);
});

async function bootstrap() {
  renderHourOptions();
  renderCourtOptions();
  renderPriceOptions();

  const response = await fetch("/api/config");
  state.config = await response.json();

  els.appVersion.textContent = state.config.appVersion ?? "unknown";
  els.instanceName.textContent = state.config.instance?.name ?? state.config.instance?.id ?? "default";
  hydrateForm(state.config);
  bindEvents();
  renderCommandPreview("scan-api");
  writeOutput(
    [
      `控制台已准备好。当前版本: ${state.config.appVersion ?? "unknown"}`,
      "操作提示：先看场地可视化确认校内开放限制，再勾选想抢的场地；快速扫描始终查看全场，不受勾选影响。",
      "正式开抢会自动启用快速切换：一组目标失败就立刻换下一组。灰色代表学校规则不可用，橙色代表只满足其中一个时段。"
    ].join("\n")
  );

  await refreshAvailabilityMap();
}

function bindEvents() {
  [
    els.date,
    els.bookingPageUrl,
    els.startTime,
    els.startTime2,
    els.releaseAt,
    els.allowSingleSlot,
    els.scanLoops,
    els.scanIntervalMs
  ].filter(Boolean).forEach((input) => {
    input.addEventListener("input", handleConfigChanged);
    input.addEventListener("change", handleConfigChanged);
  });

  [els.courts, els.blockedPrices].forEach((container) => {
    container.addEventListener("change", handleConfigChanged);
  });

  els.preferBackRow.addEventListener("click", () => {
    setSelectedValues(els.courts, DEFAULT_BACK_ROW_COURTS);
    handleConfigChanged();
  });

  els.saveConfig.addEventListener("click", saveConfig);
  els.clearOutput.addEventListener("click", () => {
    hideSuccessBanner();
    writeOutput("");
  });
  els.refreshMap.addEventListener("click", refreshAvailabilityMap);
  els.cancelRun.addEventListener("click", cancelCurrentRun);

  for (const button of els.actionButtons) {
    button.addEventListener("click", () => runAction(button));
  }
}

function renderHourOptions() {
  const options = Array.from({ length: 14 }, (_, index) => {
    const hour = index + 8;
    const value = `${String(hour).padStart(2, "0")}:00`;
    return `<option value="${value}">${hour}:00-${hour + 1}:00</option>`;
  }).join("");

  els.startTime.innerHTML = options;
  els.startTime2.innerHTML = options;
}

function renderCourtOptions() {
  els.courts.innerHTML = ALL_COURTS.map((courtNo) => optionButtonMarkup(courtNo, `羽${courtNo}`)).join("");
}

function renderPriceOptions() {
  els.blockedPrices.innerHTML = PRICE_OPTIONS.map((price) => optionButtonMarkup(price, `${price}元`)).join("");
}

function optionButtonMarkup(value, label) {
  return `
    <label class="option-chip">
      <input type="checkbox" value="${value}" />
      <span data-label="${label}">${label}</span>
    </label>
  `;
}

function hydrateForm(config) {
  const segments = Array.isArray(config.bookingWindow.segments) ? config.bookingWindow.segments : [];
  const firstStart = normalizeHour(segments[0]?.startTime ?? config.bookingWindow.startTime ?? DEFAULT_FIRST_HOUR);
  const secondStart = normalizeHour(segments[1]?.startTime ?? DEFAULT_SECOND_HOUR);

  els.date.value = formatDateInput(addDays(new Date(), 7));
  els.bookingPageUrl.value = config.bookingPageUrl ?? "";
  els.startTime.value = firstStart;
  els.startTime2.value = secondStart;
  syncEndTimes();
  els.releaseAt.value = formatDateTimeLocal(new Date(), 9, 0);
  els.maxAttempts.value = String(DEFAULT_MAX_ATTEMPTS);
  els.allowSingleSlot.checked = Boolean(config.rules?.allowSingleSlot);
  els.manualOverrideWarning.hidden = !Boolean(config.manualOverride?.allowManualOverride);
  els.scanLoops.value = String(config.scan?.loops ?? 10);
  els.scanIntervalMs.value = String(config.scan?.intervalMs ?? 500);

  setSelectedValues(els.courts, config.preferences?.courtNumbers ?? []);
  setSelectedValues(els.blockedPrices, config.rules?.blockedPrices ?? []);
  updateHourOptionAvailability();
  updateCourtOptionAvailability();
}

function handleConfigChanged() {
  syncEndTimes();
  updateHourOptionAvailability();
  updateCourtOptionAvailability();
  renderCommandPreview("scan-api");
  debounceRefreshMap();
}

async function saveConfig() {
  const updated = buildUpdatedConfig();
  const response = await fetch("/api/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(updated)
  });

  if (!response.ok) {
    const message = await response.text();
    writeOutput(`保存配置失败: ${message}`);
    return;
  }

  state.config = updated;
  renderCommandPreview("scan-api");
  writeOutput("配置已保存。场地勾选只影响模拟/正式开抢；快速扫描和场地可视化仍会看全场，方便抢前判断余量。");
  await refreshAvailabilityMap();
}

async function runAction(button) {
  if (state.running) {
    return;
  }

  state.running = true;
  state.abortController = new AbortController();
  setButtonsDisabled(true);

  const mode = button.dataset.mode;
  const dryRun = button.dataset.dryRun === "true";
  const payload = collectPayload({ mode, dryRun });
  renderCommandPreview(mode);
  hideSuccessBanner();
  writeOutput(buildPendingMessage({ mode, dryRun }));

  try {
    const response = await fetch("/api/run-stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: state.abortController.signal
    });

    if (!response.ok || !response.body) {
      const message = await response.text();
      throw new Error(message || `Request failed with ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let output = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      output += decoder.decode(value, { stream: true });
      updateSuccessBanner(output);
      writeOutput(output);
    }

    output += decoder.decode();
    updateSuccessBanner(output);
    writeOutput(output.trimEnd());
    await refreshAvailabilityMap();
  } catch (error) {
    if (error.name === "AbortError") {
      appendOutput("\n\n[client] 已取消当前运行。");
    } else {
      writeOutput(`执行失败: ${error.message}`);
    }
  } finally {
    state.running = false;
    state.abortController = null;
    setButtonsDisabled(false);
  }
}

async function cancelCurrentRun() {
  if (!state.running) {
    writeOutput("当前没有正在运行的任务。");
    return;
  }

  els.cancelRun.disabled = true;
  appendOutput("\n\n[client] 正在取消...");

  try {
    const response = await fetch("/api/cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const result = await response.json();
    appendOutput(`\n[server] ${result.message}`);
  } catch (error) {
    appendOutput(`\n[server] 取消请求失败: ${error.message}`);
  } finally {
    if (state.abortController) {
      state.abortController.abort();
    }
  }
}

function buildPendingMessage({ mode, dryRun }) {
  if (mode === "scan-api") {
    return [
      `执行中: ${els.commandPreview.value}`,
      "正在实时接收扫描日志..."
    ].join("\n");
  }

  if (dryRun) {
    return [
      `执行中: ${els.commandPreview.value}`,
      "模拟下单不会真的提交订单。",
      "它会按正式规则搜索两个目标时段，找到后打印 payload。"
    ].join("\n");
  }

  return [
    `执行中: ${els.commandPreview.value}`,
    "正在持续搜索并等待命中；如果不想继续，点取消即可。"
  ].join("\n");
}

function buildUpdatedConfig() {
  const updated = structuredClone(state.config);
  updated.bookingWindow.date = els.date.value;
  updated.bookingWindow.dateLabel = toDateLabel(els.date.value);
  updated.bookingWindow.startTime = els.startTime.value;
  updated.bookingWindow.endTime = els.endTime2.value;
  updated.bookingWindow.segments = collectTimeSegments();
  updated.bookingWindow.maxAttempts = DEFAULT_MAX_ATTEMPTS;
  updated.bookingPageUrl = els.bookingPageUrl.value.trim();
  updated.loginUrl = updated.bookingPageUrl;
  updated.releaseAt = els.releaseAt.value ? els.releaseAt.value.replace("T", " ") : "";
  updated.preferences = {
    courtNumbers: getSelectedValues(els.courts),
    courtKeywords: updated.preferences?.courtKeywords ?? []
  };
  updated.rules.blockedPrices = getSelectedValues(els.blockedPrices);
  updated.rules.allowSingleSlot = els.allowSingleSlot.checked;
  updated.scan = {
    loops: Number(els.scanLoops.value),
    intervalMs: Number(els.scanIntervalMs.value)
  };
  return updated;
}

function collectPayload({ mode, dryRun = false }) {
  const courts = mode === "scan-api" ? ALL_COURTS : getSelectedValues(els.courts);

  return {
    mode,
    bookingPageUrl: els.bookingPageUrl.value.trim(),
    date: els.date.value,
    time: `${els.startTime.value}-${els.endTime.value}`,
    timeSegments: collectTimeSegments(),
    courts,
    allowSingleSlot: els.allowSingleSlot.checked,
    releaseAt: els.releaseAt.value ? els.releaseAt.value.replace("T", " ") : "",
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    scanLoops: els.scanLoops.value,
    scanIntervalMs: els.scanIntervalMs.value,
    dryRun
  };
}

function renderCommandPreview(mode) {
  const payload = collectPayload({ mode });
  const parts = [
    "npm.cmd run",
    mode,
    "--",
    "--date",
    payload.date,
    "--times",
    payload.timeSegments.map((segment) => `${segment.startTime}-${segment.endTime}`).join(",")
  ];

  if (payload.courts.length) {
    parts.push("--courts", payload.courts.join(","));
  }

  if (payload.bookingPageUrl) {
    parts.push("--booking-url", `"${payload.bookingPageUrl}"`);
  }

  if (payload.releaseAt) {
    parts.push("--release-at", `"${payload.releaseAt}"`);
  }

  if (payload.allowSingleSlot) {
    parts.push("--allow-single-slot");
  }

  if (mode === "scan-api") {
    parts.push("--scan-loops", payload.scanLoops, "--scan-interval-ms", payload.scanIntervalMs);
  } else {
    parts.push("--max-attempts", String(DEFAULT_MAX_ATTEMPTS));
  }

  if (payload.dryRun) {
    parts.push("--dry-run");
  }

  els.commandPreview.value = parts.join(" ");
}

function collectTimeSegments() {
  syncEndTimes();
  return [
    { startTime: els.startTime.value, endTime: els.endTime.value },
    { startTime: els.startTime2.value, endTime: els.endTime2.value }
  ];
}

function syncEndTimes() {
  els.endTime.value = addOneHour(els.startTime.value);
  els.endTime2.value = addOneHour(els.startTime2.value);
}

function setButtonsDisabled(disabled) {
  for (const button of els.actionButtons) {
    button.disabled = disabled;
  }
  els.saveConfig.disabled = disabled;
  els.refreshMap.disabled = disabled;
  els.cancelRun.disabled = !disabled;
}

function setSelectedValues(container, values) {
  const selected = new Set(values.map((item) => Number(item)));
  for (const input of container.querySelectorAll('input[type="checkbox"]')) {
    input.checked = selected.has(Number(input.value));
  }
}

function getSelectedValues(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
    .map((input) => Number(input.value))
    .filter((value) => Number.isFinite(value));
}

function toDateLabel(date) {
  const parts = String(date).split("-");
  if (parts.length !== 3) {
    return "";
  }

  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function addOneHour(value) {
  const hour = Number(String(value).split(":")[0]);
  if (!Number.isFinite(hour)) {
    return "";
  }
  return `${String(hour + 1).padStart(2, "0")}:00`;
}

function normalizeHour(value) {
  const hour = Number(String(value).split(":")[0]);
  if (!Number.isFinite(hour)) {
    return DEFAULT_FIRST_HOUR;
  }
  const clamped = Math.min(21, Math.max(8, hour));
  return `${String(clamped).padStart(2, "0")}:00`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateInput(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function formatDateTimeLocal(date, hour, minute) {
  return `${formatDateInput(date)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function writeOutput(text) {
  const shouldStickToBottom = isOutputNearBottom();
  els.output.textContent = text;
  scrollOutputToBottomIfNeeded(shouldStickToBottom);
}

function appendOutput(text) {
  const shouldStickToBottom = isOutputNearBottom();
  els.output.textContent += text;
  updateSuccessBanner(els.output.textContent);
  scrollOutputToBottomIfNeeded(shouldStickToBottom);
}

function isOutputNearBottom() {
  const distance = els.output.scrollHeight - els.output.scrollTop - els.output.clientHeight;
  return distance < 24;
}

function scrollOutputToBottomIfNeeded(shouldStickToBottom) {
  if (!shouldStickToBottom) {
    return;
  }

  requestAnimationFrame(() => {
    els.output.scrollTop = els.output.scrollHeight;
  });
}

function updateSuccessBanner(text) {
  const success = parseBookingSuccess(text);
  if (!success) {
    return;
  }

  els.successBanner.hidden = false;
  els.successBanner.textContent = `抢场成功！订单号: ${success.orderId}，场地: ${success.slots}`;
}

function hideSuccessBanner() {
  els.successBanner.hidden = true;
  els.successBanner.textContent = "";
}

let refreshTimer = null;

function debounceRefreshMap() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshAvailabilityMap, 250);
}

async function refreshAvailabilityMap() {
  els.refreshMap.disabled = true;
  els.mapStatus.textContent = "刷新中...";
  els.mapStatus.className = "map-status loading";

  try {
    const payload = collectAvailabilityMapPayload();
    const response = await fetch("/api/availability", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const summary = await response.json();
    if (!response.ok || summary.error) {
      throw new Error(summary.error || "Refresh failed");
    }

    renderCourtMap(summary);
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    els.mapStatus.textContent = `已刷新 ${stamp}`;
    els.mapStatus.className = "map-status";
  } catch (error) {
    els.mapStatus.textContent = `刷新失败: ${error.message}`;
    els.mapStatus.className = "map-status error";
    writeOutput(`场地刷新失败: ${error.message}`);
  } finally {
    els.refreshMap.disabled = false;
  }
}

function collectAvailabilityMapPayload() {
  return {
    ...collectPayload({ mode: "scan-api" }),
    time: "08:00-22:00",
    timeSegments: [
      { startTime: "08:00", endTime: "22:00" }
    ],
    courts: ALL_COURTS
  };
}

function renderCourtMap(summary) {
  els.courtMap.innerHTML = "";

  for (const court of summary.courts) {
    const groupedSlots = groupSlotsByPrice(court.slots);
    const hasOpen = court.slots.some((slot) => !slot.blocked);
    const blockedOnly = court.slots.length > 0 && court.slots.every((slot) => slot.blocked);
    const campusClosedOnly = court.slots.length > 0 && court.slots.every((slot) => slot.campusClosed);

    const card = document.createElement("article");
    card.className = [
      "court-card",
      court.hasAny ? "open" : "empty",
      blockedOnly ? "blocked-only" : "",
      campusClosedOnly ? "campus-closed" : ""
    ]
      .filter(Boolean)
      .join(" ");

    const meta = [];
    if (court.hasCampusClosed) meta.push('<span class="mini-tag campus">校内关闭</span>');
    if (blockedOnly) meta.push('<span class="mini-tag blocked">仅禁抢</span>');
    if (!court.hasAny) meta.push('<span class="mini-tag">空白</span>');
    if (hasOpen) meta.push('<span class="mini-tag open">可抢</span>');

    const slotsHtml = groupedSlots.length
      ? groupedSlots
          .map((group) => `
            <div class="slot-item ${group.campusClosed ? "campus-closed" : group.blocked ? "blocked" : "open"}">
              <strong>${group.campusClosed ? "校内关闭" : `${group.price}元`}</strong>
              <span>${group.times.join(" ")}</span>
            </div>
          `)
          .join("")
      : '<div class="slot-empty">当前目标时段内没有空位</div>';

    card.innerHTML = `
      <h3>羽${court.courtNo}</h3>
      <div class="court-meta">${meta.join("")}</div>
      <div class="slot-list">${slotsHtml}</div>
    `;

    els.courtMap.appendChild(card);
  }
}

function groupSlotsByPrice(slots) {
  const groups = new Map();

  for (const slot of slots) {
    const key = slot.campusClosed ? "campus" : `${slot.price}|${slot.blocked ? 1 : 0}`;
    if (!groups.has(key)) {
      groups.set(key, {
        price: slot.price || 0,
        blocked: Boolean(slot.blocked),
        campusClosed: Boolean(slot.campusClosed),
        times: []
      });
    }
    groups.get(key).times.push(shortTimeRange(slot.timeRange));
  }

  return Array.from(groups.values()).sort((left, right) => {
    if (left.campusClosed !== right.campusClosed) {
      return left.campusClosed ? 1 : -1;
    }
    if (left.blocked !== right.blocked) {
      return left.blocked ? 1 : -1;
    }
    return left.price - right.price;
  });
}

function shortTimeRange(range) {
  const [start, end] = String(range).split("-");
  return `${shortTime(start)}-${shortTime(end)}`;
}

function shortTime(value) {
  const [hour, minute] = String(value).split(":");
  return minute === "00" ? String(Number(hour)) : `${Number(hour)}:${minute}`;
}

function updateHourOptionAvailability() {
  let changed = false;
  for (const select of [els.startTime, els.startTime2]) {
    for (const option of Array.from(select.options)) {
      const endTime = addOneHour(option.value);
      const allowed = isAnyCampusCourtAllowed(els.date.value, `${option.value}-${endTime}`);
      option.disabled = !allowed;
      option.textContent = `${shortTime(option.value)}-${shortTime(endTime)}${allowed ? "" : "（关闭）"}`;
    }

    const selectedOption = select.selectedOptions[0];
    if (selectedOption?.disabled) {
      const firstAllowed = Array.from(select.options).find((option) => !option.disabled);
      if (firstAllowed) {
        select.value = firstAllowed.value;
        changed = true;
      }
    }
  }

  if (changed) {
    syncEndTimes();
  }
}

function isAnyCampusCourtAllowed(date, timeRange) {
  return ALL_COURTS.some((courtNo) => isCampusSlotAllowed(date, courtNo, timeRange));
}

function updateCourtOptionAvailability() {
  const timeRanges = collectTimeSegments().map((segment) => `${segment.startTime}-${segment.endTime}`);
  for (const input of Array.from(els.courts.querySelectorAll("input"))) {
    const courtNo = Number(input.value);
    const allowedIndexes = timeRanges
      .map((timeRange, index) => isCampusSlotAllowed(els.date.value, courtNo, timeRange) ? index + 1 : null)
      .filter(Boolean);
    const allowed = allowedIndexes.length > 0;
    const chip = input.closest(".option-chip");
    const label = chip?.querySelector("span");

    input.disabled = !allowed;
    chip?.classList.toggle("disabled", !allowed);
    chip?.classList.toggle("partial", allowed && allowedIndexes.length < timeRanges.length);
    input.title = allowed
      ? `可用于时段 ${allowedIndexes.join(", ")}`
      : "当前两个时段校内都不开放";

    if (label) {
      const baseLabel = label.dataset.label ?? label.textContent;
      label.textContent = allowed
        ? `${baseLabel} ${allowedIndexes.map((index) => `T${index}`).join("/")}`
        : `${baseLabel} 关闭`;
    }

    if (!allowed) {
      input.checked = false;
    }
  }
}

function isCampusSlotAllowed(date, courtNo, timeRange) {
  const context = getCampusRuleContext(date);
  if (!context.enabled || !context.hasRulesForDay) {
    return true;
  }

  const [startLabel, endLabel] = String(timeRange).split("-");
  const startMinutes = toMinutes(startLabel);
  const endMinutes = toMinutes(endLabel);

  if (startMinutes === null || endMinutes === null) {
    return false;
  }

  const matchingWindows = context.windows.filter((window) => rangesOverlap(startMinutes, endMinutes, window));
  if (matchingWindows.length === 0) {
    return true;
  }

  return matchingWindows.some((window) =>
    window.courts.includes(courtNo) &&
    startMinutes >= window.startMinutes &&
    endMinutes <= window.endMinutes
  );
}

function rangesOverlap(startMinutes, endMinutes, window) {
  return startMinutes < window.endMinutes && endMinutes > window.startMinutes;
}

function getCampusRuleContext(date) {
  const rules = state.config?.campusAvailabilityRules;
  const enabled = Boolean(rules?.enabled);
  const weekday = getWeekdayKey(date);
  const dayRules = rules?.weekdays?.[weekday] ?? [];

  return {
    enabled,
    hasRulesForDay: enabled && dayRules.length > 0,
    windows: dayRules
      .map((rule) => {
        const [startLabel, endLabel] = String(rule.time ?? "").split("-");
        return {
          startMinutes: floorToHour(toMinutes(startLabel)),
          endMinutes: ceilToHour(toMinutes(endLabel)),
          courts: Array.isArray(rule.courts) ? rule.courts.map(Number) : []
        };
      })
      .filter((rule) => rule.startMinutes !== null && rule.endMinutes !== null)
  };
}

function getWeekdayKey(date) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return WEEKDAY_KEYS[parsed.getDay()] ?? "";
}

function toMinutes(value) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function floorToHour(minutes) {
  return minutes === null ? null : Math.floor(minutes / 60) * 60;
}

function ceilToHour(minutes) {
  return minutes === null ? null : Math.ceil(minutes / 60) * 60;
}
