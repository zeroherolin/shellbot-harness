import { test } from "node:test";
import assert from "node:assert/strict";
import { splitText, makeLimiter, inQuietHours, makeOutbox, groupImageCap } from "../src/limits.js";

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
  const now = new Date();
  const q = { enabled: true, from: now.getHours(), to: (now.getHours() + 1) % 24, allowDirect: true };
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


test("outbox：push 立即返回、后台按节流顺序发、失败不抛回调用方、drain 等清空", async () => {
  const lim = makeLimiter({ minIntervalMs: 30, maxWaitMs: 120000, quietHours: { enabled: false } });
  const sent = [], errors = [];
  const box = makeOutbox({
    limiter: lim,
    send: async (job) => { if (job.fail) throw new Error("boom"); sent.push([Date.now(), job.id]); },
    onError: (job, e) => errors.push([job.id, e.message]),
  });
  const t0 = Date.now();
  box.push({ id: "a" }); box.push({ id: "b", fail: true }); box.push({ id: "c" });
  assert.ok(Date.now() - t0 < 25);  // push 不等发送（留调度余量）
  assert.equal(box.size(), 3);
  await box.drain();
  assert.deepEqual(sent.map((s) => s[1]), ["a", "c"]);  // 顺序保持，失败的跳过
  assert.deepEqual(errors, [["b", "boom"]]);
  assert.ok(sent[1][0] - sent[0][0] >= 45);  // a 与 c 之间隔了 b 的时隙 + 自己的时隙（2×30ms，留余量）
  assert.equal(box.size(), 0);
  box.push({ id: "d" });  // 清空后再 push 会重新启动后台循环
  await box.drain();
  assert.equal(sent.at(-1)[1], "d");
});

test("outbox：onError 自己抛错、persist 抛错都不会让循环死掉，后面的照发", async () => {
  const lim = makeLimiter({ minIntervalMs: 1, maxWaitMs: 120000, quietHours: { enabled: false } });
  const sent = [];
  let persistFails = false;
  const box = makeOutbox({
    limiter: lim,
    send: async (job) => { if (job.fail) throw new Error("boom"); sent.push(job.id); },
    onError: () => { throw new Error("onError 也炸了"); },
    persist: () => { if (persistFails) throw new Error("磁盘满"); },
  });
  box.push({ id: "a", fail: true }); box.push({ id: "b" });
  await box.drain();
  assert.deepEqual(sent, ["b"]);
  persistFails = true;
  assert.doesNotThrow(() => box.push({ id: "c" }));  // 落盘炸了不影响入队与发送
  await box.drain();
  persistFails = false;
  box.push({ id: "d" });
  await box.drain();
  assert.deepEqual(sent, ["b", "c", "d"]);
  assert.equal(box.size(), 0);
});

test("outbox persist：队列每次变化都同步给出快照；正在发的那条不在里面，发完是空数组", async () => {
  const lim = makeLimiter({ minIntervalMs: 20, maxWaitMs: 120000, quietHours: { enabled: false } });
  const snapshots = [];
  const box = makeOutbox({ limiter: lim, send: async () => {}, onError() {}, persist: (jobs) => snapshots.push(jobs.map((j) => j.id)) });
  box.push({ id: "a" }); box.push({ id: "b" });
  assert.deepEqual(snapshots.slice(0, 2), [["a"], ["a", "b"]]);
  await box.drain();
  assert.deepEqual(snapshots.slice(2), [["b"], []]);  // a 出队时快照里只剩 b；b 出队时为空
});

test("outbox 过期任务：出队前先判、交给 onStale，不占时隙（一串过期的不拖慢后面的新任务）；没有 ts 的不算过期", async () => {
  const lim = makeLimiter({ minIntervalMs: 50, maxWaitMs: 1000, quietHours: { enabled: false } });
  const sent = [], stale = [];
  const box = makeOutbox({ limiter: lim, send: async (job) => sent.push([Date.now(), job.id]), onError() {}, onStale: (job) => stale.push(job.id) });
  const old = Date.now() - 5000;
  const t0 = Date.now();
  box.push({ id: "fresh1", ts: Date.now() });
  for (let i = 0; i < 5; i++) box.push({ id: `old${i}`, ts: old });
  box.push({ id: "fresh2", ts: Date.now() });
  box.push({ id: "no-ts" });
  await box.drain();
  assert.deepEqual(stale, ["old0", "old1", "old2", "old3", "old4"]);
  assert.deepEqual(sent.map((s) => s[1]), ["fresh1", "fresh2", "no-ts"]);
  assert.ok(sent[1][0] - t0 < 5 * 50);  // fresh2 只等了自己的 1 个时隙，没为 5 条过期的各等一次
});

test("outbox hold / resume：暂停期间入队、落盘照常但不发；resume 后按顺序发", async () => {
  const lim = makeLimiter({ minIntervalMs: 1, maxWaitMs: 120000, quietHours: { enabled: false } });
  const sent = [], snapshots = [];
  const box = makeOutbox({ limiter: lim, send: async (job) => sent.push(job.id), onError() {}, persist: (jobs) => snapshots.push(jobs.map((j) => j.id)) });
  box.hold();
  assert.equal(box.held(), true);
  box.push({ id: "a" }); box.push({ id: "b" });
  await box.drain();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, []);
  assert.deepEqual(snapshots.at(-1), ["a", "b"]);  // 暂停时崩了也在盘上
  box.resume();
  assert.equal(box.held(), false);
  await box.drain();
  assert.deepEqual(sent, ["a", "b"]);
});

test("outbox stop：正在发的那条发完就不再出队，剩下的留在盘上；之后 push 只落盘不发", async () => {
  const lim = makeLimiter({ minIntervalMs: 1, maxWaitMs: 120000, quietHours: { enabled: false } });
  const sent = [], snapshots = [];
  let release;
  const box = makeOutbox({
    limiter: lim,
    send: async (job) => { if (job.id === "a") await new Promise((r) => { release = r; }); sent.push(job.id); },
    onError() {}, persist: (jobs) => snapshots.push(jobs.map((j) => j.id)),
  });
  box.push({ id: "a" }); box.push({ id: "b" }); box.push({ id: "c" });
  await new Promise((r) => setTimeout(r, 20));  // a 正在发
  box.stop();
  release();
  await box.drain();
  assert.deepEqual(sent, ["a"]);
  assert.deepEqual(snapshots.at(-1), ["b", "c"]);  // 留给下一个进程续发
  box.push({ id: "d" });
  await box.drain();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ["a"]);
  assert.deepEqual(snapshots.at(-1), ["b", "c", "d"]);
  assert.equal(box.size(), 3);
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
