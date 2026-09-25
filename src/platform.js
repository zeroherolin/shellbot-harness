// ShellBot 平台适配：机器人信息与历史、原生 MQTT 收、OpenClaw MQTT 收发（真 @）、HTTP 出站的文本雷区、哪些图算平台托管。
// 图片下载在 fetch-image.js，puppet 日志里扒的东西（微信表情、图片 OSS 地址）在 puppet-log.js。
// 三条通道为什么这样分，见 README「怎么工作」；平台行为的结论写在各段注释里。
import mqtt from "mqtt";
import { sleep, isImageMsg, isTrue, toMillis, stripSlash, ERR_CLIP, HISTORY_PAGE_MAX } from "./util.js";

const BACKOFF_MAX_EXP = 10;        // 重连退避指数封顶
const TLS_FALLBACK_AFTER = 3;      // TLS 连续这么多次没连上就试一次明文（明文也不通就回到 TLS；明文那条断开后下次仍先试 TLS）
const QUICK_DROP_MS = 10_000;      // 连上不到这么久就被断开，算「被踢」：不清零退避
const QUICK_DROP_WARN = 3;         // 连续被踢这么多次提示一次 clientId 冲突

// ---- 机器人 ----

/**
 * 机器人基本信息（GET /bots/:id）。
 * name 取微信昵称（puppet 登录时回写的 name），不取后台起的别名 accountName：@ 判定靠的是微信里显示的名字。
 * robotId 登录成功后才有，之前是 null（运行时也从入站消息学）；apiSecret 是 OpenClaw 与上传的凭证。
 * avatar 是 puppet 登录时传到平台的头像路径（/uploads/… 相对路径，拼上 host 就能访问）。
 * clawOpen：平台只在 clawConfig.open 时接收 OpenClaw sendTopic 上的消息，没开就算发了也没人收。
 * clawText / clawMedia：OpenClaw 入站（reciveTopic）推不推文字 / 媒体消息——要开着、配了范围组 userGroupId，
 * 再分别开 forwardAllMsg / forwardMediaMsg。没配范围组就一条都不推（clawGroup 为假），两个转发开关开着也没用。
 * recordOpen：recordConfig 为空或 open 为真时平台才写历史、推原生 MQTT；「聊天记录范围」选了什么都不影响，只有明确关掉才收不到。
 */
export async function loadBot(api, botId) {
  const b = await api.bot(botId);
  if (!b || typeof b !== "object") throw new Error(`读取 bot ${botId} 失败`);
  const claw = b.clawConfig || {};
  return {
    id: botId,  // 响应里的 id 是编码过的字符串，用配置里的数字
    name: b.name || b.accountName || `bot${botId}`,
    robotId: b.robotId || null,
    apiSecret: b.apiSecret || null,
    avatar: typeof b.avatar === "string" && b.avatar ? b.avatar : null,
    clawOpen: !!claw.open,
    clawGroup: !!claw.userGroupId,
    clawText: !!(claw.open && claw.userGroupId && claw.forwardAllMsg),
    clawMedia: !!(claw.open && claw.userGroupId && claw.forwardMediaMsg),
    recordOpen: !b.recordConfig || !!b.recordConfig.open,
  };
}

/**
 * 平台历史，按时间倒序（最新在前）。返回 { rows, pagination }。
 * startTime / endTime 调用方给毫秒，这里换成平台要的秒：记录的 timestamp 是秒，传毫秒什么都筛不出来。
 */
export async function fetchHistory(api, cfg, target, { page = 1, pageSize = cfg.history.defaultCount, startTime, endTime, timeoutMs, retries } = {}) {
  const sec = (ms) => (Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined);
  return api.history(cfg.bot.id, {
    type: target.isGroup ? "room" : "contact", wxid: target.id,
    page, pageSize: Math.min(pageSize, HISTORY_PAGE_MAX), startTime: sec(startTime), endTime: sec(endTime),
  }, { timeoutMs, retries });
}

/** 从平台历史找某人最近一张图。个人微信协议下引用图片只有「昵称：图片」文本、没有原消息 id 或 url，只能按昵称匹配；最多翻 history.quotedImageDepth 条。 */
export async function findAuthorImage(api, cfg, conv, author) {
  const pageSize = HISTORY_PAGE_MAX;
  const pages = Math.max(1, Math.ceil(cfg.history.quotedImageDepth / pageSize));
  for (let page = 1; page <= pages; page++) {
    let rows;
    try { ({ rows } = await fetchHistory(api, cfg, conv, { page, pageSize })); } catch { return null; }
    if (!rows.length) break;
    for (const r of rows) if (isImageMsg(r) && String(r.chatUserName).trim() === author) return r.url;
  }
  return null;
}

// ---- 入站（原生 MQTT） ----

/**
 * 拉原生 MQTT broker。platformInfo 面向浏览器给 wss:// 地址，Node 走底层 MQTT。
 * 优先 TLS：平台用的百度 IoT 在 1884 提供 mqtts（实测入站与 OpenClaw 两个 broker 都通），明文 1883 只作退路（plainUrl），
 * 否则全部群聊私聊内容都以明文过公网。其他 broker 不认得就照原样用。
 */
export async function fetchBroker(host, { timeoutMs }) {
  const endpoint = `${stripSlash(host)}/api/v1/platformInfo`;
  const res = await fetch(endpoint, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`获取 platformInfo 失败 HTTP ${res.status}: ${(await res.text()).slice(0, ERR_CLIP)}`);
  const mqInfo = (await res.json())?.data?.mqInfo;
  if (!mqInfo) throw new Error("platformInfo 响应缺少 data.mqInfo");
  let info;
  try { info = JSON.parse(Buffer.from(mqInfo, "base64").toString("utf8")); } catch { throw new Error("mqInfo 不是有效的 base64 JSON"); }
  for (const k of ["host", "name", "password"]) if (!info[k]) throw new Error(`mqInfo 缺少字段 ${k}`);
  const u = new URL(info.host);
  const plainUrl = u.protocol === "ws:" || u.protocol === "wss:" ? `mqtt://${u.hostname}:${u.port || "1883"}` : info.host;
  return { url: tlsUrl(plainUrl), plainUrl, username: info.name, password: info.password };
}

/** 已知支持 TLS 的 broker（百度 IoT：明文 1883 ↔ TLS 1884）换成 mqtts；不认得的原样返回。 */
export function tlsUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "mqtt:" && /\.iot\.[a-z0-9-]+\.baidubce\.com$/.test(u.hostname) && (u.port || "1883") === "1883") return `mqtts://${u.hostname}:1884`;
  } catch {}
  return url;
}

/**
 * 聊天记录（MQTT 推送或历史接口的一行）是不是机器人自己发的：看 isRobotAnswer（发送者就是机器人时为真），
 * 手机上手动发的、HTTP 发的都算；载荷里没带 robotId 时用运行时学到的兜底。
 */
export const isOwnRecord = (r, botRobotId = null) =>
  isTrue(r.isRobotAnswer) || (!!r.robotId && r.chatUserId === r.robotId) || (!!botRobotId && r.chatUserId === botRobotId);

/**
 * 聊天记录（MQTT 推送的一行）→ 内部消息。解析失败或 topic 与载荷不一致返回 null。
 * 平台每写一条历史就原样推到 chat/<botId>/<conversationId>：
 * 文字的 content 是原文（@ 文本保留，引用是「昵称：原文」+ 分隔线的文本形式）；图片 / 文件 content 与 url 都是平台上传后的地址、fileName 另给；
 * h5 卡片 content 只是链接，标题在 title / description 里。没有「是否被 @」标志，@ 判定由 gate.js 从文本做。
 */
export function normalizeInbound(topic, raw, botId) {
  let r;
  try { r = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString("utf8")); } catch { return null; }
  if (!r || typeof r !== "object") return null;
  if (typeof r.conversationId !== "string" || typeof r.chatUserId !== "string") return null;
  const prefix = `chat/${botId}/`;
  if (typeof topic === "string" && topic.startsWith(prefix)) {
    const convFromTopic = topic.slice(prefix.length);
    if (convFromTopic && convFromTopic !== r.conversationId) return null;
  }
  const isGroup = r.recordType === "room";
  const ts = toMillis(r.timestamp);
  const receivedAt = Date.now();
  const url = typeof r.url === "string" && /^https?:\/\//.test(r.url) ? r.url : null;
  const isImage = isTrue(r.isImage) && !!url;  // 微信图片以「文件」类型进来，靠 isImage 判定
  const type = typeof r.contentType === "string" ? r.contentType : "文字";
  let text = typeof r.content === "string" ? r.content : "";
  if (type === "h5卡片" && r.title) text = `${r.title}${r.description ? `｜${r.description}` : ""}`;
  else if (type === "文件" && !isImage && r.fileName && text === url) text = r.fileName;
  return {
    id: r.msgId || r._id || `${r.chatUserId}-${ts}`,
    ts,
    receivedAt,  // 排队超时按本地收到时间算，不受平台时钟偏差影响
    type,
    text,
    url,
    isImage,
    robotId: typeof r.robotId === "string" ? r.robotId : null,
    isMine: isOwnRecord(r),
    sender: { id: r.chatUserId, name: r.chatUserName || r.chatUserId },
    isGroup,
    mention: false,  // 原生通道不带 @ 标志，触发判定由 gate.js 从文本做
    conv: {
      id: r.conversationId,
      name: r.conversationName || r.roomName || (isGroup ? r.conversationId : r.chatUserName || r.chatUserId),
      isGroup,
    },
  };
}

/**
 * 常驻 MQTT 连接循环，入站 / 出站共用。每次连接前重新 resolve 参数（凭证会换），断线指数退避重连。
 * resolve() 返回 { url, fallbackUrl?, options, onConnect?, onMessage?, onClose? }；本函数返回 { current(), close() }。
 * fallbackUrl：url（TLS）连续 TLS_FALLBACK_AFTER 次没连上，就试一次它（明文）。明文也连不上说明是网络问题、不是 TLS 被挡，
 * 回到 TLS 继续试；明文连上了，这条连接断开后下次仍先试 TLS——不因一阵网络抖动就永久退到明文。
 * 退避只在连接撑过 QUICK_DROP_MS 后才清零：同一 clientId 另有实例在跑时两边互踢，每次都是「连上—秒断」，清零会变成几秒一次的死循环。
 */
export function mqttLoop({ label, resolve, log, net }) {
  const { reconnectBaseMs: baseDelayMs, reconnectMaxMs: maxDelayMs, mqttKeepalive, mqttConnectTimeoutMs } = net;
  let client = null, closed = false, attempt = 0;
  let failedStreak = 0, quickDrops = 0;
  const loop = async () => {
    while (!closed) {
      let conn;
      try { conn = await resolve(); }
      catch (err) {
        attempt++;
        const delay = backoff(attempt, baseDelayMs, maxDelayMs);
        log.warn(`${label} 配置获取失败：${err.message}，${Math.round(delay / 1000)}s 后重试`);
        await sleep(delay);
        continue;
      }
      if (closed) break;
      const plain = !!conn.fallbackUrl && failedStreak >= TLS_FALLBACK_AFTER;
      if (plain) log.warn(`${label} TLS（${conn.url}）连续 ${failedStreak} 次没连上，这次试明文 ${conn.fallbackUrl}`);
      const url = plain ? conn.fallbackUrl : conn.url;
      log.info(`${label} 连接 ${url}（clientId=${conn.options.clientId}）`);
      try {
        client = mqtt.connect(url, {
          clean: true, keepalive: mqttKeepalive, connectTimeout: mqttConnectTimeoutMs, reconnectPeriod: 0, ...conn.options,
        });
      } catch (err) {  // 非法 URL 等同步错误也走退避，别让循环退出
        attempt++;
        failedStreak = plain ? 0 : failedStreak + 1;
        const delay = backoff(attempt, baseDelayMs, maxDelayMs);
        log.error(`${label} 连接参数无效：${err.message}，${Math.round(delay / 1000)}s 后重试`);
        await sleep(delay);
        continue;
      }
      let connectedAt = 0;
      await new Promise((done) => {
        client.on("connect", () => { connectedAt = Date.now(); conn.onConnect?.(client); });
        if (conn.onMessage) client.on("message", conn.onMessage);
        client.on("error", (err) => log.warn(`${label} MQTT 错误：${err.message}`));
        client.on("close", () => { conn.onClose?.(); done(); });
      });
      client = null;
      if (closed) break;
      failedStreak = plain || connectedAt ? 0 : failedStreak + 1;  // 明文这次不管连没连上都回到 TLS 从头数；连上过也清零
      if (connectedAt && Date.now() - connectedAt >= QUICK_DROP_MS) { attempt = 0; quickDrops = 0; }
      else if (connectedAt && ++quickDrops === QUICK_DROP_WARN) log.warn(`${label} 连续 ${quickDrops} 次连上不到 ${QUICK_DROP_MS / 1000} 秒就被断开：多半是同一 clientId 另有实例在跑（同一个 bot 只能跑一个 harness）`);
      attempt++;
      const delay = backoff(attempt, baseDelayMs, maxDelayMs);
      log.warn(`${label} 断开，${Math.round(delay / 1000)}s 后重连`);
      await sleep(delay);
    }
  };
  loop().catch((e) => log.error(`${label} 循环异常退出：${e.stack || e}`));
  return {
    current: () => (client?.connected ? client : null),
    close() { closed = true; client?.end(true); },
  };
}

/** 入站：订阅 chat/<botId>/+，每条聊天记录规范化后交给 onMessage。onSubscribed 可选：每次订阅成功回调一次（probe 等它再发测试消息）。 */
export function startMqtt({ host, botId, clientId, onMessage, onSubscribed, log, net }) {
  const topic = `chat/${botId}/+`;
  return mqttLoop({
    label: "入站",
    log, net,
    async resolve() {
      const b = await fetchBroker(host, { timeoutMs: net.platformTimeoutMs });
      return {
        url: b.url,
        fallbackUrl: b.plainUrl !== b.url ? b.plainUrl : undefined,
        options: { clientId, username: b.username, password: b.password },
        onConnect(client) {
          client.subscribe(topic, { qos: 0 }, (err) => {
            if (err) { log.error(`订阅失败：${err.message}`); client.end(true); }
            else { log.info(`已订阅 ${topic}`); onSubscribed?.(); }
          });
        },
        onMessage(t, payload, packet) {
          if (packet?.retain) return;  // 不重放离线事件
          const msg = normalizeInbound(t, payload, botId);
          if (!msg) { log.warn(`无法解析的消息（topic ${t}）：${payload.toString().slice(0, ERR_CLIP)}`); return; }
          (async () => onMessage(msg))().catch((e) => log.error(`处理消息 ${msg.id} 出错：${e.stack || e}`));
        },
      };
    },
  });
}

// ---- 出站 ----

/** OpenClaw 频道配置（/openapi/v1/openclaw/chat/config，apiSecret 鉴权）：broker、凭证、sendTopic / reciveTopic。 */
async function fetchOpenClawConfig(host, apiSecret, { timeoutMs }) {
  const url = `${stripSlash(host)}/openapi/v1/openclaw/chat/config?apiSecret=${encodeURIComponent(apiSecret)}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`获取 OpenClaw 配置失败 HTTP ${res.status}`); }  // 重连循环里反复失败，不读 body 连接会挂到 GC
  const d = await res.json();
  for (const k of ["host", "port", "username", "password", "clientId", "sendTopic"]) if (!d[k]) throw new Error(`OpenClaw 配置缺字段 ${k}`);
  return d;
}

// 包已经写进 socket、只是没等到 PUBACK：broker 多半已收、puppet 会发，调用方不能再走 HTTP 重发
const uncertain = (m) => Object.assign(new Error(m), { uncertain: true });

/** publish 回调里的错误归类：只有 mqtt.js 明说没写出去的（client disconnecting）算失败，其余都是结果未知。 */
export const publishError = (err) => (/client disconnecting/i.test(err?.message || "") ? err : uncertain(`OpenClaw 发布中断：${err?.message || err}`));

/**
 * OpenClaw 连接。发：puppet 收到后群文字带上 mentionIds 对应的联系人一起说出去（真 @）、私聊直接说，不经 HTTP 那套文本过滤，也不写平台历史。
 * 收（可选，传 onInbound 才订阅 reciveTopic）：平台把微信消息转发过来，带按 wxid 判定的「@ 了机器人」标志和图片的 OSS 地址，
 * messageId 与原生记录的 msgId 是同一条消息。只用来补这两样信息，消息本身仍以原生通道为准。
 * clientId 必须与平台自己的转发器不同，否则会把它踢下线。和入站一样优先 TLS（这条连接的用户名密码能往 sendTopic 发消息，明文可被嗅探）。
 */
export function startOpenClawSender({ host, apiSecret, clientIdSuffix, log, net, onInbound }) {
  let sendTopic = null;
  const pending = new Set();  // 未决的 publish 拒绝器：broker 主动断线时 mqtt.js 不会回调 QoS1 的 publish，得自己拒绝
  const conn = mqttLoop({
    label: "OpenClaw",
    log, net,
    async resolve() {
      const c = await fetchOpenClawConfig(host, apiSecret, { timeoutMs: net.platformTimeoutMs });
      sendTopic = c.sendTopic;
      const plain = /^[a-z]+:\/\//.test(c.host) ? `${c.host}:${c.port}` : `mqtt://${c.host}:${c.port}`;
      const url = tlsUrl(plain);
      return {
        url,
        fallbackUrl: url !== plain ? plain : undefined,
        options: { clientId: `${c.clientId}${clientIdSuffix}`, username: c.username, password: c.password },
        onClose() { for (const reject of pending) reject(uncertain("OpenClaw 连接断开")); pending.clear(); },
        ...(onInbound && c.reciveTopic ? {
          onConnect(client) {
            client.subscribe(c.reciveTopic, { qos: 0 }, (err) => (err ? log.warn(`OpenClaw 入站订阅失败：${err.message}`) : log.info("OpenClaw 入站已订阅（补 @ 标志与图片 OSS 地址）")));
          },
          onMessage(_t, payload) {
            const evt = normalizeClawInbound(payload);
            if (evt) (async () => onInbound(evt))().catch((e) => log.error(`处理 OpenClaw 入站出错：${e.stack || e}`));
          },
        } : {}),
      };
    },
  });
  return {
    connected: () => !!conn.current(),
    /**
     * 发布并等 PUBACK。没连上、或 mqtt.js 明说没写出去（client disconnecting）是「肯定没发出去」，调用方可回退 HTTP；
     * 其余都是「结果未知」（err.uncertain），调用方别重发：超时、等 PUBACK 期间断线，以及连接被关时 mqtt.js 用
     * 「Connection closed」回调所有未决 QoS1 发布（热重连 end(true)、退出、keepalive 超时都会走到）——那时包多半已经写出去了。
     */
    publish(payload) {
      const client = conn.current();
      if (!client) return Promise.reject(new Error("OpenClaw 出站未连接"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(fail); fail(uncertain("OpenClaw 发布超时")); }, net.sendTimeoutMs);
        const fail = (e) => { clearTimeout(timer); reject(e); };
        const ok = () => { clearTimeout(timer); pending.delete(fail); resolve(); };
        pending.add(fail);
        client.publish(sendTopic, JSON.stringify(payload), { qos: 1 }, (err) => {
          if (!err) return ok();
          pending.delete(fail);
          fail(publishError(err));
        });
      });
    },
    close: conn.close,
  };
}

/**
 * OpenClaw 入站载荷 → { id, isGroup, convId, senderId, robotId, type, mention, url }；解析不了返回 null。
 * mention 只对文字可信：平台把群里的媒体消息一律标成「@ 了机器人」。@所有人 平台已经排除。
 */
export function normalizeClawInbound(raw) {
  let p;
  try { p = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); } catch { return null; }
  if (!p || typeof p !== "object" || typeof p.messageId !== "string" || !p.messageId) return null;
  const isGroup = p.isGroup === true;
  const type = typeof p.type === "string" ? p.type : "";
  return {
    id: p.messageId,
    isGroup,
    convId: isGroup ? p.groupId : p.senderId,
    senderId: typeof p.senderId === "string" ? p.senderId : null,
    robotId: typeof p.robotId === "string" ? p.robotId : null,
    type,
    mention: isGroup && type === "文字" && p.isGroupMention === true,
    url: typeof p.url === "string" && /^https?:\/\//.test(p.url) ? p.url : null,
  };
}

/** OpenClaw 出站 payload，群里 mentionIds 做真 @。 */
export function openclawOutbound(conv, messages, mentionIds = []) {
  return conv.isGroup
    ? { isGroup: true, groupId: conv.id, ...(mentionIds.length ? { mentionIds } : {}), messages }
    : { isGroup: false, contactId: conv.id, messages };
}

// ---- HTTP 出站的文本雷区 ----
// 平台 HTTP 通道发文字前会处理内容：
//   以 ReferenceError: / Run failed: / Error: 开头，或含 OpenAI error / AxiosError / FetchError / TypeError / TimeoutError / Error:
//     → 整条不发、不报错（本意是拦 AI 报错文本），历史里却照样记一条原文；
//   私聊再删掉所有 @所有人 和 all 子串：含 all 的英文（call / really / install）都被掏空；
//   群里以 @所有人 / @all 开头 → 当成 @全体发，bot 不是管理员就失败；
//   字面的「\n」（反斜杠 + n）被换成真换行。
// OpenClaw 通道没有这些处理，所以文字优先走 OpenClaw；回退 HTTP 时在这些串里塞零宽空格：显示不变、匹配失效。

const ZW = "​";
const HTTP_DROP_WORDS = ["ReferenceError:", "Run failed:", "OpenAI error", "AxiosError", "FetchError", "TypeError", "TimeoutError", "Error:"];

export function platformSafeText(text, { isGroup }) {
  let s = String(text ?? "");
  for (const w of HTTP_DROP_WORDS) if (s.includes(w)) s = s.split(w).join(w.slice(0, -1) + ZW + w.slice(-1));
  s = s.split("\\n").join(`\\${ZW}n`);
  if (!isGroup) s = s.replace(/all/g, `a${ZW}ll`).replace(/@所有人/g, `@${ZW}所有人`);
  else if (/^\s*@(所有人|all)/.test(s)) s = ZW + s;
  return s;
}

/**
 * 这张图 puppet 能不能稳稳拉到、不用先搬：主机在 hosts 里（平台域名，以及运行时从平台数据里见过的图片主机：
 * 上传结果、puppet 的 OSS 地址、图库），或是平台上传目录的形态（/uploads/<userId>/chat/… 或 bot_avatar_…）。
 * 只认这些：别人站点的 /wp-content/uploads/、别人的阿里云桶都照搬，否则 puppet 自己去拉海外地址、超时静默丢图——正是搬运要解决的情形。
 */
export function isPlatformUrl(url, hosts = new Set()) {
  try {
    const u = new URL(url);
    return hosts.has(u.hostname) || PLATFORM_UPLOADS.test(u.pathname);
  } catch { return false; }
}
const PLATFORM_UPLOADS = /^\/uploads\/\d+\/(chat\/|bot_avatar_)/;

/** 指数退避加 ±10% 抖动。 */
function backoff(attempt, base, max) {
  const d = Math.min(base * 2 ** Math.min(Math.max(0, attempt - 1), BACKOFF_MAX_EXP), max);  // 第 1 次等 base，之后翻倍
  return d * (0.9 + Math.random() * 0.2);
}
