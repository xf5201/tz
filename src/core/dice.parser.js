// src/core/dice.parser.js
const { Api } = require('telegram');

/**
 * 消息解析器
 *
 * 1. 骰子开奖消息（MessageMediaDice，点数 1–6）
 * 2. 开盘信号消息（🧧底注: 1u，识别词写死在 strategy-executor）
 * 3. 结算消息（❤️第xxx期输赢 … 骰子为: N …【用户ID】… 赢 4.75 💰）
 *
 * 骰类表情：🎲🎯⚽🏀🎳（1–6）；🎰 为 1–64，不作为本业务的开奖来源。
 */

const DICE_EMOTICONS = new Set(['🎲', '🎯', '⚽', '🏀', '🎳']);

/**
 * 解析消息是否为开奖（骰子消息）
 *
 * @param {object} message - GramJS CustomMessage
 * @returns {{
 *   msgId: string,
 *   senderId: string,
 *   value: number,
 *   msgType: string,
 *   rawText: string
 * }|null} 非开奖消息返回 null
 */
function parseDiceMessage(message) {
  const media = message?.media;
  if (!media || !(media instanceof Api.MessageMediaDice)) return null;

  // 仅接受 1–6 的骰类表情（🎰 老虎机为 1–64，不属于本业务开奖）
  if (!DICE_EMOTICONS.has(media.emoticon)) return null;

  const value = Number(media.value);
  if (!Number.isInteger(value) || value < 1 || value > 6) return null;

  return {
    msgId: String(message.id),
    senderId: message.senderId ? message.senderId.toString() : null,
    value,
    msgType: 'dice',
    rawText: typeof message.message === 'string' ? message.message : '',
  };
}

/**
 * 判断是否为开奖结算消息（形如「❤️第xxx期输赢 ❤️ 骰子为: N 闲家: …」）
 * 注意区分庄家汇总消息（「庄家本局输赢与余额汇总」不含「期输赢」）。
 *
 * @param {string|null} text
 * @returns {boolean}
 */
function isSettleMessage(text) {
  if (!text) return false;
  return String(text).includes('期输赢') && /骰子为[:：]/.test(String(text));
}

/**
 * 判断是否为余额播报消息（机器人对下注的回复，形如）：
 *   👤可乐❤️挂机胜率99%
 *   🎲 期号: bbc10e69...
 *   大 -600 JIBA - ✅ 投注成功
 *   ——————————————————
 *   💰余额：1123690.20 JIBA
 *
 * @param {string|null} text
 * @returns {boolean}
 */
function isBalanceMessage(text) {
  if (!text) return false;
  return parseBalance(String(text)) != null;
}

/**
 * 解析余额播报消息中的余额数字
 *
 * 兼容写法：💰余额：1234.56 / 余额: 1234 / 💰 余额 1234.56 JIBA
 * 千分位逗号与空格均兼容（1,123,690.20）。
 *
 * @param {string|null} text
 * @returns {number|null} 余额；解析不到返回 null
 */
function parseBalance(text) {
  const raw = String(text || '');
  if (!raw.includes('余额')) return null;

  const m = raw.match(/余额\s*[:：]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (!m) return null;

  const value = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * 判断是否为「主动查询余额」的回复消息
 *
 * 我们往群里发「余额」两个字后，机器人回复形如：
 *   👤 昵称: 小花猫
 *   🆔 ID: 7653490880
 *
 *   💰 USDT : 0.000
 *   💰 CNY : 0.720
 *   💰 JIBA : 0.640
 *   💰 TRX : 0
 *   ————————
 *
 * 识别特征：含「昵称」+「ID」+「JIBA」三种字样，
 * 与开奖 / 结算 / 下注回复都能区分开。
 *
 * @param {string|null} text
 * @returns {boolean}
 */
function isBalanceQueryReply(text) {
  const raw = String(text || '');
  if (!raw) return false;
  return raw.includes('昵称') && /\bID\b/i.test(raw) && /JIBA/i.test(raw);
}

/**
 * 解析「主动查询余额」的回复
 *
 * 币种很多（USDT / CNY / JIBA / TRX…），下注用的是 JIBA，
 * 因此只取 JIBA 那一行作为余额，其余币种忽略。
 *
 * @param {string|null} text
 * @returns {{
 *   jiba: number|null,      // JIBA 余额（本业务唯一用得到的币种）
 *   nickname: string|null,  // 👤 昵称
 *   userId: string|null     // 🆔 ID（用于归属判定，最可靠）
 * }}
 */
function parseBalanceQuery(text) {
  const raw = String(text || '');
  if (!raw) return { jiba: null, nickname: null, userId: null };

  // JIBA 余额（大小写不敏感，兼容 jiba / JIBA / Jiba）
  const jibaMatch = raw.match(/JIBA\s*[:：]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const jiba = jibaMatch ? parseFloat(jibaMatch[1].replace(/,/g, '')) : null;

  // 昵称：👤 昵称: 小花猫
  const nickMatch = raw.match(/昵称\s*[:：]\s*([^\n]+)/);
  const nickname = nickMatch ? nickMatch[1].trim() : null;

  // ID：🆔 ID: 7653490880
  const idMatch = raw.match(/ID\s*[:：]\s*([0-9]+)/i);
  const userId = idMatch ? idMatch[1].trim() : null;

  return {
    jiba: Number.isFinite(jiba) ? jiba : null,
    nickname,
    userId,
  };
}

/**
 * 判断余额播报是否属于某个昵称（兜底归属）
 *
 * 播报首行是下注人昵称，形如：
 *   👤可乐❤️挂机胜率99%
 *   👤小花猫
 * 因此只在**首行**里找昵称，避免「可乐」误命中「可乐2」「可乐小号」等别人的名字。
 *
 * 用途：余额不足停注后不再下注，也就收不到「回复自己下注」的播报；
 * 此时只能靠昵称在群里认领自己的播报（被动检测，不用发消息）。
 *
 * @param {string|null} text
 * @param {string|null} nickname - 本账号在群里的下注昵称（.env BALANCE_NICKNAME）
 * @returns {boolean}
 */
function isBalanceForNickname(text, nickname) {
  if (!text || !nickname) return false;
  const firstLine = String(text).split('\n')[0] || '';
  return firstLine.includes(String(nickname).trim());
}

/**
 * 判定机器人对下注的回复是「投注成功」还是「失败」
 *
 * 成功样例（必须有 ✅ 投注成功）：
 *   👤可乐❤️挂机胜率99%
 *   🎲 期号: 7b0bcbb5b486e06df1cc8b444b6d5d09
 *   小 -60 JIBA - ✅ 投注成功
 *   💰余额：1165750.20 JIBA
 *
 * 失败样例（余额不足等）：
 *   👤小花猫
 *   🎲 期号: 14fb827e01619e74522477593920f279
 *   ❌ 余额不足,总下注金额 5 JIBA 点我充值
 *   💰余额：0.64 JIBA
 *
 * 判定规则：出现「❌」即失败；否则必须有「投注成功」才算成功。
 * 两者都没有 → 判失败（宁可不下注，也不能把没投出去的注当成有效注）。
 *
 * @param {string|null} text
 * @returns {{success: boolean, reason: string|null}}
 */
function parseBetResult(text) {
  const raw = String(text || '');

  if (raw.includes('❌')) {
    const m = raw.match(/❌\s*([^\n，,。]{0,40})/);
    return { success: false, reason: (m ? m[1] : '机器人拒绝').trim() || '机器人拒绝' };
  }

  if (raw.includes('投注成功')) return { success: true, reason: null };

  return { success: false, reason: '回复中未出现「投注成功」' };
}

/**
 * 取消息所回复的那条消息 ID（GramJS 两种结构都兼容）
 *
 * 余额播报是机器人「回复我们的下注消息」发出来的，
 * 靠 reply_to 才能确认这余额是本账号的，绝不能拿别人的余额。
 *
 * @param {object} message
 * @returns {string|null}
 */
function getReplyToMsgId(message) {
  const reply = message?.replyTo;
  if (!reply) return null;
  const id = reply.replyToMsgId ?? reply.reply_to_msg_id ?? reply.msgId;
  return id != null ? String(id) : null;
}

/**
 * 解析开盘/播报消息中的期号（「期号: xxx」）
 *
 * 开盘消息与下注成功播报都带期号：
 *   期号: eba8f9014fbf5320171ffbcd2f16fc7b
 * 期号是「注单 ↔ 开奖」的唯一关联键：下注时记下所属期号，
 * 结算只认同期的开奖点数，杜绝拿别期名单判输赢。
 *
 * @param {string|null} text
 * @returns {string|null} 期号；解析不到返回 null
 */
function parseWindowPeriod(text) {
  const m = String(text || '').match(/期号[:：]\s*([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * 从结算消息名单提取 大/小 的赔率样本（赢金额 ÷ 投注额）
 *
 * 获胜行形如：　久遇 【8872785955】 大 300,赢 285 💰
 * → 赔率样本 = 285 / 300 = 0.95
 *
 * 只取「大/小」行（本系统只下大小）；组合（大单/大双…）、特码、单双
 * 赔率不同，一律排除。样本用于按群动态维护赔率（chat_odds）。
 *
 * @param {string|null} text - 结算消息文本
 * @returns {number[]} 赔率样本列表（如 [0.95]）
 */
function parseOddsSamples(text) {
  const raw = String(text || '');
  if (!raw.includes('期输赢')) return [];

  const samples = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/【\d+】\s*(?:大|小)\s*([\d,]+(?:\.\d+)?)\s*,\s*赢\s*([\d,]+(?:\.\d+)?)/);
    if (!m) continue;
    const stake = parseFloat(m[1].replace(/,/g, ''));
    const win = parseFloat(m[2].replace(/,/g, ''));
    if (!(stake > 0) || !(win > 0)) continue;
    const odds = win / stake;
    // 大/小赔率必然在 (0, 2) 区间（0.95 左右），越界视为解析噪声
    if (odds > 0 && odds <= 2) {
      samples.push(Math.round(odds * 10000) / 10000);
    }
  }
  return samples;
}

/**
 * 解析结算消息：期号 + 开奖点数 + 用登录账号的用户 ID 匹配本账号的输赢
 *
 * 获胜行形如：　奔驰 迈巴赫 【7016374749】 大 5,赢 4.75 💰
 * 无获奖时为：　本期无获奖用户
 *
 * @param {string|null} text - 结算消息文本
 * @param {string} userId - 登录账号的 TG 用户 ID
 * @returns {{
 *   period: string|null,    // 结算期号（「第xxx期输赢」中的 xxx）
 *   diceValue: number|null,
 *   matched: boolean,       // 结算名单中是否出现本账号
 *   isWin: boolean|null,    // matched 时才有意义
 *   profit: number|null     // 从消息解析出的盈亏金额（输的行可能解析不到）
 * }}
 */
function parseSettle(text, userId) {
  const raw = String(text || '');
  const periodMatch = raw.match(/第\s*([A-Za-z0-9]+)\s*期输赢/);
  const period = periodMatch ? periodMatch[1] : null;
  const diceMatch = raw.match(/骰子为[:：]\s*(\d+)/);
  const diceValue = diceMatch ? parseInt(diceMatch[1], 10) : null;

  const meLine = raw
    .split('\n')
    .find((line) => line.includes(`【${userId}】`));

  if (!meLine) {
    return { period, diceValue, matched: false, isWin: null, profit: null };
  }

  // 行内同时含「赢」与「输」时按出现位置判断
  const winMatch = meLine.match(/赢\s*([\d.]+)/);
  const loseMatch = meLine.match(/输\s*([\d.]+)/);
  let isWin;
  let profit = null;
  if (winMatch && (!loseMatch || winMatch.index < loseMatch.index)) {
    isWin = true;
    profit = parseFloat(winMatch[1]);
  } else if (loseMatch) {
    isWin = false;
    profit = -parseFloat(loseMatch[1]);
  } else {
    isWin = false;
  }

  return { period, diceValue, matched: true, isWin, profit: Number.isFinite(profit) ? profit : null };
}

module.exports = {
  parseDiceMessage,
  isSettleMessage,
  parseSettle,
  parseWindowPeriod,
  parseOddsSamples,
  isBalanceMessage,
  parseBalance,
  parseBetResult,
  isBalanceForNickname,
  isBalanceQueryReply,
  parseBalanceQuery,
  getReplyToMsgId,
};
