// cloudfunctions/fetchNews/index.js —— 实时热搜聚合
//
// 数据源（均为公开热榜接口，云函数代理以绕开小程序「合法域名」限制）：
//   1) 微博热搜：https://weibo.com/ajax/side/hotSearch       —— 排名 / 热度 / 话题
//   2) 百度热搜：https://top.baidu.com/api/board             —— 排名 / 热度 / 事实摘要(desc)
//
// 两路合并去重成「全网热搜」：
//   - 同一话题同时命中两路时，保留百度的公开事实摘要（AI 解读的唯一事实依据）
//   - 只有微博标题、没有事实摘要的条目，解读环节会自动拒答「事实不足」
//
// 缓存：news_cache 集合，8 分钟 TTL；每日归档到 hot_YYYYMMDD，保证分享/推送深链可回查
//
// 入参：{ channel, keyword, source: 'all'|'baidu'|'weibo', force, id }
// 出参：{ ok, articles, updatedAt, sources: {baidu, weibo}, cached }
const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 20000 });
const db = cloud.database();

const CACHE = 'news_cache';
const TTL = 8 * 60 * 1000;           // 热搜缓存 8 分钟
const FORCE_MIN_INTERVAL = 60 * 1000; // force 刷新最短间隔 60s，防止客户端反复强制回源
const MAX_ARTICLES = 60;             // 单次返回上限
const MAX_ARCHIVE = 300;             // 单日归档上限（约 200KB，低于 1MB 文档上限）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------- 基础工具 ----------------

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// 北京时间（云函数运行时区不固定，统一按 UTC+8 计算）
function bj(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes()
  };
}
function compactDate(ts) {
  const p = bj(ts);
  return '' + p.y + pad2(p.m) + pad2(p.d);
}
function timeLabel(ts) {
  const p = bj(ts);
  return pad2(p.hh) + ':' + pad2(p.mm);
}

function hashStr(s) {
  let h = 5381;
  s = String(s || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function formatHeat(n) {
  n = Number(n) || 0;
  if (!n) return '实时';
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

// 标题归一化：去 #、标点、空白，用于跨源去重与稳定 id
function titleKey(s) {
  return String(s || '')
    .replace(/^#+|#+$/g, '')
    .replace(/[\s#，。！？、：；""''《》【】（）()\[\]{}<>·—…\-_,.!?:;"']/g, '')
    .toLowerCase();
}

// ---------------- HTTP ----------------

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({
        'User-Agent': UA,
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }, headers || {})
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error('HTTP ' + res.statusCode + ' ' + raw.slice(0, 80)));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('接口返回非 JSON：' + raw.slice(0, 80))); }
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// ---------------- 数据源适配 ----------------

// 百度热搜：cards 下递归收集带 word 的条目
function collectBaidu(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(n => collectBaidu(n, out, seen));
    return;
  }
  const word = node.word || node.query;
  if (typeof word === 'string' && word.trim()) {
    // 只收集真正的热榜条目，避免把分类标签等带 word 的包装对象误当新闻
    const isItem = !!(node.desc || node.hotScore || node.rawUrl || node.url ||
      node.appUrl || typeof node.index === 'number');
    if (isItem) {
      const k = titleKey(word);
      if (k && !seen[k]) {
        seen[k] = true;
        out.push(node);
      }
      return;
    }
    // 带 word 但不是条目的包装对象：继续向下递归，避免漏掉子节点
  }
  Object.keys(node).forEach(k => {
    if (node[k] && typeof node[k] === 'object') collectBaidu(node[k], out, seen);
  });
}

function extractBaidu(body) {
  const out = [];
  const seen = {};
  const cards = (body && body.data && body.data.cards) || [];
  cards.forEach(c => collectBaidu(c, out, seen));
  return out;
}

async function fetchBaidu() {
  let out = [];
  try {
    const body = await httpGetJson('https://top.baidu.com/api/board?platform=pc&tab=realtime', {
      'Referer': 'https://top.baidu.com/board?tab=realtime'
    });
    out = extractBaidu(body);
  } catch (e) {
    console.warn('百度 PC 榜单失败，尝试移动端接口', e.message);
  }
  // PC 接口失败或返回空：退到移动端接口（无 desc，但至少保留标题/热度）
  if (!out.length) {
    const body = await httpGetJson('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
      'Referer': 'https://top.baidu.com/'
    });
    out = extractBaidu(body);
  }

  return out.map((n, i) => {
    const title = unescapeHtml(n.word || n.query || '').trim();
    const desc = unescapeHtml(n.desc || '').trim();
    const url = n.rawUrl || n.url || n.appUrl ||
      ('https://www.baidu.com/s?wd=' + encodeURIComponent(title));
    return {
      title,
      desc: desc || '',
      url,
      sourceName: '百度热搜',
      heatNum: Number(n.hotScore) || 0,
      heat: formatHeat(Number(n.hotScore) || 0),
      sourceRank: Number(n.index) + 1 || (i + 1),
      label: n.hotTag ? String(n.hotTag) : ''
    };
  }).filter(x => x.title);
}

async function fetchWeibo() {
  let list = [];
  try {
    const body = await httpGetJson('https://weibo.com/ajax/side/hotSearch', {
      'Referer': 'https://weibo.com/'
    });
    list = (body && body.data && body.data.realtime) || [];
  } catch (e) {
    console.warn('微博热搜接口失败，尝试 hot_band', e.message);
  }
  if (!list.length) {
    const band = await httpGetJson('https://weibo.com/ajax/statuses/hot_band', {
      'Referer': 'https://weibo.com/'
    });
    list = (band && band.data && band.data.band_list) || [];
  }
  return list
    .filter(n => n && !n.is_ad && !n.ad_type && (n.word || n.note))
    .map((n, i) => {
      const title = unescapeHtml(n.word || n.note || '').trim();
      const raw = String(n.word_scheme || n.word || n.note || title).trim();
      return {
        title,
        desc: '',
        url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + raw.replace(/^#+|#+$/g, '') + '#'),
        sourceName: '微博热搜',
        heatNum: Number(n.num) || 0,
        heat: formatHeat(Number(n.num) || 0),
        sourceRank: Number(n.realpos) || (i + 1),
        label: n.label_name || n.icon_desc || ''
      };
    })
    .filter(x => x.title);
}

function union(arr, v) {
  if (arr.indexOf(v) === -1) arr.push(v);
  return arr;
}

// 交替合并两路，按归一化标题去重；同题保留事实摘要更完整的一条
function mergeSources(baidu, weibo) {
  const out = [];
  const byKey = {};
  const max = Math.max(baidu.length, weibo.length);

  function add(raw) {
    const k = titleKey(raw.title);
    if (!k) return;
    const existing = byKey[k];
    if (existing) {
      existing.sources = union(existing.sources, raw.sourceName);
      existing.sourceRanks.push({ source: raw.sourceName, rank: raw.sourceRank });
      if (raw.heatNum > existing.heatNum) {
        existing.heatNum = raw.heatNum;
        existing.heat = raw.heat;
      }
      if (raw.desc && raw.desc.length > (existing.desc || '').length) {
        existing.desc = raw.desc;
        existing.url = raw.url;
      }
      return;
    }
    const item = {
      title: raw.title,
      desc: raw.desc || '',
      url: raw.url || '',
      sources: [raw.sourceName],
      sourceRanks: [{ source: raw.sourceName, rank: raw.sourceRank }],
      heatNum: raw.heatNum,
      heat: raw.heat || formatHeat(raw.heatNum),
      label: raw.label || '',
      sourceRank: raw.sourceRank
    };
    byKey[k] = item;
    out.push(item);
  }

  for (let i = 0; i < max; i++) {
    if (baidu[i]) add(baidu[i]);
    if (weibo[i]) add(weibo[i]);
  }
  return out;
}

// ---------------- 分类 ----------------

const CHANNEL_RULES = [
  ['军事', ['军演', '军事', '军队', '解放军', '国防', '航母', '战机', '导弹', '海军', '空军', '陆军', '火箭军', '台海', '南海', '北约', '俄乌', '武器', '阅兵', '退役军人', '征兵', '国防部', '舰艇', '战斗机', '军情']],
  ['财经', ['A股', '股市', '股票', '基金', '涨停', '跌停', '央行', '利率', '降息', '加息', '汇率', '人民币', '黄金', '期货', '债券', 'GDP', 'CPI', 'PPI', '财报', '上市公司', '融资', '关税', '贸易', '经济', '消费券', '房价', '楼市', '房贷', '银行', '保险', '券商', '市值', '就业率']],
  ['科技', ['人工智能', 'AI', '大模型', '芯片', '半导体', '光刻机', '华为', '苹果', '小米', '手机', '操作系统', '机器人', '航天', '卫星', '火箭', '空间站', '互联网', '算法', '大数据', '网络安全', '量子', '5G', '6G', '新能源', '电池', '算力']],
  ['汽车', ['汽车', '车企', '电动车', '新能源车', '特斯拉', '比亚迪', '车型', '车展', '召回', '驾照', '油价', '充电桩', '自动驾驶', '燃油车', '座舱', '轮胎']],
  ['音乐', ['音乐', '歌曲', '专辑', '音乐节', '演唱会', '乐团', '乐队', '歌手', '钢琴', '交响', '单曲', '编曲', '歌词', '巡演']],
  ['文化', ['文物', '博物馆', '非遗', '考古', '古籍', '传统文化', '戏曲', '京剧', '书法', '读书', '出版', '图书馆', '文化遗产', '历史建筑', '春节', '端午', '中秋', '民俗']],
  ['娱乐', ['明星', '演员', '艺人', '综艺', '电影', '电视剧', '票房', '恋情', '官宣', '离婚', '结婚', '网红', '直播', '粉丝', '偶像', '剧组', '导演', '热播', '定档', '红毯', '盛典']],
  ['生活', ['天气', '气温', '台风', '暴雨', '降雪', '寒潮', '高温', '健康', '医院', '医保', '养老', '社保', '食品', '菜价', '猪肉', '快递', '外卖', '旅游', '出行', '铁路', '高铁', '航班', '地铁', '车祸', '火灾', '救援', '社区', '物业', '租房', '公积金', '育儿', '托育']],
  ['社会', ['警方', '通报', '法院', '判刑', '犯罪', '诈骗', '拐卖', '失联', '坠楼', '事故', '死亡', '受伤', '殴打', '纠纷', '维权', '农民工', '教育', '学校', '学生', '教师', '家长', '考试', '招聘', '就业', '彩礼', '家暴', '偷拍', '谣言', '行政处罚', '立案', '调查', '外交部', '外交', '领事馆', '大使', '联合国', '国际']]
];

function classify(text) {
  let best = '热点';
  let bestScore = 0;
  for (let i = 0; i < CHANNEL_RULES.length; i++) {
    const ch = CHANNEL_RULES[i][0];
    const kws = CHANNEL_RULES[i][1];
    let score = 0;
    for (let j = 0; j < kws.length; j++) {
      if (text.indexOf(kws[j]) > -1) score += kws[j].length >= 3 ? 2 : 1;
    }
    if (score > bestScore) { bestScore = score; best = ch; }
  }
  return best;
}

// ---------------- 规范化 ----------------

function normalizeMerged(merged) {
  const now = Date.now();
  const date = compactDate(now);
  return merged.map((m, i) => {
    const text = m.title + ' ' + (m.desc || '');
    const channel = classify(text);
    const digest = (m.desc || m.title).slice(0, 360);
    const hasFacts = !!(m.desc && m.desc.length >= 24 && titleKey(m.desc) !== titleKey(m.title));
    const sourcesText = m.sources.join(' + ');
    return {
      id: 'hot_' + date + '_' + hashStr(titleKey(m.title)),
      title: m.title.slice(0, 120),
      digest,
      content: [digest],
      channel,
      source: sourcesText,
      sources: m.sources,
      sourceRanks: m.sourceRanks,
      url: m.url,
      heatNum: m.heatNum,
      heat: m.heat || formatHeat(m.heatNum),
      label: m.label,
      rank: i + 1,
      hasFacts,
      remote: true,
      hot: true,
      time: timeLabel(now),
      date,
      ts: now
    };
  });
}

// ---------------- 云端缓存 ----------------

function isMissingCollection(err) {
  const msg = String((err && err.errMsg) || (err && err.message) || err || '');
  return /collection not exist|DATABASE_COLLECTION_NOT_EXIST|-502005/i.test(msg);
}

async function ensureCollection(name) {
  try { await db.createCollection(name); } catch (e) { /* 已存在或并发创建 */ }
}

async function readDoc(id) {
  try {
    const res = await db.collection(CACHE).doc(id).get();
    return res.data || null;
  } catch (e) {
    return null;
  }
}

async function writeDoc(id, data) {
  try {
    await db.collection(CACHE).doc(id).set({ data });
  } catch (e) {
    if (isMissingCollection(e)) {
      await ensureCollection(CACHE);
      await db.collection(CACHE).doc(id).set({ data });
    } else {
      throw e;
    }
  }
}

async function getHotList(force) {
  const cached = await readDoc('hot_all');
  if (cached && cached.ts) {
    const age = Date.now() - cached.ts;
    // 普通请求走 8 分钟缓存；force 刷新也至少间隔 60 秒，
    // 避免客户端高频调用 force 导致外部接口被封或云函数费用上升。
    if (age < TTL || (force && age < FORCE_MIN_INTERVAL)) {
      return {
        articles: cached.articles || [],
        updatedAt: cached.ts,
        sources: cached.sources || {},
        cached: true
      };
    }
  }

  const results = await Promise.all([
    fetchBaidu().then(list => ({ ok: true, list })).catch(err => ({ ok: false, err })),
    fetchWeibo().then(list => ({ ok: true, list })).catch(err => ({ ok: false, err }))
  ]);

  const baidu = results[0].ok ? results[0].list : [];
  const weibo = results[1].ok ? results[1].list : [];
  if (!baidu.length && !weibo.length) {
    const reasons = results.filter(r => !r.ok).map(r => String(r.err && r.err.message || r.err));
    throw new Error('热搜源均不可用' + (reasons.length ? '：' + reasons.join('；') : ''));
  }

  const merged = mergeSources(baidu, weibo).slice(0, MAX_ARTICLES);
  const articles = normalizeMerged(merged);
  const sources = { baidu: baidu.length > 0, weibo: weibo.length > 0 };
  const updatedAt = Date.now();

  // 写 TTL 缓存 + 当日归档（归档让分享/推送深链在当天内始终可回查）
  await writeDoc('hot_all', { key: 'hot_all', ts: updatedAt, articles, sources }).catch(e => {
    console.error('写热搜缓存失败', e);
  });
  await archive(articles).catch(e => {
    console.error('写热搜归档失败', e);
  });

  return { articles, updatedAt, sources, cached: false };
}

async function archive(articles) {
  const id = 'hot_' + compactDate();
  const prev = await readDoc(id);
  const map = {};
  ((prev && prev.articles) || []).forEach(a => { if (a && a.id) map[a.id] = a; });
  articles.forEach(a => { map[a.id] = a; });
  const all = Object.keys(map).map(k => map[k])
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, MAX_ARCHIVE);
  await writeDoc(id, { type: 'hot_archive', date: compactDate(), ts: Date.now(), articles: all });
}

// ---------------- 入口 ----------------

exports.main = async (event) => {
  const e = event || {};
  try {
    // 1) 按 id 精确回查（详情页分享/推送深链）
    if (e.id) {
      const m = /^hot_(\d{8})_/.exec(String(e.id));
      const dates = [];
      if (m) dates.push(m[1]);
      dates.push(compactDate());
      const yesterday = compactDate(Date.now() - 86400000);
      if (dates.indexOf(yesterday) === -1) dates.push(yesterday);
      dates.push('all'); // 归档写入失败时，回退到当前热搜缓存
      for (let i = 0; i < dates.length; i++) {
        const doc = await readDoc('hot_' + dates[i]);
        const hit = doc && (doc.articles || []).find(a => a.id === e.id);
        if (hit) return { ok: true, article: hit };
      }
      return { ok: false, article: null, error: '该条热点已过期或不存在' };
    }

    const result = await getHotList(!!e.force);
    let list = result.articles || [];

    // 2) 关键词检索：在当前热搜榜单内检索标题与事实摘要
    if (e.keyword) {
      const kw = String(e.keyword).trim().toLowerCase();
      list = kw ? list.filter(a =>
        String(a.title || '').toLowerCase().indexOf(kw) > -1 ||
        String(a.digest || '').toLowerCase().indexOf(kw) > -1 ||
        String(a.channel || '').toLowerCase().indexOf(kw) > -1
      ) : list;
    }

    // 3) 频道筛选
    const channel = e.channel || '';
    if (channel && channel !== '热搜' && channel !== '推荐' && channel !== '热点') {
      list = list.filter(a => a.channel === channel);
    } else if (channel === '推荐') {
      list = list.slice(0, 20);
    }

    // 4) 指定来源
    if (e.source === 'baidu') list = list.filter(a => (a.sources || []).indexOf('百度热搜') > -1);
    if (e.source === 'weibo') list = list.filter(a => (a.sources || []).indexOf('微博热搜') > -1);

    return {
      ok: true,
      articles: list,
      updatedAt: result.updatedAt,
      updatedLabel: timeLabel(result.updatedAt),
      sources: result.sources,
      cached: result.cached
    };
  } catch (err) {
    console.error('fetchNews 失败', err);
    return { ok: false, articles: [], error: String(err.message || err) };
  }
};
