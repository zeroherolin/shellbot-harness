// 门控与 @ 解析：一条入站消息是跳过、只记上下文、还是触发回复；回复文本里的「@昵称」怎么变成 wxid、什么时候补 @。
// 顺序：自己的消息 → 黑名单 → 会话准入 → 触发判定。未触发的群消息仍进上下文。
import { escapeRe, isNickname, noSpace } from "./util.js";

/** 有明确对象的触发原因：回复默认 @ 回触发者；静默时段也照回（加上私聊）。 */
export const MENTION_BACK_REASONS = ["mention", "at-text", "quote", "wake", "name"];

export function classify(msg, cfg, bot) {
  if (msg.isMine || (bot.robotId && msg.sender.id === bot.robotId)) return { kind: "skip", reason: "self" };
  if (cfg.blockedSenders.includes(msg.sender.id)) return { kind: "skip", reason: "blocked" };

  const isOwner = msg.sender.id === cfg.owner;

  if (!msg.isGroup) {
    const p = cfg.dm.policy;
    const allowed = isOwner || p === "open" || (p === "allowlist" && cfg.dm.allowFrom.includes(msg.sender.id));
    return allowed ? { kind: "trigger", reason: "dm", isOwner } : { kind: "skip", reason: "dm-policy" };
  }

  const g = cfg.groups;
  if (g.policy === "disabled") return { kind: "skip", reason: "groups-disabled" };
  if (g.policy === "allowlist" && !g.allow.includes(msg.conv.id)) return { kind: "skip", reason: "group-not-allowed" };

  const reason = triggerReason(msg, cfg, bot);
  return reason ? { kind: "trigger", reason, isOwner } : { kind: "context", reason: "not-triggered", isOwner };
}

const reCache = new Map();
const compile = (pat) => {
  let re = reCache.get(pat);
  if (!re) reCache.set(pat, (re = new RegExp(pat, "i")));
  return re;
};

/** 机器人在这条消息所在会话里能被叫的名字：微信昵称，加上本群的群昵称（bot.alias，由 harness 按会话填，只从可信来源学）。 */
const selfNames = (bot) => [bot.name, bot.alias].filter((n, i, a) => n && a.indexOf(n) === i);

function triggerReason(msg, cfg, bot) {
  if (msg.mention) return "mention";  // 协议自带的被提及标志，原生通道没有
  const text = msg.text || "";
  const own = ownWords(text);  // @ / 唤醒词 / 提到昵称都只看说话人自己写的：引用块里别人 @ 过你不算，先引用再叫你的句首唤醒也能认
  const names = selfNames(bot);
  if (names.some((n) => tagRe(n).test(own))) return "at-text";
  // 微信引用格式：「昵称：原文」+ 分隔线 + 正文；群里引用块显示的是群昵称
  if (names.some((n) => new RegExp(`^「${escapeRe(n)}[：:]`).test(text))) return "quote";
  for (const pat of cfg.groups.wakePatterns) if (compile(pat).test(own)) return "wake";
  if (cfg.groups.nameTrigger && bot.name && nameRe(bot.name).test(own)) return "name";  // 只认微信昵称：群昵称可能很短，中文名前后又不看边界
  return null;
}

/** 去掉开头的微信引用块，只留说话人自己写的部分（引用里提到机器人不算提到；引用后可以没有正文）。 */
const ownWords = (text) => String(text || "").replace(/^「[\s\S]*?」\n[-\s]+(?:\n|$)/, "");
/** 昵称作为独立的词出现（不区分大小写）：Workmate 里的 mate 不算，「小mate」「cc mate」算；邮箱 / 域名里的（foo@helper.com）不算。 */
const nameRe = (name) => compile(`(?<![A-Za-z0-9@.])${escapeRe(name)}(?![A-Za-z0-9]|\\.[A-Za-z])`);
/** 「@」前面紧挨着的是邮箱本地部分的字符（foo@、x.y@）。 */
const EMAIL_CHAR = "[A-Za-z0-9_.+\\-]";
/**
 * 「@昵称」匹配（默认区分大小写）：昵称以字母 / 数字结尾时后面不能再接字母数字（@helperboy 不算 @helper）；中文昵称后面紧跟什么都行。
 * 邮箱不算：@ 前紧挨着邮箱字符、且昵称后面紧跟「.域名」时（foo@helper.com、x@qq.com）不匹配；
 * 只看前面会误杀「cc@helper」「thx@helper」这种先打字再从列表里点 @ 的写法，所以两头都像邮箱才排除。
 */
const tagRe = (name, flags = "") => {
  const n = escapeRe(name);
  return new RegExp(`(?:(?<!${EMAIL_CHAR})|(?!@${n}\\.[A-Za-z0-9]))@${n}${/[A-Za-z0-9_]$/.test(name) ? "(?![A-Za-z0-9_])" : ""}`, flags);
};
/**
 * 回复里还剩下的「@某某」（没对上任何已知昵称的），只用来报告、做宽松匹配：取到空白或标点为止，而且 @ 得站在名字的位置上——
 * 行首、空白或标点后面。紧贴着前一个字的（「我@不到他呀」「他@了一个」，模型拿 @ 当动词）不算；邮箱（x@qq.com）也不算。
 * 看后面没用：昵称也可能是一整句话。
 */
const LOOSE_AT = /(?<=^|[\s\u2005，,。．！？!?：:、；;（(「【"'“‘])@([^\s@\u2005，,。．！？!?：:、；;）)」】]{1,24})/gm;
const EMAIL_CHAR_RE = new RegExp(`^${EMAIL_CHAR}$`);
const looksLikeEmail = (src, m) => EMAIL_CHAR_RE.test(src[m.index - 1] || "") && /\.[A-Za-z0-9]/.test(m[1]);
const EVERYONE = /^(所有人|全体成员|all)$/i;

const SEP_RUN = /^[\s，,、：:]*$/;  // 两个 @ 之间、@ 与句首 / 句尾之间只有这些字符，就算「连成一串」

/**
 * 从回复文本里抽出 @ 提及。平台把 mentionIds 统一渲染成消息开头的一串「@A @B 」；正文里若再有 @ 文本，
 * 要么重复显示（正文不含那串前缀时），要么连同正文里所有 @xxx 一起被平台删掉（正文含前缀时）。
 * 所以正文里不能留任何「@已知昵称」：开头 / 结尾成串的 @ 整个去掉（前缀会显示），句中的 @ 只去掉 @ 号、留下名字（句子还通顺）。
 * mentions 按出现顺序；同一人连着 @ 几遍就保留几个（主人要求「@ 他三遍」），隔着正文再提到同一人只算一次。
 * 昵称可能含空格：长名优先匹配，避免短名误吃长名；先按原样大小写对，对不上的再不分大小写对一遍（模型常把 Alice 写成 alice）。
 * @所有人 不处理。unknown 是没对上任何人的「@xx」，照原样留在正文里，调用方记日志 / 告诉模型。HTTP 回退时用 mentionPrefix 把「@A @B 」拼回正文。
 */
export function extractMentions(text, nameToWxid, { display = displayNames(nameToWxid), strict = new Set() } = {}) {
  const src = String(text || "");
  const names = Object.keys(nameToWxid).filter((n) => n && !EVERYONE.test(n)).sort((a, b) => b.length - a.length);
  const hits = [];
  const hit = (start, end, name) => { if (!hits.some((h) => start < h.end && end > h.start)) hits.push({ start, end, name: display[nameToWxid[name]] || name, wxid: nameToWxid[name] }); };
  // strict 里的名字（从聊天里学来的群昵称）要求后面紧跟空白 / 标点 / 结尾：短群昵称不能截走「@老王」里的「@老」
  const bounded = (name, flags) => new RegExp(`${tagRe(name).source}(?=[\\s\\u2005，,。．！？!?：:、；;）)」】]|$)`, flags);
  for (const flags of ["g", "gi"]) {
    for (const name of names) for (const m of src.matchAll(strict.has(name) ? bounded(name, flags) : tagRe(name, flags))) hit(m.index, m.index + m[0].length, name);
  }
  // 最后一道：名字里的空白写没了（「@Amy Lee」写成「@AmyLee」），去掉空白后不分大小写对得上的也算
  const loose = new Map(names.map((n) => [noSpace(n).toLowerCase(), n]));
  for (const m of src.matchAll(LOOSE_AT)) {
    const name = loose.get(noSpace(m[1]).toLowerCase());
    if (name) hit(m.index, m.index + m[0].length, name);
  }
  hits.sort((a, b) => a.start - b.start);
  const unknownHits = [...src.matchAll(LOOSE_AT)]
    .filter((m) => !EVERYONE.test(m[1]) && !looksLikeEmail(src, m) && !hits.some((h) => m.index < h.end && m.index + m[0].length > h.start));
  const unknown = unknownHits.map((m) => m[1]);
  if (!hits.length) return { rest: src.trim(), mentions: [], unknown };

  // 判断「连成一串」时把没对上的 @xx 当分隔看：「@alice @甲 @乙 睡觉」里甲乙仍算开头那串，不会被当成句中名字留在正文里
  let masked = src;
  for (const m of unknownHits) masked = masked.slice(0, m.index) + " ".repeat(m[0].length) + masked.slice(m.index + m[0].length);
  const sep = (a, b) => SEP_RUN.test(masked.slice(a, b));
  const joined = (i) => sep(hits[i - 1].end, hits[i].start);  // 第 i 个与前一个连成一串
  let lead = sep(0, hits[0].start) ? 1 : 0;                   // 开头那串有几个
  while (lead && lead < hits.length && joined(lead)) lead++;
  let trail = hits.length;                                      // 结尾那串从第几个起
  if (sep(hits[hits.length - 1].end)) { trail--; while (trail > lead && joined(trail)) trail--; }
  if (trail < lead) trail = lead;

  let rest = "", pos = 0;
  const mentions = [], seen = new Set();
  hits.forEach((h, i) => {
    rest += src.slice(pos, h.start) + (i < lead || i >= trail ? "" : h.name);
    pos = h.end;
    if ((i > 0 && hits[i - 1].wxid === h.wxid && joined(i)) || !seen.has(h.wxid)) mentions.push({ name: h.name, wxid: h.wxid });
    seen.add(h.wxid);
  });
  rest += src.slice(pos);
  if (lead) rest = rest.replace(/^[\s，,、：:]+/, "");
  if (trail < hits.length) rest = rest.replace(/[\s，,、：:]+$/, "");
  return { rest: rest.replace(/[ \t]{2,}/g, " ").trim(), mentions, unknown };
}

/**
 * 本群的人名目录：[{ wxid, name 微信昵称, alias? 群昵称 }]，最近说过话的排前（新的在前），再补成员表里其余的；机器人自己不在内。
 * 平台没有群成员接口，只有入站流和启动预热学到的、发过言的人。@ 解析（directoryIndex）和给模型看的名单（rosterLabel）都从这一份来。
 * members 是 mem.members(群 id) 的结果；recent 里的名字比成员表新（刚改的名）。
 */
export function memberDirectory(members, recent) {
  const byId = new Map((members || []).map((m) => [m.wxid, { ...m }]));
  const order = [];
  const seen = new Set();
  const add = (id) => { if (id && !seen.has(id) && byId.has(id)) { seen.add(id); order.push(byId.get(id)); } };
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.mine || !m.from || !isNickname(m.name)) continue;
    if (!byId.has(m.from)) byId.set(m.from, { wxid: m.from, name: m.name });
    else if (!seen.has(m.from)) byId.get(m.from).name = m.name;  // 最近一条的名字最新
    add(m.from);
  }
  for (const id of byId.keys()) add(id);
  return order.filter((p) => isNickname(p.name));
}

/**
 * 名字 → wxid 的解析表：微信昵称和群昵称都能对上同一个人。同一个名字属于两个人时，微信昵称优先、再按目录顺序（最近说话的）。
 * 给 extractMentions 用。
 */
export function directoryIndex(dir) {
  const map = Object.create(null);  // 昵称可能叫 constructor / toString
  for (const p of dir) if (!Object.hasOwn(map, p.name)) map[p.name] = p.wxid;
  for (const p of dir) if (p.alias && !Object.hasOwn(map, p.alias)) map[p.alias] = p.wxid;
  return map;
}
/** 目录里从聊天学来的群昵称（解析时要求右边界，见 extractMentions 的 strict）。 */
export const directoryAliases = (dir) => new Set(dir.map((p) => p.alias).filter(Boolean));

/** @ 出去显示的名字：有群昵称就用群昵称（群里大家看到的是它，平台渲染真 @ 也优先用它），没有就用微信昵称。 */
export const directoryDisplay = (dir) => {
  const index = directoryIndex(dir);
  return Object.fromEntries(dir.map((p) => [p.wxid, p.alias && index[p.alias] === p.wxid ? p.alias : p.name]));
};

/** 名单里一个人的写法：「微信昵称」或「微信昵称（群里叫 群昵称）」。 */
export const rosterLabel = (p) => (p.alias ? `${p.name}（群里叫 ${p.alias}）` : p.name);

/** 没给显示名时的默认：同一个 wxid 有好几个名字，取解析表里排在最前的那个。 */
function displayNames(nameToWxid) {
  const out = Object.create(null);
  for (const [name, id] of Object.entries(nameToWxid)) if (!Object.hasOwn(out, id)) out[id] = name;
  return out;
}

/** 把 mentions 渲染成 HTTP 回退用的文本前缀（与平台真 @ 的显示形态一致）。 */
export const mentionPrefix = (mentions) => (mentions.length ? mentions.map((m) => `@${m.name}`).join(" ") + " " : "");


/**
 * 群里回人默认 @ 回触发者：平台不支持引用回复，@ 是唯一能标明回给谁的手段。返回该补的 { name, wxid }，不补给 null。
 * 直接给结构化的 mention、不拼成「@名字」文本再解析：群昵称可能撞上别人的微信昵称，文本再解析一遍会 @ 错人。
 * 模型已写了 @ 触发者就不补；插嘴没有特定对象不补；窗口内说话的人不够多（只有触发者一人在聊）也不补；
 * 触发者没有昵称（平台拿 wxid 顶替）也不补，免得拼出「@wxid_xxx」。text 传整条回复来判断，调用方只把前缀加在分条后的第一条上。
 */
export function mentionBack(text, { mb, isGroup, reason, sender, recent, nameToWxid, display = {}, strict, now = Date.now() }) {
  if (!mb.enabled || !isGroup || !isNickname(sender.name)) return null;
  if (!MENTION_BACK_REASONS.includes(reason)) return null;
  if (extractMentions(text, nameToWxid, { display, strict }).mentions.some((m) => m.wxid === sender.id) || text.includes(`@${sender.name}`)) return null;
  const since = now - mb.quietWindowSec * 1000;
  const speakers = new Set(recent.filter((m) => !m.mine && m.ts >= since).map((m) => m.from));
  if (speakers.size < mb.minSpeakers) return null;
  return { name: display[sender.id] || sender.name, wxid: sender.id };
}


/**
 * 从一条入站消息里学群昵称，返回 [{ wxid, alias }]。平台记录只给微信昵称，群昵称只在聊天文本里露面，两个来源：
 *  1. 引用块「群昵称：原文」——引用块会截断原文，所以片段要是某条最近记录的开头或其中一段（至少 QUOTE_SNIPPET_MIN 个字），
 *     而且只有一个人说过，才算那个人的群昵称；
 *  2. 点选出来的 @（「@群昵称」后面跟 U+2005，微信从成员列表里点人时插入的正是群昵称）——没法直接对上人，只在去掉空白、
 *     不分大小写后和某个成员的微信昵称一样时，确认这就是他（大小写不同的群昵称）。
 * 引用块是普通文本、谁都能手打，所以：学到的只能是群成员的群昵称，机器人自己的一概不从这里学（见 harness 的 OpenClaw 那条路）；
 * 已有人用着的名字不学；名字得像个群昵称（isAliasLike），免得被拿来伪造名单项或截走别人的 @。
 * dir 是 memberDirectory 的结果；recent 是这条消息之前的最近记录；bot 用来排除机器人自己的名字。
 */
export function learnAliases(msg, recent, dir, bot = {}) {
  const out = [];
  const text = String(msg.text || "");
  const taken = (n) => dir.some((p) => p.name === n || p.alias === n) || selfNames(bot).includes(n);
  const quote = QUOTE_HEAD.exec(text);
  if (quote) {
    const author = quote[1].trim(), snippet = quote[2].trim();
    if (isAliasLike(author) && !taken(author) && snippet !== "图片") {
      const said = recent.filter((m) => m.from && !m.mine && quoteMatches(m.text, snippet));
      const who = new Set(said.map((m) => m.from));
      if (who.size === 1 && !recent.some((m) => m.mine && quoteMatches(m.text, snippet))) out.push({ wxid: [...who][0], alias: author });
    }
  }
  for (const m of ownWords(text).matchAll(PICKED_AT)) {
    const tag = m[1].trim();
    if (!isAliasLike(tag) || taken(tag)) continue;
    const same = dir.filter((p) => noSpace(p.name).toLowerCase() === noSpace(tag).toLowerCase());
    if (same.length === 1) out.push({ wxid: same[0].wxid, alias: tag });
  }
  return out;
}
/** 从文本里学来的名字得像个群昵称：2~16 个字、不是 wxid / 群 id、不含换行和会搅乱名单写法的括号、顿号、引号、冒号。 */
export const isAliasLike = (s) => typeof s === "string" && s.length >= 2 && s.length <= 16 && isNickname(s) && !/[\n（）()、，,「」【】"：:<>]/.test(s);
const QUOTE_HEAD = /^「([^：:」\n]{1,30})[：:]([\s\S]*?)」\n[-\s]+/;
const PICKED_AT = /@([^@\u2005\n]{1,30})\u2005/g;
const QUOTE_SNIPPET_MIN = 4;  // 引用片段至少这么多字才拿来认人：「好」「嗯」这种谁都说过
/** 引用片段对得上某条原话：片段是原话的开头或其中一段（引用块只会截短、不会加长）。 */
export function quoteMatches(text, snippet) {
  const a = noSpace(text), b = noSpace(snippet).replace(/…$/, "");
  return b.length >= QUOTE_SNIPPET_MIN && a.includes(b);
}

/** 说话人自己写的部分（引用块不算）是否命中任一正则（不区分大小写）。头像等「问到才附图」的判定用它。 */
export const matchesAny = (text, patterns) => {
  const own = ownWords(text);
  return (patterns || []).some((p) => compile(p).test(own));
};

/**
 * 说话人明说要多发几张图 / 表情：「都发出来」「全都秀一下」「挨个发」「每张都发」「发三张」「发我 3 张」「来几张」「多发点」。
 * 命中时群里这一轮的图片上限放宽（limits.groupImagesOnRequest），system 里也会照实告诉模型。只看自己写的部分：引用块里的话不算他的要求。
 * 按分句判断：分句里「发」前面有否定（别 / 不 / 甭 / 没 / 莫）、或说的是已经发过（发了 / 发过）就不算——「都别发了」「我都发了」不能当成要多发。
 */
const CLAUSE_SPLIT = /[，,。．！？!?；;\n]/;
const NUM = "(?:[2-9]|[1-9]\\d{1,2}|两|俩|三|四|五|六|七|八|九|十|几|好几|多)";
const IMG_UNIT = "(?:张|个表情|个图|套|连)";
const MANY_IMAGES = new RegExp([
  "(?:都|全|统统|通通|挨个|逐个|一个个|一张张|一起|每一?张)[^发秀晒]{0,4}[发秀晒]",  // 都发出来 / 全都秀一下 / 挨个发 / 每张都发（「每个月发工资」不算）
  `[发来晒秀](?:我|给我|上|出)?\\s*${NUM}\\s*${IMG_UNIT}`,                              // 发三张 / 发我 3 张 / 来几张 / 发两个表情
  "多发[点些几]|连发",
].join("|"));
const NOT_ASKING = /(?:别|不|甭|没|莫)[^发秀晒]{0,4}[发秀晒]|[发秀晒][^，,。！？!?]{0,3}(?:了|过)(?:[^吧吗呢]|$)/;
export const asksForManyImages = (text) => ownWords(text).split(CLAUSE_SPLIT).some((c) => MANY_IMAGES.test(c) && !NOT_ASKING.test(c));

/** 去掉触发用的 @机器人（微信昵称或本群群昵称）和多余空白。 */
export function stripMention(text, bot) {
  let out = text;
  for (const n of selfNames(bot)) out = out.replace(new RegExp(`${tagRe(n).source}[\\u2005\\s]*`, "g"), "");
  return out.trim();
}
