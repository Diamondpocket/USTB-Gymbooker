import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";
import { log } from "./logger.js";

const DEFAULT_DEVICE = devices["iPhone 13"];

export async function captureSession(config) {
  ensureParentDir(config.storageStatePath);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(createContextOptions(config, false));
  const page = await context.newPage();

  try {
    log("Opening login page for manual sign-in.");
    await page.goto(config.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.openPageTimeoutMs
    });

    if (config.selectors.postLoginReady) {
      log("Complete login in the browser window. The script will save your session afterward.");
      await page.locator(config.selectors.postLoginReady).waitFor({
        timeout: 5 * 60 * 1000
      });
    } else {
      log("Log in manually, then press Enter in this terminal to continue.");
      await waitForEnter();
    }

    await context.storageState({ path: config.storageStatePath });
    log(`Session saved to ${config.storageStatePath}`);
  } finally {
    await browser.close();
  }
}

export async function runBooking(config) {
  if (!fs.existsSync(config.storageStatePath)) {
    throw new Error(`Missing saved session: ${config.storageStatePath}. Run capture-session first.`);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(createContextOptions(config, true));
  const page = await context.newPage();

  try {
    await page.goto(config.bookingPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.openPageTimeoutMs
    });

    log("Booking page opened.");
    await waitUntilReleaseTime(config);
    let lastError = "No matching slot found yet.";

    for (let attempt = 1; attempt <= config.bookingWindow.maxAttempts; attempt += 1) {
      log(`Attempt ${attempt}/${config.bookingWindow.maxAttempts}`);

      await applySearchFilters(page, config);
      await waitForListReady(page, config);

      const booked = config.bookingMode === "grid"
        ? await tryBookGridSlot(page, config)
        : await tryBookListSlot(page, config);

      if (booked) {
        log("Booking flow completed. Verify the result in the browser.");
        return;
      }

      lastError = `No free slot matched ${config.bookingWindow.date} ${config.bookingWindow.startTime}-${config.bookingWindow.endTime}`;
      await page.reload({ waitUntil: "domcontentloaded", timeout: config.openPageTimeoutMs });
      await page.waitForTimeout(config.pollIntervalMs);
    }

    throw new Error(lastError);
  } finally {
    await context.storageState({ path: config.storageStatePath });
    await browser.close();
  }
}

function createContextOptions(config, withStorageState) {
  const mobile = config.mobile ?? {};
  const useMobile = mobile.enabled !== false;
  const baseOptions = {
    timezoneId: config.timezone ?? "Asia/Shanghai",
    storageState: withStorageState ? config.storageStatePath : (fs.existsSync(config.storageStatePath) ? config.storageStatePath : undefined)
  };

  if (!useMobile) {
    return baseOptions;
  }

  return {
    ...DEFAULT_DEVICE,
    ...baseOptions,
    viewport: mobile.viewport ?? DEFAULT_DEVICE.viewport,
    userAgent: mobile.userAgent ?? DEFAULT_DEVICE.userAgent,
    locale: mobile.locale ?? "zh-CN"
  };
}

async function applySearchFilters(page, config) {
  await clickTargetDate(page, config);

  if (config.selectors.dateInput) {
    await fillIfVisible(page, config.selectors.dateInput, config.bookingWindow.date);
  }

  if (config.selectors.searchButton) {
    const button = page.locator(config.selectors.searchButton).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
    }
  }
}

async function clickTargetDate(page, config) {
  if (!config.selectors.dateTab) {
    return;
  }

  const labels = collectDateLabels(config.bookingWindow.date, config.bookingWindow.dateLabel);
  const tabs = page.locator(config.selectors.dateTab);
  const count = await tabs.count();

  for (let index = 0; index < count; index += 1) {
    const tab = tabs.nth(index);
    const text = normalizeWhitespace(await tab.innerText().catch(() => ""));
    if (!text) {
      continue;
    }

    if (labels.some((label) => text.includes(label))) {
      await tab.click();
      await page.waitForTimeout(300);
      return;
    }
  }
}

async function waitForListReady(page, config) {
  if (!config.selectors.listLoading) {
    return;
  }

  const loading = page.locator(config.selectors.listLoading).first();
  await loading.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

async function tryBookListSlot(page, config) {
  const slot = await findTargetSlot(page, config);
  if (!slot) {
    return false;
  }

  log("Matching slot found. Trying to submit booking.");
  await slot.locator(config.selectors.slotBookButton).click();
  await confirmBooking(page, config);
  return true;
}

async function tryBookGridSlot(page, config) {
  const directMatch = await findGridTargetByAttributes(page, config);
  if (directMatch) {
    log(`Grid cell found by attributes for ${directMatch.courtLabel} at ${directMatch.timeLabel}.`);
    await directMatch.cell.click({ force: true });
    await page.waitForTimeout(250);
    await confirmBooking(page, config);
    return true;
  }

  const target = await findGridTarget(page, config);
  if (!target) {
    return false;
  }

  log(`Grid cell found for ${target.courtLabel} at ${target.timeLabel}.`);
  await target.cell.click({ force: true });
  await page.waitForTimeout(250);
  await confirmBooking(page, config);
  return true;
}

async function findGridTargetByAttributes(page, config) {
  const selector = config.selectors.gridCell;
  if (!selector) {
    return null;
  }

  const cells = page.locator(selector);
  const count = await cells.count();
  const preferredCourts = config.preferences?.courtKeywords ?? [];
  const preferredCourtNumbers = normalizeCourtNumbers(config.preferences?.courtNumbers);

  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    const attrs = await cell.evaluate((node) => ({
      time: node.getAttribute("timespan") || node.getAttribute("data-timespan") || "",
      court: node.getAttribute("cdmc") || node.getAttribute("data-court") || "",
      courtNo: node.getAttribute("cdbh") || node.getAttribute("data-court-no") || "",
      statusClass: node.getAttribute("class") || ""
    })).catch(() => null);

    if (!attrs) {
      continue;
    }

    if (!matchesGridTimeRange(attrs.time, config.bookingWindow.startTime, config.bookingWindow.endTime)) {
      continue;
    }

    if (!matchesCourt(attrs.court, attrs.courtNo, preferredCourts, preferredCourtNumbers)) {
      continue;
    }

    if (!isBookable(`${attrs.statusClass} ${await cell.innerText().catch(() => "")}`)) {
      continue;
    }

    return {
      cell,
      courtLabel: attrs.court || "unknown-court",
      timeLabel: attrs.time || config.bookingWindow.startTime
    };
  }

  return null;
}

async function findTargetSlot(page, config) {
  const cards = page.locator(config.selectors.slotCard);
  const count = await cards.count();

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const slot = {
      time: await safeText(card, config.selectors.slotTime),
      venue: await safeText(card, config.selectors.slotVenue),
      court: await safeText(card, config.selectors.slotCourt),
      status: await safeText(card, config.selectors.slotStatus)
    };

    if (!matchesTime(slot.time, config.bookingWindow.startTime, config.bookingWindow.endTime)) {
      continue;
    }

    if (!matchesKeywords(slot.venue, config.preferences?.venueKeywords)) {
      continue;
    }

    if (!matchesKeywords(slot.court, config.preferences?.courtKeywords)) {
      continue;
    }

    if (!matchesCourt(slot.court, "", [], normalizeCourtNumbers(config.preferences?.courtNumbers))) {
      continue;
    }

    if (!matchesKeywords(`${slot.venue} ${slot.court}`, config.preferences?.sportKeywords)) {
      continue;
    }

    if (!isBookable(slot.status)) {
      continue;
    }

    const button = card.locator(config.selectors.slotBookButton).first();
    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }

    return card;
  }

  return null;
}

async function findGridTarget(page, config) {
  const headers = await captureGridLabels(page, config.selectors.courtHeader);
  const rows = await captureGridLabels(page, config.selectors.timeLabel);
  const cells = page.locator(config.selectors.gridCell);
  const cellCount = await cells.count();

  if (headers.length === 0 || rows.length === 0 || cellCount === 0) {
    return null;
  }

  const preferredCourts = config.preferences?.courtKeywords ?? [];
  const preferredCourtNumbers = normalizeCourtNumbers(config.preferences?.courtNumbers);
  const courtTargets = headers.filter((header) => matchesCourt(header.text, "", preferredCourts, preferredCourtNumbers));
  const rowTarget = rows.find((row) => matchesGridTime(row.text, config.bookingWindow.startTime));

  if (!rowTarget || courtTargets.length === 0) {
    return null;
  }

  for (const court of courtTargets) {
    const hit = await locateCellNearIntersection(cells, court.box, rowTarget.box, config);
    if (hit) {
      return {
        cell: hit,
        courtLabel: court.text,
        timeLabel: rowTarget.text
      };
    }
  }

  return null;
}

async function captureGridLabels(page, selector) {
  if (!selector) {
    return [];
  }

  const labels = page.locator(selector);
  const count = await labels.count();
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const locator = labels.nth(index);
    const box = await locator.boundingBox();
    const text = normalizeWhitespace(await locator.innerText().catch(() => ""));
    if (box && text) {
      results.push({ text, box });
    }
  }

  return results;
}

async function locateCellNearIntersection(cells, courtBox, rowBox, config) {
  const targetX = courtBox.x + courtBox.width / 2;
  const targetY = rowBox.y + rowBox.height / 2;
  const maxDistance = config.grid?.maxDistancePx ?? 50;
  const bookableColorHints = config.grid?.bookableColorHints ?? [];
  const cellCount = await cells.count();

  for (let index = 0; index < cellCount; index += 1) {
    const cell = cells.nth(index);
    const box = await cell.boundingBox();
    if (!box) {
      continue;
    }

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const distance = Math.hypot(centerX - targetX, centerY - targetY);

    if (distance > maxDistance) {
      continue;
    }

    if (!(await isBookableGridCell(cell, bookableColorHints))) {
      continue;
    }

    return cell;
  }

  return null;
}

async function isBookableGridCell(cell, bookableColorHints) {
  const visible = await cell.isVisible().catch(() => false);
  if (!visible) {
    return false;
  }

  const text = normalizeWhitespace(await cell.innerText().catch(() => ""));
  if (text && ["sold", "full", "unavailable"].some((word) => text.toLowerCase().includes(word))) {
    return false;
  }

  if (bookableColorHints.length === 0) {
    return true;
  }

  const backgroundColor = await cell.evaluate((node) => getComputedStyle(node).backgroundColor).catch(() => "");
  return bookableColorHints.some((hint) => backgroundColor.toLowerCase().includes(String(hint).toLowerCase()));
}

async function confirmBooking(page, config) {
  if (config.selectors.submitButton) {
    const submitButton = page.locator(config.selectors.submitButton).first();
    const visible = await submitButton.isVisible().catch(() => false);
    if (visible) {
      await submitButton.click();
      await page.waitForTimeout(300);
    }
  }

  if (config.selectors.confirmButton) {
    const confirmButton = page.locator(config.selectors.confirmButton).first();
    const visible = await confirmButton.isVisible().catch(() => false);
    if (visible) {
      await confirmButton.click();
    } else {
      await confirmButton.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      if (await confirmButton.isVisible().catch(() => false)) {
        await confirmButton.click();
      }
    }
  }

  if (config.selectors.successToast) {
    await page.locator(config.selectors.successToast).first().waitFor({
      state: "visible",
      timeout: 10_000
    });
  } else {
    await page.waitForTimeout(3000);
  }
}

async function safeText(locator, selector) {
  if (!selector) {
    return "";
  }

  const target = locator.locator(selector).first();
  const visible = await target.isVisible().catch(() => false);
  if (!visible) {
    return "";
  }

  return normalizeWhitespace(await target.innerText());
}

function matchesTime(text, startTime, endTime) {
  const normalized = normalizeWhitespace(text);
  return normalized.includes(startTime) && normalized.includes(endTime);
}

function matchesGridTime(text, startTime) {
  const normalized = normalizeWhitespace(text);
  return normalized.includes(startTime);
}

function matchesGridTimeRange(text, startTime, endTime) {
  const normalized = normalizeWhitespace(text);
  return normalized.includes(startTime) && normalized.includes(endTime);
}

function matchesKeywords(text, keywords) {
  if (!keywords || keywords.length === 0) {
    return true;
  }

  const haystack = normalizeWhitespace(text).toLowerCase();
  return keywords.some((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

function matchesCourt(courtText, courtNo, keywords, courtNumbers) {
  if (courtNumbers.length > 0) {
    const actualNumber = extractCourtNumber(courtNo || courtText);
    if (!actualNumber || !courtNumbers.includes(actualNumber)) {
      return false;
    }
  }

  return matchesKeywords(courtText, keywords);
}

function isBookable(statusText) {
  const normalized = normalizeWhitespace(statusText);
  if (!normalized) {
    return true;
  }

  return !["full", "unavailable", "closed", "sold", "已约满", "不可预约", "已预约", "关闭"].some((word) =>
    normalized.toLowerCase().includes(word.toLowerCase())
  );
}

function collectDateLabels(isoDate, explicitLabel) {
  const labels = [];
  if (explicitLabel) {
    labels.push(explicitLabel);
  }

  const [year, month, day] = String(isoDate).split("-").map(Number);
  if (year && month && day) {
    labels.push(`${month}/${day}`);
    labels.push(`${month}-${day}`);
    labels.push(`${month}.${day}`);
  }

  return labels;
}

function normalizeCourtNumbers(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function extractCourtNumber(value) {
  const match = String(value ?? "").match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

async function waitUntilReleaseTime(config) {
  if (!config.releaseAt) {
    return;
  }

  const target = parseLocalDateTime(config.releaseAt);
  if (!target) {
    throw new Error(`Invalid releaseAt value: ${config.releaseAt}`);
  }

  while (true) {
    const now = new Date();
    const diff = target.getTime() - now.getTime();
    if (diff <= 0) {
      log(`Release time reached: ${config.releaseAt}`);
      return;
    }

    const waitMs = Math.min(diff, 1000);
    if (diff > 5000) {
      log(`Waiting for release time ${config.releaseAt}, ${Math.ceil(diff / 1000)}s remaining.`);
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function parseLocalDateTime(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second = "00"] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function fillIfVisible(page, selector, value) {
  const input = page.locator(selector).first();
  if (await input.isVisible().catch(() => false)) {
    await input.fill(value);
  }
}

function ensureParentDir(targetPath) {
  const parent = path.dirname(targetPath);
  fs.mkdirSync(parent, { recursive: true });
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });
}
