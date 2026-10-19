// pages/focus/focus.js —— 今日聚焦落地页
// 优先展示当日实时热搜：全站 Top 3 + 每个订阅频道各一条；未开通云开发时回退本地示例
import { CHANNELS, todayLabel, recommended } from '../../js/data.js';
import { cloudReady, fetchHot } from '../../js/source.js';

Page({
  data: {
    today: '',
    list: [],
    loading: false,
    error: ''
  },

  onLoad() {
    this.load();
  },

  onShow() {
    // 从详情页返回时，订阅可能已变更：重新计算一次（不重复请求云端）
    // 注意：实时源返回空列表时 hotAll 为 []，此时应保留本地示例，不能重建为空
    if (this.hotAll && this.hotAll.length) this.build(this.hotAll);
  },

  load() {
    this.setData({ today: todayLabel() });
    if (!cloudReady()) {
      this.fallback();
      return;
    }
    this.setData({ loading: true, error: '' });
    fetchHot({})
      .then(r => {
        this.hotAll = r.articles || [];
        this.setData({ loading: false });
        if (this.hotAll.length) this.build(this.hotAll);
        else this.fallback();
      })
      .catch(err => {
        console.warn('今日聚焦加载失败', err);
        this.setData({ loading: false, error: '实时热搜暂时不可用，已展示本地示例内容' });
        this.fallback();
      });
  },

  build(hot) {
    const subs = wx.getStorageSync('subChannels') || CHANNELS;
    const picked = [];
    const seen = {};

    const add = a => {
      if (a && a.id && !seen[a.id]) { seen[a.id] = 1; picked.push(a); }
    };

    // 全站 Top 3：优先有事实摘要、可生成视点的条目
    const factual = hot.filter(a => a.hasFacts);
    (factual.length ? factual : hot).slice(0, 3).forEach(add);
    // 每个订阅频道各取最热一条（同样优先有事实摘要的）
    subs.forEach(ch => {
      const candidates = hot.filter(a => a.channel === ch);
      const hit = candidates.find(a => a.hasFacts) || candidates[0];
      if (hit) add(hit);
    });
    // 推荐流兜底：不足 5 条时补足
    if (picked.length < 5) hot.slice(0, 8).forEach(add);

    this.setData({ list: picked.slice(0, 10), error: '' });
  },

  fallback() {
    const subs = wx.getStorageSync('subChannels') || CHANNELS;
    let list = recommended(subs);
    if (!list.length) list = recommended(CHANNELS);
    this.setData({ list, loading: false });
  },

  openDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goSubscribe() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  onShareAppMessage() {
    return { title: '今日聚焦 · 实时热点与唯物主义视点', path: '/pages/focus/focus' };
  }
});
