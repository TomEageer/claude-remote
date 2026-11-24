// 回复中状态行上的词：Claude Code 终端里「Orchestrating…」这类词是程序里写死的一张表，每一轮随机挑一个，不是 Claude 返回的。
// 这里照着 2.1.331 的整张表（187 个）译成中文；词本身不代表在做什么，真正在做的事看后面的操作说明。
const SPIN_VERBS = (() => {
  const t = `
Accomplishing 达成中|Actioning 执行中|Actualizing 落实中|Architecting 架构中|Baking 烘焙中|Beaming 发光中|Beboppin' 哼着小曲|Befuddling 犯迷糊中|Billowing 翻涌中|Blanching 焯水中
Bloviating 高谈阔论中|Boogieing 摇摆中|Boondoggling 瞎忙活中|Booping 轻点中|Bootstrapping 启动中|Brewing 酝酿中|Bunning 揉面包中|Burrowing 钻研中|Calculating 计算中|Caramelizing 熬糖色中
Cascading 倾泻中|Catapulting 弹射中|Cerebrating 动脑中|Channeling 凝神中|Choreographing 编舞中|Churning 翻搅中|Clauding 克劳德中|Coalescing 聚合中|Cogitating 思索中|Combobulating 理顺中
Composing 谱写中|Computing 运算中|Concocting 调配中|Considering 考虑中|Contemplating 沉思中|Cooking 烹饪中|Crafting 打磨中|Creating 创作中|Crunching 埋头苦算中|Crystallizing 结晶中
Cultivating 培育中|Deciphering 破译中|Deliberating 斟酌中|Determining 判断中|Dilly-dallying 磨蹭中|Discombobulating 手忙脚乱中|Doing 干活中|Doodling 涂鸦中|Drizzling 淋酱中|Ebbing 退潮中
Effecting 推动中|Elucidating 阐明中|Embellishing 润色中|Enchanting 施魔法中|Envisioning 展望中|Fermenting 发酵中|Fiddle-faddling 捣鼓中|Finagling 想办法中|Flambéing 火焰炙烤中|Flibbertigibbeting 叽叽喳喳中
Flowing 流动中|Flummoxing 抓耳挠腮中|Fluttering 扑腾中|Forging 锻造中|Forming 成形中|Frolicking 嬉戏中|Frosting 裱花中|Gallivanting 闲逛中|Galloping 飞奔中|Garnishing 摆盘中
Generating 生成中|Gesticulating 比划中|Germinating 发芽中|Gitifying 提交化中|Grooving 律动中|Gusting 起风中|Harmonizing 调和中|Hashing 推敲中|Hatching 孵化中|Herding 归拢中
Honking 鸣笛中|Hullaballooing 喧闹中|Hyperspacing 超空间跃迁中|Ideating 构思中|Imagining 想象中|Improvising 即兴发挥中|Incubating 孕育中|Inferring 推断中|Infusing 浸泡中|Ionizing 电离中
Jitterbugging 跳吉特巴中|Julienning 切丝中|Kerfuffling 折腾中|Kneading 揉面中|Leavening 醒面中|Levitating 悬浮中|Lollygagging 溜达中|Manifesting 显现中|Marinating 腌制中|Meandering 蜿蜒前行中
Metamorphosing 蜕变中|Misting 喷雾中|Moonwalking 太空漫步中|Moseying 踱步中|Mulling 琢磨中|Mustering 集结中|Nebulizing 雾化中|Nesting 筑巢中|Newspapering 排版中|Noodling 琢磨点子中
Nucleating 成核中|Onioning 层层剥开中|Orbiting 环绕中|Orchestrating 编排中|Osmosing 渗透中|Perambulating 漫步中|Percolating 滤煮中|Perusing 细读中|Philosophizing 探讨哲理中|Photosynthesizing 光合作用中
Polishing 抛光中|Pollinating 授粉中|Pondering 思量中|Pontificating 侃侃而谈中|Pouncing 猛扑中|Precipitating 沉淀中|Prestidigitating 变戏法中|Processing 处理中|Proofing 校对中|Propagating 传播中
Puttering 忙些小事中|Puzzling 解谜中|Quantumizing 量子化中|Razzle-dazzling 炫技中|Razzmatazzing 花样百出中|Recombobulating 重新理顺中|Reticulating 织网中|Roosting 栖息中|Ruminating 反复咀嚼中|Sautéing 煸炒中
Scampering 小跑中|Schlepping 搬运中|Scurrying 疾走中|Seasoning 调味中|Shenaniganing 搞怪中|Shimmying 抖动中|Simmering 慢炖中|Skedaddling 开溜中|Sketching 勾勒中|Slithering 滑行中
Smooshing 揉捏中|Sock-hopping 跳舞中|Spelunking 探洞中|Spinning 旋转中|Sprouting 抽芽中|Stewing 炖煮中|Sublimating 升华中|Swirling 打旋中|Swooping 俯冲中|Symbioting 共生中
Synthesizing 综合中|Tempering 淬炼中|Thinking 思考中|Thundering 轰鸣中|Tinkering 摆弄中|Tomfoolering 胡闹中|Topsy-turvying 颠来倒去中|Transfiguring 变形中|Transmogrifying 奇妙变身中|Transmuting 转化中
Twisting 扭转中|Undulating 起伏中|Unfurling 舒展中|Unraveling 抽丝剥茧中|Vibing 找感觉中|Waddling 摇摇摆摆中|Wandering 漫游中|Warping 扭曲时空中|Whatchamacalliting 叫什么来着中|Whirlpooling 漩涡中
Whirring 嗡嗡运转中|Whisking 搅打中|Wibbling 晃悠中|Working 工作中|Wrangling 驯服中|Zesting 擦柠檬皮中|Zigzagging 迂回前进中`;
  return t.trim().split(/[|\n]/).map((x) => { const i = x.indexOf(' '); return [x.slice(0, i), x.slice(i + 1)]; });
})();
// 每一轮挑一个，这一轮里不变（和终端一样）
function spinVerb(lv) {
  if (!lv.verb) lv.verb = SPIN_VERBS[Math.floor(Math.random() * SPIN_VERBS.length)];
  return lv.verb;
}
// 思考了多久的提示：分段和终端一样（10 / 20 / 30 / 45 秒）；想完后「思考了 N 秒」留 2 秒
function thinkStage(lv) {
  if (lv.thinkAt) {
    const t = Date.now() - lv.thinkAt;
    return t >= 45000 ? '深度思考中' : t >= 30000 ? '还要再想一会儿' : t >= 20000 ? '继续思考' : t >= 10000 ? '仍在思考' : '思考';
  }
  return lv.thoughtEnd && Date.now() - lv.thoughtEnd < 2000 ? `思考了 ${Math.max(1, Math.round(lv.thoughtMs / 1000))} 秒` : '';
}
function endThink(lv) {
  if (!lv.thinkAt) return;
  lv.thoughtEnd = Date.now();
  lv.thoughtMs = lv.thoughtEnd - lv.thinkAt;
  lv.thinkAt = 0;
}
