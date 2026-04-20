import { log } from "./logger.js";
import { buildResourceId, createResourceRegistry } from "./resource-registry.js";

const BOOKABLE_STATUS = "i";
const TOTAL_COURTS = 20;
const HOME_FUNCTION_ROUTE = "/HomefuntionV2json.aspx";
const AVAILABILITY_ROUTE = "/GetForm.aspx?datatype=viewchangdi4weixinv&pagesize=0&pagenum=0";
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 20000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 120000;
const DEFAULT_NETWORK_RETRY_COUNT = 0;
const DEFAULT_NETWORK_RETRY_DELAY_MS = 80;
const DEFAULT_FAST_RESCAN_DELAY_MS = 0;
const DEFAULT_FAILED_TARGET_COOLDOWN_MS = 5000;
const DEFAULT_MAX_PLANS_PER_SCAN = 16;
const DEFAULT_MAX_SUBMITS_PER_SCAN = 2;
const DEFAULT_PREFETCH_WHILE_SUBMITTING = true;
const DEFAULT_PREFETCH_SCAN_INTERVAL_MS = 800;
const DEFAULT_PREFERRED_COURTS = [
  12, 13, 14, 15, 16, 17, 18, 19, 20,
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
];
const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const RATE_LIMIT_HINTS = [
  "\u592a\u7d2f",
  "\u559d\u53e3\u6c34",
  "\u4f11\u606f"
];
const DAILY_LIMIT_HINTS = [
  "\u4eca\u5929\u5df2\u7ecf\u9884\u8ba2",
  "\u5df2\u7ecf\u9884\u8ba2\u4e861\u6b21",
  "\u4e0d\u80fd\u518d\u9884\u8ba2"
];
const RELEASE_NOT_OPEN_HINTS = [
  "\u8fd8\u6ca1\u6709\u4e0a\u7ebf",
  "\u7b49\u4e0b\u518d\u8bd5"
];
const TARGET_UNAVAILABLE_HINTS = [
  "\u5df2\u88ab",
  "\u5df2\u8ba2",
  "\u6ca1\u6709",
  "\u65e0\u7a7a",
  "\u4e0d\u53ef",
  "\u4e0d\u80fd",
  "\u5931\u8d25"
];

export async function getStructuredAvailability(config) {
  const runtime = createRuntime(config);
  const availability = await fetchAvailability(runtime);
  return buildAvailabilitySummary(availability, runtime);
}

export async function runApiBooking(config) {
  const runtime = createRuntime(config);
  const registry = createResourceRegistry(config);
  let reservedSlots = [];
  const uninstallCleanup = installReservationCleanup(registry, runtime, () => reservedSlots);

  runtimeLog(runtime, `Start book-api mode=${runtime.runMode}, date=${runtime.bookingDate}, key=${maskKey(runtime.wxkey)}`);
  runtimeLog(runtime, `Random court order: ${runtime.preferredCourts.join(",")}`);
  runtimeLog(runtime, `Optimization fastSwitch=${runtime.fastTargetSwitch}, plansPerScan=${runtime.maxPlansPerScan}, maxSubmitsPerScan=${runtime.maxSubmitsPerScan}, prefetch=${runtime.prefetchWhileSubmitting}, submitTimeout=${runtime.submitTimeoutMs}ms, networkRetry=${runtime.networkRetryCount}`);
  await waitUntilReleaseTime(runtime.releaseAt, runtime);

  let lastReason = "No allowed slots found yet.";
  let lastPlanFingerprint = null;
  const failedSignatures = new Map();
  const failedResourceIds = new Map();

  try {
    for (let attempt = 1; attempt <= runtime.maxAttempts; attempt += 1) {
      let availability;
      try {
        availability = await fetchAvailability(runtime);
      } catch (error) {
        if (isFatalAvailabilityError(error)) {
          lastReason = `Availability fatal error: ${error.message}`;
          runtimeLog(runtime, lastReason);
          throw error;
        }
        lastReason = `Availability error: ${error.message}`;
        runtimeLog(runtime, `${lastReason}; quick rescan in ${runtime.networkRetryDelayMs}ms`);
        await sleepIfNeeded(attempt, runtime.maxAttempts, runtime.networkRetryDelayMs);
        continue;
      }

      const plans = await buildPlansForRuntime(availability, runtime, registry, failedSignatures, failedResourceIds);

      if (plans.length === 0) {
        lastPlanFingerprint = null;
        lastReason = `Search ${attempt}/${runtime.maxAttempts}: no complete allowed plan`;
        runtimeLog(runtime, lastReason);
        await sleepIfNeeded(attempt, runtime.maxAttempts, runtime.pollIntervalMs);
        continue;
      }

      const planFingerprint = plans.slice(0, 3).map((plan) => buildSlotSignature(plan)).join(" || ");
      if (planFingerprint !== lastPlanFingerprint) {
        lastPlanFingerprint = planFingerprint;
        runtimeLog(runtime, `Search ${attempt}/${runtime.maxAttempts}: found ${plans.length} candidate plan(s); first=${buildSlotSignature(plans[0])}`);
      }

      if (runtime.dryRun) {
        runtimeLog(runtime, `Dry run enabled. Top plans: ${plans.slice(0, 5).map((plan) => buildSlotSignature(plan)).join(" || ")}`);
        runtimeLog(runtime, `Dry run payload: ${JSON.stringify(buildBookingPayload(runtime.bookingDate, plans[0], runtime.paytype, runtime.lxbh))}`);
        return;
      }

      let planQueue = [...plans];
      let planQueueTotal = plans.length;
      let triedSubmit = false;
      let stopPlanQueue = false;
      let submitCountThisScan = 0;
      while (planQueue.length > 0) {
        const selectedSlots = planQueue.shift();
        const signature = buildSlotSignature(selectedSlots);
        const payload = buildBookingPayload(runtime.bookingDate, selectedSlots, runtime.paytype, runtime.lxbh);
        const planPosition = planQueueTotal - planQueue.length;

        if (hasBlockedResource(selectedSlots, failedResourceIds)) {
          runtimeLog(runtime, `[fast-switch] skip stale plan: ${signature}`);
          continue;
        }

        if (submitCountThisScan >= runtime.maxSubmitsPerScan) {
          runtimeLog(runtime, `[safety] maxSubmitsPerScan=${runtime.maxSubmitsPerScan} reached; rescan before more submits.`);
          stopPlanQueue = true;
          break;
        }

        const reservation = await reserveSelectedSlots(registry, runtime, selectedSlots);
        if (!reservation.ok) {
          lastReason = describeReservationConflict(reservation.conflicts);
          rememberFailedSignature(failedSignatures, signature, runtime.failedTargetCooldownMs);
          rememberFailedResources(failedResourceIds, selectedSlots, runtime.failedTargetCooldownMs);
          runtimeLog(runtime, `Coordination conflict on plan ${planPosition}/${planQueueTotal}: ${lastReason}`);
          continue;
        }
        reservedSlots = selectedSlots;
        triedSubmit = true;

        runtimeLog(runtime, `Submit ${attempt}/${runtime.maxAttempts} plan ${planPosition}/${planQueueTotal}: trying ${signature}`);
        submitCountThisScan += 1;
        const prefetchScanner = startSubmitPrefetchScanner(runtime, registry, failedSignatures, failedResourceIds);
        const submit = await submitOrderWithFastRetry(runtime, payload, signature);
        prefetchScanner.stop();

        if (!submit.ok) {
          await registry.releaseSlots(selectedSlots, runtime);
          reservedSlots = [];
          rememberFailedSignature(failedSignatures, signature, runtime.failedTargetCooldownMs);
          rememberFailedResources(failedResourceIds, selectedSlots, runtime.failedTargetCooldownMs);
          lastReason = `Submit unknown/network error: ${submit.error.message}`;
          runtimeLog(runtime, `${lastReason}; result is not decisive, rescan and continue.`);
          stopPlanQueue = true;
          break;
        }

        const result = submit.result;
        runtimeLog(runtime, `Submit response: ${JSON.stringify(result)}`);

        if (isSuccessfulBookingResult(result)) {
          const orderIds = getBookingOrderIds(result);
          const orderId = orderIds[0] ?? "unknown";
          if (orderIds.length >= selectedSlots.length) {
            await registry.markBooked(selectedSlots, runtime);
          } else {
            await registry.releaseSlots(selectedSlots, runtime);
          }
          reservedSlots = [];
          runtimeLog(runtime, `BOOKING_SUCCESS orderIds=${orderIds.join(",") || "unknown"} orderCount=${orderIds.length}/${selectedSlots.length} slots=${signature}`);
          if (orderIds.length > 0 && orderIds.length < selectedSlots.length) {
            runtimeLog(runtime, `BOOKING_PARTIAL_OR_UNMAPPED orderCount=${orderIds.length}/${selectedSlots.length}; released shared locks so other instances can rely on fresh scans.`);
          }
          runtimeLog(runtime, `Booking success for ${signature}, orderId=${orderId}`);
          return;
        }

        await registry.releaseSlots(selectedSlots, runtime);
        reservedSlots = [];

        const failure = classifyBookingFailure(result, runtime);
        lastReason = failure.reason;
        if (failure.blockTarget) {
          rememberFailedSignature(failedSignatures, signature, runtime.failedTargetCooldownMs);
          rememberFailedResources(failedResourceIds, selectedSlots, runtime.failedTargetCooldownMs);
        }
        runtimeLog(runtime, `Submit failed (${failure.kind}): ${failure.reason}`);

        if (failure.fatal) {
          runtimeLog(runtime, `FATAL_SUBMIT_STOP kind=${failure.kind}: ${failure.reason}`);
          throw new Error(`${failure.kind} stop: ${failure.reason}`);
        }

        if (failure.rescanBeforeNextSubmit) {
          runtimeLog(runtime, `[${failure.kind}] rescan before next submit.`);
          stopPlanQueue = true;
          break;
        }

        const prefetchedPlanQueue = await getPrefetchedPlanQueue(
          prefetchScanner,
          runtime,
          registry,
          failedSignatures,
          failedResourceIds
        );
        if (prefetchedPlanQueue) {
          planQueue = prefetchedPlanQueue;
          planQueueTotal = prefetchedPlanQueue.length;
          submitCountThisScan = 0;
          runtimeLog(runtime, `[prefetch] response returned; using latest scanned candidate queue.`);
        } else {
          runtimeLog(runtime, `[prefetch] no fresh candidate queue available; rescan before next submit.`);
          stopPlanQueue = true;
          break;
        }

        if (!runtime.fastTargetSwitch) {
          stopPlanQueue = true;
          break;
        }

        if (planQueue.length > 0) {
          runtimeLog(runtime, `[fast-switch] switching target immediately.`);
        }
      }

      if (!stopPlanQueue && triedSubmit) {
        runtimeLog(runtime, `[fast-switch] candidate queue exhausted; rescan now.`);
      }
      await sleepIfNeeded(
        attempt,
        runtime.maxAttempts,
        triedSubmit ? runtime.fastRescanDelayMs : runtime.pollIntervalMs
      );
    }
  } finally {
    if (reservedSlots.length > 0) {
      await registry.releaseSlots(reservedSlots, runtime);
    }
    uninstallCleanup();
  }

  throw new Error(lastReason);
}

export async function runAvailabilityScan(config) {
  const runtime = createRuntime(config);
  const loops = Number(config.scan?.loops ?? 1);
  const intervalMs = Number(config.scan?.intervalMs ?? 1000);

  runtimeLog(runtime, `Start scan-api date=${runtime.bookingDate}, loops=${loops}, key=${maskKey(runtime.wxkey)}`);

  for (let attempt = 1; attempt <= loops; attempt += 1) {
    const availability = await fetchAvailability(runtime);
    const summary = buildAvailabilitySummary(availability, runtime);

    runtimeLog(runtime, `Availability scan ${attempt}/${loops} for ${runtime.bookingDate}`);
    for (const line of formatAvailabilitySummary(summary)) {
      console.log(`[${runtime.instanceName}] ${line}`);
    }

    if (attempt < loops) {
      await sleep(intervalMs);
    }
  }
}

async function buildPlansForRuntime(availability, runtime, registry, failedSignatures, failedResourceIds, options = {}) {
  pruneExpiredEntries(failedSignatures);
  pruneExpiredEntries(failedResourceIds);
  const blockedResourceIds = await getBlockedResourceIdsForRuntime(registry, runtime, options);
  const activeBlockedResourceIds = mergeBlockedResourceIds(blockedResourceIds, failedResourceIds);
  return buildBookingPlans(availability, runtime, activeBlockedResourceIds, failedSignatures);
}

function startSubmitPrefetchScanner(runtime, registry, failedSignatures, failedResourceIds) {
  if (!runtime.prefetchWhileSubmitting) {
    return createEmptyPrefetchScanner();
  }

  let stopped = false;
  let latest = null;
  let latestSignature = "";
  const controller = new AbortController();

  const loop = async () => {
    while (!stopped) {
      try {
        const availability = await fetchAvailability(runtime, { signal: controller.signal });
        if (stopped) {
          return;
        }
        const plans = await buildPlansForRuntime(
          availability,
          runtime,
          registry,
          failedSignatures,
          failedResourceIds,
          { quiet: true }
        );
        latest = {
          availability,
          plans,
          scannedAt: Date.now()
        };

        const signature = plans[0] ? buildSlotSignature(plans[0]) : "none";
        if (signature !== latestSignature) {
          latestSignature = signature;
          runtimeLog(runtime, `[prefetch] scanned while submit pending: plans=${plans.length}, first=${signature}`);
        }
      } catch (error) {
        if (stopped) {
          return;
        }
        latest = {
          availability: null,
          plans: [],
          scannedAt: Date.now(),
          error
        };
        runtimeLog(runtime, `[prefetch] scan failed while submit pending: ${error.message}`);
      }

      if (stopped || runtime.prefetchScanIntervalMs <= 0) {
        return;
      }
      await sleep(runtime.prefetchScanIntervalMs);
    }
  };

  loop().catch((error) => {
    runtimeLog(runtime, `[prefetch] scanner crashed: ${error.message}`);
  });

  return {
    stop() {
      stopped = true;
      controller.abort();
    },
    getLatest() {
      return latest;
    }
  };
}

function createEmptyPrefetchScanner() {
  return {
    stop() {},
    getLatest() {
      return null;
    }
  };
}

async function getPrefetchedPlanQueue(scanner, runtime, registry, failedSignatures, failedResourceIds) {
  const latest = scanner.getLatest();
  if (!latest?.availability) {
    return null;
  }

  const plans = await buildPlansForRuntime(
    latest.availability,
    runtime,
    registry,
    failedSignatures,
    failedResourceIds,
    { quiet: true }
  );
  if (plans.length === 0) {
    return null;
  }

  return plans;
}

function createRuntime(config) {
  const bookingUrl = new URL(config.bookingPageUrl);
  const origin = bookingUrl.origin;
  const wxkey = bookingUrl.searchParams.get("wxkey");
  const lxbh = bookingUrl.searchParams.get("lxbh") ?? "Y";
  const optimization = config.optimization ?? {};

  if (!wxkey) {
    throw new Error("bookingPageUrl is missing wxkey.");
  }

  if (!isBookingPageUrl(bookingUrl)) {
    throw new Error("bookingPageUrl must be the booking page URL ending with /weixinordernewv7.aspx. Re-enter the booking page from WeChat, then paste the full URL with wxkey and lxbh.");
  }

  const bookingDate = toCompactDate(config.bookingWindow.date);
  const preferredCourts = shuffleCourtOrder(getPreferredCourtOrder(config));
  const preferredCourtRank = new Map(preferredCourts.map((courtNo, index) => [courtNo, index]));
  const runMode = String(config.instance?.mode ?? config.runMode ?? "auto").toLowerCase();
  const manualCourtNumbers = normalizeNumberList(config.preferences?.courtNumbers);

  return {
    origin,
    wxkey,
    lxbh,
    bookingDate,
    instanceName: config.instance?.name ?? config.instance?.id ?? "default",
    accountLabel: config.instance?.account?.label ?? config.instance?.account?.name ?? config.instance?.name ?? "default",
    runMode,
    isManualMode: runMode === "manual",
    allowManualOverride: Boolean(config.manualOverride?.allowManualOverride ?? config.manual_override?.allow_manual_override),
    manualAllowedCourtSet: runMode === "manual" && manualCourtNumbers.length > 0 ? new Set(manualCourtNumbers) : null,
    paytype: config.paytype ?? "M",
    dryRun: Boolean(config.dryRun),
    maxAttempts: Number(config.bookingWindow.maxAttempts ?? 1),
    pollIntervalMs: Number(config.pollIntervalMs ?? 800),
    fastTargetSwitch: optimization.fastTargetSwitch !== false,
    maxPlansPerScan: clampNumber(optimization.maxPlansPerScan, 1, 80, DEFAULT_MAX_PLANS_PER_SCAN),
    maxSubmitsPerScan: clampNumber(optimization.maxSubmitsPerScan, 1, 10, DEFAULT_MAX_SUBMITS_PER_SCAN),
    prefetchWhileSubmitting: optimization.prefetchWhileSubmitting ?? DEFAULT_PREFETCH_WHILE_SUBMITTING,
    prefetchScanIntervalMs: clampNumber(optimization.prefetchScanIntervalMs, 0, 10000, DEFAULT_PREFETCH_SCAN_INTERVAL_MS),
    availabilityTimeoutMs: clampNumber(optimization.availabilityTimeoutMs, 500, 30000, DEFAULT_AVAILABILITY_TIMEOUT_MS),
    submitTimeoutMs: clampNumber(optimization.submitTimeoutMs, 500, 180000, DEFAULT_SUBMIT_TIMEOUT_MS),
    networkRetryCount: clampNumber(optimization.networkRetryCount, 0, 5, DEFAULT_NETWORK_RETRY_COUNT),
    networkRetryDelayMs: clampNumber(optimization.networkRetryDelayMs, 0, 5000, DEFAULT_NETWORK_RETRY_DELAY_MS),
    fastRescanDelayMs: clampNumber(optimization.fastRescanDelayMs, 0, 5000, DEFAULT_FAST_RESCAN_DELAY_MS),
    failedTargetCooldownMs: clampNumber(optimization.failedTargetCooldownMs, 0, 60000, DEFAULT_FAILED_TARGET_COOLDOWN_MS),
    targetSlotCount: Number(config.rules?.requiredCourtCount ?? 2),
    minimumSlotCount: config.rules?.allowSingleSlot ? 1 : Number(config.rules?.requiredCourtCount ?? 2),
    releaseAt: config.releaseAt,
    timeWindows: createTimeWindows(config.bookingWindow),
    campusRuleContext: createCampusRuleContext(config.campusAvailabilityRules, config.bookingWindow.date),
    blockedPriceSet: new Set(normalizeNumberList(config.rules?.blockedPrices)),
    preferredCourts,
    preferredCourtRank,
    availabilityUrlBase: `${origin}${AVAILABILITY_ROUTE}&wxkey=${encodeURIComponent(wxkey)}`,
    requestHeaders: {
      "User-Agent": config.userAgent ?? "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
      Origin: origin,
      Referer: `${origin}/weixinordernewv7.aspx?wxkey=${wxkey}&lxbh=${lxbh}`
    }
  };
}

async function getBlockedResourceIdsForRuntime(registry, runtime, options = {}) {
  if (!registry.enabled) {
    return new Set();
  }

  if (runtime.isManualMode && runtime.allowManualOverride) {
    runtimeLog(runtime, "Manual override is enabled. Shared occupied resources may be overwritten.");
    return new Set();
  }

  const blocked = await registry.getBlockedResourceIds(
    { date: runtime.bookingDate, lxbh: runtime.lxbh },
    runtime.instanceName
  );
  if (blocked.size > 0 && !options.quiet) {
    runtimeLog(runtime, `Coordination skipped ${blocked.size} resource(s) selected by other instance(s).`);
  }
  return blocked;
}

async function reserveSelectedSlots(registry, runtime, selectedSlots) {
  if (!registry.enabled) {
    return { ok: true, conflicts: [], reserved: [] };
  }

  const manualOverride = runtime.isManualMode && runtime.allowManualOverride;
  const result = await registry.reserveSlots({
    slots: selectedSlots,
    runtime,
    allowOverride: manualOverride,
    manualOverride
  });

  if (result.ok && result.conflicts.length > 0 && manualOverride) {
    runtimeLog(runtime, `Manual override replaced conflicts: ${describeReservationConflict(result.conflicts)}`);
  } else if (result.ok) {
    runtimeLog(runtime, `Locked ${selectedSlots.length} resource(s) in shared registry.`);
  }

  return result;
}

async function fetchAvailability(runtime, options = {}) {
  const searchparam = `orderdate=${runtime.bookingDate}|lxbh=${runtime.lxbh}`;
  const url = `${runtime.availabilityUrlBase}&searchparam=${encodeURIComponent(searchparam)}`;
  const response = await fetchWithTimeout(url, {
    headers: runtime.requestHeaders,
    signal: options.signal
  }, runtime.availabilityTimeoutMs, "Availability request");

  if (!response.ok) {
    throw new Error(`Availability request failed with ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data[0] !== true) {
    throw new Error(describeAvailabilityFailure(data));
  }

  return JSON.parse(data[1]);
}

function buildAvailabilitySummary(availability, runtime) {
  const filteredRows = getFilteredRows(availability.rows, runtime.timeWindows);
  const courts = createEmptyCourtSummaries();
  const rows = [];

  for (const row of filteredRows) {
    const timeRange = formatTimeRange(row.timemc, row.endtimemc);
    const available = [];

    for (const slot of iterateAvailableSlots(row, runtime)) {
      available.push(slot.summary);
      courts[slot.courtNo - 1].hasAny = true;
      courts[slot.courtNo - 1].slots.push({
        timeRange,
        price: slot.price,
        blocked: slot.blocked,
        campusClosed: false
      });
    }

    rows.push({
      timeRange,
      available
    });
  }

  addCampusClosedSlots(courts, runtime);

  return {
    date: runtime.bookingDate,
    startTime: runtime.timeWindows[0].startLabel,
    endTime: runtime.timeWindows[runtime.timeWindows.length - 1].endLabel,
    timeWindows: runtime.timeWindows.map((window) => ({
      startTime: window.startLabel,
      endTime: window.endLabel
    })),
    campusRules: {
      enabled: runtime.campusRuleContext.enabled,
      weekday: runtime.campusRuleContext.weekday,
      hasRulesForDay: runtime.campusRuleContext.hasRulesForDay
    },
    rows,
    courts
  };
}

function selectBookingSlots(availability, runtime, blockedResourceIds = new Set()) {
  return buildBookingPlans(availability, runtime, blockedResourceIds, new Map(), { allowPartial: true })[0] ?? [];
}

function buildBookingPlans(availability, runtime, blockedResourceIds = new Set(), failedSignatures = new Map(), options = {}) {
  const excludedSignatures = new Set(failedSignatures.keys ? failedSignatures.keys() : failedSignatures);
  const minimumSlotCount = options.allowPartial ? 1 : runtime.minimumSlotCount;
  const plans = runtime.timeWindows.length > 1
    ? buildPlansByTimeWindow(availability, runtime, blockedResourceIds)
    : buildPlansForSingleWindow(availability, runtime, blockedResourceIds);

  return plans
    .filter((plan) => plan.length >= minimumSlotCount)
    .filter((plan) => !excludedSignatures.has(buildSlotSignature(plan)))
    .sort(comparePlans)
    .slice(0, runtime.maxPlansPerScan);
}

function selectSlotsByTimeWindow(availability, runtime, blockedResourceIds) {
  return buildPlansByTimeWindow(availability, runtime, blockedResourceIds)[0] ?? [];
}

function buildPlansByTimeWindow(availability, runtime, blockedResourceIds) {
  const candidateGroups = runtime.timeWindows.map((window, segmentIndex) =>
    collectCandidatesForWindow(availability, runtime, window, blockedResourceIds, segmentIndex)
      .sort(compareCandidates)
  );
  const plans = [];
  const planBudget = runtime.maxPlansPerScan * 4;

  const walk = (segmentIndex, selected, usedResourceIds) => {
    if (selected.length >= runtime.targetSlotCount) {
      plans.push([...selected]);
      return;
    }

    if (segmentIndex >= candidateGroups.length || plans.length >= planBudget) {
      return;
    }

    for (const candidate of candidateGroups[segmentIndex]) {
      if (usedResourceIds.has(candidate.resourceId)) {
        continue;
      }

      selected.push(candidate);
      usedResourceIds.add(candidate.resourceId);
      walk(segmentIndex + 1, selected, usedResourceIds);
      usedResourceIds.delete(candidate.resourceId);
      selected.pop();

      if (plans.length >= planBudget) {
        return;
      }
    }
  };

  walk(0, [], new Set());

  if (plans.length === 0) {
    for (const group of candidateGroups) {
      for (const candidate of group) {
        plans.push([candidate]);
        if (plans.length >= planBudget) {
          return plans;
        }
      }
    }
  }

  return plans;
}

function buildPlansForSingleWindow(availability, runtime, blockedResourceIds) {
  const candidates = collectCandidatesForWindows(availability, runtime, runtime.timeWindows, blockedResourceIds)
    .sort(compareCandidates);
  const plans = [];
  const planBudget = runtime.maxPlansPerScan * 4;

  const walk = (startIndex, selected, usedTimes, usedResourceIds) => {
    if (selected.length >= runtime.targetSlotCount) {
      plans.push([...selected]);
      return;
    }

    if (plans.length >= planBudget) {
      return;
    }

    for (let index = startIndex; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (usedTimes.has(candidate.timeRange) || usedResourceIds.has(candidate.resourceId)) {
        continue;
      }

      selected.push(candidate);
      usedTimes.add(candidate.timeRange);
      usedResourceIds.add(candidate.resourceId);
      walk(index + 1, selected, usedTimes, usedResourceIds);
      usedResourceIds.delete(candidate.resourceId);
      usedTimes.delete(candidate.timeRange);
      selected.pop();

      if (plans.length >= planBudget) {
        return;
      }
    }
  };

  walk(0, [], new Set(), new Set());

  if (plans.length === 0) {
    for (const candidate of candidates) {
      plans.push([candidate]);
      if (plans.length >= planBudget) {
        break;
      }
    }
  }

  return plans;
}

function collectCandidatesForWindows(availability, runtime, timeWindows, blockedResourceIds) {
  const candidates = [];

  for (const row of getFilteredRows(availability.rows, timeWindows)) {
    const timeRange = formatTimeRange(row.timemc, row.endtimemc);
    for (const slot of iterateAvailableSlots(row, runtime)) {
      if (slot.blocked) {
        continue;
      }

      if (runtime.manualAllowedCourtSet && !runtime.manualAllowedCourtSet.has(slot.courtNo)) {
        continue;
      }

      const resourceId = buildResourceIdForSlot(runtime, slot.courtNo, timeRange);
      if (blockedResourceIds.has(resourceId)) {
        continue;
      }

      candidates.push({
        courtNo: slot.courtNo,
        timeRange,
        price: slot.price,
        resourceId,
        preferenceRank: getCourtPreferenceRank(slot.courtNo, runtime.preferredCourtRank),
        startMinutes: toMinutes(row.timemc)
      });
    }
  }

  return candidates;
}

function collectCandidatesForWindow(availability, runtime, timeWindow, blockedResourceIds, segmentIndex) {
  const candidates = [];

  for (const row of getFilteredRows(availability.rows, [timeWindow])) {
    const timeRange = formatTimeRange(row.timemc, row.endtimemc);
    for (const slot of iterateAvailableSlots(row, runtime)) {
      if (slot.blocked) {
        continue;
      }

      if (runtime.manualAllowedCourtSet && !runtime.manualAllowedCourtSet.has(slot.courtNo)) {
        continue;
      }

      const resourceId = buildResourceIdForSlot(runtime, slot.courtNo, timeRange);
      if (blockedResourceIds.has(resourceId)) {
        continue;
      }

      candidates.push({
        courtNo: slot.courtNo,
        timeRange,
        price: slot.price,
        resourceId,
        segmentIndex,
        preferenceRank: getCourtPreferenceRank(slot.courtNo, runtime.preferredCourtRank),
        startMinutes: toMinutes(row.timemc)
      });
    }
  }

  return candidates;
}

function* iterateAvailableSlots(row, runtime) {
  const slotCount = Number(row.cdcount ?? 0);
  const timeRange = formatTimeRange(row.timemc, row.endtimemc);

  for (let index = 1; index <= slotCount; index += 1) {
    if (row[`c${index}`] !== BOOKABLE_STATUS) {
      continue;
    }

    const courtNo = Number(row[`cdbh${index}`]);
    if (!Number.isFinite(courtNo)) {
      continue;
    }

    const price = Number(row[`price${index}`] || 0);
    const blocked = runtime.blockedPriceSet.has(price);

    if (!isCampusSlotAllowed(runtime, courtNo, timeRange)) {
      continue;
    }

    yield {
      courtNo,
      price,
      blocked,
      summary: {
        courtNo,
        price,
        blocked,
        campusClosed: false
      },
      timeRange
    };
  }
}

function createEmptyCourtSummaries() {
  return Array.from({ length: TOTAL_COURTS }, (_, index) => {
    const courtNo = index + 1;
    return {
      courtNo,
      hasAny: false,
      hasCampusClosed: false,
      slots: [],
      row: Math.floor(index / 5) + 1,
      col: (index % 5) + 1
    };
  });
}

function addCampusClosedSlots(courts, runtime) {
  if (!runtime.campusRuleContext.enabled || !runtime.campusRuleContext.hasRulesForDay) {
    return;
  }

  for (const timeRange of expandHourlyTimeRanges(runtime.timeWindows)) {
    for (const court of courts) {
      if (isCampusSlotAllowed(runtime, court.courtNo, timeRange)) {
        continue;
      }

      court.hasCampusClosed = true;
      court.slots.push({
        timeRange,
        price: 0,
        blocked: true,
        campusClosed: true
      });
    }
  }
}

function formatAvailabilitySummary(summary) {
  return summary.rows.map((row) => {
    const suffix =
      row.available.length > 0 ? row.available.map(formatCourtLabel).join(", ") : "none";
    return `${row.timeRange} | available=${row.available.length} | ${suffix}`;
  });
}

async function submitOrderWithFastRetry(runtime, payload, signature) {
  let lastError = null;

  for (let attempt = 0; attempt <= runtime.networkRetryCount; attempt += 1) {
    try {
      return {
        ok: true,
        result: await submitOrder(runtime, payload)
      };
    } catch (error) {
      lastError = error;
      if (attempt >= runtime.networkRetryCount) {
        break;
      }

      runtimeLog(
        runtime,
        `[quick-retry] submit network error on ${signature}: ${error.message}; retry ${attempt + 1}/${runtime.networkRetryCount} in ${runtime.networkRetryDelayMs}ms`
      );
      await sleep(runtime.networkRetryDelayMs);
    }
  }

  return {
    ok: false,
    error: lastError ?? new Error("Unknown submit network error")
  };
}

async function submitOrder(runtime, payload) {
  const form = new URLSearchParams({
    searchparam: JSON.stringify(payload),
    wxkey: runtime.wxkey,
    classname: "saasbllclass.CommonFuntion",
    funname: "MemberOrderfromWx"
  });

  const response = await fetchWithTimeout(`${runtime.origin}${HOME_FUNCTION_ROUTE}`, {
    method: "POST",
    headers: {
      ...runtime.requestHeaders,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: form.toString()
  }, runtime.submitTimeoutMs, "Submit request");

  if (!response.ok) {
    throw new Error(`Submit request failed with ${response.status}`);
  }

  return response.json();
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  const fetchOptions = { ...options };
  delete fetchOptions.signal;

  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new Error(`${label} aborted`);
      }
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

function buildBookingPayload(bookingDate, slots, paytype, lxbh = "Y") {
  return {
    datestring: bookingDate,
    cdstring: slots.map((slot) => `${lxbh}:${slot.courtNo},${slot.timeRange};`).join(""),
    paytype
  };
}

function getFilteredRows(rows, timeWindows) {
  const windows = Array.isArray(timeWindows) ? timeWindows : [timeWindows];
  return rows.filter((row) => windows.some((window) => isRowWithinRange(row.timemc, row.endtimemc, window)));
}

function createTimeWindows(bookingWindow) {
  const explicitSegments = Array.isArray(bookingWindow.segments)
    ? bookingWindow.segments
        .map((segment) => createTimeWindow(segment.startTime, segment.endTime))
        .filter((window) => window.startMinutes !== null && window.endMinutes !== null)
    : [];

  if (explicitSegments.length > 0) {
    return explicitSegments;
  }

  return [createTimeWindow(bookingWindow.startTime, bookingWindow.endTime)];
}

function createTimeWindow(startLabel, endLabel) {
  return {
    startLabel,
    endLabel,
    startMinutes: toMinutes(startLabel),
    endMinutes: toMinutes(endLabel)
  };
}

function createCampusRuleContext(rules, date) {
  const enabled = Boolean(rules?.enabled);
  const weekday = getWeekdayKey(date);
  const dayRules = rules?.weekdays?.[weekday] ?? [];

  return {
    enabled,
    weekday,
    hasRulesForDay: enabled && dayRules.length > 0,
    windows: dayRules
      .map((rule) => createCampusWindow(rule))
      .filter((rule) => rule.startMinutes !== null && rule.endMinutes !== null)
  };
}

function createCampusWindow(rule) {
  const [startLabel, endLabel] = String(rule.time ?? "").split("-");
  return {
    startMinutes: floorToHour(toMinutes(startLabel)),
    endMinutes: ceilToHour(toMinutes(endLabel)),
    courts: new Set(normalizeNumberList(rule.courts))
  };
}

function isCampusSlotAllowed(runtime, courtNo, timeRange) {
  const context = runtime.campusRuleContext;
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
    window.courts.has(courtNo) &&
    startMinutes >= window.startMinutes &&
    endMinutes <= window.endMinutes
  );
}

function rangesOverlap(startMinutes, endMinutes, window) {
  return startMinutes < window.endMinutes && endMinutes > window.startMinutes;
}

function expandHourlyTimeRanges(timeWindows) {
  const ranges = [];
  for (const window of timeWindows) {
    const start = floorToHour(window.startMinutes);
    const end = ceilToHour(window.endMinutes);
    if (start === null || end === null) {
      continue;
    }

    for (let minute = start; minute < end; minute += 60) {
      ranges.push(`${formatMinutes(minute)}-${formatMinutes(minute + 60)}`);
    }
  }
  return [...new Set(ranges)];
}

function getWeekdayKey(date) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return WEEKDAY_KEYS[parsed.getDay()] ?? "";
}

function floorToHour(minutes) {
  if (minutes === null) {
    return null;
  }
  return Math.floor(minutes / 60) * 60;
}

function ceilToHour(minutes) {
  if (minutes === null) {
    return null;
  }
  return Math.ceil(minutes / 60) * 60;
}

function formatMinutes(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function isRowWithinRange(rowStart, rowEnd, timeWindow) {
  const rowStartMinutes = toMinutes(rowStart);
  const rowEndMinutes = toMinutes(rowEnd);

  if (
    rowStartMinutes === null ||
    rowEndMinutes === null ||
    timeWindow.startMinutes === null ||
    timeWindow.endMinutes === null
  ) {
    return false;
  }

  return rowStartMinutes >= timeWindow.startMinutes && rowEndMinutes <= timeWindow.endMinutes;
}

function compareCandidates(left, right) {
  if (left.preferenceRank !== right.preferenceRank) {
    return left.preferenceRank - right.preferenceRank;
  }

  if (left.startMinutes !== right.startMinutes) {
    return left.startMinutes - right.startMinutes;
  }

  return left.courtNo - right.courtNo;
}

function comparePlans(left, right) {
  const leftScore = scorePlan(left);
  const rightScore = scorePlan(right);
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }

  return buildSlotSignature(left).localeCompare(buildSlotSignature(right));
}

function scorePlan(plan) {
  return plan.reduce((score, slot, index) =>
    score + slot.preferenceRank * 10000 + slot.startMinutes * 10 + slot.courtNo + index,
    0
  );
}

function getPreferredCourtOrder(config) {
  const explicit = normalizeNumberList(config.preferences?.courtNumbers);
  return explicit.length > 0 ? explicit : DEFAULT_PREFERRED_COURTS;
}

function shuffleCourtOrder(courts) {
  const shuffled = [...courts];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function getCourtPreferenceRank(courtNo, preferredCourtRank) {
  return preferredCourtRank.get(courtNo) ?? preferredCourtRank.size + courtNo;
}

function normalizeNumberList(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(number)));
}

function formatCourtLabel(entry) {
  const price = entry.price > 0 ? `@${entry.price}` : "@0";
  const blocked = entry.blocked ? "[blocked]" : "";
  return `Court${entry.courtNo}${price}${blocked}`;
}

function buildSlotSignature(slots) {
  return slots.map((slot) => `Court${slot.courtNo}@${slot.timeRange}`).join(" + ");
}

function describeBookingFailure(result) {
  if (!Array.isArray(result)) {
    return `Unexpected response: ${JSON.stringify(result)}`;
  }

  const message = [result[1], result[2], result[3]]
    .filter((item) => item !== undefined && item !== null && String(item).trim() !== "")
    .join(" | ");

  return message || JSON.stringify(result);
}

function classifyBookingFailure(result, runtime = {}) {
  const reason = describeBookingFailure(result);
  if (containsAny(reason, DAILY_LIMIT_HINTS)) {
    return {
      kind: "daily-limit",
      reason,
      blockTarget: false,
      fatal: true
    };
  }

  if (containsAny(reason, RATE_LIMIT_HINTS)) {
    return {
      kind: "rate-limit",
      reason,
      blockTarget: false,
      fatal: true
    };
  }

  if (containsAny(reason, RELEASE_NOT_OPEN_HINTS)) {
    return {
      kind: "release-not-open",
      reason,
      blockTarget: false,
      fatal: false,
      rescanBeforeNextSubmit: true
    };
  }

  if (containsAny(reason, TARGET_UNAVAILABLE_HINTS)) {
    return {
      kind: "target-unavailable",
      reason,
      blockTarget: true,
      fatal: false
    };
  }

  return {
    kind: "business-failure",
    reason,
    blockTarget: true,
    fatal: false
  };
}

function containsAny(message, hints) {
  return hints.some((hint) => String(message).includes(hint));
}

function rememberFailedSignature(failedSignatures, signature, cooldownMs) {
  if (cooldownMs <= 0) {
    return;
  }
  failedSignatures.set(signature, Date.now() + cooldownMs);
}

function rememberFailedResources(failedResourceIds, slots, cooldownMs) {
  if (cooldownMs <= 0) {
    return;
  }

  const expiresAt = Date.now() + cooldownMs;
  for (const slot of slots) {
    failedResourceIds.set(slot.resourceId, expiresAt);
  }
}

function mergeBlockedResourceIds(sharedBlockedResourceIds, failedResourceIds) {
  return new Set([
    ...sharedBlockedResourceIds,
    ...failedResourceIds.keys()
  ]);
}

function hasBlockedResource(slots, failedResourceIds) {
  return slots.some((slot) => failedResourceIds.has(slot.resourceId));
}

function pruneExpiredEntries(entries) {
  const now = Date.now();
  for (const [signature, expiresAt] of entries.entries()) {
    if (expiresAt <= now) {
      entries.delete(signature);
    }
  }
}

function describeAvailabilityFailure(result) {
  if (!Array.isArray(result)) {
    return `Unexpected availability response: ${JSON.stringify(result)}`;
  }

  const rawMessage = [result[1], result[2], result[3]]
    .filter((item) => item !== undefined && item !== null && String(item).trim() !== "")
    .join(" | ");

  const expiredMessage =
    rawMessage.includes("\u94fe\u63a5\u5df2\u7ecf\u8fc7\u671f") ||
    rawMessage.includes("\u5e95\u90e8\u83dc\u5355");

  if (expiredMessage) {
    return "Booking link expired. Re-enter from the WeChat menu and update config/local.json with the new full booking URL.";
  }

  return rawMessage || `Unexpected availability response: ${JSON.stringify(result)}`;
}

function isFatalAvailabilityError(error) {
  const message = String(error?.message ?? error);
  return (
    message.includes("Booking link expired") ||
    message.includes("\u94fe\u63a5\u5df2\u7ecf\u8fc7\u671f") ||
    message.includes("\u5e95\u90e8\u83dc\u5355") ||
    message.includes("bookingPageUrl must be the booking page URL") ||
    message.includes("bookingPageUrl is missing wxkey")
  );
}

function isBookingPageUrl(bookingUrl) {
  return /\/weixinordernewv7\.aspx$/i.test(bookingUrl.pathname);
}

function describeReservationConflict(conflicts) {
  if (!conflicts || conflicts.length === 0) {
    return "unknown shared resource conflict";
  }

  return conflicts
    .map((item) => `${item.date} Court${item.courtNo}@${item.timeRange} by ${item.sourceInstance}`)
    .join("; ");
}

function isSuccessfulBookingResult(result) {
  return Array.isArray(result) && result[0] === true;
}

function getBookingOrderId(result) {
  return getBookingOrderIds(result)[0] ?? "unknown";
}

function getBookingOrderIds(result) {
  if (!Array.isArray(result)) {
    return [];
  }

  return result
    .slice(1)
    .filter((item) => item !== undefined && item !== null && String(item).trim() !== "")
    .map((item) => String(item).trim())
    .filter(looksLikeOrderId);
}

function looksLikeOrderId(value) {
  return /^[A-Za-z]?\d{8,}$/.test(String(value).trim());
}

function formatTimeRange(start, end) {
  return `${start}-${end}`;
}

function toCompactDate(isoDate) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  return `${year}-${month}-${day}`;
}

function toMinutes(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

async function waitUntilReleaseTime(releaseAt, runtime) {
  if (!releaseAt) {
    return;
  }

  const target = parseLocalDateTime(releaseAt);
  if (!target) {
    throw new Error(`Invalid releaseAt value: ${releaseAt}`);
  }

  while (true) {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) {
      runtimeLog(runtime, `Release time reached: ${releaseAt}`);
      return;
    }

    const waitMs = Math.min(diff, 1000);
    if (diff > 5000) {
      runtimeLog(runtime, `Waiting for release time ${releaseAt}, ${Math.ceil(diff / 1000)}s remaining.`);
    }
    await sleep(waitMs);
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

async function sleepIfNeeded(attempt, maxAttempts, delayMs) {
  if (attempt < maxAttempts) {
    await sleep(delayMs);
  }
}

function buildResourceIdForSlot(runtime, courtNo, timeRange) {
  return buildResourceId({
    date: runtime.bookingDate,
    lxbh: runtime.lxbh,
    courtNo,
    timeRange
  });
}

function installReservationCleanup(registry, runtime, getSlots) {
  if (!registry.enabled) {
    return () => {};
  }

  const cleanup = async (signal) => {
    const slots = getSlots();
    if (slots.length > 0) {
      await registry.releaseSlots(slots, runtime);
      runtimeLog(runtime, `Released shared registry locks after ${signal}.`);
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  const onSigint = () => {
    cleanup("SIGINT").catch((error) => {
      runtimeLog(runtime, `Failed to cleanup after SIGINT: ${error.message}`);
      process.exit(130);
    });
  };
  const onSigterm = () => {
    cleanup("SIGTERM").catch((error) => {
      runtimeLog(runtime, `Failed to cleanup after SIGTERM: ${error.message}`);
      process.exit(143);
    });
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function maskKey(value) {
  if (!value) {
    return "missing";
  }

  const text = String(value);
  if (text.length <= 12) {
    return `${text.slice(0, 3)}...`;
  }
  return `${text.slice(0, 6)}...${text.slice(-6)}`;
}

function runtimeLog(runtime, message) {
  log(`[${runtime.instanceName}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __test__ = {
  buildAvailabilitySummary,
  buildBookingPayload,
  buildBookingPlans,
  buildResourceIdForSlot,
  buildSlotSignature,
  classifyBookingFailure,
  compareCandidates,
  createRuntime,
  describeBookingFailure,
  describeAvailabilityFailure,
  formatAvailabilitySummary,
  getBookingOrderId,
  getBookingOrderIds,
  getPreferredCourtOrder,
  isBookingPageUrl,
  isFatalAvailabilityError,
  selectBookingSlots
};
