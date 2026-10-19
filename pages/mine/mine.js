// pages/mine/mine.js —— 订阅管理 + 每日推送授权
import { CHANNELS } from '../../js/data.js';
import { cloudReady } from '../../js/source.js';
import { SUB_TEMPLATE_ID } from '../../js/config.js';

const app = getApp();

Page({
  data: {
    channels: CHANNELS,
    subs: [],
    total: CHANNELS.length,
    version: '',
    cloudOn: false,
    quota: 0,
    methods: [
      { name: '毛泽东思想', desc: '实事求是、群众路线、独立自主——一切从调查研究出发。' },
      { name: '历史唯物主义', desc: '人民群众是历史的创造者；社会存在决定社会意识，生产力决定生产关系。' },
      { name: '辩证唯物主义', desc: '联系与发展、对立统一、量变质变、否定之否定；实践是检验真理的唯一标准。' }
    ]
  },

  onShow() {
    this.setData({
      subs: wx.getStorageSync('subChannels') || [],
      version: app.globalData.version,
      cloudOn: cloudReady()
    });
    this.refreshQuota();
  },

  // 查询本机推送额度（存于云端 subscribe_users 集合，按 openid 记账）
  refreshQuota() {
    if (!cloudReady()) return;
    wx.cloud
      .callFunction({ name: 'subscribe', data: { action: 'get' } })
      .then(res => {
        const r = res.result || {};
        this.setData({ quota: r.quota || 0 });
      })
      .catch(() => {});
  },

  // 开启/续订每日推送：先弹微信授权，成功后云端 +1 额度
  subscribeDaily() {
    if (!cloudReady()) {
      wx.showToast({ title: '需先开通云开发', icon: 'none' });
      return;
    }
    if (!SUB_TEMPLATE_ID || SUB_TEMPLATE_ID.indexOf('请填入') === 0) {
      wx.showModal({
        title: '模板未配置',
        content: '请到小程序后台选用订阅消息模板，并把模板 ID 填入 js/config.js 的 SUB_TEMPLATE_ID',
        showCancel: false
      });
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [SUB_TEMPLATE_ID],
      success: (res) => {
        if (res[SUB_TEMPLATE_ID] === 'accept') {
          wx.cloud
            .callFunction({ name: 'subscribe', data: { action: 'inc' } })
            .then(r => {
              const quota = (r.result && r.result.quota) || 0;
              this.setData({ quota });
              wx.showToast({ title: '授权成功，额度 ' + quota, icon: 'success' });
            })
            .catch(() => wx.showToast({ title: '额度记账失败，请重试', icon: 'none' }));
        } else if (res[SUB_TEMPLATE_ID] === 'reject') {
          wx.showToast({ title: '你拒绝了授权，无法推送', icon: 'none' });
        } else {
          wx.showToast({ title: '授权未生效，请重试', icon: 'none' });
        }
      },
      fail: () => wx.showToast({ title: '授权弹窗调用失败', icon: 'none' })
    });
  },

  toggleChannel(e) {
    const ch = e.currentTarget.dataset.ch;
    const subs = this.data.subs.slice();
    const i = subs.indexOf(ch);
    if (i > -1) subs.splice(i, 1);
    else subs.push(ch);
    this.save(subs);
  },

  selectAll() {
    this.save(CHANNELS.slice());
  },

  clearAll() {
    this.save([]);
    wx.showToast({ title: '推荐流将为空，请至少勾选一个频道', icon: 'none' });
  },

  save(subs) {
    // 保持频道原始顺序存储
    subs = CHANNELS.filter(c => subs.includes(c));
    wx.setStorageSync('subChannels', subs);
    this.setData({ subs });
    // 同步上云：定时推送 dailyPush 按此列表选择推送频道
    if (cloudReady()) {
      wx.cloud
        .callFunction({ name: 'subscribe', data: { action: 'setChannels', channels: subs } })
        .catch(() => {});
    }
  }
});
