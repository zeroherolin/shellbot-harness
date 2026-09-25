import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { safeSlice, writeFileAtomic, localDate, failStreak, toMillis, isImageMsg, decodedUrl, encodedUrl, retry, fatal } from "../src/util.js";
import { tmpDir } from "./helpers.js";

test("safeSlice：不把代理对切成半个，JSON 里不出现孤立代理", () => {
  assert.equal(safeSlice("ab😀cd", 3), "ab");
  assert.equal(safeSlice("ab😀cd", 4), "ab😀");
  assert.equal(safeSlice("短", 10), "短");
  assert.doesNotMatch(JSON.stringify(safeSlice("😀😀😀", 5)), /\\ud83d"/);
});

test("writeFileAtomic：写完是完整内容、不留临时文件；目录不存在时抛错也不留垃圾", () => {
  const dir = tmpDir("atomic-");
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

test("failStreak：连续失败只记第一次（warn），恢复时记一行带失败次数（info）；没失败过恢复不记", () => {
  const lines = [];
  const log = { warn: (m) => lines.push(["warn", m]), info: (m) => lines.push(["info", m]) };
  const s = failStreak("拉日志失败", () => log);
  s.ok();
  for (let i = 0; i < 100; i++) s.fail("fetch failed");
  assert.equal(s.failing, true);
  s.ok();
  s.fail("又断了");
  assert.deepEqual(lines, [
    ["warn", "拉日志失败：fetch failed（之后连续失败不再逐条记，恢复时说一声）"],
    ["info", "拉日志失败：恢复了（中间失败 100 次）"],
    ["warn", "拉日志失败：又断了（之后连续失败不再逐条记，恢复时说一声）"],
  ]);
});

test("failStreak：日志器缺方法 / 自己抛错也不往外抛（它接在成功路径上，一抛成功就变失败）", () => {
  const s = failStreak("x", () => ({ warn() {} }));  // 没有 info
  s.fail("断了");
  assert.doesNotThrow(() => s.ok());
  const boom = failStreak("x", () => { throw new Error("日志坏了"); });
  assert.doesNotThrow(() => { boom.fail("a"); boom.ok(); });
  assert.doesNotThrow(() => failStreak("x", () => undefined).fail("a"));
});

test("出站 url 解码 / 自用 url 单次编码（平台会再编码一次）", () => {
  const raw = "https://oss/a_/微信图片_1.png?x-oss-process=image/format,png";
  const once = "https://oss/a_/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_1.png?x-oss-process=image/format,png";
  assert.equal(decodedUrl(once), raw);
  assert.equal(decodedUrl(raw), raw);
  assert.equal(decodedUrl("https://x/a.png"), "https://x/a.png");
  assert.equal(decodedUrl("https://x/%E0%A4%A"), "https://x/%E0%A4%A"); // 非法序列原样返回
  assert.equal(encodedUrl(raw), once);
  assert.equal(encodedUrl(once), once); // 不会二次编码
  assert.equal(encodedUrl("https://x/a%2Fb.png?s=ab%2B%3D"), "https://x/a%2Fb.png?s=ab%2B%3D"); // 保留字转义与签名参数不动
  assert.equal(encodedUrl("https://x/图 片.png"), "https://x/%E5%9B%BE%20%E7%89%87.png");
});

test("时间戳秒 / 毫秒 / 非法", () => {
  assert.equal(toMillis(1700000000), 1700000000000);
  assert.equal(toMillis(1700000000000), 1700000000000);
  assert.ok(Math.abs(toMillis("bad") - Date.now()) < 1000);
  assert.ok(Math.abs(toMillis(undefined) - Date.now()) < 1000);
});

test("图片消息判定：isImage 或扩展名", () => {
  assert.equal(isImageMsg({ url: "https://x/a.JPG" }), true);
  assert.equal(isImageMsg({ url: "https://x/a.png?x=1" }), true);
  assert.equal(isImageMsg({ url: "https://x/a", isImage: "True" }), true);
  assert.equal(isImageMsg({ url: "https://x/a.pdf" }), false);
  assert.equal(isImageMsg({ isImage: true }), false);
  assert.equal(isImageMsg(null), false);
});

test("retry：瞬时错误重试到上限、fatal 立即放弃、delay 按第几次给", async () => {
  const delays = [];
  const withDelay = { retries: 2, delay: (n) => { delays.push(n); return 0; } };
  let calls = 0;
  assert.equal(await retry(async () => (++calls < 3 ? Promise.reject(new Error("x")) : "ok"), withDelay), "ok");
  assert.deepEqual(delays, [1, 2]);
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error("x"); }, withDelay), /x/);
  assert.equal(calls, 3);  // 首次 + 2 次重试
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw fatal("no"); }, withDelay), /no/);
  assert.equal(calls, 1);
  const seen = [];  // onRetry：重试了但最后成功也要留痕，且回调自己抛错不影响重试
  calls = 0;
  assert.equal(await retry(async () => (++calls < 3 ? Promise.reject(new Error("抖")) : "ok"), { ...withDelay, onRetry: (e, n) => { seen.push([e.message, n]); throw new Error("回调炸了"); } }), "ok");
  assert.deepEqual(seen, [["抖", 1], ["抖", 2]]);
});
