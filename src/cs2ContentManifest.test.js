import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  stat,
  rm,
  chmod,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CS2_CONTENT_MANIFEST_GID,
  ContentManifestError,
  verifyPinnedContentIndex,
  verifyDepotFile,
  chunkOccurrenceBatches,
} from "./cs2ContentManifest.js";
import { CS2_SHADER_MANIFEST_GID, prepareCs2Shaders } from "./cs2Shaders.js";
import { syncCs2Index, readCs2Index, ensureCs2Assets } from "./cs2Content.js";
import { convertMap } from "./mapPipeline.js";

const temporary = async (run) => {
  const path = await mkdtemp(join(tmpdir(), "kz-content-manifest-"));
  try {
    return await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
};
const varint = (value) => {
  const bytes = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
};
const number = (field, value) =>
  Buffer.concat([varint(field * 8), varint(value)]);
const field = (key, value) =>
  Buffer.concat([varint(key * 8 + 2), varint(value.length), value]);
const descriptor = (name, bytes) => ({
  name,
  size: bytes.length,
  chunks: [
    {
      sha: createHash("sha1").update(bytes).digest("hex"),
      offset: 0,
      size: bytes.length,
    },
  ],
});
const manifestBytes = (entries) =>
  Buffer.concat([
    Buffer.alloc(8),
    ...entries.map((entry) =>
      field(
        1,
        Buffer.concat([
          field(1, Buffer.from(entry.name)),
          number(2, entry.size),
          ...entry.chunks.map((chunk) =>
            field(
              6,
              Buffer.concat([
                field(1, Buffer.from(chunk.sha, "hex")),
                number(3, chunk.offset),
                number(4, chunk.size),
              ]),
            ),
          ),
        ]),
      ),
    ),
  ]);
const setup = async (path, extra = []) => {
  const entries = [
    descriptor("game/csgo/pak01_dir.vpk", Buffer.from("index")),
    descriptor("game/csgo/gameinfo.gi", Buffer.from("game")),
    ...extra,
  ];
  await mkdir(join(path, ".DepotDownloader"), { recursive: true });
  await mkdir(join(path, "game/csgo"), { recursive: true });
  await writeFile(
    join(path, `.DepotDownloader/2347770_${CS2_CONTENT_MANIFEST_GID}.manifest`),
    manifestBytes(entries),
  );
  await writeFile(join(path, "game/csgo/pak01_dir.vpk"), "index");
  await writeFile(join(path, "game/csgo/gameinfo.gi"), "game");
  return entries;
};
const executable = async (path, code) => {
  await writeFile(path, `#!${process.execPath}\n${code}\n`);
  await chmod(path, 0o755);
  return path;
};
const coherenceError = (error) =>
  error instanceof ContentManifestError &&
  error.code === "CS2_CONTENT_MANIFEST_MISMATCH";

test("content and shader selection share one manifest and verify an unlabelled existing index", () =>
  temporary(async (path) => {
    await setup(path);
    assert.equal(CS2_SHADER_MANIFEST_GID, CS2_CONTENT_MANIFEST_GID);
    await writeFile(
      join(path, ".DepotDownloader/2347770_9999999999999999999.manifest"),
      manifestBytes([
        descriptor("game/csgo/pak01_dir.vpk", Buffer.from("other")),
      ]),
    );
    assert.equal(await syncCs2Index({ cs2Dir: path }), false);
    const verified = await verifyPinnedContentIndex(path);
    assert.equal(verified.manifest, CS2_CONTENT_MANIFEST_GID);
    assert.equal(
      verified.indexSha256,
      createHash("sha256").update("index").digest("hex"),
    );
    await writeFile(join(path, "game/csgo/pak01_dir.vpk"), "other");
    await assert.rejects(syncCs2Index({ cs2Dir: path }), coherenceError);
    assert.equal(
      await readFile(join(path, "game/csgo/pak01_dir.vpk"), "utf8"),
      "other",
    );
  }));

test("a mixed content index fails before any shader mounting or archive acquisition", () =>
  temporary(async (path) => {
    await setup(path);
    await writeFile(join(path, "game/csgo/pak01_dir.vpk"), "other");
    const gameDir = join(path, "export/game/csgo");
    await assert.rejects(
      prepareCs2Shaders({ cs2Dir: path, gameDir }),
      coherenceError,
    );
    await assert.rejects(access(gameDir), { code: "ENOENT" });
    await assert.rejects(access(join(path, "shader-metadata")), {
      code: "ENOENT",
    });
  }));

test("an index.json from mtime-only caching is rebuilt and rebound to verified content", () =>
  temporary(async (path) => {
    await setup(path);
    const { mtimeMs } = await stat(join(path, "game/csgo/pak01_dir.vpk"));
    await writeFile(
      join(path, "index.json"),
      JSON.stringify({ mtimeMs, parts: { stale: [1, 0, 4] } }),
    );
    const cli = await executable(
      join(path, "fixture-cli"),
      "console.log('materials/x.vmat_c crc=0x1 metadatasz=0 fnumber=0 ofs=0x0 sz=4');",
    );
    assert.deepEqual(
      [...(await readCs2Index({ cs2Dir: path, cli }))],
      [["materials/x.vmat_c", [0, 0, 4]]],
    );
    const cache = JSON.parse(await readFile(join(path, "index.json"), "utf8"));
    assert.equal(cache.manifest, CS2_CONTENT_MANIFEST_GID);
    assert.match(cache.indexSha256, /^[a-f0-9]{64}$/);
    await rm(cli);
    assert.equal((await readCs2Index({ cs2Dir: path, cli })).size, 1);
  }));

test("whole-part fallback validates requested bytes in an existing sparse cache", () =>
  temporary(async (path) => {
    const entry = {
      name: "game/csgo/pak01_000.vpk",
      size: 8,
      chunks: [
        { ...descriptor("", Buffer.from("good")).chunks[0] },
        { ...descriptor("", Buffer.from("tail")).chunks[0], offset: 4 },
      ],
    };
    await setup(path, [entry]);
    const partPath = join(path, entry.name);
    await writeFile(
      partPath,
      Buffer.concat([Buffer.from("good"), Buffer.alloc(4)]),
    );
    const cli = await executable(
      join(path, "fixture-cli"),
      "console.log('materials/x.vmat_c crc=0x1 metadatasz=0 fnumber=0 ofs=0x0 sz=4');",
    );
    const options = {
      cs2Dir: path,
      cli,
      paths: ["materials/x.vmat"],
      siblings: false,
    };
    assert.deepEqual(await ensureCs2Assets(options), {
      fetched: [],
      missing: [],
      bytes: 0,
    });
    await writeFile(partPath, "bad!tail");
    await assert.rejects(ensureCs2Assets(options), coherenceError);
    await assert.rejects(
      verifyDepotFile(partPath, entry.name, entry, [{ offset: 7, size: 2 }]),
      coherenceError,
    );
  }));

test("index acquisition pins DepotDownloader and verifies its resulting bytes", () =>
  temporary(async (path) => {
    const staged = join(path, "staged"),
      cache = join(path, "cache"),
      tools = join(path, "tools");
    await setup(staged);
    await mkdir(tools);
    const record = join(path, "args.json");
    await executable(
      join(tools, "DepotDownloader"),
      `
    const fs=await import('node:fs/promises');
    await fs.writeFile(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));
    await fs.cp(${JSON.stringify(staged)},${JSON.stringify(cache)},{recursive:true});
  `,
    );
    assert.equal(await syncCs2Index({ cs2Dir: cache, toolsDir: tools }), true);
    const args = JSON.parse(await readFile(record, "utf8"));
    assert.equal(args[args.indexOf("-manifest") + 1], CS2_CONTENT_MANIFEST_GID);
    assert.equal(args[args.indexOf("-depot") + 1], "2347770");
  }));

test("duplicate content hashes retain every destination offset", () => {
  const a = { sha: "a", offset: 0 },
    b = { sha: "b", offset: 4 },
    c = { sha: "a", offset: 8 };
  assert.deepEqual(chunkOccurrenceBatches([a, b, c]), [[a, b], [c]]);
});

test("conversion rejects a mixed cache before export and preserves the coherence error", () =>
  temporary(async (path) => {
    const cache = join(path, "cache"),
      tools = join(path, "tools"),
      workshop = join(path, "workshop"),
      output = join(path, "output");
    await setup(cache);
    await mkdir(tools);
    await mkdir(workshop);
    await writeFile(join(cache, "game/csgo/pak01_dir.vpk"), "other");
    await writeFile(join(workshop, "fixture.vpk"), "fixture");
    const calls = join(path, "calls.jsonl");
    await executable(
      join(tools, "Source2Viewer-CLI"),
      `
    const fs=await import('node:fs/promises');
    await fs.appendFile(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
  `,
    );
    await assert.rejects(
      convertMap({
        mapName: "fixture",
        workshopId: "123",
        toolsDir: tools,
        outputDir: output,
        workshopDir: workshop,
        cs2Dir: cache,
        textureCompression: "source",
        cleanup: false,
      }),
      coherenceError,
    );
    const args = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(args.length, 1);
    assert(!args[0].includes("--gltf_export_format"));
    assert.equal(
      await readFile(join(cache, "game/csgo/pak01_dir.vpk"), "utf8"),
      "other",
    );
  }));
