import { loadConfig } from "./config.js";
import { captureSession, runBooking } from "./booking.js";
import { runApiBooking, runAvailabilityScan } from "./api-booking.js";
import { log } from "./logger.js";

const command = process.argv[2];

async function main() {
  const overrides = parseArgs(process.argv.slice(3));
  const config = loadConfig(overrides);

  if (command === "capture-session") {
    await captureSession(config);
    return;
  }

  if (command === "book") {
    await runBooking(config);
    return;
  }

  if (command === "book-api") {
    await runApiBooking(config);
    return;
  }

  if (command === "scan-api") {
    await runAvailabilityScan(config);
    return;
  }

  throw new Error("Usage: npm run capture-session | npm run book -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 | npm run book-api -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --dry-run | npm run scan-api -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --scan-loops 30 --scan-interval-ms 500");
}

function parseArgs(args) {
  const overrides = {};

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];

    if (!key.startsWith("--")) {
      continue;
    }

    switch (key) {
      case "--config":
        overrides.configPath = value;
        index += 1;
        break;
      case "--instance":
        overrides.instanceName = value;
        index += 1;
        break;
      case "--mode":
        overrides.runMode = value;
        index += 1;
        break;
      case "--date":
        overrides.date = value;
        overrides.dateLabel = toDateLabel(value);
        index += 1;
        break;
      case "--time":
        {
          const [startTime, endTime] = String(value).split("-");
          overrides.startTime = startTime;
          overrides.endTime = endTime;
          index += 1;
        }
        break;
      case "--times":
        overrides.timeSegments = String(value)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => {
            const [startTime, endTime] = item.split("-");
            return { startTime, endTime };
          })
          .filter((item) => item.startTime && item.endTime);
        if (overrides.timeSegments.length > 0) {
          overrides.startTime = overrides.timeSegments[0].startTime;
          overrides.endTime = overrides.timeSegments[overrides.timeSegments.length - 1].endTime;
        }
        index += 1;
        break;
      case "--courts":
        overrides.courtNumbers = String(value)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item));
        index += 1;
        break;
      case "--release-at":
        overrides.releaseAt = value;
        index += 1;
        break;
      case "--booking-url":
        overrides.bookingPageUrl = value;
        index += 1;
        break;
      case "--login-url":
        overrides.loginUrl = value;
        index += 1;
        break;
      case "--max-attempts":
        overrides.maxAttempts = value;
        index += 1;
        break;
      case "--scan-loops":
        overrides.scanLoops = value;
        index += 1;
        break;
      case "--scan-interval-ms":
        overrides.scanIntervalMs = value;
        index += 1;
        break;
      case "--dry-run":
        overrides.dryRun = true;
        break;
      case "--allow-single-slot":
        overrides.allowSingleSlot = true;
        break;
      default:
        break;
    }
  }

  return overrides;
}

function toDateLabel(isoDate) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  if (!year || !month || !day) {
    return undefined;
  }

  return `${month}/${day}`;
}

main().catch((error) => {
  log(`Failed: ${error.message}`);
  process.exitCode = 1;
});
