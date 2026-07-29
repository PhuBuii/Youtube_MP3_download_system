import test from "node:test";
import assert from "node:assert/strict";

import { corsHeaders, isAllowedTarget } from "../worker.js";

test("allows YouTube media hosts over HTTPS", () => {
  assert.equal(isAllowedTarget(new URL("https://rr1---sn.googlevideo.com/videoplayback")), true);
  assert.equal(isAllowedTarget(new URL("https://i.ytimg.com/vi/id/hqdefault.jpg")), true);
  assert.equal(isAllowedTarget(new URL("https://www.youtube.com/watch?v=id")), true);
});

test("rejects non-HTTPS and unrelated hosts", () => {
  assert.equal(isAllowedTarget(new URL("http://www.youtube.com/watch?v=id")), false);
  assert.equal(isAllowedTarget(new URL("https://example.com/file.mp4")), false);
});

test("CORS headers expose range metadata", () => {
  const headers = corsHeaders("https://app.example");
  assert.equal(headers["Access-Control-Allow-Origin"], "https://app.example");
  assert.match(headers["Access-Control-Allow-Headers"], /Range/);
  assert.match(headers["Access-Control-Expose-Headers"], /Content-Range/);
});
