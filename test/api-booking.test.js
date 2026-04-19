import test from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../src/api-booking.js";

function makeConfig(overrides = {}) {
  return {
    bookingPageUrl: "http://example.com/weixinordernewv7.aspx?wxkey=test-key&lxbh=Y",
    bookingWindow: {
      date: "2026-04-16",
      startTime: "08:00",
      endTime: "10:00",
      maxAttempts: 10
    },
    rules: {
      blockedPrices: [60, 120],
      requiredCourtCount: 2
    },
    preferences: {
      courtNumbers: []
    },
    pollIntervalMs: 500,
    ...overrides
  };
}

function makeAvailability(rows) {
  return { rows };
}

test("selectBookingSlots randomizes inside selected courts and keeps times distinct", () => {
  const runtime = __test__.createRuntime(makeConfig({
    preferences: {
      courtNumbers: [17, 18, 16]
    }
  }));

  const availability = makeAvailability([
    {
      timemc: "8:00",
      endtimemc: "9:00",
      cdcount: "3",
      cdbh1: "17",
      c1: "i",
      price1: "10",
      cdbh2: "18",
      c2: "i",
      price2: "10",
      cdbh3: "16",
      c3: "i",
      price3: "10"
    },
    {
      timemc: "9:00",
      endtimemc: "10:00",
      cdcount: "3",
      cdbh1: "17",
      c1: "i",
      price1: "10",
      cdbh2: "18",
      c2: "i",
      price2: "10",
      cdbh3: "16",
      c3: "i",
      price3: "10"
    }
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime);

  assert.equal(selected.length, 2);
  assert.deepEqual([...runtime.preferredCourtRank.keys()].sort((left, right) => left - right), [16, 17, 18]);
  assert.ok(selected.every((slot) => [16, 17, 18].includes(slot.courtNo)));
  assert.notEqual(selected[0].timeRange, selected[1].timeRange);
});

test("selectBookingSlots skips resources locked by other instances", () => {
  const runtime = __test__.createRuntime(makeConfig({
    preferences: {
      courtNumbers: [18, 17, 16]
    }
  }));

  const availability = makeAvailability([
    {
      timemc: "8:00",
      endtimemc: "9:00",
      cdcount: "2",
      cdbh1: "18",
      c1: "i",
      price1: "10",
      cdbh2: "17",
      c2: "i",
      price2: "10"
    },
    {
      timemc: "9:00",
      endtimemc: "10:00",
      cdcount: "2",
      cdbh1: "18",
      c1: "i",
      price1: "10",
      cdbh2: "16",
      c2: "i",
      price2: "10"
    }
  ]);
  const blocked = new Set([
    __test__.buildResourceIdForSlot(runtime, 18, "8:00-9:00"),
    __test__.buildResourceIdForSlot(runtime, 18, "9:00-10:00")
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime, blocked);

  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((slot) => slot.courtNo).sort((left, right) => left - right), [16, 17]);
});

test("selectBookingSlots can pick one slot from each configured time segment", () => {
  const runtime = __test__.createRuntime(makeConfig({
    bookingWindow: {
      date: "2026-04-16",
      startTime: "08:00",
      endTime: "19:00",
      segments: [
        { startTime: "08:00", endTime: "09:00" },
        { startTime: "18:00", endTime: "19:00" }
      ],
      maxAttempts: 10
    },
    preferences: {
      courtNumbers: [18, 17, 16]
    }
  }));

  const availability = makeAvailability([
    {
      timemc: "8:00",
      endtimemc: "9:00",
      cdcount: "2",
      cdbh1: "17",
      c1: "i",
      price1: "10",
      cdbh2: "18",
      c2: "i",
      price2: "10"
    },
    {
      timemc: "12:00",
      endtimemc: "13:00",
      cdcount: "1",
      cdbh1: "18",
      c1: "i",
      price1: "10"
    },
    {
      timemc: "18:00",
      endtimemc: "19:00",
      cdcount: "2",
      cdbh1: "16",
      c1: "i",
      price1: "10",
      cdbh2: "18",
      c2: "i",
      price2: "10"
    }
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime);

  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((slot) => slot.timeRange), ["8:00-9:00", "18:00-19:00"]);
  assert.ok(selected.every((slot) => [16, 17, 18].includes(slot.courtNo)));
});

test("buildBookingPlans creates fast-switch alternatives from one scan", () => {
  const runtime = __test__.createRuntime(makeConfig({
    bookingWindow: {
      date: "2026-04-16",
      startTime: "08:00",
      endTime: "19:00",
      segments: [
        { startTime: "08:00", endTime: "09:00" },
        { startTime: "18:00", endTime: "19:00" }
      ],
      maxAttempts: 10
    },
    preferences: {
      courtNumbers: [18, 17, 16]
    },
    optimization: {
      maxPlansPerScan: 4
    }
  }));

  const availability = makeAvailability([
    {
      timemc: "8:00",
      endtimemc: "9:00",
      cdcount: "2",
      cdbh1: "18",
      c1: "i",
      price1: "10",
      cdbh2: "17",
      c2: "i",
      price2: "10"
    },
    {
      timemc: "18:00",
      endtimemc: "19:00",
      cdcount: "2",
      cdbh1: "18",
      c1: "i",
      price1: "10",
      cdbh2: "16",
      c2: "i",
      price2: "10"
    }
  ]);

  const plans = __test__.buildBookingPlans(availability, runtime);

  assert.ok(plans.length > 1);
  assert.ok(plans.every((plan) => plan.length === 2));
  assert.ok(new Set(plans.map(__test__.buildSlotSignature)).size === plans.length);
});

test("buildBookingPlans skips recently failed signatures", () => {
  const runtime = __test__.createRuntime(makeConfig({
    bookingWindow: {
      date: "2026-04-16",
      startTime: "08:00",
      endTime: "19:00",
      segments: [
        { startTime: "08:00", endTime: "09:00" },
        { startTime: "18:00", endTime: "19:00" }
      ],
      maxAttempts: 10
    },
    preferences: {
      courtNumbers: [18, 17, 16]
    }
  }));
  const availability = makeAvailability([
    {
      timemc: "8:00",
      endtimemc: "9:00",
      cdcount: "2",
      cdbh1: "18",
      c1: "i",
      price1: "10",
      cdbh2: "17",
      c2: "i",
      price2: "10"
    },
    {
      timemc: "18:00",
      endtimemc: "19:00",
      cdcount: "2",
      cdbh1: "18",
      c1: "i",
      price1: "10",
      cdbh2: "16",
      c2: "i",
      price2: "10"
    }
  ]);
  const firstPlan = __test__.buildBookingPlans(availability, runtime)[0];
  const failed = new Map([[__test__.buildSlotSignature(firstPlan), Date.now() + 5000]]);

  const plans = __test__.buildBookingPlans(availability, runtime, new Set(), failed);

  assert.notEqual(__test__.buildSlotSignature(plans[0]), __test__.buildSlotSignature(firstPlan));
});

test("classifyBookingFailure treats rate-limit hints as fatal safety stops", () => {
  const failure = __test__.classifyBookingFailure([false, "\u60a8\u8ba2\u573a\u592a\u7d2f\u4e86\uff0c\u5750\u4e0b\u559d\u53e3\u6c34\u518d\u6765\u5427"]);

  assert.equal(failure.kind, "rate-limit");
  assert.equal(failure.fatal, true);
  assert.equal(failure.blockTarget, false);
});

test("classifyBookingFailure stops on daily booking limit", () => {
  const failure = __test__.classifyBookingFailure([false, "\u4eca\u5929\u5df2\u7ecf\u9884\u8ba2\u4e861\u6b21\uff0c\u4e0d\u80fd\u518d\u9884\u8ba2"]);

  assert.equal(failure.kind, "daily-limit");
  assert.equal(failure.fatal, true);
  assert.equal(failure.blockTarget, false);
});

test("classifyBookingFailure keeps trying before release opens", () => {
  const failure = __test__.classifyBookingFailure([false, "\u4eb2\uff0c\u60a8\u5173\u6ce8\u7684\u7403\u9986\u8fd8\u6ca1\u6709\u4e0a\u7ebf\u54e6\u3002\u7b49\u4e0b\u518d\u8bd5\u8bd5\u5427!!"]);

  assert.equal(failure.kind, "release-not-open");
  assert.equal(failure.fatal, false);
  assert.equal(failure.blockTarget, false);
  assert.equal(failure.rescanBeforeNextSubmit, true);
});

test("createRuntime keeps long submit timeout and zero submit retry by default", () => {
  const runtime = __test__.createRuntime(makeConfig({
    optimization: {
      submitTimeoutMs: 120000
    }
  }));

  assert.equal(runtime.submitTimeoutMs, 120000);
  assert.equal(runtime.networkRetryCount, 0);
});

test("allowSingleSlot accepts one slot when fallback is enabled", () => {
  const runtime = __test__.createRuntime(makeConfig({
    rules: {
      blockedPrices: [60, 120],
      requiredCourtCount: 2,
      allowSingleSlot: true
    }
  }));

  const availability = makeAvailability([
    {
      timemc: "8:00",
      endtimemc: "9:00",
      cdcount: "1",
      cdbh1: "18",
      c1: "i",
      price1: "10"
    }
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime);

  assert.equal(runtime.minimumSlotCount, 1);
  assert.equal(runtime.targetSlotCount, 2);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].courtNo, 18);
});

test("buildBookingPayload uses lxbh-prefixed cdstring format", () => {
  const payload = __test__.buildBookingPayload(
    "2026-4-15",
    [{ courtNo: 18, timeRange: "8:00-9:00" }],
    "M",
    "Y"
  );

  assert.deepEqual(payload, {
    datestring: "2026-4-15",
    cdstring: "Y:18,8:00-9:00;",
    paytype: "M"
  });
});

test("getBookingOrderId extracts the backend order id", () => {
  assert.equal(__test__.getBookingOrderId([true, "Y26040900134", null, null]), "Y26040900134");
  assert.equal(__test__.getBookingOrderId([true, null, "", undefined]), "unknown");
  assert.deepEqual(__test__.getBookingOrderIds([true, "Y26041700016", "Y26041700017", null]), [
    "Y26041700016",
    "Y26041700017"
  ]);
  assert.deepEqual(__test__.getBookingOrderIds([true, "Y26041700016", "\u9884\u8ba2\u6210\u529f", null]), [
    "Y26041700016"
  ]);
});

test("buildAvailabilitySummary marks blocked prices without losing rows", () => {
  const runtime = __test__.createRuntime(makeConfig());
  const availability = makeAvailability([
    {
      timemc: "8:00",
      endtimemc: "9:00",
      cdcount: "2",
      cdbh1: "2",
      c1: "i",
      price1: "10",
      cdbh2: "18",
      c2: "i",
      price2: "120"
    }
  ]);

  const summary = __test__.buildAvailabilitySummary(availability, runtime);
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].available.length, 2);

  const court2 = summary.courts.find((court) => court.courtNo === 2);
  const court18 = summary.courts.find((court) => court.courtNo === 18);

  assert.equal(court2.slots[0].blocked, false);
  assert.equal(court18.slots[0].blocked, true);
});

test("campus rules floor half-hour starts and filter closed courts", () => {
  const runtime = __test__.createRuntime(makeConfig({
    bookingWindow: {
      date: "2026-04-23",
      startTime: "13:00",
      endTime: "15:00",
      maxAttempts: 10
    },
    preferences: {
      courtNumbers: [15, 16]
    },
    campusAvailabilityRules: {
      enabled: true,
      weekdays: {
        thursday: [
          { time: "13:30-15:00", courts: [16] }
        ]
      }
    }
  }));
  const availability = makeAvailability([
    {
      timemc: "13:00",
      endtimemc: "14:00",
      cdcount: "2",
      cdbh1: "15",
      c1: "i",
      price1: "10",
      cdbh2: "16",
      c2: "i",
      price2: "10"
    }
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime);
  const summary = __test__.buildAvailabilitySummary(availability, runtime);
  const court15 = summary.courts.find((court) => court.courtNo === 15);
  const court16 = summary.courts.find((court) => court.courtNo === 16);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].courtNo, 16);
  assert.equal(court15.hasAny, false);
  assert.equal(court15.hasCampusClosed, true);
  assert.equal(court16.hasAny, true);
});

test("campus rules leave unmentioned time ranges open", () => {
  const runtime = __test__.createRuntime(makeConfig({
    bookingWindow: {
      date: "2026-04-23",
      startTime: "12:00",
      endTime: "13:00",
      maxAttempts: 10
    },
    preferences: {
      courtNumbers: [15]
    },
    campusAvailabilityRules: {
      enabled: true,
      weekdays: {
        thursday: [
          { time: "13:30-15:00", courts: [16] }
        ]
      }
    }
  }));
  const availability = makeAvailability([
    {
      timemc: "12:00",
      endtimemc: "13:00",
      cdcount: "1",
      cdbh1: "15",
      c1: "i",
      price1: "10"
    }
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].courtNo, 15);
});

test("campus rules can explicitly close a time range", () => {
  const runtime = __test__.createRuntime(makeConfig({
    bookingWindow: {
      date: "2026-04-22",
      startTime: "13:00",
      endTime: "15:00",
      maxAttempts: 10
    },
    preferences: {
      courtNumbers: [11]
    },
    campusAvailabilityRules: {
      enabled: true,
      weekdays: {
        wednesday: [
          { time: "13:30-15:00", courts: [] }
        ]
      }
    }
  }));
  const availability = makeAvailability([
    {
      timemc: "13:00",
      endtimemc: "14:00",
      cdcount: "1",
      cdbh1: "11",
      c1: "i",
      price1: "10"
    }
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime);

  assert.equal(selected.length, 0);
});

test("campus rules close monday 10-12", () => {
  const runtime = __test__.createRuntime(makeConfig({
    bookingWindow: {
      date: "2026-04-20",
      startTime: "10:00",
      endTime: "12:00",
      maxAttempts: 10
    },
    preferences: {
      courtNumbers: [11, 10]
    },
    campusAvailabilityRules: {
      enabled: true,
      weekdays: {
        monday: [
          { time: "10:00-12:00", courts: [] },
          { time: "13:00-15:00", courts: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] }
        ]
      }
    }
  }));
  const availability = makeAvailability([
    {
      timemc: "10:00",
      endtimemc: "11:00",
      cdcount: "2",
      cdbh1: "11",
      c1: "i",
      price1: "10",
      cdbh2: "10",
      c2: "i",
      price2: "10"
    }
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime);

  assert.equal(selected.length, 0);
});

test("campus rules handle restricted and normal monday segments independently", () => {
  const runtime = __test__.createRuntime(makeConfig({
    bookingWindow: {
      date: "2026-04-20",
      startTime: "13:00",
      endTime: "16:00",
      segments: [
        { startTime: "13:00", endTime: "14:00" },
        { startTime: "15:00", endTime: "16:00" }
      ],
      maxAttempts: 10
    },
    preferences: {
      courtNumbers: [11, 10]
    },
    campusAvailabilityRules: {
      enabled: true,
      weekdays: {
        monday: [
          { time: "10:00-12:00", courts: [] },
          { time: "13:00-15:00", courts: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] }
        ]
      }
    }
  }));
  const availability = makeAvailability([
    {
      timemc: "13:00",
      endtimemc: "14:00",
      cdcount: "2",
      cdbh1: "11",
      c1: "i",
      price1: "10",
      cdbh2: "10",
      c2: "i",
      price2: "10"
    },
    {
      timemc: "15:00",
      endtimemc: "16:00",
      cdcount: "1",
      cdbh1: "10",
      c1: "i",
      price1: "10"
    }
  ]);

  const selected = __test__.selectBookingSlots(availability, runtime);

  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((slot) => slot.timeRange), ["13:00-14:00", "15:00-16:00"]);
  assert.deepEqual(selected.map((slot) => slot.courtNo), [11, 10]);
});

test("describeBookingFailure keeps the first useful backend message", () => {
  assert.equal(
    __test__.describeBookingFailure([false, "您订场太累太辛苦了，坐下喝口水再来吧。", null]),
    "您订场太累太辛苦了，坐下喝口水再来吧。"
  );
});
