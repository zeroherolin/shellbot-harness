// 下载图片：只拉公网地址（地址可能来自群成员）、跳转每跳都校验、按字节数封顶、按魔数识别类型。也用来探测表情包链接还能不能打开。
// 和平台无关，只依赖 fetch 与 DNS。
import dns from "node:dns/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";
import { retry, fatal, encodedUrl } from "./util.js";

const IMAGE_BACKOFF_MS = 700;   // 下载重试退避基数（× 第几次）
const IMAGE_MAX_REDIRECTS = 3;  // 最多跟几次跳转（每跳都重新校验地址）

/** 模型能看的图片格式（Anthropic 只收这四种，bmp 等会整条 400）。其余格式照样能发，只是不给模型看。 */
export const VISION_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * 下载图片，返回 { mediaType, buffer, base64, bytes }。自己拉而不让模型侧拉，规避 URL 刚发未就绪、部分中转不认 url 图片源两个坑。
 * 带重试等平台重托管就绪；过大、不是图、地址不允许都直接放弃（fatal），上层回退直传 url 或按原地址发。
 * url 可能来自群成员（send_image），所以：只拉公网地址，跳转手动跟、每跳都重新校验，防止借 bot 的机器去探内网 / 本机端口；
 * 大小先看 content-length、读的时候再按字节数卡，超了立刻中止，不先整个读进内存。
 * trustedHosts：自建平台在内网时，把平台域名放进来豁免私网校验。allowPrivate 只给测试用。
 * 残余风险：校验和真正连接之间 DNS 可能被换（rebinding），这里不做 IP 钉死。
 */
export function fetchImageData(url, { timeoutMs, maxBytes, retries, trustedHosts = [], allowPrivate = false }) {
  return retry(async () => {
    const { res, finalUrl: current } = await fetchPublic(url, { signal: AbortSignal.timeout(timeoutMs), trustedHosts, allowPrivate });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`); }  // 不读 body 连接会挂到 GC
    const declared = Number(res.headers.get("content-length"));
    if (declared > maxBytes) { await res.body?.cancel().catch(() => {}); throw fatal(`图片过大（${(declared / 1e6).toFixed(1)}MB）`); }
    const buf = await readCapped(res, maxBytes);
    if (!buf.length) throw new Error("空响应");
    const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    let mediaType = sniffImageType(buf);
    if (!mediaType) {
      if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") throw fatal(`不是图片（${contentType}）`);  // 错误页、登录页
      mediaType = headerImageType(contentType) || extImageType(current);
    }
    if (!mediaType) throw fatal("不是图片");
    return { mediaType, buffer: buf, base64: buf.toString("base64"), bytes: buf.length };
  }, { retries, delay: (n) => IMAGE_BACKOFF_MS * n });
}

/** GET 一个公网地址：跳转手动跟，每一跳都先校验地址（assertPublicUrl），最多 IMAGE_MAX_REDIRECTS 跳。返回 { res, finalUrl }。 */
async function fetchPublic(url, { signal, trustedHosts = [], allowPrivate = false }) {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current, { trustedHosts, allowPrivate });
    const res = await fetch(current, { redirect: "manual", signal });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return { res, finalUrl: current };
    await res.body?.cancel().catch(() => {});
    if (hop >= IMAGE_MAX_REDIRECTS) throw fatal(`跳转超过 ${IMAGE_MAX_REDIRECTS} 次`);
    try { current = new URL(location, current).href; } catch { throw fatal("跳转地址无效"); }
  }
}

/** 边读边数字节，超过 maxBytes 立刻中止。 */
async function readCapped(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw fatal(`图片过大（超过 ${(maxBytes / 1e6).toFixed(1)}MB）`);  // 抛出去时迭代器会取消响应流
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 只放行 http(s) 公网地址：主机名解析出的每个地址都得是公网的（trustedHosts 里的主机名例外）。 */
async function assertPublicUrl(url, { trustedHosts, allowPrivate }) {
  let u;
  try { u = new URL(url); } catch { throw fatal("图片地址无效"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw fatal("只支持 http(s) 图片地址");
  if (allowPrivate || trustedHosts.includes(u.hostname)) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try { addrs = isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true }); }
  catch (e) { throw new Error(`解析 ${host} 失败：${e.code || e.message}`); }  // DNS 抖动可重试
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw fatal("不能下载内网 / 本机地址的图片");
}

/**
 * 回环、私网、链路本地、CGNAT、组播、保留、未指定地址（含 IPv4-mapped / NAT64 形式的 IPv6）。
 * 198.18.0.0/15 不算：Clash / Surge / sing-box 的 fake-ip 模式把所有域名都解析到这一段，算内网的话开着代理的机器一张图都下不了。
 * 代价是 fake-ip 下这层校验基本失效（真实解析在代理里做，这里看不到），只剩协议 / 跳转 / 大小那几道。
 */
export function isPrivateAddress(ip) {
  const s = String(ip).toLowerCase();
  if (isIPv4(s)) {
    const [a, b] = s.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0);
  }
  if (!isIPv6(s)) return true;  // 解析不出来的一律按不安全处理
  const v4 = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (v4) return isPrivateAddress(v4);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);  // URL 解析会把 [::ffff:127.0.0.1] 规范成 [::ffff:7f00:1]
  if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
}

/**
 * 逐张探测表情包链接还能不能打开，返回失效的 [{ name, reason }]。
 * 平台发图是 puppet 自己去拉 url，拉不到就静默丢、照样回执成功，所以失效只能主动查。只看响应头不下载正文。
 * 地址校验同 fetchImageData：内网地址算失效（reason 写明原因），trustedHosts 豁免。
 */
export async function checkStickers(list, { timeoutMs, trustedHosts = [], allowPrivate = false }) {
  const dead = [];
  await Promise.all(list.map(async (s) => {
    try {
      const { res, finalUrl } = await fetchPublic(encodedUrl(s.url), { signal: AbortSignal.timeout(timeoutMs), trustedHosts, allowPrivate });  // 和下载图片同一套地址校验
      await res.body?.cancel().catch(() => {});
      if (!res.ok) dead.push({ name: s.name, reason: `HTTP ${res.status}` });
      else if (!headerImageType(res.headers.get("content-type")) && !extImageType(finalUrl)) dead.push({ name: s.name, reason: "不是图片" });
    } catch (e) { dead.push({ name: s.name, reason: e.name === "TimeoutError" ? "超时" : e.message }); }
  }));
  return dead;
}

const MIN_SNIFF_BYTES = 12;  // 识别 WEBP 至少要看到 RIFF....WEBP

/** 按魔数识别图片类型。平台常给错 content-type、URL 又常无扩展名，魔数最可靠。 */
export function sniffImageType(buf) {
  if (buf.length < MIN_SNIFF_BYTES) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
const headerImageType = (ct) => {
  const t = String(ct || "").split(";")[0].trim().toLowerCase();
  return /^image\/(png|jpeg|gif|webp|bmp)$/.test(t) ? t : null;
};
const extImageType = (url) => {
  const ext = (String(url).split(/[?#]/)[0].match(/\.(\w+)$/)?.[1] || "").toLowerCase();
  return IMAGE_TYPES[ext] || null;
};

