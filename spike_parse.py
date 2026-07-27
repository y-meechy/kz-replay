"""Spike: decode a CS2KZ .replay run and print the movement path.

Container (see cs2kz-metamod src/kz/replays/{data,compression}.cpp):
  u32 headerSize
  bytes[headerSize]           protobuf cs2kz.replay.ReplayHeader
  section: TickData           (u32 compressedSize, u32 uncompressedSize, u32 elementCount, zstd blob)
  section: SubtickData        (same shape, raw structs, not delta encoded)
  section: Weapons / Jumps / Events / CmdData ...
"""

import os
import struct
import subprocess
import sys
import tempfile

replay_path = sys.argv[1] if len(sys.argv) > 1 else "replay.bin"
with open(replay_path, "rb") as f:
    data = f.read()


def zstd_decompress(blob, expected):
    with tempfile.NamedTemporaryFile(suffix=".zst", delete=False) as f:
        f.write(blob)
        name = f.name
    try:
        out = subprocess.run(
            ["zstd", "-d", "-c", name], capture_output=True, check=True
        ).stdout
    finally:
        os.unlink(name)
    assert len(out) == expected, f"got {len(out)} want {expected}"
    return out


def read_varint(buf, i):
    shift = 0
    out = 0
    while True:
        b = buf[i]
        i += 1
        out |= (b & 0x7F) << shift
        if not b & 0x80:
            return out, i
        shift += 7


def protobuf_fields(buf):
    """Minimal protobuf walk: {field number: [values]}. No schema, no nesting."""
    fields = {}
    i = 0
    while i < len(buf):
        key, i = read_varint(buf, i)
        fnum, wt = key >> 3, key & 7
        if wt == 0:
            v, i = read_varint(buf, i)
        elif wt == 2:
            ln, i = read_varint(buf, i)
            v = buf[i : i + ln]
            i += ln
        elif wt == 5:
            v = struct.unpack_from("<f", buf, i)[0]
            i += 4
        elif wt == 1:
            v = struct.unpack_from("<d", buf, i)[0]
            i += 8
        else:
            raise ValueError(f"wiretype {wt}")
        fields.setdefault(fnum, []).append(v)
    return fields


# --- header -----------------------------------------------------------------
header_size = struct.unpack_from("<I", data, 0)[0]
header_bytes = data[4 : 4 + header_size]
off = 4 + header_size

header = protobuf_fields(header_bytes)
player = protobuf_fields(header[3][0]) if 3 in header else {}
map_info = protobuf_fields(header[4][0]) if 4 in header else {}
run = protobuf_fields(header[16][0]) if 16 in header else {}
version = header.get(1, [None])[0]
print("replay version :", version)
print("type           :", header.get(2, [0])[0], "(2 = run)")
print("player         :", player.get(1, [b""])[0].decode(), player.get(2, [None])[0])
print("map            :", map_info.get(1, [b""])[0].decode())
print("course         :", run.get(1, [b""])[0].decode() if 1 in run else "?")
print("time           :", run.get(4, [None])[0])
print("teleports      :", run.get(5, [None])[0])
print(
    "mode           :",
    protobuf_fields(run[2][0]).get(1, [b""])[0].decode() if 2 in run else "?",
)

# --- tick section -----------------------------------------------------------
csize, usize, count = struct.unpack_from("<III", data, off)
off += 12
blob = data[off : off + csize]
off += csize
print(f"\nticks          : {count}  ({usize} bytes delta-encoded, {csize} compressed)")
raw = zstd_decompress(blob, usize)

# Every tick starts with a u64 flag word. A field is only present in the blob when
# its bit is set; otherwise it keeps the value from the previous tick.
# Read order below IS the wire order -- do not reorder these tables.

# name, flag bit, byte size, struct format
SCALAR_FIELDS = (
    ("SERVER_TICK", 0, 4, "<I"),
    ("GAME_TIME", 1, 4, "<f"),
    ("REAL_TIME", 2, 4, "<f"),
    ("UNIX_TIME", 3, 8, "<Q"),
    ("CMD_NUMBER", 4, 4, "<I"),
    ("CLIENT_TICK", 5, 4, "<I"),
    ("FORWARD", 6, 4, "<f"),
    ("LEFT", 7, 4, "<f"),
    ("UP", 8, 4, "<f"),
    ("LEFT_HANDED", 9, 1, "<b"),
    ("WEAPON", 39, 4, "<i"),
)

# Movement state, written twice per tick: pre-move then post-move.
# Flag bit listed is the pre-move one; post-move uses bit + POST_FLAG_OFFSET.
# MOVE_TYPE is appended in decode_ticks because its width is what we probe for.
VECTOR_FIELDS = (
    ("ORIGIN", 10, 12, "<3f"),
    ("VELOCITY", 11, 12, "<3f"),
    ("ANGLES", 12, 12, "<3f"),
    ("B0", 13, 4, "<I"),
    ("B1", 14, 4, "<I"),
    ("B2", 15, 4, "<I"),
    ("JPT", 16, 4, "<f"),
    ("DUCK_SPEED", 17, 4, "<f"),
    ("DUCK_AMOUNT", 18, 4, "<f"),
    ("DUCK_OFFSET", 19, 4, "<f"),
    ("LAST_DUCK", 20, 4, "<f"),
    ("RPFLAGS", 21, 1, "<B"),
    ("ENT_FLAGS", 22, 4, "<I"),
)
MOVE_TYPE_FLAG_BIT = 23
POST_FLAG_OFFSET = 14

# Trailing per-tick blocks we only need to skip over.
BIT_CHECKPOINT = 38
BIT_MJ_ACTUAL = 40
BIT_MJ_USABLE = 41
BIT_MJ_LANDED = 42


def has_flag(flags, bit):
    return bool(flags >> bit & 1)


def read_vector_group(raw, p, flags, flag_offset, into, vector_fields):
    """Overlay the present movement fields onto `into`, returning the new offset."""
    for name, bit, size, fmt in vector_fields:
        if has_flag(flags, bit + flag_offset):
            v = struct.unpack_from(fmt, raw, p)
            into[name] = v if len(v) > 1 else v[0]
            p += size
    return p


def decode_ticks(raw, count, version, movetype_size):
    movetype_fmt = "<B" if movetype_size == 1 else "<I"
    vector_fields = VECTOR_FIELDS + (
        ("MOVE_TYPE", MOVE_TYPE_FLAG_BIT, movetype_size, movetype_fmt),
    )

    p = 0
    ticks = []
    prev = None
    for _ in range(count):
        flags = struct.unpack_from("<Q", raw, p)[0]
        p += 8

        t = {}
        for name, bit, size, fmt in SCALAR_FIELDS:
            if has_flag(flags, bit):
                t[name] = struct.unpack_from(fmt, raw, p)[0]
                p += size
        next_tick = prev["serverTick"] + 1 if prev else 0
        t["serverTick"] = t.get("SERVER_TICK", next_tick)

        t["pre"] = dict(prev["post"]) if prev else {}
        p = read_vector_group(raw, p, flags, 0, t["pre"], vector_fields)
        t["post"] = dict(t["pre"])
        p = read_vector_group(raw, p, flags, POST_FLAG_OFFSET, t["post"], vector_fields)

        if has_flag(flags, BIT_CHECKPOINT):
            p += 12
        if version >= 2:
            if has_flag(flags, BIT_MJ_ACTUAL):
                p += 8
            if has_flag(flags, BIT_MJ_USABLE):
                p += 8
            if has_flag(flags, BIT_MJ_LANDED):
                p += 8 + 12

        ticks.append(t)
        prev = t
    return ticks, p


# MOVE_TYPE width is not obvious from the source; probe both and trust the one
# that consumes the section exactly.
for movetype_size in (1, 4):
    try:
        ticks, consumed = decode_ticks(raw, count, version, movetype_size)
    except Exception as e:  # noqa: BLE001
        print(f"movetype={movetype_size}: crashed {e}")
        continue

    status = "EXACT MATCH" if consumed == usize else "desync"
    print(f"movetype size {movetype_size}: consumed {consumed} / {usize} -> {status}")
    if consumed != usize:
        continue

    print("\nfirst 3 ticks:")
    for t in ticks[:3]:
        print(
            "  tick", t["serverTick"],
            "origin", t["post"].get("ORIGIN"),
            "angles", t["post"].get("ANGLES"),
        )

    print("\nsampled path (every 500th tick):")
    for t in ticks[::500]:
        o = t["post"].get("ORIGIN")
        v = t["post"].get("VELOCITY") or (0, 0, 0)
        speed = (v[0] ** 2 + v[1] ** 2) ** 0.5
        print(f"  t={t['serverTick']:>6}  xyz=({o[0]:9.1f},{o[1]:9.1f},{o[2]:9.1f})  speed={speed:6.1f}")

    origins = [t["post"]["ORIGIN"] for t in ticks if t["post"].get("ORIGIN")]
    print(
        f"\n{len(origins)} ticks carry an origin;"
        f" bbox x[{min(o[0] for o in origins):.0f},{max(o[0] for o in origins):.0f}]"
        f" y[{min(o[1] for o in origins):.0f},{max(o[1] for o in origins):.0f}]"
        f" z[{min(o[2] for o in origins):.0f},{max(o[2] for o in origins):.0f}]"
    )
    break
