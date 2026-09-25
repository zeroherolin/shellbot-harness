#!/usr/bin/env node
// 生成 / 迁移配置文件：
//   node bin/config.js example                            → 写 config.example.jsonc（占位符 + 默认值 + 逐字段注释）
//   node bin/config.js migrate mybot.local/config.json    → 读旧配置（json 或 jsonc），按当前字段结构重写为同名 .jsonc，
//                                                            保留真实值、补默认值、加注释、丢掉不认识的字段；
//                                                            原文件（以及会被覆盖的同名 .jsonc）备份为 .bak-<时间到毫秒>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, merge, parseJsonc, renderJsonc, unknownKeys, validate } from "../src/config.js";
import { getPath, fileStamp, writeFileAtomic } from "../src/util.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, arg] = process.argv.slice(2);

const PLACEHOLDERS = {
  host: "https://REPLACE_WITH_PLATFORM_HOST",
  workspace: "mybot.local/workspace",
  bot: { id: 0 },
  owner: "wxid_REPLACE_WITH_OWNER_WXID",
  groups: { allow: ["REPLACE_WITH_ROOM_ID@chatroom"], wakePatterns: [] },
  agent: { baseUrl: "https://REPLACE_WITH_LLM_BASE_URL", token: "sk-REPLACE_WITH_LLM_TOKEN", model: "REPLACE_WITH_MODEL_NAME" },
};

/** 备份成 <file>.bak-<本地时间到毫秒>，撞名再加序号；COPYFILE_EXCL 保证绝不覆盖已有的备份。返回备份路径。 */
function backup(file) {
  const stamp = fileStamp();
  for (let n = 0; ; n++) {
    const bak = `${file}.bak-${stamp}${n ? `-${n}` : ""}`;
    try { fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL); return bak; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
}

/**
 * 挪了位置的字段：旧路径 → 新路径。迁移时值搬过去（新路径已有值就不动），而不是当成不认识的字段丢掉。
 * 挪进代码常量的（不再可配）不在这里，按不认识的字段丢掉并列出来。
 */
const MOVED = {
  "mqtt.clientIdSuffix": "network.mqttClientIdSuffix",
};

/** 按点路径删字段。 */
const dropPath = (obj, p) => {
  const keys = p.split(".");
  const parent = keys.slice(0, -1).reduce((x, k) => x?.[k], obj);
  if (parent && typeof parent === "object") delete parent[keys.at(-1)];
};
/** 按点路径写字段，中间的对象按需建。 */
const setPath = (obj, p, v) => {
  const keys = p.split(".");
  const parent = keys.slice(0, -1).reduce((x, k) => (x[k] && typeof x[k] === "object" ? x[k] : (x[k] = {})), obj);
  parent[keys.at(-1)] = v;
};
/** 挪了位置的字段搬到新路径，旧路径删掉；搬空的旧分组也删掉。返回搬了的「旧 → 新」。 */
function moveFields(obj) {
  const moved = [];
  for (const [from, to] of Object.entries(MOVED)) {
    const v = getPath(obj, from);
    if (v === undefined) continue;
    if (getPath(obj, to) === undefined) setPath(obj, to, v);
    dropPath(obj, from);
    const group = from.split(".").slice(0, -1).join(".");
    if (group) { const g = getPath(obj, group); if (g && typeof g === "object" && !Object.keys(g).length) dropPath(obj, group); }
    moved.push(`${from} → ${to}`);
  }
  return moved;
}

if (cmd === "example") {
  const out = path.join(root, "config.example.jsonc");
  writeFileAtomic(out, renderJsonc(merge(structuredClone(DEFAULTS), PLACEHOLDERS)));
  console.log(`已写 ${path.relative(root, out)}`);
} else if (cmd === "migrate" && arg) {
  const src = path.resolve(arg);
  const old = parseJsonc(fs.readFileSync(src, "utf8"));
  const moved = moveFields(old);
  // 不认识的字段（拼错的、旧版本的）丢掉并列出来：校验拒绝未知字段，不丢就迁移不了；原值留在备份里
  const dropped = unknownKeys(old);
  for (const p of dropped) dropPath(old, p);
  const cfg = validate(merge(structuredClone(DEFAULTS), old), { root });  // 校验不过就什么都不写、不备份
  if (cfg.timezone) process.env.TZ = cfg.timezone;  // 备份文件名里的时间按配置的时区
  const out = src.replace(/\.jsonc?$/, "") + ".jsonc";
  const baks = [backup(src)];
  if (out !== src && fs.existsSync(out)) baks.push(backup(out));  // 旁边已有同名 .jsonc（多半是正在用的配置）：先留底再覆盖
  writeFileAtomic(out, renderJsonc(cfg));
  if (out !== src) fs.unlinkSync(src);
  console.log(`已迁移 ${path.relative(root, src)} → ${path.relative(root, out)}，备份 ${baks.map((b) => path.relative(root, b)).join("、")}`);
  if (moved.length) console.log(`挪了位置的字段：${moved.join("、")}`);
  if (dropped.length) console.log(`丢掉了不认识的字段：${dropped.join("、")}（原值在备份里）`);
} else {
  console.error("用法：node bin/config.js example | migrate <config.json 或 .jsonc>");
  process.exit(1);
}
