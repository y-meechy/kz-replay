import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureShaderArchives, shaderArchiveNames } from "./cs2Shaders.js";

test("select complete Vulkan shader archives only from known Source game search roots", () => {
  const paths = [
    "game/csgo/shaders_vulkan_dir.vpk",
    "game/csgo_core/shaders_vulkan_001.vpk",
    "game/core/shaders_vulkan_000.vpk",
    "game/csgo/pak01_000.vpk",
    "game/csgo/shaders_pc_000.vpk",
    "game/csgo/shaders_vulkan_../escape.vpk",
    "game/custom/shaders_vulkan_dir.vpk",
  ];
  assert.deepEqual(
    shaderArchiveNames(new Map(paths.map((path) => [path, {}]))),
    paths.slice(0, 3).sort(),
  );
});

const withTempDir = async (run) => {
  const path = await mkdtemp(join(tmpdir(), "kz-replay-shaders-"));
  try {
    return await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
};

const fixture = (cache) => {
  const name = "game/csgo/shaders_vulkan_dir.vpk";
  return {
    cache,
    name,
    files: new Map([
      [
        name,
        {
          name,
          size: 4,
          chunks: [{ sha: "a".repeat(40), offset: 0, size: 4 }],
        },
      ],
    ]),
    names: [name],
    manifestGid: "1234",
    access: { key: Buffer.alloc(32), hosts: ["https://cache.invalid"] },
  };
};

test("rejects a correctly sized cache without a completion record", () =>
  withTempDir(async (cache) => {
    const setup = fixture(cache);
    const path = join(cache, setup.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(4));
    let fetches = 0;
    await ensureShaderArchives({
      ...setup,
      fetchRanges: async ({ path: destination, ranges, totalSize }) => {
        fetches += 1;
        assert.deepEqual(ranges, [{ offset: 0, size: 4 }]);
        assert.equal(totalSize, 4);
        await writeFile(destination, "done");
      },
    });
    assert.equal(fetches, 1);
    const completion = JSON.parse(
      await readFile(join(cache, "complete.json"), "utf8"),
    );
    assert.equal(completion.archives[0].bytes, 4);
    assert.match(completion.archives[0].sha256, /^[a-f0-9]{64}$/);
  }));

test("reuses only a completed cache whose hashes still match", () =>
  withTempDir(async (cache) => {
    const setup = fixture(cache);
    await ensureShaderArchives({
      ...setup,
      fetchRanges: async ({ path }) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "done");
      },
    });
    const archives = await ensureShaderArchives({
      ...setup,
      access: undefined,
      readAccess: async () => {
        assert.fail("verified cache reuse must not read depot credentials");
      },
      fetchRanges: async () => {
        assert.fail("valid completed cache must not be fetched again");
      },
    });
    assert.equal(archives.length, 1);
    assert.equal(archives[0].bytes, 4);
  }));

test("writes every offset when a shader archive repeats a chunk hash", () =>
  withTempDir(async (cache) => {
    const setup = fixture(cache);
    setup.files.get(setup.name).size = 8;
    setup.files.get(setup.name).chunks = [
      { sha: "a".repeat(40), offset: 0, size: 4 },
      { sha: "a".repeat(40), offset: 4, size: 4 },
    ];
    const batches = [];
    await ensureShaderArchives({
      ...setup,
      fetchRanges: async ({ path, chunks, totalSize }) => {
        batches.push(chunks);
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(path, batches.length === 1 ? "w+" : "r+");
        try {
          await handle.truncate(totalSize);
          for (const chunk of chunks) {
            await handle.write(Buffer.from("done"), 0, 4, chunk.offset);
          }
        } finally {
          await handle.close();
        }
      },
    });
    assert.equal(batches.length, 2);
    assert.deepEqual(
      batches.map(([chunk]) => chunk.offset),
      [0, 4],
    );
    assert.equal(await readFile(join(cache, setup.name), "utf8"), "donedone");
  }));

test("rejects pinned manifest chunks with gaps before fetching", () =>
  withTempDir(async (cache) => {
    const setup = fixture(cache);
    setup.files.get(setup.name).chunks[0].offset = 1;
    await assert.rejects(
      ensureShaderArchives({
        ...setup,
        fetchRanges: async () => {
          assert.fail("invalid manifest coverage must not be fetched");
        },
      }),
      /Invalid shader archive chunk coverage/,
    );
  }));
