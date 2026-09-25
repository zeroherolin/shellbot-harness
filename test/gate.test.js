import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, stripMention, extractMentions, mentionPrefix, mentionBack, memberDirectory, directoryIndex, directoryDisplay, directoryAliases, rosterLabel, learnAliases, isAliasLike, quoteMatches, matchesAny, asksForManyImages } from "../src/gate.js";

const cfg = {
  owner: "wxid_owner",
  blockedSenders: ["wxid_bad"],
  dm: { policy: "owner", allowFrom: [] },
  groups: { policy: "allowlist", allow: ["room1@chatroom"], wakePatterns: ["^helper[，,：:\\s]"], nameTrigger: true },
};
const bot = { name: "helper", robotId: "wxid_bot" };
const base = { isMine: false, sender: { id: "wxid_u", name: "u" }, isGroup: true, conv: { id: "room1@chatroom", isGroup: true }, mention: false, text: "hi" };

test("群里未 @ 只记上下文", () => assert.equal(classify(base, cfg, bot).kind, "context"));
test("协议 mention 标志触发", () => assert.equal(classify({ ...base, mention: true }, cfg, bot).reason, "mention"));
test("文本 @昵称 触发；@ 别的以昵称开头的人不算", () => {
  assert.equal(classify({ ...base, text: "@helper 在吗" }, cfg, bot).reason, "at-text");
  assert.equal(classify({ ...base, text: "@helper 在吗" }, cfg, bot).reason, "at-text");
  assert.equal(classify({ ...base, text: "@helperboy 在吗" }, cfg, bot).reason, "not-triggered");
});
test("引用机器人触发", () => assert.equal(classify({ ...base, text: "「helper：你好」\n- - -\n再说一遍" }, cfg, bot).reason, "quote"));
test("唤醒词触发（不区分大小写）", () => {
  assert.equal(classify({ ...base, text: "helper，帮我查一下" }, cfg, bot).reason, "wake");
  assert.equal(classify({ ...base, text: "Helper 在吗" }, cfg, bot).reason, "wake");
});
test("提到昵称触发：句中 / 句尾 / 贴着中文都算；连着字母不算；引用块里的不算；可关闭", () => {
  const r = (text, c = cfg) => classify({ ...base, text }, c, bot).reason;
  assert.equal(r("吃🍚吗 .cc helper"), "name");
  assert.equal(r("我要举报你了小HELPER"), "name");
  assert.equal(r("这个helper不是之前还能发表情包吗"), "name");
  assert.equal(r("你跟WorkHelper什么关系"), "not-triggered");
  assert.equal(r("「老板：@阿强 这两个功能跟进一下 .cc helper」\n- - - - - - - - - - - - - - -\nok"), "not-triggered");  // 只在被引用的那句里
  assert.equal(r("「老板：跟进一下」\n- - - - - - - - - - - - - - -\n好的 cc helper"), "name");  // 自己写的部分提到了
  assert.equal(r("「小明：\n@老王 我建议你用 helper」\n- - - - - - - - - - - - - - -"), "not-triggered");  // 引用后没正文
  assert.equal(r("吃🍚吗 .cc helper", { ...cfg, groups: { ...cfg.groups, nameTrigger: false } }), "not-triggered");
});
test("matchesAny：只看自己写的部分（引用块不算）、不区分大小写、空清单不命中", () => {
  assert.equal(matchesAny("你头像是啥", ["头像"]), true);
  assert.equal(matchesAny("「甲：看我头像」\n- - - - -\n哈哈", ["头像"]), false);
  assert.equal(matchesAny("「甲：哈哈」\n- - - - -\n你头像呢", ["头像"]), true);
  assert.equal(matchesAny("your AVATAR?", ["avatar"]), true);
  assert.equal(matchesAny("在吗", ["头像"]), false);
  assert.equal(matchesAny("头像", []), false);
  assert.equal(matchesAny(null, ["头像"]), false);
});
test("不在白名单的群跳过", () => assert.equal(classify({ ...base, conv: { id: "x@chatroom", isGroup: true } }, cfg, bot).reason, "group-not-allowed"));
test("open 策略任何群都收", () => assert.equal(classify({ ...base, conv: { id: "x@chatroom", isGroup: true } }, { ...cfg, groups: { ...cfg.groups, policy: "open" } }, bot).kind, "context"));
test("disabled 策略群全跳过", () => assert.equal(classify({ ...base, text: "@helper" }, { ...cfg, groups: { ...cfg.groups, policy: "disabled" } }, bot).reason, "groups-disabled"));
test("黑名单跳过（优先于触发）", () => assert.equal(classify({ ...base, sender: { id: "wxid_bad" }, mention: true }, cfg, bot).reason, "blocked"));
test("自己的消息跳过（isMine 或 robotId 任一）", () => {
  assert.equal(classify({ ...base, sender: { id: "wxid_bot" } }, cfg, bot).reason, "self");
  assert.equal(classify({ ...base, isMine: true }, cfg, bot).reason, "self");
});
test("私聊策略：owner / allowlist / open", () => {
  const dm = (sender, policy, allowFrom = []) => classify({ ...base, isGroup: false, sender: { id: sender }, conv: { id: sender, isGroup: false } }, { ...cfg, dm: { policy, allowFrom } }, bot);
  assert.equal(dm("wxid_u", "owner").reason, "dm-policy");
  assert.deepEqual([dm("wxid_owner", "owner").kind, dm("wxid_owner", "owner").isOwner], ["trigger", true]);
  assert.equal(dm("wxid_u", "allowlist", ["wxid_u"]).kind, "trigger");
  assert.equal(dm("wxid_v", "allowlist", ["wxid_u"]).kind, "skip");
  assert.equal(dm("wxid_v", "open").kind, "trigger");
});
test("去掉 @ 前缀（含 U+2005 空格）；别人的名字以昵称开头不动", () => {
  assert.equal(stripMention("@helper\u2005今天天气", bot), "今天天气");
  assert.equal(stripMention("@helper  今天天气", bot), "今天天气");
  assert.equal(stripMention("@helper 在吗", bot), "在吗");
  assert.equal(stripMention("@helperboy 在吗", bot), "@helperboy 在吗");
  assert.equal(stripMention("x", { name: "" }), "x");
});
test("extractMentions：开头 / 结尾成串的 @ 去掉，句中的 @ 留名字；按出现顺序；连着重复保留、隔着正文重复只算一次；mentionPrefix 还原显示形态", () => {
  const map = { 小明: "wxid_a", 小红: "wxid_b", "Amy Lee": "wxid_c", 老板: "wxid_o", 阿强: "wxid_k" };
  const ex = (t) => { const { rest, mentions } = extractMentions(t, map); return { rest, mentions }; };
  assert.deepEqual(ex("@小明 你好", { 小明: "wxid_a", 小明改名: "wxid_a" }), { rest: "你好", mentions: [{ name: "小明", wxid: "wxid_a" }] });  // 上下文里新旧名字都能对上同一人
  assert.deepEqual(extractMentions("@AB2 在", { AB: "wxid_ab" }), { rest: "@AB2 在", mentions: [], unknown: ["AB2"] });  // 字母昵称要整词匹配；没对上的报出来
  assert.deepEqual(ex("@老板 @阿强 老板说他要加班"), { rest: "老板说他要加班", mentions: [{ name: "老板", wxid: "wxid_o" }, { name: "阿强", wxid: "wxid_k" }] });  // 顺序按出现，不按长度
  assert.deepEqual(ex("@阿强，老板 让你想想"), { rest: "老板 让你想想", mentions: [{ name: "阿强", wxid: "wxid_k" }] });  // 吃掉紧跟的中文逗号
  assert.deepEqual(ex("@老板\n@阿强\n按顺序"), { rest: "按顺序", mentions: [{ name: "老板", wxid: "wxid_o" }, { name: "阿强", wxid: "wxid_k" }] });  // 换行分隔
  assert.deepEqual(ex("@Amy Lee 在"), { rest: "在", mentions: [{ name: "Amy Lee", wxid: "wxid_c" }] });
  assert.deepEqual(ex("没有提及"), { rest: "没有提及", mentions: [] });
  // 句中的 @：只去 @ 号留名字，句子不被掏空（平台会把 @ 挪到最前面，原位得留个名字）
  assert.deepEqual(ex("记好啦！明天 @老板 带 @阿强 去提车"), { rest: "记好啦！明天 老板 带 阿强 去提车", mentions: [{ name: "老板", wxid: "wxid_o" }, { name: "阿强", wxid: "wxid_k" }] });
  assert.deepEqual(ex("哈哈，@小明，你别闹"), { rest: "哈哈，小明，你别闹", mentions: [{ name: "小明", wxid: "wxid_a" }] });
  assert.deepEqual(ex("他们 @小明 和 @小红 都在"), { rest: "他们 小明 和 小红 都在", mentions: [{ name: "小明", wxid: "wxid_a" }, { name: "小红", wxid: "wxid_b" }] });
  // 结尾成串的 @ 也去掉
  assert.deepEqual(ex("抽你哦 @阿强"), { rest: "抽你哦", mentions: [{ name: "阿强", wxid: "wxid_k" }] });
  assert.deepEqual(ex("都来开会，@老板、@阿强"), { rest: "都来开会", mentions: [{ name: "老板", wxid: "wxid_o" }, { name: "阿强", wxid: "wxid_k" }] });
  // 重复：连着的保留（主人要求 @ 三遍），隔着正文的只算一次
  assert.deepEqual(ex("@小明 @小明 @小明 抽你"), { rest: "抽你", mentions: [{ name: "小明", wxid: "wxid_a" }, { name: "小明", wxid: "wxid_a" }, { name: "小明", wxid: "wxid_a" }] });
  assert.deepEqual(ex("@小明 @小明 @小明"), { rest: "", mentions: [{ name: "小明", wxid: "wxid_a" }, { name: "小明", wxid: "wxid_a" }, { name: "小明", wxid: "wxid_a" }] });  // 只有 @ 没正文
  assert.equal(mentionPrefix(ex("@小明 @小明 @小明").mentions), "@小明 @小明 @小明 ");
  assert.deepEqual(ex("@老板 记好了，明天 @老板 带 @阿强 去"), { rest: "记好了，明天 老板 带 阿强 去", mentions: [{ name: "老板", wxid: "wxid_o" }, { name: "阿强", wxid: "wxid_k" }] });
  assert.deepEqual(ex("@小明 抽你 @小明 抽你").mentions, [{ name: "小明", wxid: "wxid_a" }]);
  assert.equal(mentionPrefix([{ name: "老板" }, { name: "阿强" }]), "@老板 @阿强 ");
  assert.equal(mentionPrefix([]), "");
  const ids = (t, m = map) => extractMentions(t, m).mentions.map((x) => x.wxid);
  assert.deepEqual(ids("@小红 @小明 都来"), ["wxid_b", "wxid_a"]);
  assert.deepEqual(ids("@所有人 通知", { 所有人: "x", ...map }), []);  // @所有人 不处理
  assert.deepEqual(ids("@Amy Lee 在", { Amy: "wxid_amy", "Amy Lee": "wxid_al" }), ["wxid_al"]);  // 不误匹配短名子串
});

test("mentionBack：热闹时补 @ 回触发者（给结构化的 { name, wxid }）、只有他一人时不补、模型已 @ 不重复、插嘴不补、私聊不补、触发者没昵称不补", () => {
  const mb = { enabled: true, quietWindowSec: 120, minSpeakers: 2 };
  const now = 1700000000000;
  const sender = { id: "wxid_a", name: "小明" };
  const busy = [{ from: "wxid_a", ts: now - 10000 }, { from: "wxid_b", ts: now - 5000 }];
  const lonely = [{ from: "wxid_a", ts: now - 10000 }, { from: "wxid_b", ts: now - 300000 }];  // 另一人在窗口外
  const map = { 小明: "wxid_a", 小红: "wxid_b" };
  const ctx = (o) => ({ mb, isGroup: true, reason: "at-text", sender, recent: busy, nameToWxid: map, now, ...o });
  const me = { name: "小明", wxid: "wxid_a" };
  assert.deepEqual(mentionBack("好的", ctx()), me);
  assert.equal(mentionBack("好的", ctx({ recent: lonely })), null);
  assert.equal(mentionBack("@小明 好的", ctx()), null);
  assert.deepEqual(mentionBack("@小红 你看", ctx()), me);  // @ 了别人也要补触发者
  for (const o of [{ reason: "chime" }, { isGroup: false }, { mb: { ...mb, enabled: false } }, { sender: { id: "wxid_a", name: "wxid_a" } }]) assert.equal(mentionBack("好的", ctx(o)), null);
  for (const reason of ["quote", "name", "wake"]) assert.deepEqual(mentionBack("好的", ctx({ reason })), me);
  assert.deepEqual(mentionBack("好的", ctx({ reason: "wake", recent: [{ from: "wxid_a", ts: now }, { from: "wxid_c", ts: now }, { from: "wxid_bot", ts: now, mine: true }] })), me);  // 自己的发言不算说话人
  assert.deepEqual(mentionBack("好的", ctx({ display: { wxid_a: "明明" } })), { name: "明明", wxid: "wxid_a" });  // 显示群昵称
});

test("@ 与唤醒词只看自己写的部分：引用块里别人 @ 过机器人不算；先引用再句首叫它算", () => {
  const r = (text) => classify({ ...base, text }, cfg, bot).reason;
  assert.equal(r("「老板：@helper 查下天气」\n- - - - - - - - - - - - - - -\n你别理它"), "not-triggered");
  assert.equal(r("「老板：查下天气」\n- - - - - - - - - - - - - - -\n@helper 你看看"), "at-text");
  assert.equal(r("「老板：查下天气」\n- - - - - - - - - - - - - - -\nhelper，帮我查"), "wake");
});

test("@ 前面紧挨着邮箱字符不算：foo@helper.com 不触发，x@qq.com 不会 @ 到叫 qq 的人", () => {
  assert.equal(classify({ ...base, text: "发到 foo@helper.com 就行" }, cfg, bot).reason, "not-triggered");
  assert.equal(classify({ ...base, text: "叫@helper 来" }, cfg, bot).reason, "at-text");  // 贴着中文照样算
  assert.deepEqual(extractMentions("邮箱 x@qq.com", { qq: "wxid_q" }).mentions, []);
});

test("extractMentions：大小写对不上的再不分大小写对一遍；没对上的 @ 报在 unknown 里，@所有人 不算", () => {
  const map = { Alice: "wxid_k", carol: "wxid_c" };
  const r = extractMentions("@alice @CAROL 睡觉", map);
  assert.deepEqual(r.mentions, [{ name: "Alice", wxid: "wxid_k" }, { name: "carol", wxid: "wxid_c" }]);
  assert.equal(r.rest, "睡觉");
  assert.deepEqual(extractMentions("@Alice @老王 @所有人 睡觉", map).unknown, ["老王"]);
  assert.deepEqual(extractMentions("@Alice 睡觉", map).unknown, []);
});

test("memberDirectory：最近说话的在前、再补成员表；最近一条的名字最新；去重、跳过自己和拿 wxid 顶替的名字、按上限截；群昵称带上", () => {
  const members = [{ wxid: "wxid_a", name: "甲" }, { wxid: "wxid_b", name: "乙", alias: "小乙" }, { wxid: "wxid_c", name: "丙" }, { wxid: "wxid_x", name: "wxid_x" }];
  const recent = [{ from: "wxid_b", name: "乙" }, { from: "wxid_bot", name: "helper", mine: true }, { from: "wxid_c", name: "丙新名" }, { from: "wxid_n", name: "新来的" }];
  assert.deepEqual(memberDirectory(members, recent).map((p) => p.name), ["新来的", "丙新名", "乙", "甲"]);
  assert.equal(memberDirectory(members, recent).find((p) => p.wxid === "wxid_b").alias, "小乙");
  assert.deepEqual(memberDirectory([], []), []);
});

test("directoryIndex / directoryDisplay / rosterLabel：微信昵称、群昵称都能对上同一个人；@ 出去显示群昵称；名单写法带群昵称", () => {
  const dir = [{ wxid: "wxid_c", name: "Bobby", alias: "小白" }, { wxid: "wxid_k", name: "Alice" }];
  assert.deepEqual({ ...directoryIndex(dir) }, { Bobby: "wxid_c", Alice: "wxid_k", 小白: "wxid_c" });
  assert.deepEqual(directoryDisplay(dir), { wxid_c: "小白", wxid_k: "Alice" });
  assert.equal(rosterLabel(dir[0]), "Bobby（群里叫 小白）");
  assert.equal(rosterLabel(dir[1]), "Alice");
  // 群昵称撞上别人的微信昵称：微信昵称优先
  assert.equal(directoryIndex([{ wxid: "wxid_a", name: "甲", alias: "乙" }, { wxid: "wxid_b", name: "乙" }]).乙, "wxid_b");
});

test("真实群里那几种 @：小写、群昵称、@ 20 遍、@ 当动词；都对上人、显示群里的名字、不乱报没对上", () => {
  const dir = [{ wxid: "wxid_o", name: "carol" }, { wxid: "wxid_c", name: "Bobby", alias: "小白" }, { wxid: "wxid_k", name: "Alice" }];
  const ex = (t) => extractMentions(t, directoryIndex(dir), { display: directoryDisplay(dir) });
  assert.deepEqual(ex("@alice 吃饭了").mentions, [{ name: "Alice", wxid: "wxid_k" }]);
  assert.deepEqual(ex("@小白 看一下").mentions, [{ name: "小白", wxid: "wxid_c" }]);
  assert.deepEqual(ex("@Bobby 看一下").mentions, [{ name: "小白", wxid: "wxid_c" }]);  // 用微信昵称写也行，显示群昵称
  const twenty = ex(`${"@Alice ".repeat(20)}起床`);
  assert.equal(twenty.mentions.length, 20);
  assert.equal(twenty.rest, "起床");
  assert.deepEqual(ex("这个群里alice没发过言，我@不到他呀。").unknown, []);  // @ 当动词：不当成名字
  assert.deepEqual(ex("@老王 在吗").unknown, ["老王"]);
});

test("learnAliases：引用块作者对上原话的发送者 → 他的群昵称；点选 @ 只在和某人微信昵称只差大小写时认", () => {
  const recent = [
    { from: "wxid_c", name: "Bobby", text: "感觉，这个号的讲话风格，跟老大很像" },
    { from: "wxid_o", name: "carol", text: "送我什么" },
    { from: "wxid_z", name: "路人", text: "好" },
    { from: "wxid_bot", name: "helper", mine: true, text: "当然是S属性大爆发啊" },
  ];
  const dir = [{ wxid: "wxid_c", name: "Bobby" }, { wxid: "wxid_o", name: "carol" }, { wxid: "wxid_k", name: "Alice" }, { wxid: "wxid_z", name: "路人" }];
  const quote = (author, snippet, own = "嗯") => ({ text: `「${author}：${snippet}」\n- - - - - - - - - - - - - - -\n${own}` });
  const learn = (m) => learnAliases(m, recent, dir, { name: "helper" });
  assert.deepEqual(learn(quote("小白", "感觉，这个号的讲话风格，跟老大很像")), [{ wxid: "wxid_c", alias: "小白" }]);
  assert.deepEqual(learn(quote("小白", "感觉，这个号的讲话")), [{ wxid: "wxid_c", alias: "小白" }]);  // 引用块截断了原话
  assert.deepEqual(learn(quote("carol", "送我什么")), []);  // 作者就是微信昵称：没什么可学
  assert.deepEqual(learn(quote("周周", "对不上的原话")), []);  // 原话找不到：不猜
  assert.deepEqual(learn({ text: "@alice\u2005吃饭" }), [{ wxid: "wxid_k", alias: "alice" }]);
  assert.deepEqual(learn({ text: "@小白\u2005在吗" }), []);  // 点选 @ 对不上人：留给引用块去学
});

test("learnAliases 防伪造：短原话不拿来认人；引用机器人说过的话不学（机器人的群昵称只从 OpenClaw 学）；名字要像群昵称", () => {
  const recent = [{ from: "wxid_z", name: "路人", text: "好" }, { from: "wxid_bot", name: "helper", mine: true, text: "当然是S属性大爆发啊" }];
  const dir = [{ wxid: "wxid_z", name: "路人" }];
  const quote = (author, snippet) => ({ text: `「${author}：${snippet}」\n- - - - - - - - - - - - - - -\nx` });
  const learn = (m) => learnAliases(m, recent, dir, { name: "helper" });
  assert.deepEqual(learn(quote("老王", "好久不见啊兄弟们，好")), []);  // 片段比原话长：原话「好」谁都说过，不算
  assert.deepEqual(learn(quote("老王", "好")), []);  // 片段太短
  assert.deepEqual(learn(quote("小助手", "当然是S属性大爆发啊")), []);  // 引用的是机器人的话：不从这里学机器人的群昵称
  assert.deepEqual(learn(quote("哈", "当然是S属性大爆发啊")), []);
  for (const bad of ["x）、主人（群里叫 y", "哈", "wxid_abcdefgh", "a".repeat(20)]) assert.equal(isAliasLike(bad), false, bad);
  assert.equal(isAliasLike("小白"), true);
});

test("quoteMatches：片段得是原话里的一段（引用块只会截短），至少 4 个字", () => {
  assert.equal(quoteMatches("感觉这个号的讲话风格跟老大很像", "感觉这个号的讲话…"), true);
  assert.equal(quoteMatches("好", "好久不见"), false);
  assert.equal(quoteMatches("今天天气不错", "天气"), false);
});

test("群昵称撞上别人的微信昵称：解析表微信昵称优先，显示名退回微信昵称，@ 不会落到别人身上", () => {
  const dir = [{ wxid: "wxid_a", name: "Alice", alias: "Tom" }, { wxid: "wxid_t", name: "Tom" }];
  assert.equal(directoryIndex(dir).Tom, "wxid_t");
  assert.deepEqual(directoryDisplay(dir), { wxid_a: "Alice", wxid_t: "Tom" });
});

test("从聊天学来的群昵称要求右边界：短群昵称不截走「@老王」；微信昵称照旧贴着中文也认；昵称叫 constructor 也能 @", () => {
  const dir = [{ wxid: "wxid_x", name: "张三", alias: "老" }, { wxid: "wxid_k", name: "Alice" }];
  const ex = (t) => extractMentions(t, directoryIndex(dir), { display: directoryDisplay(dir), strict: directoryAliases(dir) });
  assert.deepEqual(ex("@老王 你好").mentions, []);
  assert.deepEqual(ex("@老王 你好").unknown, ["老王"]);
  assert.deepEqual(ex("@老 你好").mentions.map((m) => m.wxid), ["wxid_x"]);
  assert.deepEqual(ex("叫@Alice来").mentions.map((m) => m.wxid), ["wxid_k"]);
  assert.deepEqual(extractMentions("@constructor 在吗", directoryIndex([{ wxid: "wxid_c", name: "constructor" }])).mentions.map((m) => m.wxid), ["wxid_c"]);
});

test("门控认机器人在本群的群昵称：@群昵称、引用块里的群昵称算；「提到名字」只认微信昵称（群昵称可能很短）", () => {
  const me = { ...bot, alias: "小助手" };
  assert.equal(classify({ ...base, text: "@小助手 在吗" }, cfg, me).reason, "at-text");
  assert.equal(classify({ ...base, text: "「小助手：你好」\n- - -\n再说一遍" }, cfg, me).reason, "quote");
  assert.equal(classify({ ...base, text: "问问小助手" }, cfg, me).reason, "not-triggered");
  assert.equal(classify({ ...base, text: "问问 helper" }, cfg, me).reason, "name");
  assert.equal(classify({ ...base, text: "@小助手 在吗" }, cfg, bot).reason, "not-triggered");  // 没学到群昵称时不认
  assert.equal(stripMention("@小助手\u2005今天天气", me), "今天天气");
});

test("先打字再点 @ 的「cc@helper」照样算 @；邮箱要两头都像才排除，也不报成没对上的 @", () => {
  assert.equal(classify({ ...base, text: "cc@helper 看下" }, cfg, bot).reason, "at-text");
  assert.equal(classify({ ...base, text: "thx@helper" }, cfg, bot).reason, "at-text");
  assert.equal(classify({ ...base, text: "问 @helper.看看" }, cfg, bot).reason, "at-text");  // 后面跟的不是域名
  assert.equal(stripMention("cc@helper 看下", bot), "cc看下");
  assert.deepEqual(extractMentions("cc@小明 你看", { 小明: "wxid_a" }).mentions, [{ name: "小明", wxid: "wxid_a" }]);
  assert.deepEqual(extractMentions("发到 x@qq.com 就行", { qq: "wxid_q" }), { rest: "发到 x@qq.com 就行", mentions: [], unknown: [] });
  assert.deepEqual(extractMentions("@Helper.ai 不是人 @老王", {}).unknown, ["Helper.ai", "老王"]);  // 前面是空格，不像邮箱
});

test("extractMentions：开头那串里夹着没对上的 @xx，对上的仍算开头那串（挪到前缀），没对上的原样留在正文开头", () => {
  const map = { Bob: "wxid_c", carol: "wxid_o" };
  const r = extractMentions("@alice @Bob @carol 三点多了，赶紧睡觉！", map);
  assert.deepEqual(r.mentions.map((m) => m.name), ["Bob", "carol"]);
  assert.equal(r.rest, "@alice 三点多了，赶紧睡觉！");
  assert.deepEqual(r.unknown, ["alice"]);
  assert.equal(extractMentions("睡觉 @carol @老王", map).rest, "睡觉 @老王");  // 结尾那串同理
});

test("没对上的 @ 只在名字的位置上算：行首、空白 / 标点后；紧贴前一个字的是拿 @ 当动词，不报", () => {
  const un = (t) => extractMentions(t, { Alice: "wxid_k" }).unknown;
  for (const t of ["我@不到他呀。", "他@了一个人", "你@我让我总结那段", "已经@全体成员并带上了链接"]) assert.deepEqual(un(t), [], t);
  assert.deepEqual(un("@老王 在吗"), ["老王"]);
  assert.deepEqual(un("好的，@老王 你看"), ["老王"]);
  assert.deepEqual(un("第一行\n@今天也要早睡早起 早"), ["今天也要早睡早起"]);
  assert.deepEqual(extractMentions("叫@Alice来", { Alice: "wxid_k" }).mentions.map((m) => m.wxid), ["wxid_k"]);  // 认得的名字照样认
});

test("名字里的空白写没了也认：「@AmyLee」对上「Amy Lee」", () => {
  assert.deepEqual(extractMentions("@AmyLee 在吗", { "Amy Lee": "wxid_a" }).mentions, [{ name: "Amy Lee", wxid: "wxid_a" }]);
});

test("asksForManyImages：明说要多发才算；按分句看，否定（别 / 不 / 没）和已经发过的不算；只看自己写的，引用块不算", () => {
  for (const t of ["都发出来看看", "helper 你现在有哪些表情包，全都秀一下。", "挨个发一遍", "每张都发一下", "每个都发一下", "发三张", "来两张", "来几张", "发5张图", "发 3 张", "发100张",
    "发我三张", "发两个表情", "多发点", "一起发出来", "都发了吧", "把表情包都晒一下", "好的，都发一下",
    "「helper：\n1. a\n2. b」\n- - - - - - - -\n都发出来看看"]) assert.equal(asksForManyImages(t), true, t);
  for (const t of ["发个表情", "发张图", "发一张", "来一个", "都行", "全都是假的", "表情包有哪些",
    "别都发", "不要全发", "都别发了", "别全都发出来", "全都不用发", "都不许发", "我都发过了", "我都发了", "全发了",
    "发两个字", "来几个人", "每个月发工资吗", "多发言",
    "「helper：都发出来」\n- - - - - - - -\n好的", "", null]) assert.equal(asksForManyImages(t), false, String(t));
});
