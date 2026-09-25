import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { makeDedupe, makeDebouncer, makeLanes } from "../src/queue.js";

test("去重：同 id 第二次为已见；超容量淘汰最旧", () => {
  const d = makeDedupe(3);
  assert.equal(d.seen("a"), false);
  assert.equal(d.seen("a"), true);
  d.seen("b"); d.seen("c"); d.seen("d"); // a 被挤出
  assert.equal(d.seen("a"), false);
  assert.equal(d.seen("d"), true);
});

test("防抖：同 key 连发合并成一批，不同 key 各自一批", async () => {
  const flushed = [];
  const db = makeDebouncer((key, items) => flushed.push([key, items]));
  db.push("k1", 1, 20); db.push("k1", 2, 20); db.push("k2", 9, 20);
  assert.equal(flushed.length, 0);  // 还在等窗口
  await delay(60);
  assert.deepEqual(flushed.sort(), [["k1", [1, 2]], ["k2", [9]]]);
});

test("防抖：每次 push 重新计时", async () => {
  const flushed = [];
  const db = makeDebouncer((_k, items) => flushed.push(items));
  db.push("k", 1, 40);
  await delay(25); db.push("k", 2, 40);
  await delay(25); assert.equal(flushed.length, 0); // 第一次的 40ms 已过，但被第二次续了
  await delay(30); assert.deepEqual(flushed, [[1, 2]]);
});

test("防抖 flush：还在等窗口的立刻全交出去、定时器作废（不会再交第二次）；空的 flush 什么也不做", async () => {
  const flushed = [];
  const db = makeDebouncer((key, items) => flushed.push([key, items]));
  db.push("k1", 1, 1000); db.push("k1", 2, 1000); db.push("k2", 9, 1000);
  assert.equal(db.size(), 2);
  db.flush();
  assert.deepEqual(flushed.sort(), [["k1", [1, 2]], ["k2", [9]]]);
  assert.equal(db.size(), 0);
  db.flush();
  await delay(20);
  assert.equal(flushed.length, 2);
  db.push("k1", 3, 10);  // flush 之后照常能用
  await delay(40);
  assert.deepEqual(flushed.at(-1), ["k1", [3]]);
});

test("lane idle：等所有 lane 跑完，含等待期间新排进来的；出错的也算跑完；没有 lane 时立刻返回", async () => {
  const lanes = makeLanes(() => { throw new Error("onError 也炸了"); });  // onError 抛错既不能变成未处理的拒绝，也不能让同 lane 后面的被跳过
  const done = [];
  lanes.enqueue("A", async () => { await delay(20); done.push("A1"); lanes.enqueue("B", async () => { await delay(20); done.push("B1"); }); });
  lanes.enqueue("A", async () => { throw new Error("x"); });
  lanes.enqueue("A", async () => { done.push("A3"); });
  await lanes.idle();
  assert.deepEqual(done, ["A1", "A3", "B1"]);
  assert.equal(lanes.size(), 0);
  await lanes.idle();
});

test("串行 lane：同 key 依次执行、不同 key 并行；出错不阻塞后续", async () => {
  const order = [];
  const errors = [];
  const lanes = makeLanes((key, e) => errors.push([key, e.message]));
  const job = (tag, ms, fail) => async () => { await delay(ms); if (fail) throw new Error(tag); order.push(tag); };
  lanes.enqueue("A", job("A1", 30));
  lanes.enqueue("A", job("A2-fail", 5, true));
  lanes.enqueue("A", job("A3", 5));
  lanes.enqueue("B", job("B1", 5));
  assert.equal(lanes.size(), 2);
  await delay(80);
  assert.deepEqual(order, ["B1", "A1", "A3"]); // B1 不等 A；A2 失败后 A3 照跑
  assert.deepEqual(errors, [["A", "A2-fail"]]);
  assert.equal(lanes.size(), 0); // 空闲后清理
});
