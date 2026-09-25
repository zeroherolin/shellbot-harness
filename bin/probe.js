#!/usr/bin/env node
// 连通性探测：拉原生 broker → 订阅 chat/<botId>/+ 监听 N 秒打印入站；可选先发一条测试消息（HTTP）
//   node bin/probe.js --config mybot.local/config.jsonc [--seconds 60] [--send <wxid|group:<roomId>> --text "内容"] [--client-suffix x]
// probe 的 clientId 前缀与 harness 不同，可以和运行中的 harness 并存；但同一 bot 别同时跑两个 probe（clientId 相同会互踢，看起来像平台抖动）。
// 带 --send 时先等订阅成功再发，否则自己那条的回显可能在订阅前就到了、漏掉，误以为收不到。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { loadBot, fetchBroker, startMqtt } from "../src/platform.js";
import { makeApi, resolveToken, sendTarget } from "../src/api.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const seconds = Number(opt("--seconds", 60));
const sendTo = opt("--send", null);
const text = opt("--text", "shellbot-harness 连通性测试");
const suffix = opt("--client-suffix", null);

const cfg = loadConfig(opt("--config", path.join(root, "config.jsonc")));
const stamp = () => new Date().toISOString();
const log = {
  info: (m) => console.log(stamp(), m),
  warn: (m) => console.warn(stamp(), "WARN", m),
  error: (m) => console.error(stamp(), "ERROR", m),
};

const api = makeApi({ host: cfg.host, token: resolveToken(cfg), net: cfg.network });
const bot = await loadBot(api, cfg.bot.id);
if (cfg.bot.name) bot.name = cfg.bot.name;  // 和 harness 一样：配置钉了昵称就以它为准
console.log(`机器人 ${bot.name} (id ${bot.id})，聊天记录${bot.recordOpen ? "已开" : "未开（收不到消息）"}，OpenClaw ${bot.clawOpen ? "已开" : "未开（真 @ 不可用）"}`);
const broker = await fetchBroker(cfg.host, { timeoutMs: cfg.network.platformTimeoutMs });
const mask = (s) => (s ? `${String(s).slice(0, 3)}…${String(s).slice(-2)}` : s);
console.log("原生 broker：", { url: broker.url, username: mask(broker.username), password: mask(broker.password) });

const SUBSCRIBE_WAIT_MS = 20000;  // --send 前最多等订阅成功这么久

let count = 0;
let subscribed;
const ready = new Promise((r) => { subscribed = r; });
const clientSuffix = suffix ?? cfg.network.mqttClientIdSuffix;
const mq = startMqtt({
  host: cfg.host, botId: cfg.bot.id, log, net: cfg.network,
  clientId: `harness_probe_${cfg.bot.id}${clientSuffix ? `_${clientSuffix}` : ""}`,  // 带分隔符：bot 12 加后缀 3 不会撞上 bot 123
  onSubscribed: () => subscribed(),
  onMessage: (m) => {
    count++;
    const where = m.isGroup ? `群「${m.conv.name || m.conv.id}」` : "私聊";
    console.log(`\n[入站 ${count}] ${where} ${m.sender.name} (${m.sender.id}) type=${m.type} mine=${m.isMine}`);
    console.log(`  ${m.text.slice(0, 300)}${m.url ? `\n  url=${m.url}` : ""}`);
  },
});

if (sendTo) {
  const got = await Promise.race([ready.then(() => true), new Promise((r) => setTimeout(() => r(false), SUBSCRIBE_WAIT_MS).unref())]);
  if (!got) console.warn(`${SUBSCRIBE_WAIT_MS / 1000} 秒内没订阅成功，照样发送；这条的回显可能收不到`);
  const isGroup = sendTo.startsWith("group:");
  const conv = { id: isGroup ? sendTo.slice(6) : sendTo, isGroup };
  try {
    await api.send(cfg.bot.id, sendTarget(conv), [{ type: 1, content: text }]);
    console.log(`已向 ${sendTo} 发送测试消息：${text}`);
  } catch (e) {
    console.error("发送失败：", e.message);
  }
}

console.log(`监听 ${seconds} 秒……（Ctrl+C 提前退出）`);
const finish = () => { console.log(`\n结束，共收到 ${count} 条入站消息`); mq.close(); process.exit(0); };
setTimeout(finish, seconds * 1000);
process.once("SIGINT", finish);
