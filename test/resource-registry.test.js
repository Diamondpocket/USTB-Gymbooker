import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResourceRegistry } from "../src/resource-registry.js";

test("resource registry rejects conflicting selected slots", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gymbooker-registry-"));
  const registry = createResourceRegistry({
    coordination: {
      enabled: true,
      statePath: path.join(tempDir, "state.json"),
      lockPath: path.join(tempDir, "state.lock"),
      lockTtlMs: 60000,
      bookedTtlMs: 60000,
      fileLockStaleMs: 1000
    }
  });
  const slots = [{ courtNo: 18, timeRange: "8:00-9:00" }];
  const runtimeA = {
    bookingDate: "2026-4-16",
    lxbh: "Y",
    instanceName: "card-a",
    accountLabel: "card-a"
  };
  const runtimeB = {
    ...runtimeA,
    instanceName: "card-b",
    accountLabel: "card-b"
  };

  const reserved = await registry.reserveSlots({ slots, runtime: runtimeA });
  const blocked = await registry.getBlockedResourceIds({ date: "2026-4-16", lxbh: "Y" }, "card-b");
  const conflict = await registry.reserveSlots({ slots, runtime: runtimeB });

  assert.equal(reserved.ok, true);
  assert.equal(blocked.size, 1);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflicts[0].sourceInstance, "card-a");
});
