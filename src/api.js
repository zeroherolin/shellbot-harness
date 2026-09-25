// ShellBot 开放接口（/aiapi/v1）直连客户端：鉴权、JSON、超时、重试、错误归一。
//   成功：{ success: true, code: 0, data, meta?: { pagination: { page, pageSize, total, hasMore } } }
//   失败：{ success: false, code: <http>, error: { type, message, retryable, suggestion } }
// 响应里的 id 类字段（id / chatId / userId …）是编码过的字符串，别拿它们当数字用；机器人 id 一律用配置里的。
import { retry, fatal, stripSlash, decodedUrl, ERR_CLIP } from "./util.js";

const RETRY_BACKOFF_MS = 400;  // 重试退避基数（× 第几次）
const SCRUB_MIN_LEN = 6;       // 这么短的 token 不打码（只会出现在测试里，打了会把正常字母都换掉）

/**
 * 出站用的平台 API token：配置里的 token，没填再取环境变量 SHELLBOT_TOKEN。
 * 不去读 shellbot-cli 存的凭证：那是全局文件，CLI 换个账号登录，harness 下次重载就悄悄换了身份。
 */
export function resolveToken(cfg) {
  const token = cfg.token || process.env.SHELLBOT_TOKEN || "";
  if (!token) throw new Error("找不到 ShellBot API token：在配置里填 token（后台「系统 token」），或设环境变量 SHELLBOT_TOKEN");
  return token;
}

/** 错误文本里出现的 token 一律打码：fetch 对非法请求头的报错会把整个头的值原样带出来。 */
const scrub = (s, token) => (String(token || "").length >= SCRUB_MIN_LEN ? String(s).split(token).join("***") : String(s));

/** 出站目标：群 room、私聊 contact。 */
export const sendTarget = (conv) => ({ id: conv.id, type: conv.isGroup ? "room" : "contact" });

/**
 * 建一个绑定 host / token 的客户端。所有方法失败都抛 Error。
 * 查询类（幂等）：网络错误 / 5xx / 429 / 平台标了 retryable 的都重试，其余 4xx 直接抛。
 * 发消息（非幂等）：只在 429 / 503 这两种「肯定没处理」的状态重试（实测平台业务层不返回这两个，只会来自前面的网关限流 / 维护）；
 * 5xx / 超时 / 连接错误时后端可能已经收下转给 puppet，重发就是重复进群，直接抛。
 * net：sendTimeoutMs（发消息）、apiTimeoutMs（查询）、sendRetries（重试次数）。log 可选：重试（哪怕最后成功）也留痕，抖动才有据可查。
 */
export function makeApi({ host, token, net, log }) {
  // 含换行 / 控制字符的 token 放进请求头，fetch 会抛错并把整个头（含 token）写进错误信息；先在这里拦下，报错里不带 token
  if (/[\x00-\x1f\x7f]/.test(String(token ?? ""))) throw new Error("ShellBot API token 里有换行或控制字符（多半是复制时带进来的），检查配置里的 token 或环境变量 SHELLBOT_TOKEN");
  const root = stripSlash(host);
  const base = `${root}/aiapi/v1`;
  const headers = { accept: "application/json", authorization: `Token ${token}` };

  async function call(method, p, { query, body, timeoutMs = net.apiTimeoutMs, retries = net.sendRetries, idempotent = true } = {}) {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString() : "";
    const url = `${base}${p}${qs ? `?${qs}` : ""}`;
    return retry(async () => {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: body ? { ...headers, "content-type": "application/json" } : headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const msg = scrub(e.message, token);
        if (idempotent) throw Object.assign(new Error(msg), { name: e.name });
        throw fatal(`${method} ${p} 失败：${msg}（结果未知，不重发）`);
      }
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success === true) return { data: json.data, meta: json.meta };
      const err = json?.error || {};
      const msg = scrub(`${method} ${p} 失败 HTTP ${res.status}${err.type ? ` ${err.type}` : ""}: ${err.message || String(JSON.stringify(json)).slice(0, ERR_CLIP)}`, token);
      const transient = idempotent
        ? res.status >= 500 || res.status === 429 || err.retryable === true
        : res.status === 429 || res.status === 503;
      throw transient ? new Error(msg) : fatal(msg);
    }, { retries, delay: (n) => RETRY_BACKOFF_MS * n, onRetry: (e, n) => log?.warn(`平台接口重试（第 ${n} 次）：${e.message.slice(0, ERR_CLIP)}`) });
  }
  const list = async (p, query, opts = {}) => {
    const { data, meta } = await call("GET", p, { query, ...opts });
    return { rows: Array.isArray(data) ? data : [], pagination: meta?.pagination || null };
  };
  const one = (method, p, opts) => call(method, p, opts).then((r) => r.data);

  return {
    /** 机器人详情：整行配置，含 apiSecret、clawConfig、recordConfig。 */
    bot: (id) => one("GET", `/bots/${id}`),
    status: (id) => one("GET", `/bots/${id}/status`),
    /** puppet 进程日志：平台固定给最后 1000 行（字符串数组），不认行数参数。 */
    logs: (id) => one("GET", `/bots/${id}/logs`),
    /** 平台历史，最新在前。startTime / endTime 是秒（与记录的 timestamp 同单位）；platform.fetchHistory 负责从毫秒换算。opts 可改 timeoutMs / retries。 */
    history: (id, { type, wxid, page = 1, pageSize = 20, startTime, endTime }, opts) => list(`/bots/${id}/history`, { type, wxid, page, pageSize, startTime, endTime }, opts),
    conversations: (id, { type, page = 1, pageSize = 20 } = {}) => list(`/bots/${id}/history/conversations`, { type, page, pageSize }),
    /** 群 / 联系人来自平台数据库快照：puppet 登录和 syncContacts 时才补新的，群改名、退群不会更新，可能落后于实际。 */
    rooms: (id, { keyword, page = 1, pageSize = 20 } = {}) => list(`/bots/${id}/rooms`, { keyword, page, pageSize }),
    room: (id, wxid) => one("GET", `/bots/${id}/rooms/${encodeURIComponent(wxid)}`),
    contacts: (id, { keyword, page = 1, pageSize = 20 } = {}) => list(`/bots/${id}/contacts`, { keyword, page, pageSize }),
    contact: (id, wxid) => one("GET", `/bots/${id}/contacts/${encodeURIComponent(wxid)}`),
    schedules: (id, { page = 1, pageSize = 20 } = {}) => list(`/bots/${id}/schedules`, { page, pageSize }),
    /**
     * 让 puppet 重新同步好友和群表（异步，十几秒到几十秒后回写）。走通用事件接口并带 target:"system"：
     * 实测专门的 /sync-contacts 不生效（同步不会发生），这样发才会。
     */
    syncContacts: (id) => one("POST", `/bots/${id}/event`, { body: { event: "async", data: { target: "system" } } }),
    /**
     * 发消息：{ type:1, content } 文字、{ type:10, url } 图片。图片 url 传原文，puppet 发送前会再 encodeURI 一次。
     * 成功只表示服务端已受理并转给 puppet；投递失败没有回执，而且不管发没发出去，历史里都会记一条。
     * 机器人离线是 409 DEVICE_OFFLINE、不重试；非幂等，只在 429 / 503 重试。
     */
    send: (id, target, messages) => one("POST", `/bots/${id}/messages/send`, {
      body: { target, messages: messages.map((m) => (m.type === 10 && m.url ? { ...m, url: decodedUrl(m.url) } : m)) },
      timeoutMs: net.sendTimeoutMs,
      idempotent: false,
    }),
    /**
     * 上传文件到平台自己的托管（puppet 上报聊天文件用的同一个接口 /api/v1/client/chat/upload，用机器人的 apiSecret 鉴权），
     * 返回可直接发送的 url。信封是 { code: 0, message, data: { path } }。
     */
    async upload({ apiSecret, buffer, filename, mediaType }) {
      const form = new FormData();
      form.append("apiSecret", apiSecret);
      form.append("file", new Blob([buffer], { type: mediaType }), filename);
      const res = await fetch(`${root}/api/v1/client/chat/upload`, { method: "POST", body: form, signal: AbortSignal.timeout(net.sendTimeoutMs) });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.code !== 0 || !json?.data?.path) throw new Error(`上传失败 HTTP ${res.status}: ${json?.message || String(JSON.stringify(json)).slice(0, ERR_CLIP)}`);
      return json.data.path;
    },
  };
}
