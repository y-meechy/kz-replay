import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { encodeRgbmImage } from "./hdrImage.js";
import { encodeShadowChannels, encodeIrradiance } from "./mapLightmap.js";

test("EXR irradiance restores Source row order while PNG input keeps its rows", async () => {
  const data = new Float32Array([0.25, 0, 0, 1, 0, 2, 0, 1]);
  for (const flipRows of [false, true]) {
    const result = await encodeIrradiance({
      width: 1,
      height: 2,
      channels: 4,
      data,
      decode: (v) => v,
      flipRows,
    });
    const pixels = await sharp(result.png).raw().toBuffer();
    const decoded = Array.from({ length: 2 }, (_, i) =>
      [0, 1, 2].map(
        (c) =>
          (((pixels[i * 4 + c] / 255) * pixels[i * 4 + 3]) / 255) *
          result.range,
      ),
    );
    const expected = flipRows
      ? [
          [0, 2, 0],
          [0.25, 0, 0],
        ]
      : [
          [0.25, 0, 0],
          [0, 2, 0],
        ];
    decoded.forEach((rgb, i) =>
      rgb.forEach((v, c) => assert(Math.abs(v - expected[i][c]) < 0.01)),
    );
  }
});

test("resizing direct-light channels never interprets the fourth light as opacity", async () => {
  const raw = Buffer.from([
    200, 100, 50, 0, 200, 100, 50, 255, 200, 100, 50, 0, 200, 100, 50, 255,
  ]);
  const input = await sharp(raw, { raw: { width: 2, height: 2, channels: 4 } })
    .png()
    .toBuffer();
  const png = await encodeShadowChannels(input, 1, 1);
  const output = await sharp(png).raw().toBuffer();
  assert.deepEqual([...output.subarray(0, 3)], [200, 100, 50]);
  assert(Math.abs(output[3] - 128) <= 1);
});

test("HDR encoding and explicit resizing preserve constant values above white", async () => {
  for (const targetWidth of [4, 2]) {
    const result = await encodeRgbmImage({
      width: 4,
      height: 4,
      sample: (_i, c) => [4, 0.5, 2][c],
      targetWidth,
      targetHeight: targetWidth,
    });
    const pixels = await sharp(result.png).raw().toBuffer();
    const decoded = [0, 1, 2].map(
      (c) => (((pixels[c] / 255) * pixels[3]) / 255) * result.range,
    );
    decoded.forEach((v, c) =>
      assert(Math.abs(v - [4, 0.5, 2][c]) < 0.03, `${targetWidth}: ${decoded}`),
    );
  }
});
