// src/db/chat-odds.dao.js
const { getConnection } = require('./connection');

/**
 * chat_odds 表 DAO（按群动态维护的 大/小 赔率）
 *
 * 来源：群内「第xxx期输赢」结算名单里其他玩家的中奖行
 *   久遇 【8872785955】 大 300,赢 285 💰  →  285 / 300 = 0.95
 *
 * 用途：输赢判定改为「开奖点数直接判定」后，赢的盈利金额
 *   = 下注金额 × 本群赔率（结算名单里恰好有本账号时用精确值修正）。
 * 群里没收到过任何结算信息（无样本）时，由调用方使用默认赔率。
 *
 * 平抑单条噪声：增量平均，单条权重封顶（OLD_WEIGHT_CAP），
 * 平台调赔率时最多 50 条样本收敛到新值。
 */
const OLD_WEIGHT_CAP = 50;

const chatOddsDao = {
  /**
   * 记录一批赔率样本（增量平均）
   * @param {string} chatId
   * @param {number[]} samples - 赢/投 的比值列表（已在解析层做过区间校验）
   * @returns {number} 实际采纳的样本数
   */
  recordSamples(chatId, samples) {
    if (!Array.isArray(samples) || samples.length === 0) return 0;
    const db = getConnection();
    let taken = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample) || sample <= 0 || sample > 2) continue;
      db.prepare(`
        INSERT INTO chat_odds (chat_id, odds, sample_count, updated_at)
        VALUES (?, ?, 1, datetime('now', '+8 hours'))
        ON CONFLICT(chat_id) DO UPDATE SET
          odds = ROUND(
            (odds * MIN(sample_count, ${OLD_WEIGHT_CAP}) + excluded.odds)
            / (MIN(sample_count, ${OLD_WEIGHT_CAP}) + 1),
          4),
          sample_count = sample_count + 1,
          updated_at = datetime('now', '+8 hours')
      `).run(String(chatId), sample);
      taken++;
    }
    return taken;
  },

  /**
   * 取某群当前赔率；无样本返回 null（调用方用默认赔率兜底）
   * @param {string} chatId
   * @returns {number|null}
   */
  getOdds(chatId) {
    const db = getConnection();
    const row = db.prepare('SELECT odds FROM chat_odds WHERE chat_id = ?').get(String(chatId));
    return row && Number.isFinite(Number(row.odds)) ? Number(row.odds) : null;
  },

  /**
   * 面板/排查用：取全部群的赔率
   * @returns {Array<{chat_id: string, odds: number, sample_count: number, updated_at: string}>}
   */
  listAll() {
    const db = getConnection();
    return db.prepare('SELECT * FROM chat_odds ORDER BY updated_at DESC').all();
  },

  /**
   * 删除某群赔率（取消监听/清理时用）
   * @param {string} chatId
   * @returns {number}
   */
  deleteByChat(chatId) {
    const db = getConnection();
    return db.prepare('DELETE FROM chat_odds WHERE chat_id = ?').run(String(chatId)).changes;
  },
};

module.exports = chatOddsDao;
