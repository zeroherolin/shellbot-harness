// 运行时编排：入站 → 门控 → 队列 → 选图 → 组 prompt → Agent → 分条 → 节流出站。也负责配置热更新与退出收尾。
// 平台 IO、模型、日志都从 deps 取（默认真实实现），测试注入假的就能把整条流水线跑通。
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import * as platform from "./platform.js";
import * as fetchImage from "./fetch-image.js";
import * as puppetLog from "./puppet-log.js";
import { isOwnRecord } from "./platform.js";
import { VISION_MEDIA_TYPES } from "./fetch-image.js";
import { isOssUrl } from "./puppet-log.js";
import { makeMedia } from "./media.js";
import { makeSender } from "./send.js";
import { makeApi, resolveToken } from "./api.js";
import { makeAgent } from "./agent.js";
import { makeLog } from "./log.js";
import { classify, stripMention, extractMentions, mentionPrefix, mentionBack, memberDirectory, directoryIndex, directoryDisplay, directoryAliases, learnAliases, isAliasLike, matchesAny, asksForManyImages, MENTION_BACK_REASONS } from "./gate.js";
import { makeMemory } from "./memory.js";
import { makeLimiter, splitText, groupImageCap } from "./limits.js";
import { makeDedupe, makeDebouncer, makeLanes } from "./queue.js";
import { buildTools, toolDefs } from "./tools.js";
import { buildSystem, buildUserText, contextBudget, extractQuotes, imageLabel, cleanReply } from "./prompt.js";
import { isImageMsg, isNickname, ownEntry, getPath, encodedUrl, decodedUrl, sleep, toMillis, CONFIG_POLL_MS } from "./util.js";

const DIRECT = new Set(["dm", ...MENTION_BACK_REASONS]);  // 静默时段仍回的「直接触发」
const EXIT_GRACE_MS = 300;            // 退出前给连接关闭 / 落盘的时间
const LOG_TEXT_CLIP = 500;            // 落 JSONL 的消息文本截断长度
const LANE_DRAIN_MS = 15000;          // 退出时最多等还没处理完的轮这么久（模型正在答的让它答完），到点还没完的记 dropped: shutdown
const OUTBOX_DRAIN_MS = 5000;         // 退出时最多等出站队列这么久，到点还没发的留在盘上给下一个进程续发
const OUTBOX_RESTORE_WAIT_MS = 3000;  // 续发前最多等 OpenClaw 连上这么久，免得群文字全走 HTTP 回退
const LOCK_FILE = "harness.lock";     // 单实例锁（workspace 下，内容是 pid）：同一个 workspace 同时只能有一个 harness
const CLAW_MATCH_MS = 10_000;         // 原生记录和 OpenClaw 转发谁先到都行：在这个窗口里按消息 id 对上（补 @ 标志、图片 OSS 地址）
const CLAW_OSS_WAIT_MS = 3000;        // 学图片可缩放地址时先等 OpenClaw 转发这么久，等不到再去翻 puppet 日志
const OWNER_CHECK_WINDOW_MS = 60_000;     // 核对主人消息时在它时间戳前后各查这么久的平台历史
const OWNER_CHECK_TIMEOUT_MS = 12_000;    // 核对主人消息的接口超时，重试 1 次：平台偶尔慢到七八秒，太短会把主人误降级；查不到才按非主人处理
const OWNER_MAX_SKEW_MS = 5 * 60_000;     // 「主人消息」的时间戳和本地收到时间差这么多，就不是实时推送（多半是重放的旧记录），不认
const DEDUPE_IDS = 5000;               // 入站去重记住最近这么多条消息 id（防平台重推、原生 / 表情两路重复）
// network 里这几项定在 MQTT 连接建立时（心跳、连接超时、重连退避、clientId），变了才重连；其余（含拉 broker 配置的超时）每次用时现读，不断连接
const MQTT_NET_FIELDS = ["mqttKeepalive", "mqttConnectTimeoutMs", "reconnectBaseMs", "reconnectMaxMs", "mqttClientIdSuffix"];

/** pid 对应的进程还在不在（EPERM = 在，只是不归我们管）。 */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/**
 * 占住 workspace：锁文件里写自己的 pid。另一个活着的 harness 持有就拒绝启动（同一 bot 两个进程会互踢 clientId、同一条消息回两遍、抢同一个 outbox.json）；
 * 锁里的 pid 已经不在了（崩溃 / kill -9 没来得及删）就当过期锁接管。--hot 重启是旧 worker 退出、删了锁之后才起新的，不会误拦。返回释放函数。
 */
function lockWorkspace(dir) {
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: "wx" }); break; }
    catch (e) {
      if (e.code !== "EEXIST" || attempt) throw e;
      let pid = 0;
      try { pid = Number(fs.readFileSync(file, "utf8").trim()); } catch {}
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new Error(`workspace ${dir} 正被另一个 harness（pid ${pid}）使用：同一个 workspace 只能跑一个实例。确认那个进程已经不在了，删掉 ${file} 再启动`);
      }
      try { fs.unlinkSync(file); } catch {}  // 过期锁：接管
    }
  }
  return () => { try { if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file); } catch {} };
}

/**
 * 启动 harness。返回 { close(), inbound(msg), reload(), pollStickers() }：close 收尾但不退进程（收到信号才退），inbound 是入站入口、
 * reload 是配置热更新入口、pollStickers 立刻拉一次微信表情，测试直接调。
 * deps 可覆盖 makeApi / makeAgent / makeLog 和经 P 调用的平台 IO 函数（loadBot、fetchHistory、startMqtt、startOpenClawSender、fetchImageData、checkStickers 等，工具里用到的也由这里传入）。
 */
export async function runHarness({ root, configFile, hot, deps = {} }) {
  const P = { ...platform, ...fetchImage, ...puppetLog, makeApi, makeAgent, makeLog, ...deps };
  let cfg = loadConfig(configFile);
  if (cfg.timezone) process.env.TZ = cfg.timezone;  // 须在任何 Date 操作之前
  // 工作目录四件套一起建（锁、日志、记忆）：热更新换 workspace 时先建好新的再一次性替换，建失败旧的照用、新锁放掉。
  // 记忆读到坏文件的告警走当前日志器（间接壳）：换 workspace / 重建日志器后也写到新日志
  let ws, log, mem, unlock;
  const openWorkspace = (c) => {
    const w = path.resolve(root, c.workspace);
    const release = lockWorkspace(w);
    try {
      const wlog = P.makeLog(path.join(w, "logs"), { keepDays: c.logs.keepDays });
      return { ws: w, log: wlog, mem: makeMemory(w, { contextSize: c.context.size, ...c.memory, warn: (m) => (log || wlog).warn(m) }), unlock: release };
    } catch (e) { release(); throw e; }
  };
  ({ ws, log, mem, unlock } = openWorkspace(cfg));
  const apiLog = { warn: (m, e) => log.warn(m, e) };  // 间接壳：热更新换 workspace 后 api 的重试告警也写到新日志，不锁旧 log
  const connLog = { info: (m, e) => log.info(m, e), warn: (m, e) => log.warn(m, e), error: (m, e) => log.error(m, e) };  // 同上，给 MQTT 连接用：换 workspace 不用为了换日志器重连
  const liveNet = new Proxy({}, { get: (_t, k) => cfg.network[k] });  // 连接读 network 的活视图：sendTimeoutMs 这类每次发送才读的，热更新后不重连也生效
  const limiter = makeLimiter(cfg.limits);
  let closing = null;  // close() 的收尾 Promise；非空即「正在关闭」：续发、热更新、周期复查都看它，别在关的时候再建新东西
  // 配置里钉了 bot.name 就以它为准：平台记的是 puppet 登录时的昵称，之后改名不更新
  const pinName = (b, c) => { if (c.bot.name) b.name = c.bot.name; return b; };
  let agent, token, api, bot;
  try {
    agent = P.makeAgent(cfg, log);
    token = resolveToken(cfg);
    api = P.makeApi({ host: cfg.host, token, net: cfg.network, log: apiLog });
    bot = pinName(await P.loadBot(api, cfg.bot.id), cfg);
  } catch (e) { unlock(); throw e; }  // 启动失败先放锁（嵌在别的进程里调用、失败后重试时不被自己的锁拦住）
  log.info(`机器人「${bot.name}」(id ${bot.id})，主人 ${cfg.owner}，模型 ${cfg.agent.model}`);
  checkBotSwitches();
  checkBotHealth();

  // 平台侧两个开关决定通道能不能用，启动时就说清楚，别等到收不到 / 发不出才排查
  function checkBotSwitches() {
    if (!bot.recordOpen) log.error("平台「聊天记录」被关了（后台机器人设置 → 聊天记录 → 开启），原生通道收不到任何消息");
    if (!bot.clawOpen) log.warn("平台「小龙虾 / OpenClaw」未开启（clawConfig.open），真 @ 不可用：文字走 HTTP，@ 退化成纯文字（平台文本过滤的雷区词会插零宽空格绕开）");
    else if (!bot.apiSecret) log.warn("拿不到 apiSecret，真 @ 不可用，文字走 HTTP");
    else if (!bot.clawGroup) log.info("OpenClaw 入站一条都不推：后台 OpenClaw 页的「开启分组」没选（转发开关开着也没用；下拉是空的就先到「用户分组」页建一个）。@ 只能按昵称文本判断，机器人有群昵称时会漏");
    else if (!bot.clawText) log.info("OpenClaw 入站没推文字（没开「转发所有消息」）：@ 只能按昵称文本判断，机器人有群昵称时会漏；开了按 wxid 判断");
  }

  /**
   * 平台侧机器人状态。不是 running 期间消息压根进不了平台，harness 一条都收不到、日志里也什么都没有——
   * 这正是「发了没反应」最难查的一种：所以启动查一次、之后按 health.checkMinutes 周期复查，只在状态变化时记一行。
   * 以 botState 为准（puppet 没跑时别的状态字段不实时）。
   */
  let botState = null;
  const BOT_STATE_HINT = {
    stopped: "puppet 进程没跑，在后台点「启动」（或 POST /aiapi/v1/bots/:id/start）",
    scan_pending: "已生成二维码，去后台机器人页面扫码登录（二维码有时效，过期要重新点启动）",
    confirm_pending: "手机上确认登录即可",
    login_required: "登录失效，需要重新扫码登录",
    starting: "正在拉起，稍后再看",
    error: "puppet 进程出错，看后台日志 / 重启",
  };
  async function checkBotHealth() {
    let s;
    try { s = await api.status(cfg.bot.id); }
    catch (e) { log.warn(`查询平台机器人状态失败：${e.message}`); return; }
    const state = s?.botState || "unknown";
    if (state === "unknown") return;  // 平台没给状态（老版本 / 响应不含这个字段）就不猜，别报假警
    if (state === botState) return;
    const prev = botState;
    botState = state;
    const label = s?.botStateLabel || state;
    if (state === "running") {
      log.info(prev ? `平台机器人状态恢复：${label}（先前 ${prev}）` : `平台机器人已在线（${label}）`);
      return;
    }
    const hint = BOT_STATE_HINT[state] ? `：${BOT_STATE_HINT[state]}` : "";
    log.error(`平台机器人「${s?.name || bot.name}」当前 ${label}（${state}）${hint}。这期间群里 @ 你、私聊你都收不到，harness 不会记录任何消息`);
  }

  // 发送（出站队列 + OpenClaw / HTTP 通道）：见 send.js。依赖活取值：热更新换了凭证 / workspace / 连接也跟着换
  const sender = makeSender(() => ({ cfg, api, mem, log, ws, oc: ocSender }), limiter);
  const { deliver, outbox } = sender;

  // 图片与头像（下载、搬到平台、头像）：见 media.js。依赖都是活取值，热更新换了配置 / 凭证 / workspace 也跟着换
  const media = makeMedia(() => ({ cfg, api, bot, mem, log }), { fetchImageData: (...a) => P.fetchImageData(...a), checkStickers: (...a) => P.checkStickers(...a) });

  const dedupe = makeDedupe(DEDUPE_IDS);
  const lanes = makeLanes((key, e) => log.error(`会话 ${key} 处理失败：${e.stack || e}`));
  // 已排进 lane、还没处理完的轮：退出时等它们，到时限还没完的逐条记 dropped: shutdown 并作废（没开始的不再开始，答完了也不再发）
  const turns = new Set();
  const memNow = () => mem;  // handle 里的 mem 是这一轮自己的，要取当前的用它
  const enqueueTurn = (conv, batch) => {
    const t = { conv, batch, abandoned: false };
    turns.add(t);
    lanes.enqueue(conv.id, async () => {
      try { if (!t.abandoned) await handle(conv, batch, t); }
      finally { turns.delete(t); }
    });
  };
  const debouncer = makeDebouncer((_key, items) => enqueueTurn(items[0].msg.conv, items));
  const chimeClock = new Map();  // convId → 上次开口或尝试插嘴的时间

  function shouldChime(convId) {
    const c = cfg.groups.chime;
    if (!c.enabled) return false;
    if (Date.now() - (chimeClock.get(convId) || 0) < c.cooldownMinutes * 60_000) return false;
    return Math.random() < c.probability;
  }

  // ---- 群里的名字 ----
  // 平台记录只给微信昵称；群里显示的、别人 @ 和引用块里用的是群昵称。成员的群昵称从聊天里学（gate.learnAliases）。
  // 机器人自己的群昵称不从聊天文本里学（引用块谁都能手打，伪造一个就能让它被随便一个词叫醒）：只认 OpenClaw 按 wxid 标了「@ 了机器人」的消息里，
  // 点选出来的那个 @名字（onClawInbound → learnSelfAlias）。
  /** 这个会话里的机器人：群里带上它在本群的群昵称，@ 它、引用它都认。 */
  const botIn = (conv) => (conv?.isGroup && mem.selfAlias(conv.id) ? { ...bot, alias: mem.selfAlias(conv.id) } : bot);
  /** 学成员的群昵称，返回学到几个。门控放行之后才调（黑名单、白名单外的群不学）。 */
  function learnGroupNames(room, msg, recent, memAt = mem) {
    let n = 0;
    for (const { wxid, alias } of learnAliases(msg, recent, memberDirectory(memAt.members(room), recent), botIn({ id: room, isGroup: true }))) {
      if (memAt.seeAlias(room, wxid, alias)) n++;
    }
    return n;
  }
  /** OpenClaw 说这条 @ 了机器人：它自己写的部分里点选出来的 @名字，若不是任何成员的名字，就是机器人在本群的群昵称。 */
  function learnSelfAlias(msg) {
    const tags = [...String(msg.text || "").matchAll(/@([^@\u2005\n]{1,30})\u2005/g)].map((m) => m[1].trim());
    const index = directoryIndex(memberDirectory(mem.members(msg.conv.id), mem.context(msg.conv.id).recent()));
    const mine = tags.filter((t) => !Object.hasOwn(index, t) && t !== bot.name && isAliasLike(t));
    if (mine.length !== 1 || mine[0] === mem.selfAlias(msg.conv.id)) return;
    log.info(`学到机器人在「${msg.conv.name}」的群昵称：「${mine[0]}」`);
    mem.seeSelfAlias(msg.conv.id, mine[0]);
  }
  /** 本群的人名目录与解析表（@ 解析、补 @、名单都用它）。私聊没有。 */
  function groupNames(conv, recent, memAt = mem) {
    if (!conv.isGroup) return { dir: [], index: {}, display: {}, strict: new Set() };
    const dir = memberDirectory(memAt.members(conv.id), recent);
    return { dir, index: directoryIndex(dir), display: directoryDisplay(dir), strict: directoryAliases(dir) };
  }

  // 启动预热：每个白名单群翻一页历史，把发过言的人补进成员表（平台没有群成员接口）。异步，不阻塞启动。
  // 历史是新→旧，倒过来按时间顺序学，改过名的人以最新的名字为准；机器人自己（含手机上手动发的）不算成员，否则会 @ 到自己；
  // 黑名单里的人也不学（和入站一致：不理的人不进登记表，免得按昵称找人时撞上）
  async function warmupMembers() {
    const n = cfg.groups.warmupHistory;
    if (!n || cfg.groups.policy === "disabled") return;
    const rooms = cfg.groups.policy === "allowlist" ? cfg.groups.allow : Object.keys(mem.rooms());
    let learned = 0, aliases = 0;
    for (const id of rooms) {
      try {
        const { rows } = await P.fetchHistory(api, cfg, { id, isGroup: true }, { pageSize: n });
        const seen = [];  // 按时间顺序走一遍，和入站时一样学群昵称（引用块、点选 @），重启不忘
        for (const r of rows.slice().reverse()) {
          const own = isOwnRecord(r, bot.robotId);
          const item = { from: r.chatUserId, name: r.chatUserName, text: typeof r.content === "string" ? r.content : "", mine: own };
          if (r.chatUserId && r.chatUserName && !own && !cfg.blockedSenders.includes(r.chatUserId)) {
            mem.seeMember(id, r.chatUserId, r.chatUserName); learned++;
            aliases += learnGroupNames(id, item, seen);
          }
          seen.push(item);
        }
      } catch (e) { log.warn(`预热群 ${id} 成员失败：${e.message}`); }
    }
    log.info(`成员表预热完成：${rooms.length} 个群，${learned} 条记录${aliases ? `，学到 ${aliases} 个群昵称` : ""}`);
  }
  warmupMembers();

  // 启动时探一遍表情包链接：失效的发出去微信收不到、平台却回执成功，只能主动查。异步，不阻塞启动
  async function checkStickerLinks() {
    const list = mem.stickers();
    if (!list.length) return;
    try {
      const dead = await media.stickerLinks(list);
      if (dead.length) log.warn(`表情包链接失效 ${dead.length} 张：${dead.map((d) => `「${d.name}」${d.reason}`).join("、")}；让 bot 执行 manage_stickers check 或直接删掉`);
    } catch (e) { log.warn(`表情包链接探测失败：${e.message}`); }
  }
  checkStickerLinks();

  // 连接（可热重连）。入站和 OpenClaw 出站分开建：OpenClaw 开关 / apiSecret 中途变了只重建出站那条。
  // 日志走间接壳、network 走活视图：换 workspace、改 sendTimeoutMs 这类都不用重连。
  // clientId 的后缀带分隔符：bot 12 加后缀 3 与 bot 123 不加后缀不会撞成同一个
  let ocSender = null, mq = null;
  const suffixed = (sep) => (cfg.network.mqttClientIdSuffix ? `${sep}${cfg.network.mqttClientIdSuffix}` : "");
  const connectOpenClaw = () => {
    ocSender?.close();
    ocSender = bot.apiSecret && bot.clawOpen
      ? P.startOpenClawSender({
        host: cfg.host, apiSecret: bot.apiSecret, clientIdSuffix: `-harness${suffixed("-")}`, log: connLog, net: liveNet,
        onInbound: bot.clawText || bot.clawMedia ? onClawInbound : undefined,
      })
      : null;
  };
  const connectInbound = () => {
    mq?.close();
    mq = P.startMqtt({ host: cfg.host, botId: cfg.bot.id, clientId: `harness_${cfg.bot.id}${suffixed("_")}`, log: connLog, onMessage, net: liveNet });
  };
  const connect = () => { connectOpenClaw(); connectInbound(); };
  // 续发上次没发完的：取走（rename 原子）后立刻重新入队落盘，但先暂停出队、等 OpenClaw 连上（最多等几秒），否则群文字全走 HTTP 回退、@ 退化。
  // 这几秒里本轮新产生的回复也排在积压后面等，顺序不乱；这期间关闭，积压和新任务都在盘上，下一个进程接着发
  const backlog = sender.take();
  if (backlog.length && bot.apiSecret && bot.clawOpen) outbox.hold();
  if (!sender.restore(backlog)) outbox.resume();  // 全是过期 / 坏的：没什么可等的
  connect();
  (async () => {
    const deadline = Date.now() + OUTBOX_RESTORE_WAIT_MS;
    while (outbox.held() && !closing && ocSender && !ocSender.connected() && Date.now() < deadline) await sleep(100);
    if (!closing) outbox.resume();
  })();
  // 周期复查平台侧机器人状态：掉线 / 待扫码时消息进不了平台，日志里得看得见（状态变化才记，不刷屏）。
  // 顺带重读一次机器人信息：后台中途开关 OpenClaw、换了 apiSecret，要重建出站连接，否则一直走 HTTP（或拿旧凭证连不上）
  let healthTimer = null;
  async function refreshBot() {
    const cur = bot;
    let b;
    try { b = await P.loadBot(api, cfg.bot.id); }
    catch (e) { log.warn(`复查机器人信息失败：${e.message}`); return; }
    if (closing || bot !== cur) return;  // 期间关闭了 / 热更新换了 bot：以那边为准
    const ocChg = b.clawOpen !== bot.clawOpen || b.apiSecret !== bot.apiSecret || b.clawText !== bot.clawText || b.clawMedia !== bot.clawMedia;
    const switchChg = ocChg || b.clawGroup !== bot.clawGroup || b.recordOpen !== bot.recordOpen;
    if (!switchChg && b.avatar === bot.avatar) return;
    Object.assign(bot, { apiSecret: b.apiSecret, clawOpen: b.clawOpen, clawGroup: b.clawGroup, clawText: b.clawText, clawMedia: b.clawMedia, recordOpen: b.recordOpen, avatar: b.avatar });  // 就地改：运行时学到的 wxid / 昵称保留
    if (ocChg) {
      log.info(`平台 OpenClaw 设置变了（${bot.clawOpen ? "已开启" : "已关闭"}${bot.apiSecret ? "" : "，拿不到 apiSecret"}），重建出站连接`);
      connectOpenClaw();
    }
    if (switchChg) checkBotSwitches();  // 只换了头像不重复报开关提示
  }
  const scheduleHealth = () => {
    clearInterval(healthTimer);
    const minutes = cfg.health.checkMinutes;
    const tick = async () => { await refreshBot(); if (!closing) await checkBotHealth(); };
    if (minutes > 0) healthTimer = setInterval(() => tick().catch((e) => log.warn(`周期复查出错：${e.message}`)), minutes * 60_000).unref();
  };
  scheduleHealth();

  // 微信表情：平台不把它写进历史、也不推送，只在 puppet 日志里有（puppet-log.parseStickerEvents）。定时拉日志，把新表情当普通入站消息走
  // （门控、上下文、成员表都一样），type「表情」、sticker 是名称（有的话）、url 是能下载的 CDN 地址。表情不 @ 人，一般只进上下文、给插嘴做参考
  let stickerFeed = P.makeStickerFeed(() => api, () => cfg);
  let stickerTimer = null, stickerFailing = false, stickerBusy = false;
  async function pollStickers() {
    let events;
    try { events = await stickerFeed(); stickerFailing = false; }
    catch (e) { if (!stickerFailing) log.warn(`拉 puppet 日志找表情失败：${e.message}`); stickerFailing = true; return; }
    for (const e of events) {
      if (closing) return;
      const room = e.isGroup ? e.convId : null;
      // 日志里只有 wxid，名字从登记表查（群里见过的成员、私聊联系人）；查不到先用 wxid，isNickname 会把它当「没名字」
      const sender = (room && mem.members(room).find((m) => m.wxid === e.senderId)?.name) || mem.contacts()[e.senderId] || "";  // 不拿 id 顶替：自定义微信号会被当成名字
      // trusted：来自带 token 的平台接口（puppet 日志），不是谁都能往里发的 MQTT 推送，不用再到历史里核对身份（表情本来也不进历史）。
      // 拉取断过一阵后补上来的旧表情按发送时间算排队：超过 limits.maxWaitMs 的只进上下文，不再触发回复
      const receivedAt = Date.now() - e.ts > cfg.limits.maxWaitMs ? e.ts : Date.now();
      onMessage({
        id: e.id, ts: e.ts, receivedAt, type: "表情", text: "", url: e.url, isImage: true, sticker: e.name || undefined, trusted: true,
        robotId: null, isMine: e.senderId === bot.robotId, sender: { id: e.senderId, name: sender }, isGroup: e.isGroup, mention: false,
        conv: { id: e.convId, name: (room && mem.rooms()[room]) || sender, isGroup: e.isGroup },
      });
    }
  }
  // 间隔来自 stickers.inboundPollSec（0 = 不收）。上一次还没拉完（平台慢、在重试）就跳过这一拍，不叠请求
  const tickStickers = () => {
    if (stickerBusy || closing) return;
    stickerBusy = true;
    pollStickers().catch((e) => log.warn(`处理表情出错：${e.message}`)).finally(() => { stickerBusy = false; });
  };
  const scheduleStickers = () => {
    clearInterval(stickerTimer);
    const sec = cfg.stickers.inboundPollSec;
    if (sec > 0) stickerTimer = setInterval(tickStickers, sec * 1000).unref();
  };
  scheduleStickers();
  if (cfg.stickers.inboundPollSec > 0) tickStickers();  // 第一次只记下日志里已有的，不补旧表情

  // 配置热更新
  // 先用新配置把会失败的都算好（token、api、bot、workspace），全部成功再一次性提交；任何一步失败都保留旧配置。连续改动串行处理，后写的赢
  let reloading = Promise.resolve();
  const reloadConfig = () => (reloading = reloading.then(doReload));
  async function doReload() {
    let nextSpace = null;
    try {
      const next = loadConfig(configFile);
      const chg = (p) => JSON.stringify(getPath(next, p)) !== JSON.stringify(getPath(cfg, p));
      const wsChg = path.resolve(root, next.workspace) !== ws, botChg = chg("bot.id"), allowChg = chg("groups.allow") || chg("groups.policy");  // workspace 按解析后的路径比：写法变了、目录没变不算换
      const connChg = chg("host") || botChg || MQTT_NET_FIELDS.some((k) => chg(`network.${k}`));
      const nextToken = resolveToken(next);
      const apiChg = chg("host") || chg("network") || nextToken !== token;
      const nextApi = apiChg ? P.makeApi({ host: next.host, token: nextToken, net: next.network, log: apiLog }) : api;
      let nextBot = bot;
      if (botChg || apiChg || chg("bot.name")) {
        nextBot = await P.loadBot(nextApi, next.bot.id);
        if (!botChg) {  // 运行时从回显学到的 wxid / 改名比平台那份新；上一版配置钉的名字不往下带（清空 bot.name 就回到平台的）
          nextBot.robotId ||= bot.robotId;
          if (!cfg.bot.name) nextBot.name = bot.name;
        }
        pinName(nextBot, next);
      }
      nextSpace = wsChg ? openWorkspace(next) : null;
      const nextLog = nextSpace ? nextSpace.log : chg("logs.keepDays") ? P.makeLog(path.join(ws, "logs"), { keepDays: next.logs.keepDays }) : log;
      // 等 loadBot 的时候开始关闭了：放弃提交，别在收尾之后再建连接、定时器
      if (closing) { nextSpace?.unlock(); log.info("正在关闭，放弃这次配置重载"); return; }
      // 提交点：上面任何一步抛错都还没动旧状态
      if (chg("timezone") && next.timezone) process.env.TZ = next.timezone;
      if (nextBot.name !== bot.name) log.info(`机器人昵称：「${bot.name}」→「${nextBot.name}」`);
      const ocChg = nextBot.clawOpen !== bot.clawOpen || nextBot.apiSecret !== bot.apiSecret || nextBot.clawText !== bot.clawText || nextBot.clawMedia !== bot.clawMedia;
      const prevStickerSec = cfg.stickers.inboundPollSec;
      cfg = next; token = nextToken; api = nextApi; bot = nextBot; log = nextLog;
      if (nextSpace) {
        // 换 workspace：旧的落盘、放锁；出站队列挪到新 workspace（send.moveTo）
        const oldWs = ws, oldUnlock = unlock;
        mem.flush();
        ({ ws, mem, unlock } = nextSpace);
        nextSpace = null;
        sender.moveTo(oldWs);
        oldUnlock();
      } else mem.configure({ contextSize: cfg.context.size, ...cfg.memory });
      // 换了机器人、或收表情从关着到打开：已见过的表情 id 作废，重新「只记不补」（关着期间日志里攒下的不当新消息补）
      const stickersOn = cfg.stickers.inboundPollSec > 0 && prevStickerSec === 0;
      if (botChg || stickersOn) stickerFeed = P.makeStickerFeed(() => api, () => cfg);
      if (chg("stickers.inboundPollSec")) { scheduleStickers(); if (stickersOn) tickStickers(); }
      agent = P.makeAgent(cfg, log);  // 拿新的 log
      limiter.update(cfg.limits);  // 只换参数，不重置时隙
      if (connChg) connect();
      else if (ocChg) connectOpenClaw();  // 只是 OpenClaw 开关 / 凭证变了：入站不断
      if (allowChg) warmupMembers();
      if (botChg || apiChg) checkBotSwitches();
      if (botChg || apiChg || chg("health")) { scheduleHealth(); checkBotHealth(); }
      const tail = connChg ? " · 已重连" : "";
      log.info(`配置已热更新：模型 ${cfg.agent.model} · 群白名单 ${cfg.groups.allow.length} · dm ${cfg.dm.policy}${tail}`);
    } catch (e) {
      nextSpace?.unlock();
      log.error(`配置重载失败，保留旧配置：${e.message}`);
    }
  }
  if (hot) {
    fs.watchFile(configFile, { interval: CONFIG_POLL_MS }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) reloadConfig(); });
    log.info(`配置热更新已开启：监听 ${configFile}`);
  }

  // 入站
  function onMessage(msg) {
    if (closing) return;  // 入站已断；万一还有漏进来的，也别在收尾之后再排新的一轮
    if (dedupe.seen(msg.id)) return;
    if (!bot.robotId && msg.robotId) bot.robotId = msg.robotId;
    const mine = msg.isMine || (bot.robotId && msg.sender.id === bot.robotId);
    // 自己的回显带当前昵称：改了名不用重启。HTTP 发的、手机上手动发的有回显，OpenClaw 发的没有；
    // 平台自带回复的回显昵称带「(机器人)」后缀，不学；配置钉了 bot.name 也不学
    if (mine && !cfg.bot.name && isNickname(msg.sender.name) && !/\(机器人\)$/.test(msg.sender.name) && msg.sender.name !== bot.name) {
      log.info(`机器人昵称变了：「${bot.name}」→「${msg.sender.name}」`);
      bot.name = msg.sender.name;
    }
    if (msg.conv.isGroup) mem.seeRoom(msg.conv.id, msg.conv.name);  // 不在白名单的群也登记：主人要加白名单时能按名找到 id
    if (takeClaw(clawMentions, msg.id)) msg.mention = true;  // OpenClaw 转发先到、说这条 @ 了机器人

    const verdict = classify(msg, cfg, botIn(msg.conv));
    log.event("inbound", {
      id: msg.id, conv: msg.conv.id, convName: msg.conv.name, from: msg.sender.id, name: msg.sender.name,
      type: msg.type, isImage: msg.isImage, url: msg.url || undefined, mine, text: msg.text.slice(0, LOG_TEXT_CLIP),
      verdict: verdict.kind, reason: verdict.reason,
    });
    if (verdict.kind === "skip") return;
    // 成员 / 联系人、群昵称只学放行了的：黑名单、不理的群、不回的陌生人不进登记表，免得按名字找人时撞上
    if (!mine && msg.conv.isGroup) {
      learnGroupNames(msg.conv.id, msg, mem.context(msg.conv.id).recent());
      mem.seeMember(msg.conv.id, msg.sender.id, msg.sender.name);
      if (msg.mention) learnSelfAlias(msg);
    } else if (!mine) mem.seeContact(msg.sender.id, msg.sender.name);

    const ctx = mem.context(msg.conv.id);
    ctx.push({
      id: msg.id, ts: msg.ts, from: msg.sender.id, name: msg.sender.name,
      text: msg.text, type: msg.type, url: msg.url, isImage: msg.isImage, ...(msg.sticker ? { sticker: msg.sticker } : {}),
    });
    // 主人发的消息：入站就开始核对身份（见 ownerCheck），这一轮要用主人权限时等它的结果；图片趁 puppet 日志还在，异步学出可缩放地址给 save_sticker 用
    if (verdict.isOwner && !mine && !msg.trusted) ownerCheck(msg, mem);
    if (msg.isImage && verdict.isOwner && msg.type !== "表情") learnOssUrl(ctx, msg);  // 微信表情的地址是微信 CDN，入库时再搬到平台（hostImage）

    // 触发项带上当时的记忆对象：排队期间热更新换了 workspace，这一轮仍在触发消息所在的那份上下文里处理，不会读新 workspace 而看不到触发消息
    if (verdict.kind === "trigger") {
      debouncer.push(`${msg.conv.id}|${msg.sender.id}`, { msg, verdict, mem }, cfg.agent.debounceMs);
    } else if (msg.conv.isGroup && msg.type === "文字") {  // 插嘴只对纯文字：刚发的图平台重托管有延迟，抢跑读不到
      const chime = shouldChime(msg.conv.id);
      if (chime) chimeClock.set(msg.conv.id, Date.now());  // 乐观占位，防连续插嘴
      if (bot.clawText) {
        // 没认出被 @：先等 OpenClaw 转发说一声（群昵称、改了名都按 wxid 认）。要插嘴的也等这个窗口过了再插，免得被 @ 了却按「没人叫你」答
        const entry = { msg, mem };
        if (chime) entry.timer = setTimeout(() => { if (awaitingMention.get(msg.id) === entry) { awaitingMention.delete(msg.id); enqueueChime(msg, mem); } }, CLAW_MATCH_MS).unref();
        putClaw(awaitingMention, msg.id, entry);
      } else if (chime) enqueueChime(msg, mem);
    }
  }

  // 插嘴不是在回应谁，哪怕这条是主人发的：一律按非主人给工具，不带 send_message 这类跨会话能力
  function enqueueChime(msg, mem) {
    if (closing) return;
    enqueueTurn(msg.conv, [{ msg, verdict: { kind: "trigger", reason: "chime", isOwner: false }, mem }]);
  }

  // ---- OpenClaw 入站：只补两样信息，消息本身仍以原生通道为准 ----
  // 两条通道谁先到都行，按消息 id 在 CLAW_MATCH_MS 内对上；过期的顺手清掉。
  const clawMentions = new Map();    // id → 过期时间：OpenClaw 说这条 @ 了机器人，原生记录还没到
  const awaitingMention = new Map(); // id → { msg, mem, expires }：原生记录没认出被 @，等 OpenClaw 的标志
  const clawOss = new Map();         // id → { url, expires }：图片的 OSS 地址（能挂缩放参数），给 save_sticker 用
  function putClaw(map, id, value = {}) {
    const now = Date.now();
    for (const [k, v] of map) if (v.expires < now && !v.timer) map.delete(k);  // 带插嘴定时器的由定时器自己收
    map.set(id, Object.assign(value, { expires: now + CLAW_MATCH_MS }));
  }
  function takeClaw(map, id) {
    const v = map.get(id);
    map.delete(id);
    return v && v.expires >= Date.now() ? v : null;
  }
  function onClawInbound(evt) {
    if (closing) return;
    if (!bot.robotId && evt.robotId) bot.robotId = evt.robotId;
    if (evt.senderId && evt.senderId === bot.robotId) return;  // 自己发的也会转发过来
    if (evt.url) {  // 图片 / 文件转发：OSS 地址能挂缩放参数；不是 OSS 的也记一笔「到了」，学地址那边就不用干等
      const oss = isOssUrl(evt.url) ? decodedUrl(evt.url) : null;
      putClaw(clawOss, evt.id, { url: oss });
      if (oss) media.noteHost(oss);
    }
    if (!evt.mention) return;
    const waiting = takeClaw(awaitingMention, evt.id);
    if (!waiting) { putClaw(clawMentions, evt.id); return; }
    clearTimeout(waiting.timer);  // 被 @ 了：不再按插嘴处理
    if (waiting.msg.conv.id !== evt.convId || waiting.msg.sender.id !== evt.senderId) return;  // id 对上了会话 / 发送者却对不上：不认
    // 原生记录先到、当时没认出被 @：补上标志重新判一次（门控顺序不变：黑名单、白名单照样先过）
    const msg = { ...waiting.msg, mention: true };
    const verdict = classify(msg, cfg, botIn(msg.conv));
    if (verdict.kind !== "trigger") return;
    learnSelfAlias(msg);  // 文本里没认出来却被 @ 了：多半是用它的群昵称叫的
    log.event("inbound", { id: msg.id, conv: msg.conv.id, convName: msg.conv.name, from: msg.sender.id, name: msg.sender.name, type: msg.type, text: msg.text.slice(0, LOG_TEXT_CLIP), verdict: verdict.kind, reason: verdict.reason, via: "openclaw" });
    debouncer.push(`${msg.conv.id}|${msg.sender.id}`, { msg, verdict, mem: waiting.mem }, cfg.agent.debounceMs);
  }

  // 同一条消息只进一次（onMessage 开头已去重），不用再防重入。OpenClaw 转发带着这张图的 OSS 地址、按消息 id 精确对应，先等它；
  // 没开媒体转发或等不到，再去翻 puppet 日志按文件名猜（日志只有最后 1000 行，忙起来会滚没）
  async function learnOssUrl(ctx, msg) {
    try {
      const deadline = Date.now() + (bot.clawMedia ? CLAW_OSS_WAIT_MS : 0);
      let hit = takeClaw(clawOss, msg.id);
      while (!hit && Date.now() < deadline && !closing) { await sleep(200); hit = takeClaw(clawOss, msg.id); }
      const oss = hit?.url || await P.findOssUrl(api, cfg, msg.url);  // 转发到了但不是 OSS 地址，也去日志里找
      if (oss) { ctx.update(msg.id, { ossUrl: oss }); media.noteHost(oss); }
      else log.warn(`图片 ${msg.id} 没找到可缩放地址，入库表情将存原图`);
    } catch (e) { log.warn(`学习图片可缩放地址失败：${e.message}`); }
  }

  // 处理一轮。这一轮所有日志（工具、投递、告警）都经 tlog 走，自动带 conv 和 turn（触发消息 id）——多群并发时能按 turn 把一轮串起来。
  // t 是 enqueueTurn 的登记项：退出时到时限还没处理完会被作废（t.abandoned），作废后答完了也不再发
  async function handle(conv, batch, t = { abandoned: false }) {
    const { msg: last, verdict } = batch[batch.length - 1];
    const mem = batch[batch.length - 1].mem || memNow();
    const sender = last.sender;
    let isOwner = verdict.isOwner === true;
    const direct = batch.some((b) => DIRECT.has(b.verdict.reason));
    const turn = last.id;
    const tlog = log.with({ conv: conv.id, convName: conv.name, turn });
    const drop = (reason) => tlog.event("dropped", { from: sender.id, reason });

    if (limiter.isStale(last.receivedAt ?? last.ts)) return drop("stale");
    const quiet = limiter.quietGate({ direct });
    if (quiet) return drop(quiet);

    if (isOwner) {  // 批里每条「主人消息」都得核对通过，有一条对不上就整轮按非主人处理
      const checks = await Promise.all(batch.filter((b) => b.verdict.isOwner && !b.msg.trusted).map((b) => ownerCheck(b.msg, b.mem || mem)));
      if (checks.includes(false)) { isOwner = false; tlog.warn("主人身份核对没通过，这轮按非主人处理"); }
    }

    const ctx = mem.context(conv.id);
    const recent = ctx.recent();
    const names = groupNames(conv, recent, mem);  // 微信昵称、群昵称都能对上人；@ 出去显示群里大家看到的名字
    const me = botIn(conv);

    // 出站统一走这里：图片 / 表情记进上下文（入站回显不带表情名、又被当自己的消息跳过，不记的话模型下一轮不知道自己刚发过什么）；
    // 群文字抽出 @ 提及交给出站队列按通道渲染。返回实际显示的文本（供上下文与日志）
    let imageSends = 0;  // 工具里发出的图 / 表情数：群里限量，日志里与文字回复分开记
    // 群里一轮几张图：有人直接叫它、明说要多发（「都发出来」「发三张」）才放宽；插嘴那种不算他在要
    const imageCap = groupImageCap(cfg.limits, batch.some((b) => DIRECT.has(b.verdict.reason) && asksForManyImages(b.msg.text)));
    let textSends = 0;   // 本轮已发的文字条数：say 工具发的和最后的回复共用 limits.split.maxParts
    const said = [];     // say 发出的原文：最后的回复要是原样重复，就不再发
    const atNames = [];  // 本轮真 @ 到的人（按发出顺序），落进 outbound 事件：「@ 没生效」时一眼看出是模型没写还是没对上
    const meta = { turn, log: tlog };  // 出站任务带上本轮的日志器：投递发生在出队之后，靠它把 sent 事件挂回这一轮
    const deliverTurn = (c, messages, mentions = []) => { if (!t.abandoned) deliver(c, messages, mentions, meta); };  // 退出时被作废的轮不再入队
    const send = (messages, { sticker } = {}) => {
      const image = messages.find((x) => x.type === 10);
      if (image) {
        if (conv.isGroup && imageCap > 0 && imageSends >= imageCap) throw new Error(`这一轮已经发过 ${imageSends} 张图 / 表情，群里一次回复最多 ${imageCap} 张；剩下的用文字说`);
        imageSends++;
        // 外站图先搬到平台托管再入队：在本轮自己的流程里等（工具调用本来就要 await），不堵全局出站队列；本轮后面的文字排在它后面，顺序不乱
        return (async () => {
          const out = await media.rehost(messages, tlog);
          deliverTurn(conv, out);
          const entry = ownEntry(bot, { text: "", url: out.find((x) => x.type === 10).url, isImage: true, sticker });
          ctx.push(entry);
          return imageLabel(entry);
        })();
      }
      if (!conv.isGroup) { deliverTurn(conv, messages); return messages.map((m) => m.content).join("\n"); }
      const { rest, mentions: written, unknown } = extractMentions(messages.map((m) => m.content || "").join("\n"), names.index, { display: names.display, strict: names.strict });
      const mentions = [...(messages[0].mentionBack ? [messages[0].mentionBack] : []), ...written];
      if (unknown.length) tlog.warn(`回复里的 ${unknown.map((n) => `@${n}`).join(" ")} 没对上人（成员表和最近记录里都没有这个昵称），按纯文字发`);
      atNames.push(...mentions.map((m) => m.name));
      deliverTurn(conv, [{ type: 1, content: rest }], mentions);
      return mentionPrefix(mentions) + rest;
    };

    // 发一段文字：先分条（--- 主动分 + 超长自动拆），本轮第一条给触发者补 @，记进上下文、算开过口。budget 是这次最多能发几条
    const sendText = (text, budget) => {
      const parts = splitText(text, { maxChars: cfg.limits.split.maxChars, maxParts: budget });
      // 补 @ 回触发者：给结构化的 { name, wxid }，跟模型写的 @ 一起交给平台，不拼成文本再解析（群昵称撞名时会 @ 错人）
      const back = parts.length && textSends === 0
        ? mentionBack(text, { mb: cfg.groups.mentionBack, isGroup: conv.isGroup, reason: verdict.reason, sender, recent, nameToWxid: names.index, display: names.display, strict: names.strict })
        : null;
      const mentionedBack = !!back;
      const mark = atNames.length;
      const shown = parts.map((part, i) => send([{ type: 1, content: part, ...(i === 0 && back ? { mentionBack: back } : {}) }])).join("\n");
      textSends += parts.length;
      if (parts.length) {
        ctx.push(ownEntry(bot, { text: shown }));
        if (conv.isGroup) chimeClock.set(conv.id, Date.now());
      }
      return { parts, shown, mentionedBack, mentions: atNames.slice(mark) };
    };
    const say = async (text) => {
      const max = cfg.limits.split.maxParts;
      if (textSends >= max) throw new Error(`这一轮 say 已发 ${textSends} 条、配额用完了，剩下的合并进最后一条回复`);
      said.push(text);
      const { parts, shown, mentionedBack, mentions } = sendText(text, max - textSends);
      tlog.event("outbound", { to: sender.id, trigger: verdict.reason, origin: "say", parts: parts.length, mentionedBack, mentions, text: shown.slice(0, LOG_TEXT_CLIP) });
      return { parts, left: Math.max(0, max - textSends) };
    };

    const triggerText = batch.map((b) => stripMention(b.msg.text || "", me)).join("\n");  // 这一轮触发者的原话：工具据此判断主人有没有明说要做某件事
    const tools = buildTools({ cfg, bot, api, conv, sender, isOwner, mem, send, deliver: deliverTurn, recent, triggerText, say, fetchHistory: P.fetchHistory, checkStickerLinks: media.stickerLinks, hostImage: (url) => media.host(url, tlog), avatar: media.avatar });
    const system = buildSystem({ cfg, bot: me, mem, conv, isOwner, hasAvatar: media.avatar.has(), imageCap });
    const triggerIds = new Set(batch.map((b) => b.msg.id));
    // 看图：选哪张（imageSource）、怎么给（imageEncoding：base64 真给看了 / url 只给了链接）都记下来，事后能回答「这轮到底看了什么」
    let images = [], imageSource = null, imageEncoding = null;
    if (cfg.images.vision) {
      const pick = await selectImage(conv, recent, batch, mem);
      imageSource = pick.source;
      ({ images, encoding: imageEncoding } = await loadImage(pick.url, tlog));
    }
    // 触发消息提到头像就把自己的头像图另附一张（放最后，user 文本里说明是哪张）
    let avatarAttached = false;
    if (cfg.images.vision && batch.some((b) => matchesAny(b.msg.text, cfg.images.avatarPatterns))) {
      try {
        const a = await media.avatar.load();
        if (!a) tlog.warn("触发消息提到头像，但还没有头像可附");
        else if (!VISION_MEDIA_TYPES.has(a.mediaType)) tlog.warn(`头像是 ${a.mediaType}，模型不认这种格式，这轮不附`);
        else { images.push({ mediaType: a.mediaType, base64: a.base64 }); avatarAttached = true; }
      } catch (e) { tlog.warn(`头像加载失败：${e.message}`); }
    }

    const budgetTokens = contextBudget({ maxInputTokens: cfg.agent.maxInputTokens, system, imageCount: images.length, tools: toolDefs(tools) });
    const ctxStats = {};
    const userText = buildUserText({
      conv, recent, triggerIds, bot, budgetTokens, avatarAttached, stats: ctxStats,
      strip: (t) => stripMention(t, me), reason: verdict.reason, notes: mem.notes(conv.id),
      roster: names.dir.slice(0, cfg.context.rosterSize),
    });

    const t0 = Date.now();
    let result;
    try { result = await agent.run({ system, userText, images, tools, log: tlog }); }
    catch (e) {
      // 出错也要落一条 agent 事件（下面统一记），不然这一轮在日志里就只剩一个 inbound、像凭空消失
      tlog.error(`模型调用失败：${e.message}`);
      result = { text: null, reason: "error", error: e.message };
    }
    if (t.abandoned) return;  // 退出时到点没答完、已记 dropped: shutdown：答出来也不发了，免得证据链前后矛盾
    const toolSends = imageSends + textSends;  // 工具里已发出去的条数（图 + say 的文字）
    const failed = result.text == null;  // 拒答 / 轮数用尽 / 出错时 text 为 null，与模型主动 NO_REPLY 区分
    // 和 say / send_message 同一套清洗（prompt.cleanReply）：整段 NO_REPLY 就不发；正文后面夹了 NO_REPLY（多半是漏出的思考标记带的）就去掉标记、正文照发
    const raw = (result.text || "").trim();
    const cleaned = failed ? { text: "", noReply: false } : cleanReply(raw);
    let text = cleaned.text;
    const noReply = !failed && cleaned.noReply;
    if (!failed && !noReply && text !== raw) tlog.warn("模型在正文里夹了 NO_REPLY / 思考标记，已去掉只发正文");
    tlog.event("agent", {
      from: sender.id, trigger: verdict.reason, triggers: batch.length, ms: Date.now() - t0,
      reason: result.reason, category: result.category, error: result.error, usage: result.usage, turns: result.turns, toolCalls: result.toolCalls,
      images: images.length, imageSource, imageEncoding, avatar: avatarAttached, visionDropped: result.visionDropped || false,
      ctxKept: ctxStats.kept, ctxOmitted: ctxStats.omitted, notes: ctxStats.notes, notesOmitted: ctxStats.notesOmitted || undefined,
      textLen: text.length, noReply, failed, toolSends, imageCap: conv.isGroup && imageCap !== cfg.limits.groupImagesPerTurn ? imageCap : undefined,
    });
    if (conv.isGroup && toolSends) chimeClock.set(conv.id, Date.now());  // 发了表情也算开过口
    if (noReply) return;
    // 没答出来：群里沉默；私聊按 dm.fallback 给一句兜底——但这一轮已经用工具发过东西（表情、say）就不补，发完表情再来一句「没接上」反而怪
    if (failed && (conv.isGroup || !cfg.dm.fallback || toolSends)) return;
    if (!failed && said.includes(text)) return drop("repeat-of-say");  // 用 say 发过又原样回一遍

    // 最后的回复至少能发一条（say 把配额用完也不丢答案），其余按剩余配额分条
    const { parts, shown, mentionedBack, mentions } = sendText(failed ? cfg.dm.fallback : text, Math.max(1, cfg.limits.split.maxParts - textSends));
    tlog.event("outbound", { to: sender.id, trigger: verdict.reason, parts: parts.length, mentionedBack, mentions, fallback: failed || undefined, text: shown.slice(0, LOG_TEXT_CLIP) });
  }

  /**
   * 主人消息的身份核对。推送过来的记录不带来源校验，所以主人权限只给核对过的消息：它确实在平台历史里（id、发送者、时间戳、
   * 文字内容都对得上），而且是实时推送的（时间戳和本地收到时间差不多）。平台写库在先、推送在后，真消息此时一定查得到。
   * 入站时就发起、结果按消息 id 缓存；没通过的在上下文里标「身份未核实」，模型和存表情 / 头像的工具都不再把它当主人发的。
   */
  const ownerChecks = new Map();  // 消息 id → Promise<boolean>
  function ownerCheck(msg, memAt) {
    let p = ownerChecks.get(msg.id);
    if (!p) {
      p = verifyOwner(msg).then((ok) => { if (!ok) memAt.context(msg.conv.id).update(msg.id, { unverified: true }); return ok; });
      if (ownerChecks.size >= 500) ownerChecks.delete(ownerChecks.keys().next().value);
      ownerChecks.set(msg.id, p);
    }
    return p;
  }
  async function verifyOwner(msg) {
    const fail = (why) => { log.warn(`主人身份核对失败（${why}），消息 ${msg.id} 按非主人处理`, { conv: msg.conv.id }); return false; };
    if (Math.abs((msg.receivedAt ?? Date.now()) - msg.ts) > OWNER_MAX_SKEW_MS) return fail("时间戳和收到时间差太多，不是实时推送");
    try {
      const { rows } = await P.fetchHistory(api, cfg, msg.conv, {
        pageSize: 50, startTime: msg.ts - OWNER_CHECK_WINDOW_MS, endTime: msg.ts + OWNER_CHECK_WINDOW_MS, timeoutMs: OWNER_CHECK_TIMEOUT_MS, retries: 1,
      });
      const ok = rows.some((r) => (r.msgId || r._id) === msg.id && r.chatUserId === cfg.owner && toMillis(r.timestamp) === msg.ts
        && (msg.type !== "文字" || String(r.content ?? "") === msg.text));
      return ok || fail("平台历史里查不到这条");
    } catch (e) { return fail(e.message); }
  }

  /**
   * 选本轮相关的那张图，返回 { url, source }。source 给日志看，事后能回答「这轮看的是哪张图、为什么是它」：
   * quoted 引用了某人的图并在上下文里找到；quoted-history 引用的人上下文没有、翻历史找到；
   * quoted-latest 引用了图但作者对不上（引用块里是群昵称），退而取最新一张；latest 没引用、取窗口内别人刚发的那张。
   * 个人微信协议下引用只有「昵称：图片」文本、不带原消息 id 或 url，只能按昵称定位。
   */
  async function selectImage(conv, recent, batch, memAt = mem) {
    const pool = recent.filter(isImageMsg);
    const others = pool.filter((m) => !m.mine);
    const latest = others[others.length - 1];
    const quotedAuthor = batch.flatMap((b) => extractQuotes(b.msg.text)).find((q) => q.snippet === "图片")?.author;
    if (quotedAuthor) {
      const { index, dir } = groupNames(conv, recent, memAt);  // 引用块里多半是群昵称：先按目录换成人再找
      const authorId = index[quotedAuthor];
      const byAuthor = pool.filter((m) => (authorId ? m.from === authorId : m.name === quotedAuthor));
      if (byAuthor.length) return { url: byAuthor[byAuthor.length - 1].url, source: "quoted" };
      const fromHistory = await P.findAuthorImage(api, cfg, conv, dir.find((p) => p.wxid === authorId)?.name || quotedAuthor);  // 平台历史里只有微信昵称
      if (fromHistory) return { url: fromHistory, source: "quoted-history" };
      return latest ? { url: latest.url, source: "quoted-latest" } : { url: null, source: "quoted-none" };
    }
    return latest && recent.slice(-cfg.images.window).includes(latest) ? { url: latest.url, source: "latest" } : { url: null, source: "none" };
  }

  /** 下载转 base64；失败回退直传 url。模型不认的格式（bmp 等）不给看、记 warn。encoding 回报给调用方，日志里能区分「真的读了图」「只给了链接」「格式不支持没给」。 */
  async function loadImage(url, tlog = log) {
    if (!url) return { images: [], encoding: null };
    let d;
    try { d = await media.download(url); }
    catch (e) {
      tlog.warn(`图片下载失败，回退直传 url：${e.message}`);
      return { images: [{ url: encodedUrl(url) }], encoding: "url" };
    }
    if (!VISION_MEDIA_TYPES.has(d.mediaType)) {
      tlog.warn(`图片是 ${d.mediaType}，模型不认这种格式，这轮不给看`);
      return { images: [], encoding: "unsupported" };
    }
    return { images: [{ mediaType: d.mediaType, base64: d.base64 }], encoding: "base64" };
  }

  // 收尾，按顺序：先断入站 → 防抖里还在等的触发立刻进 lane → 等 lane 处理完（最多 LANE_DRAIN_MS，到点没完的逐条记 dropped: shutdown 并作废）
  // → 清出站队列（最多 OUTBOX_DRAIN_MS，到点停止出队、剩下的留在盘上给下一个进程）→ 关出站连接 → 落盘记忆 → 放锁。
  // close() 幂等且不退进程；收到信号才在收尾后退出。总时长上界约 LANE_DRAIN_MS + OUTBOX_DRAIN_MS + EXIT_GRACE_MS，监督进程的退出宽限要盖住它。
  // 监听要留到收尾结束再卸：--hot 下 Ctrl+C 时 worker 会先后收到 SIGINT 和监督进程转来的 SIGTERM，第二个信号只是重入 close()，不能让默认动作把进程直接杀了
  const timeout = (ms) => new Promise((r) => setTimeout(r, ms).unref());
  const close = () => (closing ||= (async () => {
    log.info(`关闭中${turns.size || debouncer.size() ? `（还有 ${turns.size + debouncer.size()} 轮没处理完，先等）` : ""}${outbox.size() ? `（出站队列还有 ${outbox.size()} 条，先发完）` : ""}`);
    clearInterval(healthTimer);
    clearInterval(stickerTimer);
    for (const v of awaitingMention.values()) clearTimeout(v.timer);  // 推迟中的插嘴不再插
    if (hot) fs.unwatchFile(configFile);
    mq?.close();  // 先断入站：不再有新触发；新 worker 要用同一个 clientId 连，也别让它等
    outbox.resume();  // 启动续发还在等 OpenClaw 的话不等了：积压和新任务现在就开始发，发不完的下面留在盘上
    debouncer.flush();
    if (turns.size) await Promise.race([lanes.idle(), timeout(LANE_DRAIN_MS)]);
    for (const t of turns) {  // 到点还没处理完的：作废，每条触发记一笔，证据链不断在 inbound
      t.abandoned = true;
      const lastId = t.batch.at(-1).msg.id;
      for (const { msg } of t.batch) log.event("dropped", { conv: t.conv.id, convName: t.conv.name, turn: lastId, id: msg.id, from: msg.sender.id, reason: "shutdown" });
    }
    await Promise.race([outbox.drain(), timeout(OUTBOX_DRAIN_MS)]);
    outbox.stop();  // 到点没发完的不再出队，留在盘上；之后迟到的入队也只落盘
    ocSender?.close();
    mem.flush();
    unlock();
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
  })());
  const onSignal = () => close().then(() => setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref());
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return { close, inbound: onMessage, reload: reloadConfig, pollStickers };
}
