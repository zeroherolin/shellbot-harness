// 文件即记忆，都在 workspace 下：
//   SOUL.md / MEMORY.md / memory/<conv>.md    人格、全局记忆（仅主人可写）、会话备忘（成员可写，带署名）
//   stickers.json                             表情包图库 [{ name, desc, url }]
//   context/<conv>.json                       最近 N 条消息，重启不丢
//   rooms.json / members.json / contacts.json 群、群成员、联系人登记表，从入站流学
//                                              members.json：群 id → { wxid: { name: 微信昵称, alias?: 群昵称 } }
//   self.json                                 机器人自己在各群的群昵称：群 id → 群昵称（只从 OpenClaw 标了「@ 了机器人」的消息里学）
//   sent/<conv>.jsonl                          走 OpenClaw 发出的消息：平台不记这条通道的历史，翻历史时由 harness 合并进去
//   avatar.<ext> / avatar.json                机器人自己的头像（主人放进来或 save_avatar 存的）与它在平台上可发送地址的缓存
// 整文件写入一律 writeFileAtomic（临时文件 + rename）：写到一半被 kill / 断电，原文件要么旧的完整、要么新的完整。
// 读到坏 JSON 不静默当空值：改名成 <名>.corrupt-<时间> 留底并报 warn，再按空的继续，下次写入不会把原数据盖掉。
import fs from "node:fs";
import path from "node:path";
import { localDate, oneLine, writeFileAtomic, fileStamp, isObj } from "./util.js";

const WRITE_DELAY = 500;  // 落盘合并窗口
const SENT_MAX_BYTES = 1e6;  // 单个会话的发送日志超过这么大就砍掉最旧一半
const REQUIRED_LIMITS = ["contextSize", "maxGlobalLines", "maxNoteLines"];
const AVATAR_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };  // 头像文件扩展名 → 类型，按此顺序找
/** 一个成员：{ name 微信昵称, alias? 本群群昵称 }；老版本存的是纯字符串（只有微信昵称），读的时候升级。 */
const toMember = (v) => (typeof v === "string" ? { name: v } : isObj(v) && typeof v.name === "string" ? v : null);

/**
 * limits 来自 config（context.size 与 memory.*），已校验；这里不写兜底值。
 * warn 可选：读到坏 JSON、改名留底时报告用（harness 传 log.warn），不传打到 stderr。
 */
export function makeMemory(root, { warn = (m) => console.warn(m), ...limitsInit } = {}) {
  const dirs = { memory: path.join(root, "memory"), context: path.join(root, "context"), archive: path.join(root, "archive"), sent: path.join(root, "sent") };
  fs.mkdirSync(dirs.memory, { recursive: true });
  fs.mkdirSync(dirs.context, { recursive: true });
  fs.mkdirSync(dirs.sent, { recursive: true });
  let limits = { ...limitsInit };
  for (const k of REQUIRED_LIMITS) if (!(limits[k] > 0)) throw new Error(`makeMemory 缺少 ${k}`);

  const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
  /**
   * 读 JSON；ok 校验形状（数组 / 对象）。文件不存在或只有空白按 fallback。
   * 解析失败或形状不对（主人手改多了个逗号、半截文件）：原文件改名留底、报 warn，再按 fallback 继续。
   */
  const readJson = (p, fallback, ok = () => true) => {
    const text = readText(p);
    if (!text.trim()) return fallback;
    let why;
    try { const v = JSON.parse(text); if (ok(v)) return v; why = "内容结构不对"; }
    catch (e) { why = `不是合法 JSON（${e.message}）`; }
    const bak = `${p}.corrupt-${fileStamp()}`;
    let kept;
    try { fs.renameSync(p, bak); kept = `已改名为 ${path.basename(bak)} 留底`; }
    catch (e) { kept = `改名留底失败（${e.message}），下次写入会覆盖它，请先手动备份`; }
    try { warn(`${path.relative(root, p)} ${why}，${kept}；先按空的继续，修好后改回原名（这期间新写入的在新文件里，要手动合并）`); } catch {}
    return fallback;
  };
  const safe = (id) => String(id).replace(/[^\w@.-]/g, "_");

  /** 追加一行；超过上限把最旧的挪到 archive/ 同名文件。 */
  const appendCapped = (file, line, max) => {
    const lines = readText(file).split("\n").filter(Boolean);
    lines.push(line);
    if (lines.length > max) {
      const overflow = lines.splice(0, lines.length - max);
      fs.mkdirSync(dirs.archive, { recursive: true });
      fs.appendFileSync(path.join(dirs.archive, path.basename(file)), overflow.join("\n") + "\n");
    }
    writeFileAtomic(file, lines.join("\n") + "\n");
  };

  // 延迟落盘失败（磁盘满 / 没权限）报 warn：同一个文件只报第一次，写成功后再失败再报
  const failing = new Set();
  const persist = (file, data) => {
    try { writeFileAtomic(file, data); failing.delete(file); }
    catch (e) { if (!failing.has(file)) { failing.add(file); try { warn(`写 ${path.relative(root, file)} 失败：${e.message}`); } catch {} } }
  };

  /** 带合并落盘的 JSON 登记表；ok 校验读回来的形状。 */
  const table = (name, fallback, ok) => {
    const file = path.join(root, name);
    const data = readJson(file, fallback, ok);
    let timer = null, dirty = false;
    const write = () => { timer = null; dirty = false; persist(file, JSON.stringify(data)); };
    return {
      data,
      touch() { dirty = true; if (!timer) timer = setTimeout(write, WRITE_DELAY * 2); },
      flush() { if (timer) clearTimeout(timer); if (dirty) write(); },
    };
  };
  const rooms = table("rooms.json", {}, isObj);
  const members = table("members.json", {}, (v) => isObj(v) && Object.values(v).every((room) => isObj(room) && Object.values(room).every(toMember)));
  for (const room of Object.values(members.data)) for (const [id, v] of Object.entries(room)) room[id] = toMember(v);
  const contacts = table("contacts.json", {}, isObj);
  const self = table("self.json", {}, (v) => isObj(v) && Object.values(v).every((x) => typeof x === "string"));
  const contexts = new Map();

  const stickersFile = path.join(root, "stickers.json");
  const readStickers = () => readJson(stickersFile, [], Array.isArray).filter((s) => s && s.name && s.url);
  const writeStickers = (list) => writeFileAtomic(stickersFile, JSON.stringify(list, null, 2) + "\n");

  const avatarFile = (ext) => path.join(root, `avatar.${ext}`);
  const avatarCache = path.join(root, "avatar.json");
  /** 本地头像文件：{ file, mediaType, key }，key 随内容变（大小 + 修改时间），用来判断缓存的上传地址还算不算数；没有返回 null。 */
  const avatar = () => {
    for (const [ext, mediaType] of Object.entries(AVATAR_TYPES)) {
      try {
        const st = fs.statSync(avatarFile(ext));
        if (st.isFile() && st.size) return { file: avatarFile(ext), mediaType, key: `${st.size}-${Math.round(st.mtimeMs)}` };
      } catch {}
    }
    return null;
  };

  return {
    soul: () => readText(path.join(root, "SOUL.md")).replace(/<!--[\s\S]*?-->/g, ""),  // 模板注释不进 system
    global: () => readText(path.join(root, "MEMORY.md")),
    notes: (convId) => readText(path.join(dirs.memory, `${safe(convId)}.md`)),

    appendGlobal(text) {
      appendCapped(path.join(root, "MEMORY.md"), `- ${oneLine(text)}`, limits.maxGlobalLines);  // 一条一行，防用换行伪造段落
    },
    appendNotes(convId, text, author) {
      const day = localDate();  // 按 config.timezone 的本地日期：toISOString 是 UTC，北京时间凌晨记的会标成前一天
      appendCapped(path.join(dirs.memory, `${safe(convId)}.md`), `- ${day} ${oneLine(author)}：${oneLine(text)}`, limits.maxNoteLines);
    },

    // 表情包图库
    stickers: readStickers,
    /** 入库，同名覆盖；返回图库总数。 */
    saveSticker({ name, desc = "", url }) {
      const list = readStickers().filter((s) => s.name !== name);
      list.push({ name, desc, url });
      writeStickers(list);
      return list.length;
    },
    /** 按名字删除，返回实际删掉的。 */
    deleteStickers(names) {
      const set = new Set(names);
      const list = readStickers();
      const removed = list.filter((s) => set.has(s.name)).map((s) => s.name);
      if (removed.length) writeStickers(list.filter((s) => !set.has(s.name)));
      return removed;
    },
    /** 改名或改说明；找不到返回 null。 */
    editSticker(name, { newName, desc }) {
      const list = readStickers();
      const s = list.find((x) => x.name === name);
      if (!s) return null;
      if (newName) s.name = newName;
      if (desc !== undefined) s.desc = desc;
      writeStickers(list.filter((x) => x === s || x.name !== s.name));  // 改成已有名字时覆盖同名
      return { ...s };
    },

    // 登记表
    rooms: () => ({ ...rooms.data }),
    seeRoom(id, name) {
      if (!id) return;
      const nm = name && name !== id ? name : rooms.data[id] || id;
      if (rooms.data[id] === nm) return;
      rooms.data[id] = nm;
      rooms.touch();
    },
    /**
     * 本群见过的人：[{ wxid, name 微信昵称, alias? 群昵称 }]。按 wxid 存，改名就地覆盖。
     * 平台记录只给微信昵称；群昵称（群里显示、别人 @ 和引用块里用的那个）靠 seeAlias 从聊天里学。
     */
    members(roomId) {
      return Object.entries(members.data[roomId] || {}).map(([wxid, m]) => ({ wxid, ...m }));
    },
    seeMember(roomId, wxid, name) {
      if (!roomId || !wxid || !name || name === wxid) return;
      const room = (members.data[roomId] ||= {});
      if (room[wxid]?.name === name) return;
      room[wxid] = { ...room[wxid], name };
      if (room[wxid].alias === name) delete room[wxid].alias;  // 群昵称就是微信昵称：不用另记
      members.touch();
    },
    /** 学到某人在本群的群昵称，返回有没有变。只认已经见过的成员；「这个名字没人在用」由调用方（gate.learnAliases）保证。 */
    seeAlias(roomId, wxid, alias) {
      const m = members.data[roomId]?.[wxid];
      if (!m || !alias || alias === wxid || m.alias === alias || alias === m.name) return false;
      m.alias = alias;
      members.touch();
      return true;
    },
    /** 机器人自己在本群的群昵称（没学到给 null）。 */
    selfAlias: (roomId) => self.data[roomId] || null,
    seeSelfAlias(roomId, alias) {
      if (!roomId || !alias || self.data[roomId] === alias) return;
      self.data[roomId] = alias;
      self.touch();
    },
    /** 联系人 wxid → 昵称。 */
    contacts: () => ({ ...contacts.data }),
    seeContact(wxid, name) {
      if (!wxid || !name || name === wxid) return;
      if (contacts.data[wxid] === name) return;
      contacts.data[wxid] = name;
      contacts.touch();
    },

    /** 所有见过的 wxid（联系人 + 各群成员）。自定义微信号不以 wxid_ 开头，靠这个识别「这串字符是 id 不是名字」。 */
    wxids() {
      const all = new Set(Object.keys(contacts.data));
      for (const room of Object.values(members.data)) for (const id of Object.keys(room)) all.add(id);
      return all;
    },

    // 头像
    avatar,
    /** 写入头像（覆盖别的扩展名的旧文件、作废地址缓存），返回 avatar()。先原子写好新文件再删旧的，中途出事至少留着一张。 */
    saveAvatar(buffer, mediaType) {
      const ext = Object.entries(AVATAR_TYPES).find(([, t]) => t === mediaType)?.[0];
      if (!ext) throw new Error(`不支持的头像格式 ${mediaType}`);
      writeFileAtomic(avatarFile(ext), buffer);
      for (const e of Object.keys(AVATAR_TYPES)) if (e !== ext) { try { fs.unlinkSync(avatarFile(e)); } catch {} }
      try { fs.unlinkSync(avatarCache); } catch {}
      return avatar();
    },
    /** 头像在平台上可发送的地址缓存；key 对不上（文件换了）就当没有。 */
    avatarUrl(key) {
      const c = readJson(avatarCache, null, isObj);
      return c && c.key === key && typeof c.url === "string" ? c.url : null;
    },
    setAvatarUrl(key, url) { writeFileAtomic(avatarCache, JSON.stringify({ key, url })); },

    // 发送日志（只记平台历史里没有的：走 OpenClaw 发出的文字）
    appendSent(convId, { ts, text }) {
      const file = path.join(dirs.sent, `${safe(convId)}.jsonl`);
      fs.appendFileSync(file, JSON.stringify({ ts, text }) + "\n");  // 追加写：崩在半行只坏最后一行，读的时候逐行容错
      try {
        if (fs.statSync(file).size > SENT_MAX_BYTES) {
          const lines = readText(file).split("\n").filter(Boolean);
          writeFileAtomic(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n");
        }
      } catch {}
    },
    /** [from, to] 毫秒区间内走 OpenClaw 发出的消息，按时间正序。 */
    sentBetween(convId, from, to) {
      const out = [];
      for (const line of readText(path.join(dirs.sent, `${safe(convId)}.jsonl`)).split("\n")) {
        if (!line) continue;
        try { const e = JSON.parse(line); if (e.ts >= from && e.ts <= to) out.push(e); } catch {}
      }
      return out.sort((a, b) => a.ts - b.ts);
    },

    /** 热更新容量与上限。 */
    configure(next) { limits = { ...limits, ...Object.fromEntries(Object.entries(next).filter(([, v]) => Number.isFinite(v) && v > 0)) }; },

    // 会话上下文环形缓冲
    context(convId) {
      let c = contexts.get(convId);
      if (!c) {
        const file = path.join(dirs.context, `${safe(convId)}.json`);
        const items = readJson(file, [], Array.isArray);  // 写坏了（含非数组）改名留底、从空开始，不让入站崩
        let timer = null;
        const write = () => { timer = null; persist(file, JSON.stringify(items)); };
        const schedule = () => { if (!timer) timer = setTimeout(write, WRITE_DELAY); };
        c = {
          push(entry) {
            items.push(entry);
            if (items.length > limits.contextSize) items.splice(0, items.length - limits.contextSize);
            schedule();
          },
          /** 给已有条目补字段；找不到返回 false。 */
          update(id, patch) {
            const m = items.find((x) => x.id === id);
            if (!m) return false;
            Object.assign(m, patch);
            schedule();
            return true;
          },
          recent: () => items.slice(-limits.contextSize),
          flush() { if (timer) { clearTimeout(timer); write(); } },
        };
        contexts.set(convId, c);
      }
      return c;
    },

    /** 退出前同步落盘所有待写内容。 */
    flush() {
      for (const c of contexts.values()) c.flush();
      rooms.flush(); members.flush(); contacts.flush(); self.flush();
    },
  };
}
