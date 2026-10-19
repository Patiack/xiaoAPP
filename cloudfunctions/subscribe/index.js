// cloudfunctions/subscribe/index.js —— 订阅消息额度记账
// 集合 subscribe_users：{ _id: openid, quota, channels, updatedAt }
// 前端每次 wx.requestSubscribeMessage 授权成功 → action:'inc' 加 1 条额度
// 定时云函数 dailyPush 发送成功 → 扣减额度
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 20000 });
const db = cloud.database();
const USERS = 'subscribe_users';
const MAX_QUOTA = 30; // 防止客户端重复调用 inc 无上限累加额度

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = (event && event.action) || 'get';
  const col = db.collection(USERS);

  // 取当前额度（我的页进入时调用）
  if (action === 'get') {
    const doc = await col.where({ _id: OPENID }).get();
    return { ok: true, quota: doc.data.length ? doc.data[0].quota : 0 };
  }

  // 授权成功 +1（额度不存在则建号）
  if (action === 'inc') {
    const doc = await col.where({ _id: OPENID }).get();
    if (doc.data.length) {
      const quota = Math.min((Number(doc.data[0].quota) || 0) + 1, MAX_QUOTA);
      await col.doc(OPENID).update({ data: { quota, updatedAt: Date.now() } });
      return { ok: true, quota };
    }
    await col.add({ data: { _id: OPENID, quota: 1, channels: [], updatedAt: Date.now() } });
    return { ok: true, quota: 1 };
  }

  // 同步用户订阅频道（dailyPush 据此选择推送内容）
  if (action === 'setChannels') {
    const channels = Array.isArray(event.channels) ? event.channels : [];
    const doc = await col.where({ _id: OPENID }).get();
    if (doc.data.length) {
      await col.doc(OPENID).update({ data: { channels, updatedAt: Date.now() } });
    } else {
      await col.add({ data: { _id: OPENID, quota: 0, channels, updatedAt: Date.now() } });
    }
    return { ok: true };
  }

  return { ok: false, error: 'unknown action' };
};
