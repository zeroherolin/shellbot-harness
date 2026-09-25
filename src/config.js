// 配置：默认值、逐字段说明、加载、校验、渲染。真实配置放 <名字>.local/config.jsonc（gitignore，一个机器人一个目录）。
// 进 config 的是影响 bot 行为与体验的功能参数；协议常量、内部时序、安全上界留在各模块顶部的具名常量里。
// config 里有的字段，其它模块不再写兜底值。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPath, isObj, HISTORY_PAGE_MAX } from "./util.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");  // workspace 相对路径按它解析（与 src/index.js 的 root 一致）
const STICKER_POLL_MIN_SEC = 5;  // 拉 puppet 日志收微信表情最勤多久一次：每次都是一整页日志，太勤压平台接口
const TIMER_MAX_MS = 2 ** 31 - 1;  // Node 定时器上限（约 24.8 天）：超过的会被当成 1ms 立刻触发，时长类字段一律不能超
/** 时长类字段换算成毫秒的倍数：*Ms 是毫秒，*Sec 是秒，*Minutes 是分钟，mqttKeepalive 是秒。 */
const durationUnit = (p) => (/Ms$/.test(p) ? 1 : /Minutes$/.test(p) ? 60_000 : /Sec$|mqttKeepalive$/.test(p) ? 1000 : 0);

export const DEFAULTS = {
  host: "",
  token: "",
  bot: { id: null, name: "" },
  owner: "",
  workspace: "",
  timezone: "Asia/Shanghai",
  blockedSenders: [],
  dm: { policy: "owner", allowFrom: [], fallback: "刚才没接上，稍后再问我一次。" },
  groups: {
    policy: "allowlist",
    allow: [],
    wakePatterns: [],
    nameTrigger: true,
    chime: { enabled: false, cooldownMinutes: 15, probability: 0.15 },
    mentionBack: { enabled: true, quietWindowSec: 120, minSpeakers: 2 },
    warmupHistory: 200,
  },
  agent: {
    protocol: "openai",
    baseUrl: "",
    token: "",
    model: "",
    maxOutputTokens: 4096,
    maxInputTokens: 32000,
    effort: "",
    thinking: "",
    maxTurns: 6,
    timeoutMs: 180000,
    turnTimeoutMs: 300000,
    retries: 2,
    debounceMs: 1500,
    toolResultMaxChars: 8000,
  },
  context: { size: 100, rosterSize: 80, peekLines: 10 },
  images: { vision: true, window: 8, maxBytes: 5000000, downloadTimeoutMs: 15000, downloadRetries: 3, rehost: true, avatarPatterns: ["头像"] },
  stickers: { edge: 240, quality: 85, maxCount: 100, repeatCooldownMinutes: 10, inboundPollSec: 15 },
  history: { defaultCount: 100, maxCount: 500, quotedImageDepth: 1000 },
  memory: { maxGlobalLines: 200, maxNoteLines: 80, maxEntryChars: 200 },
  limits: {
    minIntervalMs: 2000,
    maxWaitMs: 120000,
    groupImagesPerTurn: 1,
    groupImagesOnRequest: 6,
    quietHours: { enabled: true, from: 23, to: 8, allowDirect: true },
    split: { maxChars: 800, maxParts: 5 },
  },
  logs: { keepDays: 30 },
  health: { checkMinutes: 5 },
  network: {
    sendTimeoutMs: 15000,
    sendRetries: 2,
    apiTimeoutMs: 30000,
    platformTimeoutMs: 10000,
    mqttKeepalive: 30,
    mqttConnectTimeoutMs: 15000,
    reconnectBaseMs: 2000,
    reconnectMaxMs: 60000,
    mqttClientIdSuffix: "",
  },
};

/** 每个字段一句说明；生成 config.example.jsonc 时作为行注释。 */
export const DOCS = {
  host: "ShellBot 平台地址，必填",
  token: "ShellBot 平台 API token（后台「系统 token」），发消息、查历史都用它；留空取环境变量 SHELLBOT_TOKEN",
  "bot.id": "机器人 id（后台机器人列表里的数字 id），必填",
  "bot.name": "机器人的微信昵称，@ / 引用 / 提到昵称都按它认；留空用平台记的（puppet 登录时写入，之后改名平台不更新，OpenClaw 发的文字又没有回显可学，改了名就填这里）",
  owner: "主人 wxid，必填（只认 wxid）。私聊机器人一句，logs/*.jsonl 里 inbound 的 from 就是",
  workspace: "工作目录，必填：人格、记忆、图库、上下文、日志都在这里；相对路径按仓库根目录算，一个机器人一个（如 mybot.local/workspace），不能是仓库根目录或仓库里的 workspace/ 模板目录",
  timezone: "强制时区，写 Asia/Shanghai 这类 IANA 名（CST、GMT+8 这类缩写 Node 不认）：静默时段、日志日期、给模型看的时间都按它算",
  blockedSenders: "黑名单 wxid，这些人的消息直接忽略",
  "dm.policy": "私聊策略：owner 只回主人 | allowlist 只回 allowFrom | open 回所有人",
  "dm.allowFrom": "allowlist 时允许私聊的 wxid",
  "dm.fallback": "私聊里模型拒答 / 轮数用尽 / 请求出错时发的兜底话；留空则沉默（群里一律沉默）",
  "groups.policy": "群策略：allowlist 只回 allow 里的群 | open 所在群都回 | disabled 不回群",
  "groups.allow": "白名单群 wxid（@chatroom 结尾）",
  "groups.wakePatterns": "唤醒词正则（不区分大小写），放别名或句式；提到昵称本身由 nameTrigger 管",
  "groups.nameTrigger": "群里提到机器人昵称也触发，不用 @（引用块里的、连着字母的不算）",
  "groups.chime.enabled": "主动插嘴：群里没人叫也偶尔被唤起判断要不要接一句",
  "groups.chime.cooldownMinutes": "同一群两次插嘴至少隔几分钟",
  "groups.chime.probability": "每条未触发的群文字消息唤起一次判断的概率（0~1）",
  "groups.mentionBack.enabled": "群里回人模型没写 @ 时系统补 @ 回触发者（平台无引用回复，只能靠 @）",
  "groups.mentionBack.quietWindowSec": "回复前这么多秒内说话的人少于 minSpeakers 就不补 @（只有他一人在聊）",
  "groups.mentionBack.minSpeakers": "窗口内至少几个不同的人在说话才补 @",
  "groups.warmupHistory": "启动时每个群翻多少条历史补成员表（0 = 不翻，最多 500），异步不阻塞",
  "agent.protocol": "openai（兼容 /v1/chat/completions）| anthropic（Messages API）",
  "agent.baseUrl": "模型接口地址，openai 必填；anthropic 留空则读 ANTHROPIC_BASE_URL",
  "agent.token": "模型 token，openai 必填；anthropic 留空则读 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY",
  "agent.model": "模型名，必填",
  "agent.maxOutputTokens": "单次回复最多生成多少 token",
  "agent.maxInputTokens": "输入预算（估算），超出按重要性截断上下文；0 = 不限",
  "agent.effort": "推理强度（low / medium / high 等），留空不传；仅推理型模型认，普通模型设了会报错",
  "agent.thinking": "anthropic 协议的思考开关：留空按模型默认 | adaptive 开自适应思考 | disabled 关（部分模型不接受 disabled，会报错）；openai 协议忽略",
  "agent.maxTurns": "一轮最多请求模型几次（每次工具调用后再请求一次，最后作答那次也算）",
  "agent.timeoutMs": "单次模型请求超时",
  "agent.turnTimeoutMs": "一轮（全部请求、重试、工具调用加起来）最多多久，到点放弃这轮；不能小于 timeoutMs",
  "agent.retries": "模型请求遇网络错误 / 5xx / 429 的重试次数（429 退避更久，服务端给了 Retry-After 就按它）",
  "agent.debounceMs": "同一人短时间连发合并成一轮的等待窗口；0 = 不合并",
  "agent.toolResultMaxChars": "单个工具返回给模型的最大字符数，小上下文模型调低",
  "context.size": "模型每轮能看到的最近消息条数",
  "context.rosterSize": "群聊每轮给模型的成员名单最多几人（最近说过话的优先）：模型只知道名单里的人能 @，大群可调高（每人约多几个 token）",
  "context.peekLines": "主人私聊跨会话发消息后，附目标会话最近几条供判断措辞；0 = 不附",
  "images.vision": "让模型看图（需多模态模型）",
  "images.window": "没引用时只有触发点前这么多条内的图才自动带给模型，更早的靠引用",
  "images.maxBytes": "单张超过这个字节数就不下载，回退直传 url",
  "images.downloadTimeoutMs": "图片下载超时",
  "images.downloadRetries": "下载重试次数（刚发的图平台重托管有延迟）",
  "images.rehost": "发图前把不在平台托管的图先上传到平台再发：平台是自己去拉外站 url，海外 / 临时图床超时会静默丢图",
  "images.avatarPatterns": "触发消息命中这些正则就把机器人自己的头像图附给模型（问头像时能照图描述）；头像放 <workspace>/avatar.jpg，没有就用平台上登录时传的那张",
  "stickers.edge": "表情包入库时压成长边多少像素（微信官方规范 240）",
  "stickers.quality": "jpg 质量 1~100",
  "stickers.maxCount": "图库上限，防 system prompt 无限膨胀",
  "stickers.repeatCooldownMinutes": "群里同一张表情包这么多分钟内不重发，改用文字（0 不限；私聊不限）",
  "stickers.inboundPollSec": "群友发的微信表情平台不记录，每隔这么多秒拉一次 puppet 日志补进来（0 = 不收，不能小于 5；日志只留最后 1000 行，间隔太长会漏）",
  "history.defaultCount": "read_history 一次默认翻多少条",
  "history.maxCount": "一次最多翻多少条（最多 500）",
  "history.quotedImageDepth": "引用了历史图片时，往前翻多少条去找那张图",
  "memory.maxGlobalLines": "全局记忆最多几条，超出最旧的归档到 archive/",
  "memory.maxNoteLines": "每个会话备忘最多几条，超出最旧的归档到 archive/",
  "memory.maxEntryChars": "remember 写入的单条最长多少字",
  "limits.minIntervalMs": "全局发送节流：任意两条出站至少隔这么久，排队不丢",
  "limits.maxWaitMs": "触发消息或出站消息排队超过这么久还没处理 / 发出就丢弃；重启续发的也按它算",
  "limits.groupImagesPerTurn": "群里一次回复最多几张图 / 表情，超出即拒改用文字（0 不限；私聊不限）",
  "limits.groupImagesOnRequest": "有人明说要多发（「都发出来」「发三张」「挨个发」）时这一轮放宽到几张（0 不限；不大于上一项就等于不放宽）",
  "limits.quietHours.enabled": "静默时段开关",
  "limits.quietHours.from": "静默开始小时（0~24），from > to 表示跨夜",
  "limits.quietHours.to": "静默结束小时（0~24）",
  "limits.quietHours.allowDirect": "静默时段内是否仍回直接触发（私聊 / @ / 引用 / 唤醒词 / 提到昵称）；关了就全不回",
  "limits.split.maxChars": "单条文字超过多少字就自动再拆",
  "limits.split.maxParts": "一轮最多发几条文字：模型用 --- 主动分的、超长自动拆的、say 先发的都算；say 把配额用完时最后的回复仍保底 1 条",
  "logs.keepDays": "日志保留天数，超期的每日 JSONL 自动删除（启动时与跨天各清一次）",
  "health.checkMinutes": "每隔几分钟复查一次平台侧：机器人状态（掉线 / 待扫码时收不到任何消息）和 OpenClaw 等开关，有变化才记日志、按需重连；0 = 只在启动时查一次",
  "network.sendTimeoutMs": "发消息 / 上传图片的单次超时，也是 OpenClaw 等平台确认收到的时限",
  "network.sendRetries": "平台接口重试次数：查询类遇网络错误 / 5xx / 429 都重试；发消息只在 429 / 503 重试（其余可能已受理，重发会重复进群）",
  "network.apiTimeoutMs": "平台查询类接口（历史、日志、群、联系人）的单次超时",
  "network.platformTimeoutMs": "拉平台配置的超时：入站 MQTT broker 配置、出站 OpenClaw 配置都用它",
  "network.mqttKeepalive": "MQTT 心跳秒数",
  "network.mqttConnectTimeoutMs": "MQTT 连接超时",
  "network.reconnectBaseMs": "断线重连退避起点（指数增长 ± 10% 抖动）",
  "network.reconnectMaxMs": "重连退避上限",
  "network.mqttClientIdSuffix": "MQTT clientId 后缀，只用于排查时区分连接，只能用字母 / 数字 / _ / -；正常留空。同一个机器人只能跑一个 harness（跑两个会重复回复）",
};

const ENUMS = {
  "dm.policy": ["owner", "allowlist", "open"],
  "groups.policy": ["allowlist", "open", "disabled"],
  "agent.protocol": ["openai", "anthropic"],
  "agent.thinking": ["", "adaptive", "disabled"],
};
const POSITIVE_INTS = [
  "groups.chime.cooldownMinutes", "groups.mentionBack.quietWindowSec", "groups.mentionBack.minSpeakers",
  "agent.maxOutputTokens", "agent.maxTurns", "agent.timeoutMs", "agent.turnTimeoutMs", "agent.toolResultMaxChars",
  "context.size", "context.rosterSize",
  "logs.keepDays",
  "images.window", "images.maxBytes", "images.downloadTimeoutMs",
  "history.defaultCount", "history.maxCount", "history.quotedImageDepth",
  "memory.maxGlobalLines", "memory.maxNoteLines", "memory.maxEntryChars",
  "stickers.edge", "stickers.maxCount",
  "limits.minIntervalMs", "limits.maxWaitMs", "limits.split.maxChars", "limits.split.maxParts",
  "network.sendTimeoutMs", "network.platformTimeoutMs", "network.apiTimeoutMs",
  "network.mqttKeepalive", "network.mqttConnectTimeoutMs", "network.reconnectBaseMs", "network.reconnectMaxMs",
];
const NON_NEGATIVE_INTS = [
  "agent.maxInputTokens", "agent.retries", "agent.debounceMs", "context.peekLines", "groups.warmupHistory", "limits.groupImagesPerTurn", "limits.groupImagesOnRequest",
  "images.downloadRetries", "stickers.repeatCooldownMinutes", "stickers.inboundPollSec", "network.sendRetries", "health.checkMinutes",
];
const RANGES = {
  "groups.chime.probability": [0, 1],
  "stickers.quality": [1, 100],
  "limits.quietHours.from": [0, 24],
  "limits.quietHours.to": [0, 24],
};
const BOOLS = ["groups.nameTrigger", "groups.chime.enabled", "groups.mentionBack.enabled", "images.vision", "images.rehost", "limits.quietHours.enabled", "limits.quietHours.allowDirect"];
const PATTERN_LISTS = ["groups.wakePatterns", "images.avatarPatterns"];
const STRING_LISTS = ["blockedSenders", "dm.allowFrom", "groups.allow", ...PATTERN_LISTS];
const STRINGS = ["token", "agent.baseUrl", "agent.token", "agent.effort", "network.mqttClientIdSuffix"];  // 可留空，但必须是字符串（写成数字 / null 会被拼进请求或 clientId）

/** 读 JSON 或 JSONC（行注释、块注释、尾随逗号）。逐字符扫描，字符串里的 // 、/* 和 ,] 都原样保留。 */
export function parseJsonc(text) {
  let out = "", i = 0, inStr = false;
  /** 从 j 起跳过空白和注释，返回下一个有效字符的位置。 */
  const skip = (j) => {
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "/" && text[j + 1] === "/") { while (j < text.length && text[j] !== "\n") j++; continue; }
      if (text[j] === "/" && text[j + 1] === "*") { const end = text.indexOf("*/", j + 2); j = end === -1 ? text.length : end + 2; continue; }
      return j;
    }
  };
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === "\"") inStr = false;
      i++; continue;
    }
    if (ch === "\"") { inStr = true; out += ch; i++; continue; }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end === -1 ? text.length : end + 2; continue; }
    // 尾随逗号：只去字符串外、后面（隔着空白 / 注释）紧跟 } 或 ] 的；以前整段正则替换会把唤醒词 "[，,]" 改成 "[，]"
    if (ch === "," && "}]".includes(text[skip(i + 1)] ?? "x")) { i++; continue; }
    out += ch; i++;
  }
  return JSON.parse(out);
}

/** root：workspace 相对路径的基准目录（harness 的 root），默认仓库根目录。 */
export function loadConfig(file, { root = REPO_ROOT } = {}) {
  if (!fs.existsSync(file)) throw new Error(`找不到配置 ${file}，先复制 config.example.jsonc 为 <名字>.local/config.jsonc（如 mybot.local/config.jsonc）`);
  return validate(merge(structuredClone(DEFAULTS), parseJsonc(fs.readFileSync(file, "utf8"))), { root });
}

/** 配置里 DEFAULTS 没有的字段路径：拼错的、旧版遗留的。对象按层比对，数组和标量是叶子。 */
export function unknownKeys(over, base = DEFAULTS, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(over || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (!Object.hasOwn(base, k)) out.push(p);
    else if (isObj(v) && isObj(base[k])) out.push(...unknownKeys(v, base[k], p));
  }
  return out;
}

/** 两个时刻（冬 / 夏，照顾夏令时）上，进程按 process.env.TZ 算的偏移和 Intl 按 IANA 数据算的偏移是否一致。 */
function tzHonored(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return false; }
  const intlOffset = (t) => {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(t).find((x) => x.type === "timeZoneName").value;
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(s);  // 零偏移时是纯 "GMT"
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  };
  const prev = process.env.TZ;
  try {
    process.env.TZ = tz;
    const y = new Date().getFullYear();
    return [Date.UTC(y, 0, 15), Date.UTC(y, 6, 15)].every((t) => -new Date(t).getTimezoneOffset() === intlOffset(t));
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}

/** 校验必填、枚举、类型与数值范围、未知字段；返回原对象。root 同 loadConfig。 */
export function validate(cfg, { root = REPO_ROOT } = {}) {
  const need = (ok, msg) => { if (!ok) throw new Error(`config.${msg}`); };
  const unknown = unknownKeys(cfg);
  if (unknown.length) throw new Error(`config 里有不认识的字段：${unknown.join("、")}。多半是拼错了，或是旧版字段——旧配置跑 npm run config:migrate <配置文件> 迁移（会丢掉不认识的字段并备份原文件）`);
  // 分组写成 null / 数字时，下面取字段会直接抛 TypeError，先给一句能看懂的
  const shape = (base, obj, prefix) => {
    for (const [k, v] of Object.entries(base)) {
      if (!isObj(v)) continue;
      const p = prefix ? `${prefix}.${k}` : k;
      need(isObj(obj[k]), `${p} 必须是对象（{ ... }）`);
      shape(v, obj[k], p);
    }
  };
  shape(DEFAULTS, cfg, "");
  need(typeof cfg.host === "string" && /^https?:\/\/[^\s/]+/i.test(cfg.host), "host 必填，且必须是 http:// 或 https:// 开头的平台地址");
  need(Number.isInteger(cfg.bot.id) && cfg.bot.id > 0, "bot.id 必填，且必须是正整数（后台机器人列表里的数字 id）");
  need(typeof cfg.bot.name === "string", "bot.name 必须是字符串（留空用平台记的昵称）");
  need(typeof cfg.workspace === "string" && cfg.workspace.trim(), "workspace 必填，写成 <名字>.local/workspace 这类子目录");
  const ws = path.resolve(root, cfg.workspace), rootDir = path.resolve(root);
  // 解析到仓库根目录（或它的上级）时，context/、memory/、rooms.json 这些聊天数据会落在 .gitignore 管不到的地方
  need(ws !== rootDir && !rootDir.startsWith(ws.endsWith(path.sep) ? ws : ws + path.sep), `workspace「${cfg.workspace}」解析到了仓库根目录或它的上级（${ws}），请写成 <名字>.local/workspace 这类子目录`);
  // 仓库里的 workspace/ 是要提交的模板（SOUL.md、stickers.json）：拿它当工作目录，真实的表情包地址、人格改动就会进 git
  need(ws !== path.join(rootDir, "workspace"), `workspace「${cfg.workspace}」是仓库里的模板目录，请写成 <名字>.local/workspace，并把模板复制过去`);
  need(typeof cfg.owner === "string" && cfg.owner.trim(), "owner（主人的 wxid）必填，且必须是字符串");
  need(typeof cfg.agent.model === "string" && cfg.agent.model.trim(), "agent.model 必填，且必须是字符串");
  need(typeof cfg.dm.fallback === "string", "dm.fallback 必须是字符串（留空则沉默）");
  for (const p of STRINGS) need(typeof getPath(cfg, p) === "string", `${p} 必须是字符串（不用就留空 ""）`);
  need(/^[A-Za-z0-9_-]*$/.test(cfg.network.mqttClientIdSuffix), "network.mqttClientIdSuffix 只能用字母 / 数字 / _ / -（正常留空）");
  // 写错 Node 不报错、静默按 UTC（或别的时区）计时，静默时段会整体错位。Intl 认的名字 process.env.TZ 不一定认（CST 在 Intl 里是芝加哥、在 TZ 里是 UTC），所以按进程实际算出的偏移验
  if (cfg.timezone !== "") {
    need(typeof cfg.timezone === "string" && tzHonored(cfg.timezone),
      `timezone「${cfg.timezone}」不是有效的 IANA 时区名（Node 不认或认成了别的时区），请写成 Asia/Shanghai 这类「大洲/城市」形式；CST、GMT+8 这类缩写不认`);
  }
  for (const [p, allowed] of Object.entries(ENUMS)) {
    need(allowed.includes(getPath(cfg, p)), `${p} 必须是 ${allowed.join(" / ")}`);
  }
  for (const p of POSITIVE_INTS) {
    const v = getPath(cfg, p);
    need(Number.isInteger(v) && v > 0, `${p} 必须是正整数`);
  }
  for (const p of NON_NEGATIVE_INTS) {
    const v = getPath(cfg, p);
    need(Number.isInteger(v) && v >= 0, `${p} 必须是非负整数`);
  }
  for (const p of [...POSITIVE_INTS, ...NON_NEGATIVE_INTS]) {
    const unit = durationUnit(p);
    if (unit) need(getPath(cfg, p) * unit <= TIMER_MAX_MS, `${p} 太大了：换算成毫秒不能超过 ${TIMER_MAX_MS}（约 24 天）`);
  }
  for (const [p, [lo, hi]] of Object.entries(RANGES)) {
    const v = getPath(cfg, p);
    need(typeof v === "number" && v >= lo && v <= hi, `${p} 必须在 ${lo}~${hi}`);
  }
  for (const p of BOOLS) need(typeof getPath(cfg, p) === "boolean", `${p} 必须是 true / false`);
  need(cfg.history.defaultCount <= cfg.history.maxCount, "history.defaultCount 不能大于 maxCount");
  need(cfg.history.maxCount <= HISTORY_PAGE_MAX, `history.maxCount 不能大于 ${HISTORY_PAGE_MAX}（单页最多取这么多）`);
  need(cfg.groups.warmupHistory <= HISTORY_PAGE_MAX, `groups.warmupHistory 不能大于 ${HISTORY_PAGE_MAX}（单页最多取这么多）`);
  need(cfg.network.reconnectBaseMs <= cfg.network.reconnectMaxMs, "network.reconnectBaseMs 不能大于 reconnectMaxMs");
  need(cfg.agent.turnTimeoutMs >= cfg.agent.timeoutMs, "agent.turnTimeoutMs 不能小于 timeoutMs（一轮至少要能跑满一次请求）");
  need(cfg.stickers.inboundPollSec === 0 || cfg.stickers.inboundPollSec >= STICKER_POLL_MIN_SEC, `stickers.inboundPollSec 要么是 0（不收），要么不小于 ${STICKER_POLL_MIN_SEC}（太勤会压平台接口）`);
  need(cfg.agent.protocol !== "openai" || (cfg.agent.baseUrl && cfg.agent.token), "agent.baseUrl / agent.token 在 openai 协议下必填");
  for (const p of STRING_LISTS) {
    const list = getPath(cfg, p);
    need(Array.isArray(list) && list.every((s) => typeof s === "string"), `${p} 必须是字符串数组`);  // 写成字符串时 includes 会变成子串匹配，误封误放行
  }
  for (const p of PATTERN_LISTS) {
    for (const pat of getPath(cfg, p)) {
      let re;
      try { re = new RegExp(pat, "i"); } catch (e) { throw new Error(`config.${p} 里的正则「${pat}」无效：${e.message}`); }
      // 空串、"^"、"a*" 这类能匹配空文本的正则会命中每一条消息：唤醒词变成句句都回，头像每轮都附
      need(!re.test(""), `${p} 里的正则「${pat}」能匹配空文本，会命中每一条消息；空串请删掉`);
    }
  }
  return cfg;
}


/** 深合并：用户配置覆盖默认值，对象递归合并、数组和标量整体替换。 */
export function merge(base, over) {
  for (const [k, v] of Object.entries(over || {})) base[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return base;
}

/** 把配置渲染成带注释的 JSONC：每个叶子字段后跟一行说明（同组对齐），分组之间空一行。example 与 local 共用同一格式。 */
export function renderJsonc(values, { docs = DOCS, indent = 2 } = {}) {
  const pad = (n) => " ".repeat(n);
  const lines = [];
  const walk = (obj, depth, prefix) => {
    const keys = Object.keys(obj);
    keys.forEach((k, i) => {
      const v = obj[k];
      const path = prefix ? `${prefix}.${k}` : k;
      const comma = i === keys.length - 1 ? "" : ",";
      if (isObj(v)) {
        if (depth === 1 && i > 0) lines.push({ text: "" });
        lines.push({ text: `${pad(depth * indent)}"${k}": {` });
        walk(v, depth + 1, path);
        lines.push({ text: `${pad(depth * indent)}}${comma}` });
      } else {
        lines.push({ text: `${pad(depth * indent)}"${k}": ${JSON.stringify(v)}${comma}`, doc: docs[path] });
      }
    });
  };
  walk(values, 1, "");
  // 同一分组内的行注释对齐到该组最长的一行
  const groups = [];
  let cur = [];
  for (const l of lines) { if (l.text === "") { groups.push(cur); cur = []; } else cur.push(l); }
  groups.push(cur);
  const out = ["{"];
  groups.forEach((g, gi) => {
    if (gi) out.push("");
    const col = Math.max(...g.filter((l) => l.doc).map((l) => displayWidth(l.text)), 0);
    for (const l of g) out.push(l.doc ? `${l.text}${" ".repeat(col - displayWidth(l.text) + 2)}// ${l.doc}` : l.text);
  });
  out.push("}");
  return out.join("\n") + "\n";
}

/** 终端显示宽度：中日韩等全角字符算 2 列。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
