// 图片与头像：下载（公网校验）、搬到平台托管、机器人自己的头像。harness 建一个实例，工具和出站都经它。
// 依赖都是「活」的：cfg / api / bot / mem / log 用取值函数传进来，热更新换了配置、凭证、workspace 也跟着换。
import fs from "node:fs";
import { isPlatformUrl } from "./platform.js";
import { isOssUrl } from "./puppet-log.js";
import { decodedUrl, encodedUrl, stripSlash } from "./util.js";

const REHOST_RETRIES = 1;  // 外站图搬运的下载重试次数：搬不动就按原地址发，不值得为它多等

/**
 * get() 返回当前的 { cfg, api, bot, mem, log }；fetchImageData / checkStickers 可注入（测试用假的）。
 * 「已托管」的主机：平台域名（活读配置），加上从可信来源学到的——上传结果、OSS 地址（puppet 日志 / OpenClaw 转发）、图库里 OSS 形态的地址。
 * 入站图片不用学：平台记的都是上传目录形态，isPlatformUrl 按路径就认得。不写死任何域名，换一套平台部署也照样认得。
 */
export function makeMedia(get, { fetchImageData, checkStickers }) {
  const hostedHosts = new Set();
  const noteHost = (url) => { try { hostedHosts.add(new URL(url).hostname); } catch {} };
  const platformHosts = () => { try { return [new URL(get().cfg.host).hostname]; } catch { return []; } };
  const isHosted = (url) => isPlatformUrl(url, new Set([...hostedHosts, ...platformHosts()]));
  for (const s of get().mem.stickers()) if (isOssUrl(s.url)) noteHost(s.url);

  /** 下载图片。平台自己的主机名豁免私网校验：自建平台部署在内网时，平台托管的图照样能下。 */
  const download = (url, { retries } = {}) => {
    const { downloadTimeoutMs: timeoutMs, maxBytes, downloadRetries } = get().cfg.images;
    return fetchImageData(encodedUrl(url), { timeoutMs, maxBytes, retries: retries ?? downloadRetries, trustedHosts: platformHosts() });
  };

  /** 把一张图搬到平台托管，返回平台地址；已托管的原样返回。失败抛错（调用方决定回退还是放弃）。 */
  async function host(url, log = get().log) {
    if (isHosted(url)) return decodedUrl(url);
    const { api, bot } = get();
    if (!bot.apiSecret) throw new Error("拿不到 apiSecret，没法上传到平台");
    const d = await download(url, { retries: REHOST_RETRIES });
    const hosted = await api.upload({ apiSecret: bot.apiSecret, buffer: d.buffer, filename: `harness_${Date.now()}.${ext(d.mediaType)}`, mediaType: d.mediaType });
    noteHost(hosted);
    log.info(`图片已搬到平台托管：${url.slice(0, 80)} → ${hosted}`);
    return hosted;
  }

  /**
   * 发图前把外站图搬到平台：puppet 是自己去拉 url，海外 / 临时图床超时就静默丢图、还照样回执成功。
   * 已托管的原样发；搬不动就按原地址发、记日志。由本轮的 send 在入队前调用，不占全局出站队列。
   */
  async function rehost(messages, log = get().log) {
    const { cfg, bot } = get();
    if (!cfg.images.rehost || !bot.apiSecret) return messages;
    return Promise.all(messages.map(async (m) => {
      if (m.type !== 10 || !m.url || isHosted(m.url)) return m;
      try { return { ...m, url: await host(m.url, log) }; }
      catch (e) { log.warn(`图片搬运失败，按原地址发：${e.message}`); return m; }
    }));
  }

  const stickerLinks = (list) => checkStickers(list, { timeoutMs: get().cfg.images.downloadTimeoutMs, trustedHosts: platformHosts() });

  // 机器人自己的头像：workspace/avatar.* 优先（主人放的或 save_avatar 存的），没有就用 puppet 登录时传到平台的那张（/uploads 路径拼 host 可访问）。
  // 有人问起头像时把图附给模型；要发头像时本地文件先上传到平台托管拿 url（缓存在 avatar.json，文件换了重传），平台头像本身就有 url
  let platformAvatar = null;  // 平台头像的下载缓存 { key, url, mediaType, base64, buffer }，bot 或地址换了就作废
  async function loadAvatar() {
    const { cfg, bot, mem } = get();
    const local = mem.avatar();
    if (local) {
      const buffer = fs.readFileSync(local.file);
      return { mediaType: local.mediaType, base64: buffer.toString("base64"), buffer, key: local.key, url: mem.avatarUrl(local.key) };
    }
    if (!bot.avatar) return null;
    const url = /^https?:\/\//.test(bot.avatar) ? bot.avatar : `${stripSlash(cfg.host)}${bot.avatar}`;
    const key = `${bot.id}|${url}`;
    if (platformAvatar?.key !== key) {
      const d = await download(url);
      platformAvatar = { key, url, mediaType: d.mediaType, base64: d.base64, buffer: d.buffer };
    }
    return { ...platformAvatar, key: `platform:${key}` };
  }
  const avatar = {
    has: () => !!(get().mem.avatar() || get().bot.avatar),
    load: loadAvatar,
    /** 可发送的头像 url：平台头像本身就是；本地文件上传一次拿 url 并缓存。 */
    async url() {
      const a = await loadAvatar();
      if (!a) throw new Error("还没有头像（主人还没给我存）");
      if (a.url) return a.url;
      const { api, bot, mem, log } = get();
      if (!bot.apiSecret) throw new Error("发不了头像：拿不到 apiSecret，没法把本地头像传到平台");
      const url = await api.upload({ apiSecret: bot.apiSecret, buffer: a.buffer, filename: `avatar_${bot.id}_${a.key}.${ext(a.mediaType)}`, mediaType: a.mediaType });
      mem.setAvatarUrl(a.key, url);
      log.info(`头像已上传到平台托管：${url}`);
      return url;
    },
    /** 从一张图的 url 下载存成本地头像；源图已在平台托管的话直接记下可发送地址，省一次上传。 */
    async saveFromUrl(url) {
      const d = await download(url);
      const saved = get().mem.saveAvatar(d.buffer, d.mediaType);
      if (isHosted(url)) get().mem.setAvatarUrl(saved.key, decodedUrl(url));
      return saved;
    },
  };

  return { download, host, rehost, noteHost, stickerLinks, avatar };
}

const ext = (mediaType) => mediaType.split("/")[1].replace("jpeg", "jpg");
