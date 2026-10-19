// pages/search/search.js —— 热点搜索：本地示例库 + 实时热搜 双路检索
import { searchAll } from '../../js/data.js';
import { cloudReady, fetchHot } from '../../js/source.js';

const HISTORY_KEY = 'search_history';
const MAX_HISTORY = 10;

Page({
  data: {
    keyword: '',
    lastKw: '',
    searched: false,
    loading: false,
    local: [],
    remote: [],
    remoteError: false,
    cloudOff: false,
    history: [],
    hints: ['人工智能', '就业', '房价', '台风', '军演', '演唱会', '汽车召回', '博物馆', '外贸']
  },

  onLoad() {
    this.setData({
      history: wx.getStorageSync(HISTORY_KEY) || [],
      cloudOff: !cloudReady()
    });
  },

  onInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  clearKw() {
    this.setData({ keyword: '', searched: false, local: [], remote: [] });
  },

  tapHistory(e) {
    this.setData({ keyword: e.currentTarget.dataset.kw });
    this.doSearch();
  },

  clearHistory() {
    wx.removeStorageSync(HISTORY_KEY);
    this.setData({ history: [] });
  },

  pushHistory(kw) {
    let history = this.data.history.filter(h => h !== kw);
    history.unshift(kw);
    history = history.slice(0, MAX_HISTORY);
    wx.setStorageSync(HISTORY_KEY, history);
    this.setData({ history });
  },

  doSearch() {
    const kw = this.data.keyword.trim();
    if (!kw) {
      wx.showToast({ title: '请输入关键词', icon: 'none' });
      return;
    }
    this.pushHistory(kw);
    this.setData({ searched: true, loading: true, lastKw: kw, local: [], remote: [], remoteError: false });

    // 1) 本地解读库：同步命中
    this.setData({ local: searchAll(kw) });

    // 2) 实时热搜：在当日热搜榜内检索标题/事实摘要（未开通云开发时静默跳过）
    if (!cloudReady()) {
      this.setData({ loading: false, cloudOff: true });
      return;
    }
    fetchHot({ keyword: kw })
      .then(r => {
        this.setData({ remote: r.articles || [], loading: false });
      })
      .catch(() => {
        this.setData({ remoteError: true, loading: false });
      });
  },

  openDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  onShareAppMessage() {
    return { title: '每日热点 · 搜索你关心的频道', path: '/pages/search/search' };
  }
});
