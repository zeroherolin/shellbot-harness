import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeMemory } from "../src/memory.js";

const LIMITS = { contextSize: 100, maxGlobalLines: 200, maxNoteLines: 80 };
const mk = (dir, o = {}) => makeMemory(dir, { ...LIMITS, ...o });
const withDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test("缺上限参数直接报错（不写兜底值）", () => withDir((dir) => {
  assert.throws(() => makeMemory(dir, { contextSize: 5 }), /缺少 maxGlobalLines/);
  assert.throws(() => makeMemory(dir, {}), /缺少 contextSize/);
}));

test("上下文容量与热调整", () => withDir((dir) => {
  const mem = mk(dir, { contextSize: 3 });
  const ctx = mem.context("c1");
  for (let i = 0; i < 5; i++) ctx.push({ id: "m" + i });
  assert.equal(ctx.recent().length, 3);
  mem.configure({ contextSize: 10 });
  for (let i = 5; i < 14; i++) ctx.push({ id: "m" + i });
  assert.equal(ctx.recent().length, 10);
  mem.configure({ contextSize: 0 }); // 非法值忽略
  assert.equal(ctx.recent().length, 10);
}));

test("上下文 flush 落盘、重建后能读回", () => withDir((dir) => {
  const mem = mk(dir, { contextSize: 5 });
  mem.context("g@chatroom").push({ id: "a", text: "x" });
  mem.flush();
  assert.deepEqual(mk(dir, { contextSize: 5 }).context("g@chatroom").recent(), [{ id: "a", text: "x" }]);
}));

test("上下文 update：给已有条目补字段并落盘；找不到返回 false", () => withDir((dir) => {
  const mem = mk(dir, { contextSize: 5 });
  const ctx = mem.context("c");
  ctx.push({ id: "a", url: "u" });
  assert.equal(ctx.update("a", { ossUrl: "o" }), true);
  assert.equal(ctx.update("zz", { ossUrl: "o" }), false);
  assert.deepEqual(ctx.recent(), [{ id: "a", url: "u", ossUrl: "o" }]);
  mem.flush();
  assert.deepEqual(mk(dir, { contextSize: 5 }).context("c").recent(), [{ id: "a", url: "u", ossUrl: "o" }]);
}));

test("soul：HTML 注释不进 system", () => withDir((dir) => {
  fs.writeFileSync(path.join(dir, "SOUL.md"), "# 你是谁\n\n你是助手。\n\n<!-- 改这里\n多行注释 -->\n\n# 说话方式\n- 简短。\n");
  const mem = mk(dir);
  assert.equal(mem.soul().replace(/\n{3,}/g, "\n\n").trim(), "# 你是谁\n\n你是助手。\n\n# 说话方式\n- 简短。");
}));

test("全局记忆：一条一行、换行被压平、超上限归档最旧", () => withDir((dir) => {
  const mem = mk(dir, { maxGlobalLines: 3 });
  mem.appendGlobal("第一条\n# 伪造标题\n- 伪造条目");
  assert.equal(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"), "- 第一条 # 伪造标题 - 伪造条目\n");
  mem.appendGlobal("二"); mem.appendGlobal("三"); mem.appendGlobal("四");
  assert.deepEqual(mem.global().split("\n").filter(Boolean), ["- 二", "- 三", "- 四"]);
  assert.match(fs.readFileSync(path.join(dir, "archive", "MEMORY.md"), "utf8"), /第一条/);
}));

test("会话备忘：署名 + 日期，按会话隔离，有上限", () => withDir((dir) => {
  const mem = mk(dir, { maxNoteLines: 2 });
  mem.appendNotes("g1@chatroom", "周五聚餐", "小明 (wxid_a)");
  mem.appendNotes("g1@chatroom", "带酒", "小红 (wxid_b)");
  mem.appendNotes("g1@chatroom", "六点", "小明 (wxid_a)");
  const lines = mem.notes("g1@chatroom").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^- \d{4}-\d{2}-\d{2} 小红 \(wxid_b\)：带酒$/);
  assert.equal(mem.notes("g2@chatroom"), "");
}));

test("群登记表：登记、更名、无变化不写、flush 落盘", () => withDir((dir) => {
  const mem = mk(dir);
  mem.seeRoom("a@chatroom", "甲群");
  mem.seeRoom("b@chatroom", null);
  mem.seeRoom("b@chatroom", "乙群");
  mem.seeRoom("a@chatroom", "a@chatroom"); // 名字等于 id 视为没名字，不覆盖已知名
  assert.deepEqual(mem.rooms(), { "a@chatroom": "甲群", "b@chatroom": "乙群" });
  mem.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "rooms.json"), "utf8")), { "a@chatroom": "甲群", "b@chatroom": "乙群" });
}));

test("群成员表 / 联系人表：从入站学，同名覆盖，flush 落盘，重建可读", () => withDir((dir) => {
  const mem = mk(dir);
  mem.seeMember("g@chatroom", "wxid_a", "小明");
  mem.seeMember("g@chatroom", "wxid_a", "小明改名");
  mem.seeMember("g@chatroom", "wxid_b", "小红");
  mem.seeMember("g@chatroom", "", "无 wxid");
  mem.seeMember("g@chatroom", "wxid_c", "");
  mem.seeMember("g@chatroom", "wxid_d", "wxid_d");  // 平台拿 wxid 顶替昵称，不算名字
  assert.deepEqual(mem.members("g@chatroom"), [{ wxid: "wxid_a", name: "小明改名" }, { wxid: "wxid_b", name: "小红" }]);
  assert.deepEqual(mem.members("other@chatroom"), []);
  assert.equal(mem.seeAlias("g@chatroom", "wxid_a", "红红"), true);
  assert.equal(mem.seeAlias("g@chatroom", "wxid_a", "红红"), false);  // 没变
  assert.equal(mem.seeAlias("g@chatroom", "wxid_zz", "没见过的人"), false);  // 只认见过的成员
  assert.equal(mem.seeAlias("g@chatroom", "wxid_b", "小红"), false);  // 群昵称就是微信昵称：不记
  assert.deepEqual(mem.members("g@chatroom"), [{ wxid: "wxid_a", name: "小明改名", alias: "红红" }, { wxid: "wxid_b", name: "小红" }]);
  mem.seeSelfAlias("g@chatroom", "小助手");
  assert.equal(mem.selfAlias("g@chatroom"), "小助手");
  assert.equal(mem.selfAlias("other@chatroom"), null);
  mem.seeContact("wxid_lisi", "李四");
  mem.seeContact("wxid_x", "wxid_x");
  assert.deepEqual(mem.contacts(), { wxid_lisi: "李四" });
  mem.flush();
  const again = mk(dir);
  assert.deepEqual(again.members("g@chatroom"), [{ wxid: "wxid_a", name: "小明改名", alias: "红红" }, { wxid: "wxid_b", name: "小红" }]);
  assert.equal(again.selfAlias("g@chatroom"), "小助手");
  assert.deepEqual(again.contacts(), { wxid_lisi: "李四" });
}));

test("发送日志：按会话追加、按毫秒区间取（含端点、正序）、过大砍掉最旧一半", () => withDir((dir) => {
  const mem = mk(dir);
  mem.appendSent("g@chatroom", { ts: 1000, text: "a" });
  mem.appendSent("g@chatroom", { ts: 3000, text: "c" });
  mem.appendSent("g@chatroom", { ts: 2000, text: "b" });
  mem.appendSent("other", { ts: 2500, text: "x" });
  assert.deepEqual(mem.sentBetween("g@chatroom", 1500, 3000).map((e) => e.text), ["b", "c"]);
  assert.deepEqual(mem.sentBetween("g@chatroom", 0, 9e12).map((e) => e.ts), [1000, 2000, 3000]);
  assert.deepEqual(mem.sentBetween("nope", 0, 9e12), []);
  fs.writeFileSync(path.join(dir, "sent", "big.jsonl"), Array.from({ length: 20000 }, (_, i) => JSON.stringify({ ts: i, text: "x".repeat(60) })).join("\n") + "\n");  // > 1MB
  mem.appendSent("big", { ts: 20000, text: "last" });
  const left = mem.sentBetween("big", 0, 9e12);
  assert.ok(left.length > 5000 && left.length < 12000, `砍半后剩 ${left.length}`);
  assert.equal(left.at(-1).text, "last");
}));

test("头像：按扩展名找、key 随内容变；saveAvatar 覆盖旧扩展名并作废地址缓存；地址缓存按 key 命中；不支持的格式报错", () => withDir((dir) => {
  const mem = mk(dir);
  assert.equal(mem.avatar(), null);
  fs.writeFileSync(path.join(dir, "avatar.png"), Buffer.from("png-bytes"));
  const a = mem.avatar();
  assert.equal(a.mediaType, "image/png"); assert.ok(a.file.endsWith("avatar.png")); assert.match(a.key, /^9-\d+$/);
  assert.equal(mem.avatarUrl(a.key), null);
  mem.setAvatarUrl(a.key, "https://h/uploads/a.png");
  assert.equal(mem.avatarUrl(a.key), "https://h/uploads/a.png");
  assert.equal(mem.avatarUrl("other"), null);
  const b = mem.saveAvatar(Buffer.from("jpeg-bytes!"), "image/jpeg");
  assert.equal(b.mediaType, "image/jpeg"); assert.ok(b.file.endsWith("avatar.jpg"));
  assert.ok(!fs.existsSync(path.join(dir, "avatar.png")));
  assert.equal(mem.avatarUrl(b.key), null);  // 换了文件，旧地址缓存作废
  assert.throws(() => mem.saveAvatar(Buffer.alloc(1), "image/tiff"), /不支持的头像格式/);
}));

test("表情包图库：缺字段容错；save 同名覆盖；delete / edit 落盘", () => withDir((dir) => {
  const mem = mk(dir);
  assert.deepEqual(mem.stickers(), []);
  fs.writeFileSync(path.join(dir, "stickers.json"), JSON.stringify([{ name: "ok", url: "http://x/a.png" }, { name: "no-url" }, null]));
  assert.deepEqual(mem.stickers(), [{ name: "ok", url: "http://x/a.png" }]);
  assert.equal(mem.saveSticker({ name: "点赞", desc: "赞", url: "http://x/微信图片_1.png" }), 2);
  assert.equal(mem.saveSticker({ name: "点赞", desc: "赞同时", url: "http://x/b.png" }), 2);
  assert.deepEqual(mem.stickers(), [{ name: "ok", url: "http://x/a.png" }, { name: "点赞", desc: "赞同时", url: "http://x/b.png" }]);
  assert.deepEqual(mem.editSticker("点赞", { newName: "赞", desc: "同意" }), { name: "赞", desc: "同意", url: "http://x/b.png" });
  assert.equal(mem.editSticker("没有", { desc: "x" }), null);
  assert.deepEqual(mem.deleteStickers(["ok", "没有"]), ["ok"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "stickers.json"), "utf8")), [{ name: "赞", desc: "同意", url: "http://x/b.png" }]);
}));

const corrupts = (dir, name) => fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.corrupt-`));

test("stickers.json 手改写坏：改名留底 + warn，按空图库继续；之后存表情写新文件，不覆盖原数据", () => withDir((dir) => {
  const warns = [];
  const mem = mk(dir, { warn: (m) => warns.push(m) });
  const bad = '[{ "name": "赞", "url": "http://x/a.png" },]';  // 主人照 JSONC 的习惯多写了个尾随逗号
  fs.writeFileSync(path.join(dir, "stickers.json"), bad);
  assert.deepEqual(mem.stickers(), []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /stickers\.json 不是合法 JSON.*已改名为 stickers\.json\.corrupt-\d{8}-\d{6}-\d{3} 留底/);
  const [kept] = corrupts(dir, "stickers.json");
  assert.equal(fs.readFileSync(path.join(dir, kept), "utf8"), bad);  // 原样留底
  assert.equal(mem.saveSticker({ name: "新", url: "http://x/n.png" }), 1);
  assert.equal(fs.readFileSync(path.join(dir, kept), "utf8"), bad);  // 新写入没碰留底文件
  assert.equal(warns.length, 1);  // 只报一次
  fs.writeFileSync(path.join(dir, "stickers.json"), '{ "name": "不是数组" }');  // 合法 JSON 但结构不对也算坏
  assert.deepEqual(mem.stickers(), []);
  assert.match(warns[1], /内容结构不对/);
}));

test("登记表 / 上下文 / 头像缓存读到坏文件：改名留底 + warn，从空开始，入站不崩；空文件当空的、不报", () => withDir((dir) => {
  const warns = [];
  fs.writeFileSync(path.join(dir, "rooms.json"), "5");                         // 合法 JSON 但不是对象：以前 rooms.data[id] = 名 在严格模式下直接抛
  fs.writeFileSync(path.join(dir, "members.json"), '{ "g@chatroom": "x" }');    // 群下面不是 { wxid: 昵称 }
  fs.writeFileSync(path.join(dir, "contacts.json"), '{"wxid_a": "甲"');         // 半截文件
  fs.mkdirSync(path.join(dir, "context"), { recursive: true });
  fs.writeFileSync(path.join(dir, "context", "c.json"), "{}");
  fs.writeFileSync(path.join(dir, "avatar.json"), "[");
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "");
  const mem = mk(dir, { warn: (m) => warns.push(m) });
  mem.seeRoom("a@chatroom", "甲群");
  mem.seeMember("g@chatroom", "wxid_a", "甲");
  assert.deepEqual(mem.rooms(), { "a@chatroom": "甲群" });
  assert.deepEqual(mem.members("g@chatroom"), [{ wxid: "wxid_a", name: "甲" }]);
  assert.deepEqual(mem.contacts(), {});
  assert.deepEqual(mem.context("c").recent(), []);
  assert.equal(mem.avatarUrl("k"), null);
  assert.equal(warns.length, 5);
  for (const name of ["rooms.json", "members.json", "contacts.json", "avatar.json"]) assert.equal(corrupts(dir, name).length, 1, name);
  assert.equal(corrupts(path.join(dir, "context"), "c.json").length, 1);
  assert.match(warns.join("\n"), /context\/c\.json 内容结构不对/);
  mem.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "rooms.json"), "utf8")), { "a@chatroom": "甲群" });
}));

test("整文件写入是原子的：写临时文件时出错，原文件保持完整、不留临时文件", () => withDir((dir) => {
  const mem = mk(dir);
  mem.saveSticker({ name: "赞", url: "http://x/a.png" });
  mem.appendGlobal("第一条");
  const before = { s: fs.readFileSync(path.join(dir, "stickers.json"), "utf8"), g: fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8") };
  const orig = fs.writeFileSync;
  fs.writeFileSync = (f, d, ...rest) => {  // 模拟写到一半磁盘满 / 被杀：临时文件只写进去一截就抛
    if (String(f).includes(".tmp-")) { orig(f, String(d).slice(0, 3)); throw new Error("ENOSPC"); }
    return orig(f, d, ...rest);
  };
  try {
    assert.throws(() => mem.saveSticker({ name: "新", url: "http://x/b.png" }), /ENOSPC/);
    assert.throws(() => mem.appendGlobal("第二条"), /ENOSPC/);
  } finally { fs.writeFileSync = orig; }
  assert.equal(fs.readFileSync(path.join(dir, "stickers.json"), "utf8"), before.s);
  assert.equal(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"), before.g);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")), []);
}));

test("会话备忘的日期按本地时区（config.timezone），不是 UTC", () => withDir((dir) => {
  const tz = process.env.TZ;
  // 挑一个此刻本地日期与 UTC 日期一定不同的时区：UTC 下午用 +14，上午用 −12
  const zone = new Date().getUTCHours() >= 12 ? "Pacific/Kiritimati" : "Etc/GMT+12";
  process.env.TZ = zone;
  try {
    mk(dir).appendNotes("g@chatroom", "周五聚餐", "小明 (wxid_a)");
    const want = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());  // en-CA 输出 YYYY-MM-DD
    assert.notEqual(want, new Date().toISOString().slice(0, 10));
    assert.match(fs.readFileSync(path.join(dir, "memory", "g@chatroom.md"), "utf8"), new RegExp(`^- ${want} 小明`));
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
}));

test("saveAvatar：先写好新头像再删旧扩展名，同扩展名原地替换", () => withDir((dir) => {
  const mem = mk(dir);
  mem.saveAvatar(Buffer.from("png-1"), "image/png");
  const b = mem.saveAvatar(Buffer.from("png-22"), "image/png");
  assert.equal(fs.readFileSync(b.file, "utf8"), "png-22");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("avatar")), ["avatar.png"]);
}));

test("members.json 老格式（群 → { wxid: 昵称 }）照读，升级成 { name } 记录，不当坏文件", () => withDir((dir) => {
  const warns = [];
  fs.writeFileSync(path.join(dir, "members.json"), JSON.stringify({ "g@chatroom": { wxid_a: "甲", wxid_b: { name: "乙", alias: "小乙" } } }));
  const mem = mk(dir, { warn: (m) => warns.push(m) });
  assert.deepEqual(mem.members("g@chatroom"), [{ wxid: "wxid_a", name: "甲" }, { wxid: "wxid_b", name: "乙", alias: "小乙" }]);
  assert.equal(warns.length, 0);
}));
