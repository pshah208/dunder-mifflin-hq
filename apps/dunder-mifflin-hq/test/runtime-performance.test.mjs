import test from "node:test";
import assert from "node:assert/strict";
import {
  listEnabledModelDetails, setSdkClientFactoryForTests, buildSdkSessionConfig, setAzTokenRunnerForTests,
} from "../server.mjs";

test("model catalog shares concurrent fetches, reuses the 30s cache, and refreshes after expiry", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let calls = 0;
  const enabled = { id: "enabled", policy: { state: "enabled" } };
  setSdkClientFactoryForTests(() => ({
    async listModels() {
      calls++;
      return [enabled, { id: "disabled", policy: { state: "disabled" } }];
    },
  }));
  t.after(() => setSdkClientFactoryForTests(null));
  const results = await Promise.all(Array.from({ length: 6 }, () => listEnabledModelDetails()));
  assert.equal(calls, 1, "parallel chats must share one catalog RPC");
  for (const result of results) assert.deepEqual(result.details, [enabled]);
  assert.equal((await listEnabledModelDetails()).status, "cached");
  assert.equal(calls, 1, "warm setup makes zero model-catalog RPCs");
  t.mock.timers.tick(30_001);
  assert.equal((await listEnabledModelDetails()).status, "live");
  assert.equal(calls, 2, "expired policy data must refresh");
});

test("catalog failures are explicit, retryable and only allow stale data when requested", async t => {
  let fail = false, calls = 0;
  setSdkClientFactoryForTests(() => ({
    async listModels() {
      calls++;
      if (fail) throw new Error("catalog offline");
      return [{ id: "enabled" }];
    },
  }));
  t.after(() => setSdkClientFactoryForTests(null));
  await listEnabledModelDetails();
  fail = true;
  const stale = await listEnabledModelDetails({ refresh: true, allowStaleOnError: true });
  assert.equal(stale.status, "stale");
  assert.match(stale.error.message, /catalog offline/);
  await assert.rejects(listEnabledModelDetails({ refresh: true }), /catalog offline/);
  fail = false;
  assert.equal((await listEnabledModelDetails({ refresh: true })).status, "live");
  assert.equal(calls, 4, "a failed in-flight promise must not poison future requests");
});

test("SDK setup reuses the run connector snapshot without checking auth again; study stays isolated", async t => {
  let authCalls = 0;
  setAzTokenRunnerForTests(async () => { authCalls++; throw new Error("unexpected auth check"); });
  t.after(() => setAzTokenRunnerForTests(null));
  const snapshot = { mcpServers: { sample: { type: "stdio", command: "sample", tools: ["*"] } }, skillDirectories: ["sample-skills"] };
  const handlers = { onPermissionRequest: () => ({ kind: "deny" }) };
  const config = await buildSdkSessionConfig({ connectorSnapshot: snapshot, handlers });
  assert.equal(authCalls, 0);
  assert.equal(config.mcpServers, snapshot.mcpServers);
  assert.equal(config.skillDirectories, snapshot.skillDirectories);
  assert.equal(config.onPermissionRequest, handlers.onPermissionRequest, "approvals remain enforced");
  const study = await buildSdkSessionConfig({ connectors: false, connectorSnapshot: snapshot, handlers });
  assert.equal(study.mcpServers, undefined);
  assert.equal(study.skillDirectories, undefined);
  assert.match(config.systemMessage.content, /bounded read-only lookups/);
  assert.match(config.systemMessage.content, /Speed never bypasses approvals/);
});
