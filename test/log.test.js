import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeLog, localIso } from "../src/log.js";

process.env.TZ = "Asia/Shanghai";  // 文件名、ts、跨天都按本地时区算，测试钉死时区

const withDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const capture = (fn) => {
  const orig = console.log; const out = [];
  console.log = (...a) => out.push(a.join(" "));
  try { fn(); } finally { console.log = orig; }
  return out;
};
const readJsonl = (dir) => {
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".jsonl"));
  return fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
};

test("makeLog：建目录、info/warn/error 落 JSONL 且控制台一行带标签", () => withDir((dir) => {
  const logDir = path.join(dir, "logs");
  const log = makeLog(logDir, { keepDays: 30 });
  const out = capture(() => { log.info("启动"); log.warn("注意", { k: 1 }); log.error("坏了"); });
  assert.equal(out.length, 3);
  assert.match(out[0], /^\d{2}:\d{2}:\d{2} info\s+启动$/);
  assert.match(out[1], /warn\s+注意$/);
  const rows = readJsonl(logDir);
  assert.deepEqual(rows.map((r) => r.level), ["INFO", "WARN", "ERROR"]);
  assert.equal(rows[1].k, 1);  // extra 字段进 JSONL
  assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.ts)));
}));

test("makeLog.event：inbound / agent / outbound / sent / tool / dropped 各有摘要，JSONL 落全量", () => withDir((dir) => {
  const log = makeLog(dir, { keepDays: 30 });
  const out = capture(() => {
    log.event("inbound", { conv: "g", convName: "群", name: "小明", text: "你好 ".repeat(40), type: "文字", verdict: "trigger", reason: "at-text" });
    log.event("inbound", { convName: "群", name: "小明", type: "文件", isImage: true, text: "", verdict: "context", reason: "not-triggered" });
    log.event("agent", { convName: "群", trigger: "at-text", reason: "stop", ms: 1500, usage: { input: 10, output: 5 }, textLen: 8, noReply: false, turns: 2, images: 1, imageSource: "quoted", imageEncoding: "url" });
    log.event("agent", { convName: "群", trigger: "chime", ms: 200, noReply: true });
    log.event("outbound", { convName: "群", parts: 2, text: "回复", origin: "say" });
    log.event("sent", { convName: "群", channel: "http", kind: "图片", count: 1, outcome: "failed", error: "HTTP 502", elapsedMs: 40 });
    log.event("sent", { convName: "群", channel: "openclaw", kind: "文字", count: 2, outcome: "sent", elapsedMs: 120, waitMs: 2000 });
    log.event("tool", { convName: "群", tool: "send_sticker", input: { name: "点赞" }, ok: true, ms: 30, outLen: 42 });
    log.event("tool", { tool: "shellbot", ok: false, error: "该命令不允许" });
    log.event("dropped", { convName: "群", reason: "stale" });
    log.event("custom", { any: "thing" });
    log.event("agent", { convName: "群", trigger: "at-text", reason: "stop", ms: 300, noReply: true, toolSends: 1 });
  });
  assert.equal(out.length, 12);
  assert.match(out[0], /群.*小明: 你好.*…/);           // 长文本被截断
  assert.match(out[1], /小明: \[文件\].*context\/not-triggered/);  // 非文字显示成 [类型] 占位
  assert.match(out[2], /at-text stop · \[看图 1\(quoted\) 仅链接\] 8字.*10→5tok · 1\.5s · 2轮/);  // 这轮看了哪张图、几轮
  assert.match(out[3], /不回复\(NO_REPLY\)/);
  assert.match(out[4], /→ 回复.*2条 · say/);
  assert.match(out[5], /✗ HTTP 图片 1 条.*失败：HTTP 502/);  // 失败也有 sent，证据链不断
  assert.match(out[6], /✓ OpenClaw 文字 2 条/);
  assert.match(out[7], /send_sticker ok.*30ms.*返回 42 字.*点赞/);
  assert.match(out[8], /shellbot err: 该命令不允许/);
  assert.match(out[9], /群\s+stale/);
  assert.match(out[10], /custom/);
  assert.match(out[11], /at-text stop · 工具已发 1 条 · 文字 NO_REPLY/);  // 工具里发了图 / 表情，文字部分 NO_REPLY 不算沉默
  const rows = readJsonl(dir);
  assert.equal(rows.length, 12);
  assert.equal(rows[0].text.length, 120);  // JSONL 里不截断（inbound 的 text 由调用方截）
  assert.equal(rows[0].event, "inbound");
  assert.equal(rows[0].level, "EVENT");
  assert.equal(rows[1].isImage, true);
  assert.equal(rows[6].channel, "openclaw");
}));

test("makeLog.with：固定字段自动并进每条 JSONL（事件 / 告警都算），也能继续派生；控制台不加前缀", () => withDir((dir) => {
  const log = makeLog(dir, { keepDays: 30 });
  const t = log.with({ conv: "g", convName: "群", turn: "m7" });
  const out = capture(() => { t.event("outbound", { parts: 1, text: "回复" }); t.warn("图片下载失败"); t.with({ tool: "x" }).event("tool", { ok: true }); });
  const rows = readJsonl(dir);
  assert.deepEqual(rows.map((r) => [r.event || null, r.conv, r.turn]), [["outbound", "g", "m7"], [null, "g", "m7"], ["tool", "g", "m7"]]);
  assert.equal(rows[1].level, "WARN");
  assert.equal(rows[2].tool, "x");  // 派生器继续叠加字段
  assert.equal(out[0].includes("turn"), false);  // 摘要里不暴露这些内部字段
  assert.match(out[1], /warn\s+图片下载失败$/);
}));

test("makeLog：超期的每日 JSONL 启动时清掉，未超期与其它文件不动；keepDays 生效", () => withDir((dir) => {
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  const fresh = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  for (const [name, at] of [["2026-01-01.jsonl", old], ["2026-09-21.jsonl", fresh], ["notes.txt", old]]) {
    fs.writeFileSync(path.join(dir, name), "x");
    fs.utimesSync(path.join(dir, name), at, at);
  }
  const out = capture(() => makeLog(dir, { keepDays: 30 }));
  assert.match(out.join("\n"), /清理 1 个超过 30 天的日志文件/);  // 清理不静默
  assert.throws(() => makeLog(dir, {}), /keepDays/);  // config 里有的字段不写兜底
  const left = fs.readdirSync(dir).sort();
  assert.ok(!left.includes("2026-01-01.jsonl"));
  assert.ok(left.includes("2026-09-21.jsonl") && left.includes("notes.txt"));  // 只清日志文件
}));

test("文件名与 ts 按本地时区：北京时间凌晨落在当天文件，ts 带 +08:00 且能被 Date 解析回同一时刻", () => withDir((dir) => {
  const t = Date.UTC(2026, 8, 24, 18, 47, 41, 585);  // 北京时间 09-25 02:47:41.585，UTC 还是 09-24
  const log = makeLog(dir, { keepDays: 30, now: () => t });
  const out = capture(() => log.info("凌晨"));
  assert.deepEqual(fs.readdirSync(dir), ["2026-09-25.jsonl"]);
  const [row] = readJsonl(dir);
  assert.equal(row.ts, "2026-09-25T02:47:41.585+08:00");
  assert.equal(Date.parse(row.ts), t);
  assert.match(out[0], /^02:47:41 /);  // 控制台时间与 ts 同一时区
}));

test("localIso：负偏移、半小时偏移、零偏移都能被 Date 解析回原时刻", () => {
  const t = Date.UTC(2026, 0, 15, 3, 4, 5, 6);
  try {
    for (const [zone, want] of [["America/St_Johns", "2026-01-14T23:34:05.006-03:30"], ["Asia/Kolkata", "2026-01-15T08:34:05.006+05:30"], ["UTC", "2026-01-15T03:04:05.006+00:00"]]) {
      process.env.TZ = zone;
      assert.equal(localIso(new Date(t)), want);
      assert.equal(Date.parse(want), t);
    }
  } finally { process.env.TZ = "Asia/Shanghai"; }
});

test("跨天清理：结果不止打控制台，也落进新一天的 JSONL", () => withDir((dir) => {
  const d = new Date(); d.setHours(23, 59, 0, 0);  // 今天本地 23:59，时钟相对真实时间，文件 mtime 不会被误判超期
  let t = d.getTime();
  const log = makeLog(dir, { keepDays: 30, now: () => t });
  capture(() => log.info("睡前"));
  const old = new Date(t - 40 * 24 * 3600 * 1000);
  fs.writeFileSync(path.join(dir, "2000-01-01.jsonl"), "x");
  fs.utimesSync(path.join(dir, "2000-01-01.jsonl"), old, old);
  t += 2 * 60 * 1000;  // 跨过本地零点
  const out = capture(() => log.info("起床"));
  assert.match(out.join("\n"), /清理 1 个超过 30 天的日志文件/);
  const next = new Date(t);
  const file = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}.jsonl`;
  const rows = fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.msg), ["起床", "清理 1 个超过 30 天的日志文件"]);
  assert.equal(rows[1].level, "INFO");
  assert.ok(!fs.existsSync(path.join(dir, "2000-01-01.jsonl")));
}));
