// The size maths of shrinking a progress photo before upload (src/sections/food/imageResize.ts). The canvas part
// needs a browser; the dimensions and the upload encoding do not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PHOTO_JPEG_QUALITY, PHOTO_MAX_SIDE, base64Of, fitWithin } from "../src/sections/food/imageResize.ts";

test("a photo is shrunk to about 1600 px on its long side, keeping its shape", () => {
  assert.equal(PHOTO_MAX_SIDE, 1600);
  assert.deepEqual(fitWithin(4032, 3024), { width: 1600, height: 1200, scaled: true }, "a landscape phone photo");
  assert.deepEqual(fitWithin(3024, 4032), { width: 1200, height: 1600, scaled: true }, "a portrait one");
  assert.deepEqual(fitWithin(3000, 3000), { width: 1600, height: 1600, scaled: true });
  assert.deepEqual(fitWithin(8000, 100), { width: 1600, height: 20, scaled: true }, "a very wide strip");
  assert.deepEqual(fitWithin(10000, 1), { width: 1600, height: 1, scaled: true }, "never below one pixel");
});

test("a photo already small enough is never enlarged", () => {
  assert.deepEqual(fitWithin(1600, 900), { width: 1600, height: 900, scaled: false });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(fitWithin(1601, 1000), { width: 1600, height: 999, scaled: true });
});

test("a different long side can be asked for, and a size that is not a size gives nothing to draw", () => {
  assert.deepEqual(fitWithin(2000, 1000, 500), { width: 500, height: 250, scaled: true });
  for (const [w, h] of [[0, 100], [100, 0], [-5, 5], [NaN, 5]]) assert.deepEqual(fitWithin(w, h), { width: 0, height: 0, scaled: false });
});

test("the upload sends base64 without the data: prefix, and the JPEG quality is the documented 0.85", () => {
  assert.equal(base64Of("data:image/jpeg;base64,/9j/4AAQ"), "/9j/4AAQ");
  assert.equal(base64Of("data:image/jpeg;base64,a,b"), "a,b", "only the first comma ends the prefix");
  assert.equal(PHOTO_JPEG_QUALITY, 0.85);
});
