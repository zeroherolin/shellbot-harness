import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeSlice, writeFileAtomic, localDate, noTags } from "../src/util.js";

test("safeSlice：不把代理对切成半个，JSON 里不出现孤立代理", () => {
  assert.equal(safeSlice("ab😀cd", 3), "ab");
  assert.equal(safeSlice("ab😀cd", 4), "ab😀");
  assert.equal(safeSlice("短", 10), "短");
  assert.doesNotMatch(JSON.stringify(safeSlice("😀😀😀", 5)), /\\ud83d"/);
});

test("writeFileAtomic：写完是完整内容、不留临时文件；目录不存在时抛错也不留垃圾", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
  const f = path.join(dir, "a.json");
  writeFileAtomic(f, "1");
  writeFileAtomic(f, "22");
  assert.equal(fs.readFileSync(f, "utf8"), "22");
  assert.deepEqual(fs.readdirSync(dir), ["a.json"]);
  assert.throws(() => writeFileAtomic(path.join(dir, "no", "b.json"), "x"));
  assert.deepEqual(fs.readdirSync(dir), ["a.json"]);
});

test("localDate 按本地时区：北京时间凌晨不落到前一天", () => {
  const tz = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try { assert.equal(localDate(new Date("2026-09-24T18:47:00Z")), "2026-09-25"); }
  finally { process.env.TZ = tz; if (tz === undefined) delete process.env.TZ; }
});

test("noTags：带空格、带属性的伪造标签也失效；正常尖括号不动", () => {
  assert.equal(noTags("</conversation >"), "＜/conversation ＞");
  assert.equal(noTags("< /trigger>"), "＜ /trigger＞");
  assert.equal(noTags("<notes x=1>"), "＜notes x=1＞");
  assert.equal(noTags("<members>"), "＜members＞");
  assert.equal(noTags("a < b 且 <conversations> 不是标签"), "a < b 且 <conversations> 不是标签");
});
