import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

async function loadDownloadModule() {
  const source = await readFile(new URL("../src/download.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const exports = {};
  const context = vm.createContext({
    exports,
    require: () => ({}),
  });
  vm.runInContext(output, context);
  return exports;
}

test("toBackendFormatId prefers exact backend format ids", async () => {
  const { toBackendFormatId } = await loadDownloadModule();
  assert.equal(
    toBackendFormatId({ mediaType: "audio", bitrate: "128k", formatId: "140" }),
    "140",
  );
});

test("toBackendFormatId builds legacy presets", async () => {
  const { toBackendFormatId } = await loadDownloadModule();
  assert.equal(toBackendFormatId({ mediaType: "audio", bitrate: "320k" }), "mp3_320");
  assert.equal(toBackendFormatId({ mediaType: "video", resolution: "720p" }), "mp4_720p");
});

test("formatBytes renders compact file sizes", async () => {
  const { formatBytes } = await loadDownloadModule();
  assert.equal(formatBytes(null), "Không rõ dung lượng");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});
