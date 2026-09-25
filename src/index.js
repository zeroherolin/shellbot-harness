// 入口：node src/index.js [config.jsonc] [--hot]
// --hot 时顶层做监督进程（改代码自动重启 worker、worker 挂了退避重试、挂着时改配置立刻拉起），worker 内改配置进程内热更；不加就是普通单进程。
// 配置路径按启动时的 cwd 解析（worker 继承 cwd，两层解析一致），配置里的 workspace 按仓库根解析。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHarness } from "./harness.js";
import { supervise } from "./supervisor.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(srcDir, "..");
const args = process.argv.slice(2);
const hot = args.includes("--hot");
const configArg = args.find((a) => !a.startsWith("-"));
const configFile = configArg ? path.resolve(configArg) : path.join(root, "config.jsonc");

if (hot && !process.env.HARNESS_WORKER) supervise({ srcDir, configFile });
else runHarness({ root, configFile, hot }).catch((e) => { console.error(e.stack || e); process.exit(1); });
