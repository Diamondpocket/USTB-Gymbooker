import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getStructuredAvailability } from "./api-booking.js";
import { loadConfig } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "ui");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const LOG_DIR = path.join(ROOT, "logs");
const MAX_LOG_BYTES = 300000;
const SERVER_OPTIONS = parseServerArgs(process.argv.slice(2));
const CONFIG_PATH = path.resolve(SERVER_OPTIONS.configPath ?? process.env.GYMBOOKER_CONFIG ?? path.join(ROOT, "config", "local.json"));
const INITIAL_CONFIG = readConfigSnapshot();
const INSTANCE_NAME = INITIAL_CONFIG.instance?.name ?? INITIAL_CONFIG.instance?.id ?? SERVER_OPTIONS.instanceName ?? "default";
const PORT = Number(SERVER_OPTIONS.port ?? process.env.GYMBOOKER_PORT ?? INITIAL_CONFIG.server?.port ?? INITIAL_CONFIG.instance?.port ?? 3210);
const LOG_PATH = INSTANCE_NAME === "default"
  ? path.join(LOG_DIR, "gymbooker.log")
  : path.join(LOG_DIR, `gymbooker-${sanitizeFileName(INSTANCE_NAME)}.log`);

let activeStreamChild = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/config") {
      return sendJson(res, 200, {
        ...readConfig(),
        appVersion: readPackageVersion()
      });
    }

    if (req.method === "GET" && req.url === "/api/logs") {
      return sendText(res, 200, readRecentLog());
    }

    if (req.method === "POST" && req.url === "/api/config") {
      const body = await readJsonBody(req);
      saveConfig(body);
      appendLogLine("Config saved.");
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/api/run") {
      const body = await readJsonBody(req);
      const result = await runCommand(body);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && req.url === "/api/run-stream") {
      const body = await readJsonBody(req);
      return streamCommand(res, body);
    }

    if (req.method === "POST" && req.url === "/api/cancel") {
      return sendJson(res, 200, cancelActiveCommand());
    }

    if (req.method === "POST" && req.url === "/api/availability") {
      const body = await readJsonBody(req);
      const config = mergeConfigWithBody(readConfig(), body);
      const summary = await getStructuredAvailability(config);
      return sendJson(res, 200, summary);
    }

    if (req.method === "GET") {
      return serveStatic(req, res);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    appendLogLine(`Server error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
});

server.on("error", (error) => {
  appendLogLine(`UI server failed on port ${PORT}: ${error.message}`);
  console.error(`UI server failed on port ${PORT}: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, () => {
  appendLogLine(`UI server running at http://localhost:${PORT}, config=${CONFIG_PATH}`);
  console.log(`UI server running at http://localhost:${PORT}`);
});

function readConfig() {
  return loadConfig({
    configPath: CONFIG_PATH,
    instanceName: INSTANCE_NAME
  });
}

function readConfigSnapshot() {
  return loadConfig({
    configPath: CONFIG_PATH,
    instanceName: SERVER_OPTIONS.instanceName
  });
}

function readPackageVersion() {
  const raw = fs.readFileSync(PACKAGE_PATH, "utf-8");
  return JSON.parse(raw).version;
}

function saveConfig(body) {
  const clean = sanitizeRuntimeConfig(body);
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const document = JSON.parse(raw);

  if (!document.instances) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2));
    return;
  }

  const baseConfig = ensureBaseConfig(document);
  baseConfig.releaseAt = clean.releaseAt;
  baseConfig.bookingWindow = clean.bookingWindow;
  baseConfig.preferences = clean.preferences;
  baseConfig.rules = clean.rules;
  baseConfig.scan = clean.scan;

  const instance = findCurrentInstance(document);
  instance.config = {
    ...(instance.config ?? {}),
    loginUrl: clean.loginUrl,
    bookingPageUrl: clean.bookingPageUrl,
    storageStatePath: clean.storageStatePath ?? instance.config?.storageStatePath
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(document, null, 2));
}

function sanitizeRuntimeConfig(config) {
  const clone = structuredClone(config);
  delete clone.appVersion;
  delete clone.__configPath;
  delete clone.instance;
  delete clone.server;
  return clone;
}

function ensureBaseConfig(document) {
  document.global_config = document.global_config ?? {};
  document.global_config.base_config = document.global_config.base_config ?? {};
  return document.global_config.base_config;
}

function findCurrentInstance(document) {
  const instances = Array.isArray(document.instances)
    ? document.instances
    : Object.entries(document.instances).map(([id, value]) => {
        value.id = value.id ?? id;
        return value;
      });
  const instance = instances.find((item) =>
    item.id === SERVER_OPTIONS.instanceName ||
    item.name === SERVER_OPTIONS.instanceName ||
    item.id === INSTANCE_NAME ||
    item.name === INSTANCE_NAME
  );

  if (!instance) {
    throw new Error(`Cannot find current instance in config: ${INSTANCE_NAME}`);
  }

  return instance;
}

function mergeConfigWithBody(config, body) {
  return {
    ...config,
    bookingWindow: {
      ...config.bookingWindow,
      ...(body.date ? { date: body.date } : {}),
      ...(Array.isArray(body.timeSegments) && body.timeSegments.length > 0
        ? {
            segments: body.timeSegments,
            startTime: body.timeSegments[0].startTime,
            endTime: body.timeSegments[body.timeSegments.length - 1].endTime
          }
        : {}),
      ...(body.time
        ? {
            startTime: String(body.time).split("-")[0],
            endTime: String(body.time).split("-")[1]
          }
        : {})
    },
    ...(body.bookingPageUrl
      ? {
          bookingPageUrl: body.bookingPageUrl,
          loginUrl: body.bookingPageUrl
        }
      : {}),
    preferences: {
      courtKeywords: config.preferences?.courtKeywords ?? [],
      ...(body.courts ? { courtNumbers: body.courts } : {})
    },
    rules: {
      ...(config.rules ?? {}),
      ...(typeof body.allowSingleSlot === "boolean"
        ? { allowSingleSlot: body.allowSingleSlot }
        : {})
    },
    scan: {
      ...(config.scan ?? {}),
      ...(body.scanLoops ? { loops: Number(body.scanLoops) } : {}),
      ...(body.scanIntervalMs ? { intervalMs: Number(body.scanIntervalMs) } : {})
    }
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf-8");
  return body ? JSON.parse(body) : {};
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function serveStatic(req, res) {
  const target = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.normalize(path.join(PUBLIC_DIR, target));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function runCommand(body) {
  const args = buildCommandArgs(body);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      const command = `${process.execPath} ${args.join(" ")}`;
      appendLogBlock([`Command: ${command}`, stdout, stderr, `Exit code: ${code}`].join("\n"));
      resolve({
        ok: code === 0,
        code,
        command,
        stdout,
        stderr
      });
    });
  });
}

function streamCommand(res, body) {
  if (activeStreamChild && activeStreamChild.exitCode === null && !activeStreamChild.killed) {
    res.writeHead(409, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end("A command is already running. Cancel it first.\n");
    return;
  }

  const args = buildCommandArgs(body);
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });

  const command = `${process.execPath} ${args.join(" ")}`;
  writeStream(res, `Command: ${command}\n`);
  writeStream(res, "----- live log start -----\n");

  if (body.dryRun) {
    writeStream(res, "Dry run: this will not submit an order. It only searches and prints the payload when a target is found.\n");
  }

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    windowsHide: true
  });
  activeStreamChild = child;

  child.stdout.on("data", (chunk) => {
    writeStream(res, chunk.toString("utf-8"));
  });

  child.stderr.on("data", (chunk) => {
    writeStream(res, `[stderr] ${chunk.toString("utf-8")}`);
  });

  child.on("close", (code, signal) => {
    if (activeStreamChild === child) {
      activeStreamChild = null;
    }
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    if (!res.writableEnded) {
      writeStream(res, `\n----- command ended, ${reason} -----\n`);
      res.end();
    } else {
      appendLogLine(`Command ended, ${reason}.`);
    }
  });

  child.on("error", (error) => {
    if (activeStreamChild === child) {
      activeStreamChild = null;
    }
    if (!res.writableEnded) {
      writeStream(res, `\n[server] Failed to start command: ${error.message}\n`);
      res.end();
    } else {
      appendLogLine(`Failed to start command: ${error.message}`);
    }
  });

  res.on("close", () => {
    if (activeStreamChild === child && child.exitCode === null && !child.killed) {
      child.kill();
      activeStreamChild = null;
      appendLogLine("Client connection closed. Command killed.");
    }
  });
}

function cancelActiveCommand() {
  if (!activeStreamChild || activeStreamChild.exitCode !== null || activeStreamChild.killed) {
    appendLogLine("Cancel requested, but no active command was running.");
    return {
      ok: false,
      message: "No active command."
    };
  }

  const pid = activeStreamChild.pid;
  activeStreamChild.kill();
  activeStreamChild = null;
  appendLogLine(`Cancelled running command (pid ${pid}).`);
  return {
    ok: true,
    message: `Cancelled running command (pid ${pid}).`
  };
}

function buildCommandArgs(body) {
  const mode = body.mode;
  const args = ["src/index.js", mode];

  pushArg(args, "--config", CONFIG_PATH);
  pushArg(args, "--instance", INSTANCE_NAME);
  pushArg(args, "--date", body.date);
  if (Array.isArray(body.timeSegments) && body.timeSegments.length > 1) {
    pushArg(args, "--times", body.timeSegments.map((segment) => `${segment.startTime}-${segment.endTime}`).join(","));
  } else {
    pushArg(args, "--time", body.time);
  }
  pushArg(args, "--booking-url", body.bookingPageUrl);
  pushArg(args, "--courts", Array.isArray(body.courts) ? body.courts.join(",") : body.courts);
  pushArg(args, "--release-at", body.releaseAt);
  pushArg(args, "--scan-loops", body.scanLoops);
  pushArg(args, "--scan-interval-ms", body.scanIntervalMs);
  pushArg(args, "--max-attempts", body.maxAttempts);
  pushBooleanFlag(args, "--allow-single-slot", body.allowSingleSlot);
  if (body.dryRun) {
    args.push("--dry-run");
  }

  return args;
}

function pushArg(args, flag, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  args.push(flag, String(value));
}

function pushBooleanFlag(args, flag, enabled) {
  if (enabled === true) {
    args.push(flag);
  }
}

function parseServerArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];

    if (!key.startsWith("--")) {
      continue;
    }

    switch (key) {
      case "--config":
        options.configPath = value;
        index += 1;
        break;
      case "--instance":
        options.instanceName = value;
        index += 1;
        break;
      case "--port":
        options.port = value;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function isMultiInstanceConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return Boolean(JSON.parse(raw).instances);
  } catch {
    return false;
  }
}

function sanitizeFileName(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80) || "default";
}

function writeStream(res, chunk) {
  appendLog(chunk);
  res.write(chunk);
}

function appendLogLine(message) {
  appendLog(`[${new Date().toLocaleString("zh-CN", { hour12: false })}][${INSTANCE_NAME}] ${message}\n`);
}

function appendLogBlock(message) {
  appendLog(`\n[${new Date().toLocaleString("zh-CN", { hour12: false })}][${INSTANCE_NAME}]\n${message}\n`);
}

function appendLog(message) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, message, "utf-8");
}

function readRecentLog() {
  if (!fs.existsSync(LOG_PATH)) {
    return "No logs yet.";
  }

  const stats = fs.statSync(LOG_PATH);
  const start = Math.max(0, stats.size - MAX_LOG_BYTES);
  const length = stats.size - start;
  const fd = fs.openSync(LOG_PATH, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}
