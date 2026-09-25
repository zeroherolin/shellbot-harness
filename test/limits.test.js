import { test } from "node:test";
import assert from "node:assert/strict";
import { splitText, makeLimiter, inQuietHours, groupImageCap } from "../src/limits.js";

test("长文拆条：不丢字、每条不超长、最后一条兜底", () => {
  const text = "第一段。\n".repeat(600);
  const parts = splitText(text, { maxChars: 800, maxParts: 3 });
  assert.equal(parts.length, 3);
  assert.ok(parts[0].length <= 800 && parts[1].length <= 800);
  assert.equal(parts.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  assert.deepEqual(splitText("短消息", { maxChars: 800, maxParts: 3 }), ["短消息"]);
  assert.deepEqual(splitText("  ", { maxChars: 800, maxParts: 3 }), []);
});

test("拆条：单独一行 --- 主动分条；段数超上限并进最后一段；超长段再按长度拆但总数不超上限、不丢字；行内 --- 不算", () => {
  assert.deepEqual(splitText("先说结论\n---\n再说原因\n---\n最后建议", { maxChars: 800, maxParts: 5 }), ["先说结论", "再说原因", "最后建议"]);
  assert.deepEqual(splitText("一\n---\n二\n---\n三\n---\n四", { maxChars: 800, maxParts: 3 }), ["一", "二", "三\n四"]);
  assert.deepEqual(splitText("a---b", { maxChars: 800, maxParts: 5 }), ["a---b"]);
  assert.deepEqual(splitText("  ---  \n只有一段\n----\n", { maxChars: 800, maxParts: 5 }), ["只有一段"]);
  const long = "第一段。".repeat(300);  // 1200 字
  const parts = splitText(`${long}\n---\n尾巴`, { maxChars: 800, maxParts: 3 });
  assert.equal(parts.length, 3); assert.equal(parts[2], "尾巴"); assert.equal(parts[0].length + parts[1].length, 1200);
  assert.deepEqual(splitText(`${long}\n---\n尾巴`, { maxChars: 800, maxParts: 2 }), [long, "尾巴"]);  // 配额只剩 1 条给长段：不截断
  assert.deepEqual(splitText("只此一条", { maxChars: 800, maxParts: 1 }), ["只此一条"]);
});

test("长文拆条：优先按句号切", () => {
  const parts = splitText("一二三四五。六七八九十。", { maxChars: 8, maxParts: 5 });
  assert.deepEqual(parts, ["一二三四五。", "六七八九十。"]);
  assert.deepEqual(splitText("一二三四五六七八九十。后面", { maxChars: 10, maxParts: 5 }), ["一二三四五六七八九十。", "后面"]);  // 句号正好在第 11 个字：跟着上一条，下一条不以「。」开头
});

test("长文拆条：没有换行也没有标点时硬切，不切开 emoji", () => {
  const parts = splitText("😀".repeat(15), { maxChars: 11, maxParts: 5 });
  assert.ok(parts.every((p) => p.isWellFormed() && p.length <= 11));
  assert.equal(parts.join(""), "😀".repeat(15));
});

test("静默时段：跨夜与不跨夜", () => {
  const at = (h) => new Date(2026, 0, 1, h, 30).getTime();
  const night = { enabled: true, from: 23, to: 8 };
  assert.equal(inQuietHours(night, at(23)), true);
  assert.equal(inQuietHours(night, at(3)), true);
  assert.equal(inQuietHours(night, at(8)), false);
  assert.equal(inQuietHours(night, at(12)), false);
  const lunch = { enabled: true, from: 12, to: 14 };
  assert.equal(inQuietHours(lunch, at(13)), true);
  assert.equal(inQuietHours(lunch, at(15)), false);
  assert.equal(inQuietHours({ enabled: false, from: 0, to: 24 }, at(13)), false);
});

test("quietGate：静默时段 allowDirect 只放直接触发", () => {
  const q = { enabled: true, from: 0, to: 24, allowDirect: true };  // 全天静默：不依赖跑测试的钟点（跨整点、23 点跨夜都不影响）
  const lim = makeLimiter({ minIntervalMs: 2000, maxWaitMs: 120000, quietHours: q });
  assert.equal(lim.quietGate({ direct: true }), null);
  assert.equal(lim.quietGate({ direct: false }), "quiet-hours");
  lim.update({ minIntervalMs: 2000, maxWaitMs: 120000, quietHours: { ...q, allowDirect: false } });
  assert.equal(lim.quietGate({ direct: true }), "quiet-hours");
});

test("陈旧判定与热更新", () => {
  const lim = makeLimiter({ minIntervalMs: 2000, maxWaitMs: 120000, quietHours: { enabled: false } });
  assert.equal(lim.isStale(Date.now()), false);
  assert.equal(lim.isStale(Date.now() - 130000), true);
  lim.update({ minIntervalMs: 2000, maxWaitMs: 1000, quietHours: { enabled: false } });
  assert.equal(lim.isStale(Date.now() - 5000), true);
});

test("全局节流：按间隔排队不丢；热更新不重置时隙", async () => {
  const lim = makeLimiter({ minIntervalMs: 40, maxWaitMs: 120000, quietHours: { enabled: false } });
  const t0 = Date.now();
  await lim.pace(); await lim.pace(); await lim.pace();
  assert.ok(Date.now() - t0 >= 70);  // 3 次 pace 至少等 2 个间隔，留 10ms 抖动余量
  lim.update({ minIntervalMs: 40, maxWaitMs: 120000, quietHours: { enabled: false } });
  const t1 = Date.now();
  await lim.pace(); // 上一时隙刚用完，这次仍需等 ≈40ms，而不是因重建而立刻放行
  assert.ok(Date.now() - t1 >= 20);  // 放宽到 20ms，进程调度有抖动
});

test("groupImageCap：平时按 groupImagesPerTurn；明说要多发时放宽到 groupImagesOnRequest，只放宽不收紧；0 = 不限", () => {
  const cap = (per, more, asked) => groupImageCap({ groupImagesPerTurn: per, groupImagesOnRequest: more }, asked);
  assert.equal(cap(1, 6, false), 1);
  assert.equal(cap(1, 6, true), 6);
  assert.equal(cap(3, 2, true), 3);   // 放宽值比平时还小：不收紧
  assert.equal(cap(1, 0, true), 0);   // 放宽到不限
  assert.equal(cap(0, 2, true), 0);   // 平时就不限：还是不限
  assert.equal(cap(0, 2, false), 0);
});
