// app.js —— 每日热点：入口
import { CHANNELS } from './js/data.js';
import { initCloud } from './js/source.js';

App({
  onLaunch() {
    // 首次启动：默认订阅全部频道，之后由用户在「我的订阅」中调整
    if (!wx.getStorageSync('subChannels')) {
      wx.setStorageSync('subChannels', CHANNELS);
    }
    // 云开发初始化（未开通云开发时静默降级，全部功能仍可用本地数据运行）
    this.globalData.cloudReady = initCloud();
  },
  globalData: {
    version: '1.2.0',
    cloudReady: false,
    remoteById: {}, // 实时热搜按 id 累积缓存，详情页回查用
    aiById: {}      // AI 视点解读内存缓存，避免同一会话内重复请求
  }
});
