// --hot 监督进程：spawn 一个 worker 干活，监听 src/*.js，改代码就重启 worker。
// worker 收 SIGTERM 先关连接再退出，避免新旧 worker 撞 clientId；重启期间再来改动只合并。
// worker 非正常退出一律按指数退避无限重试（启动即退多半是代码 / 配置改坏了或平台暂时连不上，都可能自己好）；
// 挂着等重试时改了代码或配置文件就立刻拉起。worker 在跑时配置由它自己热更，监督进程不管。
import fs from "node:fs";
import { spawn } from "node:child_process";
import { CONFIG_POLL_MS } from "./util.js";

const RESTART_DEBOUNCE_MS = 200;    // 编辑器连续写盘合并成一次重启
const EXIT_GRACE_MS = 25_000;       // 收到退出信号后最多等 worker 收尾这么久：worker 等 lane 15s + 清出站队列 5s + 退出前 0.3s，再留余量
const CRASH_WINDOW_MS = 3000;       // 启动后这么短时间内退出算「启动失败」，否则算「运行中崩溃」（只影响日志措辞）
const RETRY_BASE_MS = 5000;         // 第一次重试等这么久，之后每次翻倍
const RETRY_MAX_MS = 5 * 60_000;    // 重试间隔上限
const STABLE_MS = 60_000;           // worker 连续跑过这么久再退出，退避从头算

/** 第 n 次连续失败后等多久：5s → 10s → 20s …，封顶 5 分钟。 */
export const retryDelay = (n) => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, n - 1), RETRY_MAX_MS);

/**
 * 启动监督。configFile 是 worker 用的配置文件（绝对路径），挂着等重试时它变了也立刻拉起。
 * deps 可覆盖 spawn / exit / log / now / watch / watchFile / unwatchFile / listen（注册信号），测试注入假的；返回 { stop }。
 */
export function supervise({ srcDir, configFile = null, argv = process.argv, env = process.env, deps = {} }) {
  const {
    spawn: start = spawn, exit = (code) => process.exit(code), log = console.log, now = Date.now,
    watch = fs.watch, watchFile = fs.watchFile, unwatchFile = fs.unwatchFile, listen = (sig, fn) => process.on(sig, fn),
  } = deps;
  const tag = "\x1b[2m[hot]\x1b[0m";
  let child = null, timer = null, retry = null, restarting = false, stopping = false;
  let failures = 0;  // 连续非正常退出次数，决定下次等多久

  const exited = (c) => c.exitCode !== null || c.signalCode !== null;  // 被信号杀掉时 exitCode 是 null、signalCode 有值
  const launch = () => {
    clearTimeout(retry); retry = null;
    restarting = false;
    const startedAt = now();
    const c = (child = start(argv[0], argv.slice(1), { stdio: "inherit", env: { ...env, HARNESS_WORKER: "1" } }));
    c.on("exit", (code, signal) => {
      if (stopping || c !== child) return;
      if (restarting) return launch();  // 重启导致的退出，拉起新 worker
      if (code === 0 && !signal) return exit(0);  // worker 主动正常退出，监督也退；被信号杀掉（OOM / kill -9）不算
      const ran = now() - startedAt;
      failures = ran >= STABLE_MS ? 1 : failures + 1;
      const wait = retryDelay(failures);
      const why = signal ? `signal ${signal}` : `code ${code}`;
      log(ran < CRASH_WINDOW_MS
        ? `${tag} worker 启动失败（${why}，连续第 ${failures} 次），${wait / 1000}s 后重试；代码改坏 / 配置写错 / 平台暂时连不上都会这样，改了代码或配置会立刻重试`
        : `${tag} worker 运行中崩溃（${why}，跑了 ${Math.round(ran / 1000)}s），${wait / 1000}s 后自动拉起`);
      retry = setTimeout(launch, wait);
    });
  };
  const down = () => !!retry || !child || exited(child);  // worker 没在跑（等重试中）
  const restart = (what) => {
    if (stopping) return;
    if (down()) { log(`${tag} ${what}，立刻重新拉起…`); return launch(); }
    if (restarting) return;  // 已在重启中，不叠加
    log(`${tag} ${what}，重启…`);
    restarting = true;
    child.kill("SIGTERM");
  };

  watch(srcDir, (_evt, file) => {
    if (!file?.endsWith(".js")) return;
    clearTimeout(timer);
    timer = setTimeout(() => restart(`代码改动（${file}）`), RESTART_DEBOUNCE_MS);
  });
  if (configFile) {
    watchFile(configFile, { interval: CONFIG_POLL_MS }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs || stopping || restarting || !down()) return;  // 在跑的 worker 自己热更配置，不重启
      log(`${tag} 配置改动，立刻重新拉起…`);
      launch();
    });
  }
  const stop = () => {
    stopping = true;
    clearTimeout(retry); clearTimeout(timer);
    if (configFile) unwatchFile(configFile);
    if (!child || exited(child)) return exit(0);
    child.once("exit", () => exit(0));  // 等 worker 收尾（lane、出站队列）再退
    child.kill("SIGTERM");
    setTimeout(() => exit(0), EXIT_GRACE_MS).unref();
  };
  for (const sig of ["SIGINT", "SIGTERM"]) listen(sig, stop);
  launch();
  log(`${tag} 已开启：改配置免重启、改代码自动重启（监听 ${srcDir}${configFile ? ` 与 ${configFile}` : ""}）`);
  return { stop };
}
