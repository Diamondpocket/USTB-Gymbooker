import fs from "node:fs";
import path from "node:path";

const DEFAULT_STATE_PATH = ".coordination/resource-registry.json";
const DEFAULT_LOCK_PATH = ".coordination/resource-registry.lock";
const DEFAULT_LOCK_TTL_MS = 90000;
const DEFAULT_BOOKED_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 1200;
const DEFAULT_LOCK_RETRY_MS = 30;
const DEFAULT_FILE_LOCK_STALE_MS = 5000;

export function createResourceRegistry(config) {
  const coordination = config.coordination ?? {};
  if (coordination.enabled !== true) {
    return new DisabledResourceRegistry();
  }

  return new FileResourceRegistry({
    statePath: path.resolve(coordination.statePath ?? DEFAULT_STATE_PATH),
    lockPath: path.resolve(coordination.lockPath ?? DEFAULT_LOCK_PATH),
    lockTtlMs: Number(coordination.lockTtlMs ?? DEFAULT_LOCK_TTL_MS),
    bookedTtlMs: Number(coordination.bookedTtlMs ?? DEFAULT_BOOKED_TTL_MS),
    lockWaitMs: Number(coordination.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS),
    lockRetryMs: Number(coordination.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS),
    fileLockStaleMs: Number(coordination.fileLockStaleMs ?? DEFAULT_FILE_LOCK_STALE_MS)
  });
}

export function buildResourceId({ date, lxbh, courtNo, timeRange }) {
  return [date, lxbh, Number(courtNo), timeRange].join("|");
}

class DisabledResourceRegistry {
  get enabled() {
    return false;
  }

  async getBlockedResourceIds() {
    return new Set();
  }

  async reserveSlots() {
    return { ok: true, conflicts: [], reserved: [] };
  }

  async releaseSlots() {
    return { ok: true };
  }

  async markBooked() {
    return { ok: true };
  }
}

class FileResourceRegistry {
  constructor(options) {
    this.options = options;
  }

  get enabled() {
    return true;
  }

  async getBlockedResourceIds(scope, sourceInstance) {
    return this.withLock((state) => {
      const now = Date.now();
      const active = pruneExpired(state, now);
      const ids = new Set();

      for (const resource of active.resources) {
        if (!matchesScope(resource, scope) || resource.sourceInstance === sourceInstance) {
          continue;
        }
        if (resource.status === "selected" || resource.status === "booked") {
          ids.add(resource.id);
        }
      }

      state.resources = active.resources;
      state.updatedAt = new Date(now).toISOString();
      return ids;
    });
  }

  async reserveSlots({ slots, runtime, allowOverride = false, manualOverride = false }) {
    return this.withLock((state) => {
      const now = Date.now();
      state.resources = pruneExpired(state, now).resources;

      const incoming = slots.map((slot) => toResourceRecord(slot, runtime, {
        status: "selected",
        expiresAt: new Date(now + this.options.lockTtlMs).toISOString(),
        manualOverride,
        now
      }));

      const conflicts = [];
      for (const resource of incoming) {
        const existing = state.resources.find((item) =>
          item.id === resource.id &&
          item.sourceInstance !== runtime.instanceName &&
          (item.status === "selected" || item.status === "booked")
        );
        if (existing) {
          conflicts.push(existing);
        }
      }

      if (conflicts.length > 0 && !allowOverride) {
        return { ok: false, conflicts, reserved: [] };
      }

      if (conflicts.length > 0 && allowOverride) {
        state.resources = state.resources.filter((item) => !incoming.some((resource) => resource.id === item.id));
      }

      state.resources = state.resources.filter((item) =>
        !incoming.some((resource) => resource.id === item.id && item.sourceInstance === runtime.instanceName)
      );
      state.resources.push(...incoming);
      state.updatedAt = new Date(now).toISOString();
      return { ok: true, conflicts, reserved: incoming };
    });
  }

  async releaseSlots(slots, runtime) {
    return this.withLock((state) => {
      const ids = new Set(slots.map((slot) => buildResourceId({
        date: runtime.bookingDate,
        lxbh: runtime.lxbh,
        courtNo: slot.courtNo,
        timeRange: slot.timeRange
      })));
      state.resources = pruneExpired(state, Date.now()).resources.filter((resource) =>
        !(ids.has(resource.id) && resource.sourceInstance === runtime.instanceName)
      );
      state.updatedAt = new Date().toISOString();
      return { ok: true };
    });
  }

  async markBooked(slots, runtime) {
    return this.withLock((state) => {
      const now = Date.now();
      const ids = new Set(slots.map((slot) => buildResourceId({
        date: runtime.bookingDate,
        lxbh: runtime.lxbh,
        courtNo: slot.courtNo,
        timeRange: slot.timeRange
      })));

      state.resources = pruneExpired(state, now).resources.map((resource) => {
        if (ids.has(resource.id) && resource.sourceInstance === runtime.instanceName) {
          return {
            ...resource,
            status: "booked",
            updatedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + this.options.bookedTtlMs).toISOString()
          };
        }
        return resource;
      });
      state.updatedAt = new Date(now).toISOString();
      return { ok: true };
    });
  }

  async withLock(callback) {
    await acquireLock(
      this.options.lockPath,
      this.options.lockWaitMs,
      this.options.lockRetryMs,
      this.options.fileLockStaleMs
    );
    try {
      const state = readState(this.options.statePath);
      const result = callback(state);
      writeState(this.options.statePath, state);
      return result;
    } finally {
      releaseLock(this.options.lockPath);
    }
  }
}

function toResourceRecord(slot, runtime, { status, expiresAt, manualOverride, now }) {
  const updatedAt = new Date(now).toISOString();
  return {
    id: buildResourceId({
      date: runtime.bookingDate,
      lxbh: runtime.lxbh,
      courtNo: slot.courtNo,
      timeRange: slot.timeRange
    }),
    date: runtime.bookingDate,
    lxbh: runtime.lxbh,
    courtNo: slot.courtNo,
    timeRange: slot.timeRange,
    sourceInstance: runtime.instanceName,
    accountLabel: runtime.accountLabel,
    status,
    manualOverride: Boolean(manualOverride),
    lockedAt: updatedAt,
    updatedAt,
    expiresAt
  };
}

function matchesScope(resource, scope) {
  return resource.date === scope.date && resource.lxbh === scope.lxbh;
}

function pruneExpired(state, now) {
  return {
    ...state,
    resources: state.resources.filter((resource) => {
      const expiresAt = Date.parse(resource.expiresAt);
      return Number.isNaN(expiresAt) || expiresAt > now;
    })
  };
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) {
    return { version: 1, updatedAt: new Date().toISOString(), resources: [] };
  }

  const raw = fs.readFileSync(statePath, "utf-8");
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  return {
    version: parsed.version ?? 1,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    resources: Array.isArray(parsed.resources) ? parsed.resources : []
  };
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
  fs.renameSync(tempPath, statePath);
}

async function acquireLock(lockPath, waitMs, retryMs, staleMs) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      removeStaleLock(lockPath, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for coordination lock: ${lockPath}`);
      }
      await sleep(retryMs);
    }
  }
}

function removeStaleLock(lockPath, staleMs) {
  try {
    const stats = fs.statSync(lockPath);
    if (Date.now() - stats.mtimeMs > staleMs) {
      fs.unlinkSync(lockPath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
