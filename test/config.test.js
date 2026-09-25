import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULTS, DOCS, loadConfig, validate, merge, parseJsonc, renderJsonc, unknownKeys } from "../src/config.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "config.js");

const tmpConfig = (text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  const file = path.join(dir, "config.jsonc");
  fs.writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text));
  return file;
};
const minimal = { host: "https://h", workspace: "mybot.local/workspace", bot: { id: 1 }, owner: "wxid_o", agent: { baseUrl: "https://x", token: "t", model: "m" } };
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? flat(v, p + k + ".") : [p + k]));

test("深合并：对象递归、数组和标量整体替换、不改默认值", () => {
  const base = structuredClone(DEFAULTS);
  const out = merge(base, { groups: { allow: ["a"], chime: { enabled: true } }, agent: { model: "m" } });
  assert.deepEqual(out.groups.allow, ["a"]);
  assert.equal(out.groups.chime.enabled, true);
  assert.equal(out.groups.chime.cooldownMinutes, 15);
  assert.equal(out.agent.model, "m");
  assert.equal(out.agent.maxTurns, 6);
  assert.equal(DEFAULTS.agent.model, "");
});

test("parseJsonc：行注释、块注释、尾随逗号；字符串里的 // 不被当注释", () => {
  const text = `{
    // 行注释
    "a": 1, /* 块注释 */
    "url": "https://x/y", // 值里有 //
    "list": [1, 2,],
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, url: "https://x/y", list: [1, 2] });
  assert.deepEqual(parseJsonc('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonc(String.raw`{ "t": "ab//cd", "p": "^x/*y", "e": "q\"//r" }`), { t: "ab//cd", p: "^x/*y", e: 'q"//r' });  // 字符串里的注释符与转义引号
  assert.deepEqual(parseJsonc('{ "a": 1 } /* 尾部未闭合的块注释'), { a: 1 });
});

test("parseJsonc：尾随逗号只去字符串外的；字符串里的 ,] ,} 原样保留；逗号和括号之间隔着注释也认", () => {
  assert.deepEqual(parseJsonc(String.raw`{ "wake": ["^helper[，,]", "[,]"], "f": "好的, }", }`), { wake: ["^helper[，,]", "[,]"], f: "好的, }" });  // 以前变成 [，] 和 []
  assert.deepEqual(parseJsonc('{ "a": [1, 2, // 注释\n /* 块 */ ], }'), { a: [1, 2] });
  assert.deepEqual(parseJsonc('{ "a": "x" /* , */ , "b": 1 }'), { a: "x", b: 1 });  // 注释里的逗号不影响
  assert.deepEqual(parseJsonc(String.raw`{ "a": "q\\", }`), { a: "q\\" });  // 反斜杠结尾的字符串后面的尾随逗号
  assert.throws(() => parseJsonc("[1,,]"));  // 只去一个逗号，连续逗号仍是错
});

test("renderJsonc：每个叶子字段带注释且同组对齐、分组间空行、能被 parseJsonc 读回", () => {
  const text = renderJsonc({ a: 1, g: { b: "x", cc: [1] }, h: { d: true } }, { docs: { a: "甲", "g.b": "乙", "g.cc": "丙", "h.d": "丁" } });
  assert.deepEqual(parseJsonc(text), { a: 1, g: { b: "x", cc: [1] }, h: { d: true } });
  const ls = text.split("\n");
  assert.equal(ls[1], '  "a": 1,  // 甲');
  assert.equal(ls[2], "");
  assert.equal(ls[3], '  "g": {');
  assert.equal(ls[4], '    "b": "x",  // 乙');  // 同组内对齐
  assert.equal(ls[5], '    "cc": [1]  // 丙');
  assert.equal(ls[6], "  },");
  assert.equal(ls[7], "");
  assert.match(ls[9], /^    "d": true  \/\/ 丁$/);
});

test("DOCS 与 DEFAULTS 一一对应（每个字段都有注释、没有过期注释）", () => {
  const keys = flat(DEFAULTS);
  assert.deepEqual(keys.filter((k) => !DOCS[k]), []);
  assert.deepEqual(Object.keys(DOCS).filter((k) => !keys.includes(k)), []);
});

test("加载：合并默认值并通过校验；jsonc 带注释也能读", () => {
  const cfg = loadConfig(tmpConfig(`{ // 注释\n "host": "https://h", "workspace": "mybot.local/workspace", "bot": { "id": 1 }, "owner": "wxid_o", "agent": { "baseUrl": "https://x", "token": "t", "model": "m", }, }`));
  assert.equal(cfg.bot.id, 1);
  assert.equal(cfg.dm.policy, "owner");
  assert.equal(cfg.memory.maxGlobalLines, 200);
  assert.deepEqual(cfg.stickers, { edge: 240, quality: 85, maxCount: 100, repeatCooldownMinutes: 10, inboundPollSec: 15 });
  assert.deepEqual(cfg.context, { size: 100, rosterSize: 80, peekLines: 10 });
  assert.equal(cfg.limits.groupImagesPerTurn, 1);
  assert.equal(cfg.network.reconnectMaxMs, 60000);
  assert.equal(cfg.network.apiTimeoutMs, 30000);
  assert.equal(cfg.images.rehost, true);
});

test("校验：必填、枚举、类型与范围", () => {
  const v = (patch) => () => validate(merge(structuredClone(DEFAULTS), merge(structuredClone(minimal), patch)));
  assert.throws(v({ host: "" }), /host 必填/);
  assert.throws(v({ bot: { id: 0 } }), /bot\.id/);
  assert.throws(v({ bot: { id: 1, name: null } }), /bot\.name 必须是字符串/);
  assert.throws(v({ owner: "" }), /owner/);
  assert.throws(v({ agent: { model: "" } }), /agent\.model 必填/);
  assert.throws(v({ dm: { policy: "everyone" } }), /dm\.policy/);
  assert.throws(v({ groups: { policy: "all" } }), /groups\.policy/);
  assert.throws(v({ agent: { protocol: "gemini" } }), /protocol/);
  assert.throws(v({ agent: { protocol: "openai", baseUrl: "" } }), /baseUrl/);
  assert.throws(v({ groups: { wakePatterns: ["("] } }), /wakePatterns/);
  assert.throws(v({ images: { avatarPatterns: ["("] } }), /avatarPatterns 里的正则/);
  assert.throws(v({ images: { avatarPatterns: "头像" } }), /avatarPatterns 必须是字符串数组/);
  assert.throws(v({ blockedSenders: "wxid_x" }), /blockedSenders 必须是字符串数组/);  // 字符串会让 includes 变成子串匹配
  assert.throws(v({ groups: { allow: [1] } }), /groups\.allow 必须是字符串数组/);
  assert.throws(v({ dm: { allowFrom: "wxid_x" } }), /dm\.allowFrom 必须是字符串数组/);
  assert.throws(v({ context: { size: 0 } }), /context\.size 必须是正整数/);
  assert.throws(v({ context: { peekLines: -1 } }), /peekLines/);
  assert.throws(v({ limits: { groupImagesPerTurn: -1 } }), /groupImagesPerTurn/);
  assert.throws(v({ images: { vision: "yes" } }), /images\.vision 必须是 true/);
  assert.throws(v({ history: { defaultCount: 600 } }), /defaultCount 不能大于 maxCount/);
  assert.throws(v({ network: { reconnectBaseMs: 90000 } }), /reconnectBaseMs 不能大于/);
  assert.throws(v({ agent: { timeoutMs: 400000 } }), /turnTimeoutMs 不能小于 timeoutMs/);  // 一轮连一次请求都跑不满
  assert.throws(v({ context: { rosterSize: 0 } }), /context\.rosterSize 必须是正整数/);
  assert.throws(v({ stickers: { inboundPollSec: 2 } }), /inboundPollSec 要么是 0/);
  assert.doesNotThrow(v({ stickers: { inboundPollSec: 0 } }));  // 0 = 不收
  // 时长超过 Node 定时器上限（约 24.8 天）会被当成 1ms 立刻触发：按各自单位换算后一律拦下
  assert.throws(v({ health: { checkMinutes: 40000 } }), /health\.checkMinutes 太大了/);
  assert.throws(v({ stickers: { inboundPollSec: 3_000_000 } }), /inboundPollSec 太大了/);
  assert.throws(v({ agent: { timeoutMs: 2 ** 31, turnTimeoutMs: 2 ** 31 } }), /agent\.timeoutMs 太大了/);
  assert.doesNotThrow(v({ health: { checkMinutes: 1440 }, limits: { maxWaitMs: 86_400_000 } }));
  assert.throws(v({ agent: { maxInputTokens: -1 } }), /maxInputTokens/);
  assert.throws(v({ groups: { chime: { probability: 2 } } }), /probability/);
  assert.throws(v({ stickers: { quality: 0 } }), /quality/);
  assert.throws(v({ limits: { quietHours: { from: 25 } } }), /quietHours\.from/);
  assert.throws(v({ timezone: "Asia/Shangai" }), /timezone「Asia\/Shangai」不是有效的 IANA 时区名/);  // 写错 Node 会静默按 UTC
  assert.throws(v({ agent: { thinking: "on" } }), /agent\.thinking 必须是/);
  assert.throws(v({ dm: { fallback: null } }), /dm\.fallback 必须是字符串/);
  assert.doesNotThrow(v({ timezone: "UTC" }));
  assert.doesNotThrow(v({ timezone: "" }));
  assert.doesNotThrow(v({ agent: { thinking: "adaptive" }, dm: { fallback: "" } }));
  assert.doesNotThrow(v({ agent: { protocol: "anthropic", baseUrl: "", token: "" } }));
  assert.doesNotThrow(v({ agent: { maxInputTokens: 0, debounceMs: 0, retries: 0 }, context: { peekLines: 0 } }));
});

const v2 = (patch, opts) => () => validate(merge(structuredClone(DEFAULTS), merge(structuredClone(minimal), patch)), opts);

test("校验：未知字段直接报错并列出路径，提示 migrate；分组写成非对象给可读的错", () => {
  assert.throws(v2({ groups: { wakePattern: ["x"] }, agent: { contextSize: 5 }, foo: 1 }), (e) => /不认识的字段：groups\.wakePattern、agent\.contextSize、foo/.test(e.message) && /npm run config:migrate/.test(e.message));
  assert.deepEqual(unknownKeys({ groups: { allow: [], chime: { enabled: true, x: 1 } }, bot: { id: 1 } }), ["groups.chime.x"]);
  assert.deepEqual(unknownKeys({ groups: { allow: [{ a: 1 }] } }), []);  // 数组是叶子，不往里比
  assert.throws(v2({ groups: null }), /config\.groups 必须是对象/);
  assert.throws(v2({ limits: { quietHours: 1 } }), /config\.limits\.quietHours 必须是对象/);
});

test("校验：host / bot.id / workspace / owner / 字符串字段 / clientIdSuffix", () => {
  assert.throws(v2({ host: "h.example.com" }), /host 必填，且必须是 http/);
  assert.throws(v2({ host: 1 }), /host/);
  assert.doesNotThrow(v2({ host: "http://10.0.0.1:8080/" }));
  assert.throws(v2({ bot: { id: "1" } }), /bot\.id 必填，且必须是正整数/);
  assert.throws(v2({ bot: { id: 1.5 } }), /bot\.id/);
  assert.throws(v2({ workspace: "" }), /workspace 必填/);
  assert.throws(v2({ workspace: 3 }), /workspace 必填/);
  assert.throws(v2({ workspace: "workspace" }), /仓库里的模板目录/);  // 模板要提交，别拿来当工作目录
  assert.throws(v2({ history: { maxCount: 600 } }), /history\.maxCount 不能大于 500/);
  assert.throws(v2({ groups: { warmupHistory: 800 } }), /groups\.warmupHistory 不能大于 500/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-"));
  assert.throws(v2({ workspace: "." }, { root }), /workspace「\.」解析到了仓库根目录/);
  assert.throws(v2({ workspace: "a/../" }, { root }), /仓库根目录/);
  assert.throws(v2({ workspace: ".." }, { root }), /仓库根目录或它的上级/);
  assert.throws(v2({ workspace: root }, { root }), /仓库根目录/);  // 绝对路径指回根目录也不行
  assert.doesNotThrow(v2({ workspace: "other.local/workspace" }, { root }));
  assert.doesNotThrow(v2({ workspace: path.join(os.tmpdir(), "elsewhere") }, { root }));
  assert.throws(v2({ owner: ["wxid_o"] }), /owner/);
  assert.throws(v2({ agent: { model: 5 } }), /agent\.model 必填，且必须是字符串/);
  assert.throws(v2({ token: 123 }), /token 必须是字符串/);
  assert.throws(v2({ agent: { effort: null } }), /agent\.effort 必须是字符串/);
  assert.throws(v2({ network: { mqttClientIdSuffix: 2 } }), /network\.mqttClientIdSuffix 必须是字符串/);
  assert.throws(v2({ network: { mqttClientIdSuffix: "a b" } }), /mqttClientIdSuffix 只能用字母/);
  assert.throws(v2({ network: { mqttClientIdSuffix: "x/y" } }), /mqttClientIdSuffix 只能用字母/);
  assert.doesNotThrow(v2({ network: { mqttClientIdSuffix: "dbg_2-a" }, agent: { effort: "high" }, token: "" }));
});

test("校验：唤醒词 / 头像触发词不许能匹配空文本（空串、^、a* 会命中每条消息）", () => {
  assert.throws(v2({ groups: { wakePatterns: ["^helper", ""] } }), /wakePatterns 里的正则「」能匹配空文本/);
  assert.throws(v2({ groups: { wakePatterns: ["^"] } }), /能匹配空文本/);
  assert.throws(v2({ images: { avatarPatterns: ["头像|"] } }), /avatarPatterns 里的正则「头像\|」能匹配空文本/);
  assert.doesNotThrow(v2({ groups: { wakePatterns: ["^helper[，,：:\\s]", "小布"] }, images: { avatarPatterns: [] } }));
});

test("校验：时区只收进程 TZ 真正认的名字；CST / GMT+8 报错并提示写法；校验不改动进程 TZ", () => {
  const before = process.env.TZ;
  assert.throws(v2({ timezone: "CST" }), (e) => /timezone「CST」不是有效的 IANA 时区名/.test(e.message) && /Asia\/Shanghai/.test(e.message));  // Intl 认成芝加哥，TZ 认成 UTC
  assert.throws(v2({ timezone: "GMT+8" }), /timezone「GMT\+8」/);
  assert.throws(v2({ timezone: "Asia/Shanghai " }), /timezone/);
  assert.throws(v2({ timezone: 8 }), /timezone/);
  for (const tz of ["Asia/Shanghai", "Asia/Kolkata", "Europe/London", "America/New_York", "UTC", "Etc/UTC", "Etc/GMT-8"]) assert.doesNotThrow(v2({ timezone: tz }), tz);
  assert.equal(process.env.TZ, before);
});

test("找不到配置文件给出可操作提示", () => {
  assert.throws(() => loadConfig("/nonexistent/config.jsonc"), /config\.example\.jsonc/);
});

const runMigrate = (file) => execFileSync(process.execPath, [BIN, "migrate", file], { encoding: "utf8" });
const oldCfg = { ...minimal, workspace: "ws", context: { size: 7 }, groups: { allow: [], wakePattern: ["x"] }, mqtt: { clientIdSuffix: "dbg" }, memory: { dedupeWindow: 100 } };

test("migrate：丢掉不认识的字段并列出；旁边已有同名 .jsonc 时先备份再覆盖；备份到毫秒，连跑不覆盖旧备份", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  const json = path.join(dir, "config.json"), jsonc = path.join(dir, "config.jsonc");
  fs.writeFileSync(json, JSON.stringify(oldCfg));
  fs.writeFileSync(jsonc, "// 正在用的配置\n{}");
  const out = runMigrate(json);
  assert.match(out, /丢掉了不认识的字段：groups\.wakePattern、memory\.dedupeWindow/);  // 挪进代码常量的不再可配，按不认识的丢
  assert.match(out, /挪了位置的字段：mqtt\.clientIdSuffix → network\.mqttClientIdSuffix/);
  assert.ok(!fs.existsSync(json));
  const cfg = parseJsonc(fs.readFileSync(jsonc, "utf8"));
  assert.equal(cfg.context.size, 7);  // 真实值保留
  assert.equal(cfg.network.mqttClientIdSuffix, "dbg");  // 挪了位置的值搬过去，不丢
  assert.equal(cfg.mqtt, undefined);  // 搬空的旧分组删掉
  assert.equal(cfg.groups.wakePattern, undefined);
  const baks = fs.readdirSync(dir).filter((f) => f.includes(".bak-")).sort();
  assert.equal(baks.length, 2);
  assert.match(baks.find((f) => f.startsWith("config.jsonc.bak-")), /\.bak-\d{8}-\d{6}-\d{3}$/);
  assert.equal(fs.readFileSync(path.join(dir, baks.find((f) => f.startsWith("config.jsonc.bak-"))), "utf8"), "// 正在用的配置\n{}");  // 被覆盖的 .jsonc 留了底
  const migrated = fs.readFileSync(jsonc, "utf8");
  runMigrate(jsonc); runMigrate(jsonc); runMigrate(jsonc);  // 同一毫秒撞名时加序号
  const again = fs.readdirSync(dir).filter((f) => f.startsWith("config.jsonc.bak-"));
  assert.equal(again.length, 4);
  assert.ok(again.some((f) => fs.readFileSync(path.join(dir, f), "utf8") === "// 正在用的配置\n{}"));  // 最早的备份没被覆盖
  assert.equal(fs.readFileSync(jsonc, "utf8"), migrated);  // 再迁移是幂等的
});

test("migrate：校验不过就什么都不写、不备份", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  const json = path.join(dir, "config.json");
  fs.writeFileSync(json, JSON.stringify({ ...oldCfg, host: "no-scheme" }));
  assert.throws(() => execFileSync(process.execPath, [BIN, "migrate", json], { stdio: "pipe" }), /host/);
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});
