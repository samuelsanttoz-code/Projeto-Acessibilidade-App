const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

function readProjectFile(relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  assert.ok(fs.existsSync(filePath), `${relativePath} deve existir`);
  return fs.readFileSync(filePath, "utf8");
}

function loadScript(relativePath, context) {
  const source = readProjectFile(relativePath);
  vm.runInNewContext(source, context, { filename: relativePath });
}

test("manifesto MV3 referencia arquivos existentes e configura o atalho principal", () => {
  const manifest = JSON.parse(readProjectFile("manifest.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(
    Array.from(manifest.content_scripts[0].matches),
    ["http://*/*", "https://*/*"],
  );
  assert.deepEqual(
    Array.from(manifest.content_scripts[0].js),
    ["content.js"],
  );
  assert.equal(
    manifest.commands["activate-assistant"].suggested_key.default,
    "Alt+Shift+A",
  );

  assert.ok(fs.existsSync(path.join(projectRoot, manifest.background.service_worker)));
  for (const contentScript of manifest.content_scripts) {
    for (const scriptPath of contentScript.js) {
      assert.ok(fs.existsSync(path.join(projectRoot, scriptPath)));
    }
  }
});

test("service worker envia ativação para a aba ativa", () => {
  let commandListener;
  const sentMessages = [];
  const chrome = {
    commands: {
      onCommand: {
        addListener(listener) {
          commandListener = listener;
        },
      },
    },
    runtime: {},
    tabs: {
      query(queryInfo, callback) {
        assert.equal(queryInfo.active, true);
        assert.equal(queryInfo.currentWindow, true);
        assert.equal(Object.keys(queryInfo).sort().join(","), "active,currentWindow");
        callback([{ id: 42 }]);
      },
      sendMessage(tabId, message, callback) {
        sentMessages.push({ tabId, message });
        callback();
      },
    },
  };

  loadScript("background.js", { chrome, console });
  assert.equal(typeof commandListener, "function");

  commandListener("activate-assistant");

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].tabId, 42);
  assert.equal(sentMessages[0].message.type, "ACCESSIBLE_ASSISTANT_ACTIVATE");
});

test("content script mantém estado após receber ativação", () => {
  let messageListener;
  let response;
  const infoMessages = [];
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        },
      },
    },
  };
  const context = {
    chrome,
    console: {
      info(...args) {
        infoMessages.push(args);
      },
    },
  };

  loadScript("content.js", context);
  assert.equal(typeof messageListener, "function");

  messageListener(
    { type: "ACCESSIBLE_ASSISTANT_ACTIVATE" },
    {},
    (value) => {
      response = value;
    },
  );

  assert.equal(context.__accessibleWebAssistantState.isActive, true);
  assert.equal(context.__accessibleWebAssistantState.activationCount, 1);
  assert.match(context.__accessibleWebAssistantState.lastActivatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(response.ok, true);
  assert.equal(response.activationCount, 1);
  assert.equal(infoMessages.length, 1);
});
