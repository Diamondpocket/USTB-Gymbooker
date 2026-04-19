import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("loadConfig selects one instance from a multi-instance config", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gymbooker-config-"));
  const configPath = path.join(tempDir, "multi.json");
  fs.writeFileSync(configPath, JSON.stringify({
    global_config: {
      default_instance: "card_a",
      base_config: {
        storageStatePath: ".auth/shared.json",
        bookingWindow: {
          date: "2026-04-16",
          startTime: "08:00",
          endTime: "10:00",
          maxAttempts: 10
        },
        selectors: {
          postLoginReady: "body"
        }
      }
    },
    coordination: {
      enabled: true
    },
    manual_override: {
      allow_manual_override: true
    },
    instances: [
      {
        id: "card_a",
        name: "card-a",
        port: 3210,
        config: {
          loginUrl: "http://example.com/weixinordernewv7.aspx?wxkey=a&lxbh=Y",
          bookingPageUrl: "http://example.com/weixinordernewv7.aspx?wxkey=a&lxbh=Y"
        }
      },
      {
        id: "card_b",
        name: "card-b",
        port: 3211,
        mode: "manual",
        config: {
          loginUrl: "http://example.com/weixinordernewv7.aspx?wxkey=b&lxbh=Y",
          bookingPageUrl: "http://example.com/weixinordernewv7.aspx?wxkey=b&lxbh=Y"
        }
      },
      {
        id: "card_c",
        name: "card-c",
        port: 3212,
        config: {
          loginUrl: "http://example.com/weixinordernewv7.aspx?wxkey=c&lxbh=Y",
          bookingPageUrl: "http://example.com/weixinordernewv7.aspx?wxkey=c&lxbh=Y"
        }
      }
    ]
  }, null, 2));

  const config = loadConfig({
    configPath,
    instanceName: "card_b"
  });

  assert.equal(config.instance.name, "card-b");
  assert.equal(config.instance.mode, "manual");
  assert.equal(config.server.port, 3211);
  assert.equal(config.manualOverride.allowManualOverride, true);
  assert.equal(new URL(config.bookingPageUrl).searchParams.get("wxkey"), "b");

  const thirdConfig = loadConfig({
    configPath,
    instanceName: "card_c"
  });

  assert.equal(thirdConfig.instance.name, "card-c");
  assert.equal(thirdConfig.server.port, 3212);
  assert.equal(new URL(thirdConfig.bookingPageUrl).searchParams.get("wxkey"), "c");
});
