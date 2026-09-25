import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSender, makeOutbox } from "../src/send.js";
import { makeLimiter } from "../src/limits.js";
import { tmpDir, waitFor } from "./helpers.js";

const conv = { id: "g1@chatroom", isGroup: true, name: "测试群" };

/** 假依赖：HTTP 发送落在 http、OpenClaw 发布由 publish 决定、日志落在 lines / events。 */
function setup({ publish, connected = true } = {}) {
  const ws = tmpDir("send-");
  const http = [], lines = [], events = [], sentLog = [];
  const log = { info() {}, warn: (m) => lines.push(["warn", m]), error: (m) => lines.push(["error", m]), event: (name, d) => events.push({ name, ...d }) };
  const deps = {
    cfg: { bot: { id: 1 } }, ws, log,
    api: { send: async (_id, target, messages) => { http.push({ target, messages }); } },
    mem: { rooms: () => ({ [conv.id]: conv.name }), appendSent: (id, e) => sentLog.push([id, e.text]) },
    oc: { connected: () => connected, publish },
  };
  const sender = makeSender(() => deps, makeLimiter({ minIntervalMs: 0, maxWaitMs: 60_000 }));
  return { sender, ws, http, lines, events, sentLog };
}

test("OpenClaw 发布结果未知（等确认时断线）：不回退 HTTP、记 error、照样记进发送日志——宁可丢一条也不重复进群", async () => {
  const { sender, http, lines, events, sentLog } = setup({ publish: async () => { throw Object.assign(new Error("连接断了"), { uncertain: true }); } });
  sender.deliver(conv, [{ type: 1, content: "你好" }], []);
  await waitFor(() => events.some((e) => e.name === "sent"));
  assert.equal(http.length, 0);
  assert.equal(events.find((e) => e.name === "sent").outcome, "uncertain");
  assert.ok(lines.some(([lv, m]) => lv === "error" && /结果未知，不重发/.test(m)));
  assert.deepEqual(sentLog, [[conv.id, "你好"]]);
});

test("OpenClaw 肯定没发出去（failed）才回退 HTTP，@ 拼回正文；没连上直接走 HTTP", async () => {
  const failed = setup({ publish: async () => { throw new Error("client disconnecting"); } });
  failed.sender.deliver(conv, [{ type: 1, content: "开会" }], [{ name: "小王", wxid: "wxid_w" }]);
  await waitFor(() => failed.http.length === 1);
  assert.equal(failed.http[0].messages[0].content, "@小王 开会");
  assert.equal(failed.events.find((e) => e.name === "sent").channel, "http");

  let published = 0;
  const offline = setup({ connected: false, publish: async () => { published++; } });
  offline.sender.deliver(conv, [{ type: 1, content: "在" }], []);
  await waitFor(() => offline.http.length === 1);
  assert.equal(published, 0);  // 没连上就不试 OpenClaw（试了再回退也能过上一句，所以单独数）
});

test("take：读不出来的 outbox.json 改名成 .corrupt- 留底、告警、不续发；读得出来的取走后删掉", () => {
  const bad = setup({ publish: async () => {} });
  fs.writeFileSync(path.join(bad.ws, "outbox.json"), "[{半截");
  assert.deepEqual(bad.sender.take(), []);
  const files = fs.readdirSync(bad.ws);
  assert.ok(files.some((f) => f.startsWith("outbox.json.corrupt-")));
  assert.ok(!files.includes("outbox.json") && !files.includes("outbox.json.restoring"));
  assert.ok(bad.lines.some(([lv, m]) => lv === "warn" && /读不出来，已改名留底/.test(m)));

  const good = setup({ publish: async () => {} });
  fs.writeFileSync(path.join(good.ws, "outbox.json"), JSON.stringify([{ conv, messages: [{ type: 1, content: "x" }], mentions: [], ts: Date.now() }]));
  assert.equal(good.sender.take().length, 1);
  assert.deepEqual(fs.readdirSync(good.ws), []);
});

// ---- 出站队列（makeOutbox）----
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
