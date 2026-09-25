// 监督进程：spawn / 文件监听 / 退出全部注入假的，定时器用 node:test 的 mock timers，不起真进程、不等真时间。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { supervise, retryDelay } from "../src/supervisor.js";

/** 假 worker：exit(code, signal) 模拟退出，kill 记下收到的信号；exitCode / signalCode 与真 ChildProcess 一致。 */
function fakeChild() {
  const c = new EventEmitter();
  c.exitCode = null; c.signalCode = null; c.kills = [];
  c.kill = (sig) => { c.kills.push(sig); return true; };
  c.exit = (code, signal = null) => { c.exitCode = signal ? null : code; c.signalCode = signal; c.emit("exit", signal ? null : code, signal); };
  return c;
}

function boot(t) {
  try { t.mock.timers.enable({ apis: ["setTimeout"] }); } catch {}  // 同一个测试里起第二个时已经开着
  let clock = 0;
  const children = [], logs = [], exits = [], signals = {};
  let onSrc = null, onConfig = null;
  const sup = supervise({
    srcDir: "/src", configFile: "/cfg/config.jsonc", argv: ["node", "index.js", "config.jsonc", "--hot"], env: {},
    deps: {
      spawn: (cmd, args, opts) => { const c = fakeChild(); c.args = [cmd, ...args]; c.env = opts.env; children.push(c); return c; },
      exit: (code) => exits.push(code),
      log: (m) => logs.push(m),
      now: () => clock,
      watch: (_dir, cb) => { onSrc = cb; },
      watchFile: (_f, _o, cb) => { onConfig = cb; },
      unwatchFile: () => {},
      listen: (sig, fn) => { signals[sig] = fn; },
    },
  });
  return {
    sup, children, logs, exits, signals,
    advance: (ms) => { clock += ms; t.mock.timers.tick(ms); },
    srcChange: (file) => onSrc("change", file),
    configChange: () => onConfig({ mtimeMs: clock + 1 }, { mtimeMs: clock }),
  };
}

test("退避：5s 起每次翻倍，封顶 5 分钟", () => {
  assert.deepEqual([1, 2, 3, 4].map(retryDelay), [5000, 10000, 20000, 40000]);
  assert.equal(retryDelay(20), 5 * 60_000);
});

test("启动即退：不再当成「改坏了」一直挂着，而是退避无限重试，日志写明启动失败与下次多久", (t) => {
  const s = boot(t);
  assert.equal(s.children.length, 1);
  assert.equal(s.children[0].env.HARNESS_WORKER, "1");
  s.advance(1300); s.children[0].exit(1);  // 平台暂时连不上：1.3s 就退
  assert.match(s.logs.at(-1), /启动失败（code 1，连续第 1 次），5s 后重试/);
  s.advance(4999); assert.equal(s.children.length, 1);
  s.advance(1); assert.equal(s.children.length, 2);
  s.advance(100); s.children[1].exit(1);
  assert.match(s.logs.at(-1), /连续第 2 次），10s 后重试/);
  s.advance(10_000); assert.equal(s.children.length, 3);
  assert.deepEqual(s.exits, []);
});

test("运行中崩溃与启动失败分开记；跑稳过一阵再崩，退避从头算；被信号杀掉也重试", (t) => {
  const s = boot(t);
  s.advance(10_000); s.children[0].exit(null, "SIGKILL");
  assert.match(s.logs.at(-1), /运行中崩溃（signal SIGKILL，跑了 10s），5s 后自动拉起/);
  s.advance(5000); s.advance(20_000); s.children[1].exit(1);
  assert.match(s.logs.at(-1), /运行中崩溃.*10s 后自动拉起/);  // 没跑稳，接着翻倍
  s.advance(10_000); s.advance(120_000); s.children[2].exit(1);
  assert.match(s.logs.at(-1), /运行中崩溃.*5s 后自动拉起/);  // 跑了 2 分钟：从头算
});

test("挂着等重试时：改代码或改配置都立刻拉起；worker 在跑时改配置不重启（它自己热更），改代码才重启", (t) => {
  const s = boot(t);
  s.configChange();
  assert.equal(s.children.length, 1);
  assert.deepEqual(s.children[0].kills, []);
  s.advance(100); s.children[0].exit(1);
  s.configChange();  // 配置写错修好了
  assert.equal(s.children.length, 2);
  s.advance(5000); assert.equal(s.children.length, 2);  // 原来的重试定时器作废了
  s.advance(100); s.children[1].exit(1);
  s.srcChange("harness.js"); s.advance(200);
  assert.equal(s.children.length, 3);
  s.srcChange("README.md"); s.advance(200);  // 不是 .js 不管
  s.srcChange("gate.js"); s.srcChange("tools.js"); s.advance(200);  // 在跑：合并成一次 SIGTERM 重启
  assert.deepEqual(s.children[2].kills, ["SIGTERM"]);
  s.children[2].exit(0);
  assert.equal(s.children.length, 4);
  assert.deepEqual(s.exits, []);  // 重启导致的退出不算 worker 主动退出
});

test("stop：worker 在跑就等它收尾再退（有宽限上限）；已退出（含被信号杀掉、exitCode 为 null）立刻退", (t) => {
  const s = boot(t);
  s.signals.SIGINT();
  assert.deepEqual(s.children[0].kills, ["SIGTERM"]);
  assert.deepEqual(s.exits, []);
  s.children[0].exit(0);
  assert.deepEqual(s.exits, [0]);

  const u = boot(t);
  u.advance(10_000); u.children[0].exit(null, "SIGKILL");  // 等 5s 重试期间 Ctrl+C
  u.signals.SIGTERM();
  assert.deepEqual(u.exits, [0]);
  u.advance(10_000);
  assert.equal(u.children.length, 1);  // 重试定时器已清

  const w = boot(t);
  w.signals.SIGTERM();
  w.advance(24_999); assert.deepEqual(w.exits, []);
  w.advance(1); assert.deepEqual(w.exits, [0]);  // worker 卡住也不无限等
});

test("worker 主动正常退出（code 0、没有信号），监督进程也退", (t) => {
  const s = boot(t);
  s.advance(10_000); s.children[0].exit(0);
  assert.deepEqual(s.exits, [0]);
});
