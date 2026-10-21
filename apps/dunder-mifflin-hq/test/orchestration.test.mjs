import test from "node:test";
import assert from "node:assert/strict";
import { SPEEDS, quickLeadModel, orchestrationBlock } from "../orchestration.mjs";
import { planImageDelivery } from "../server.mjs";

test("speed lanes minimize delegation while preserving reviews and browser-only constraints", () => {
  assert.deepEqual(SPEEDS, ["quick", "auto", "team"]);
  const quick = orchestrationBlock("quick");
  const auto = orchestrationBlock();
  const team = orchestrationBlock("team");
  assert.match(quick, /no routine task delegation/);
  assert.match(quick, /mandatory review/);
  assert.match(auto, /Triage silently/);
  assert.match(team, /Issue independent task calls together/);
  for (const block of [quick, auto, team]) {
    assert.match(block, /not safety or permissions/);
    assert.match(block, /Browser-only requests never become DAX/);
  }
});

test("Quick selects an enabled fast vision model when screenshots are present", () => {
  const models = [
    { id: "claude-sonnet-5.5", capabilities: { supports: { vision: false } } },
    { id: "gpt-5.4-mini", capabilities: { supports: { vision: true } } },
  ];
  assert.equal(quickLeadModel(models), "claude-sonnet-5.5");
  assert.equal(quickLeadModel(models, true), "gpt-5.4-mini");
  assert.equal(quickLeadModel([{ ...models[1], policy: { state: "disabled" } }], true), null);
  assert.equal(quickLeadModel([], true), null);
});

test("all screenshots survive one-image and per-image-size model limits", () => {
  const images = [
    { id: "first", size: 100 }, { id: "second", size: 200 }, { id: "third", size: 50 },
  ];
  const one = planImageDelivery(images, { max_prompt_images: 1 });
  assert.deepEqual(one.inline, images.slice(0, 1));
  assert.deepEqual(one.viaFile, images.slice(1));
  const size = planImageDelivery(images, { max_prompt_image_size: 100, max_prompt_images: 2 });
  assert.deepEqual(size.inline, [images[0], images[2]]);
  assert.deepEqual(size.viaFile, [images[1]]);
  assert.deepEqual(planImageDelivery(images, { max_prompt_images: 0 }).viaFile, images);
  assert.deepEqual(planImageDelivery(images, { max_prompt_images: "1" }), one);
  assert.deepEqual(planImageDelivery(images, null).inline, images);
});
