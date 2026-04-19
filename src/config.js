import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.resolve("config", "local.json");
const EXAMPLE_CONFIG_PATH = path.resolve("config", "example.json");
const RESERVED_ROOT_KEYS = new Set([
  "global_config",
  "globalConfig",
  "instances",
  "coordination",
  "manual_override",
  "manualOverride",
  "logging"
]);
const RESERVED_GLOBAL_KEYS = new Set([
  "default_instance",
  "defaultInstance",
  "base_config",
  "baseConfig",
  "mode"
]);
const RESERVED_INSTANCE_KEYS = new Set([
  "id",
  "name",
  "port",
  "mode",
  "account",
  "apiKey",
  "key",
  "wxkey",
  "config",
  "coordination",
  "manual_override",
  "manualOverride",
  "logging"
]);

export function loadConfig(overrides = {}) {
  const configPath = resolveConfigPath(overrides.configPath);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const document = JSON.parse(raw);
  const normalized = normalizeConfigDocument(document, overrides);
  const merged = applyOverrides(normalized, overrides);

  validateConfig(merged, configPath);
  return {
    ...merged,
    __configPath: configPath,
    storageStatePath: path.resolve(merged.storageStatePath)
  };
}

function resolveConfigPath(configPath) {
  if (configPath) {
    return path.resolve(configPath);
  }

  if (process.env.GYMBOOKER_CONFIG) {
    return path.resolve(process.env.GYMBOOKER_CONFIG);
  }

  return fs.existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : EXAMPLE_CONFIG_PATH;
}

function normalizeConfigDocument(document, overrides) {
  if (!document.instances) {
    return normalizeSingleInstanceConfig(document, overrides);
  }

  const instances = normalizeInstances(document.instances);
  if (instances.length === 0) {
    throw new Error("Multi-instance config has no instances.");
  }

  const globalConfig = document.global_config ?? document.globalConfig ?? {};
  const defaultInstance = globalConfig.default_instance ?? globalConfig.defaultInstance;
  const requestedInstance = overrides.instanceName ?? defaultInstance ?? instances[0].id ?? instances[0].name;
  const selected = instances.find((instance) =>
    instance.id === requestedInstance || instance.name === requestedInstance
  );

  if (!selected) {
    throw new Error(`Instance not found in config: ${requestedInstance}`);
  }

  const rootBase = omit(document, RESERVED_ROOT_KEYS);
  const globalBase = getGlobalBaseConfig(globalConfig);
  const instanceInline = omit(selected, RESERVED_INSTANCE_KEYS);
  const instanceConfig = deepMerge(instanceInline, selected.config ?? {});
  const instanceName = selected.name ?? selected.id ?? String(requestedInstance);
  const instancePort = selected.port ?? selected.server?.port ?? instanceConfig.server?.port;
  const mode = overrides.runMode ?? selected.mode ?? globalConfig.mode ?? "auto";

  const merged = deepMerge(rootBase, globalBase, instanceConfig);

  return {
    ...merged,
    instance: {
      ...(merged.instance ?? {}),
      id: selected.id ?? instanceName,
      name: instanceName,
      mode,
      port: instancePort,
      account: selected.account ?? merged.instance?.account ?? null,
      apiKey: selected.apiKey ?? selected.key ?? selected.wxkey ?? merged.instance?.apiKey ?? null
    },
    server: {
      ...(merged.server ?? {}),
      ...(instancePort ? { port: Number(instancePort) } : {})
    },
    coordination: deepMerge(document.coordination ?? {}, selected.coordination ?? {}, merged.coordination ?? {}),
    manualOverride: normalizeManualOverride(document.manual_override ?? document.manualOverride, selected.manual_override ?? selected.manualOverride, merged.manualOverride),
    logging: deepMerge(document.logging ?? {}, selected.logging ?? {}, merged.logging ?? {})
  };
}

function normalizeSingleInstanceConfig(config, overrides) {
  const instanceName = overrides.instanceName ?? config.instance?.name ?? config.instance?.id ?? "default";
  const instancePort = config.instance?.port ?? config.server?.port;
  return {
    ...config,
    instance: {
      ...(config.instance ?? {}),
      id: config.instance?.id ?? instanceName,
      name: instanceName,
      mode: overrides.runMode ?? config.instance?.mode ?? config.runMode ?? "auto",
      port: instancePort,
      account: config.instance?.account ?? null,
      apiKey: config.instance?.apiKey ?? null
    },
    server: {
      ...(config.server ?? {}),
      ...(instancePort ? { port: Number(instancePort) } : {})
    },
    manualOverride: normalizeManualOverride(config.manual_override ?? config.manualOverride)
  };
}

function normalizeInstances(instances) {
  if (Array.isArray(instances)) {
    return instances;
  }

  return Object.entries(instances).map(([id, value]) => ({
    id,
    ...(value ?? {})
  }));
}

function getGlobalBaseConfig(globalConfig) {
  const inlineBase = omit(globalConfig, RESERVED_GLOBAL_KEYS);
  return deepMerge(inlineBase, globalConfig.base_config ?? globalConfig.baseConfig ?? {});
}

function normalizeManualOverride(...items) {
  const merged = deepMerge(...items.filter(Boolean));
  if ("allow_manual_override" in merged && !("allowManualOverride" in merged)) {
    merged.allowManualOverride = Boolean(merged.allow_manual_override);
  }
  return merged;
}

function applyOverrides(config, overrides) {
  const bookingWindow = {
    ...config.bookingWindow,
    ...(overrides.date ? { date: overrides.date } : {}),
    ...(overrides.dateLabel ? { dateLabel: overrides.dateLabel } : {}),
    ...(overrides.startTime ? { startTime: overrides.startTime } : {}),
    ...(overrides.endTime ? { endTime: overrides.endTime } : {}),
    ...(overrides.timeSegments ? { segments: overrides.timeSegments } : {}),
    ...(overrides.maxAttempts ? { maxAttempts: Number(overrides.maxAttempts) } : {})
  };

  return {
    ...config,
    ...(overrides.bookingPageUrl ? { bookingPageUrl: overrides.bookingPageUrl } : {}),
    ...(overrides.loginUrl ? { loginUrl: overrides.loginUrl } : {}),
    ...(overrides.releaseAt ? { releaseAt: overrides.releaseAt } : {}),
    ...(overrides.dryRun ? { dryRun: true } : {}),
    instance: {
      ...(config.instance ?? {}),
      ...(overrides.instanceName ? { id: config.instance?.id ?? overrides.instanceName } : {}),
      ...(overrides.runMode ? { mode: overrides.runMode } : {})
    },
    scan: {
      ...(config.scan ?? {}),
      ...(overrides.scanLoops ? { loops: Number(overrides.scanLoops) } : {}),
      ...(overrides.scanIntervalMs ? { intervalMs: Number(overrides.scanIntervalMs) } : {})
    },
    bookingWindow,
    preferences: {
      ...(config.preferences ?? {}),
      ...(overrides.courtNumbers ? { courtNumbers: overrides.courtNumbers } : {})
    },
    rules: {
      ...(config.rules ?? {}),
      ...(overrides.allowSingleSlot ? { allowSingleSlot: true } : {})
    }
  };
}

function validateConfig(config, configPath) {
  const requiredTopLevelKeys = ["loginUrl", "bookingPageUrl", "storageStatePath", "bookingWindow", "selectors"];
  for (const key of requiredTopLevelKeys) {
    if (!config[key]) {
      throw new Error(`Config ${configPath} is missing required field: ${key}`);
    }
  }

  const requiredBookingKeys = ["date", "startTime", "endTime", "maxAttempts"];
  for (const key of requiredBookingKeys) {
    if (!config.bookingWindow[key]) {
      throw new Error(`Config ${configPath} is missing bookingWindow.${key}`);
    }
  }

  if (!config.instance?.name) {
    throw new Error(`Config ${configPath} is missing instance.name.`);
  }
}

function deepMerge(...items) {
  const output = {};
  for (const item of items) {
    if (!isPlainObject(item)) {
      continue;
    }

    for (const [key, value] of Object.entries(item)) {
      if (isPlainObject(value) && isPlainObject(output[key])) {
        output[key] = deepMerge(output[key], value);
      } else if (Array.isArray(value)) {
        output[key] = [...value];
      } else {
        output[key] = value;
      }
    }
  }
  return output;
}

function omit(input, keys) {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter(([key]) => !keys.has(key))
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
