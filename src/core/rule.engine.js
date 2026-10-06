// src/core/rule.engine.js
const logger = require('../utils/logger');

/**
 * 规则引擎（纯计算，无 IO）
 *
 * 动态监测模型：
 *   规则只配置一个 N（streak_count）：
 *     连续 N 次开出「大」（4-6 点）→ 自动反向下注「小」
 *     连续 N 次开出「小」（1-3 点）→ 自动反向下注「大」
 *   大连击与小组击分别独立监测，下注方向取连击属性的反方向。
 *
 * 指令文本固定为 "<方向标签> <金额>"（与 pc28 一致），
 * 金额 = base_bet × ratio^连败次数（无上限倍投）。
 */

/**
 * 点数 → 大小属性
 * @param {number} value - 骰子点数 1–6
 * @returns {'BIG'|'SMALL'}
 */
function sizeOf(value) {
  return Number(value) >= 4 ? 'BIG' : 'SMALL';
}

/**
 * 反方向
 */
function opposite(direction) {
  return direction === 'BIG' ? 'SMALL' : 'BIG';
}

/**
 * 动态监测判定：本条开奖是否构成「连续 N 次同大小」，构成则给出反向下注方向。
 *
 * @param {object} rule - rules 表行（streak_count）
 * @param {number} value - 本条开奖点数 1–6
 * @param {number[]} recentValues - 本群此前的开奖点数（新→旧，不含本条）
 * @returns {'BIG'|'SMALL'|null} 应下注的方向；未触发返回 null
 */
function evaluateStreak(rule, value, recentValues) {
  const n = Math.max(2, rule.streak_count || 2);
  const size = sizeOf(value);

  // 本条之前的最近 n-1 条必须与本条同大小，才构成连续 n 次
  const history = recentValues.slice(0, n - 1);
  if (history.length < n - 1) return null;
  if (!history.every((v) => sizeOf(v) === size)) return null;

  return opposite(size);
}

/**
 * 浮点误差修正用的相对容差
 *
 * 二进制浮点无法精确表示 2.3 这类小数：
 *   100 * 2.3            → 229.99999999999997（本该是 230）
 *   100 * 2.3 * 2.3      → 529.0000000000001（本该是 529）
 * 直接 Math.floor 会把 229.99999999999997 砍成 229，凭空少投 1 块。
 * 先加一个「相对量级」的极小值把误差拉回，再向下取整。
 * 相对量取 1e-9：远大于浮点误差（~1e-15），又远小于任何一个真实的下注最小单位。
 */
const FLOAT_EPS_REL = 1e-9;

/**
 * 对理论下注金额向下取整（带浮点误差修正）
 * @param {number} raw - base × ratio^losses 的理论值（可能带浮点误差）
 * @returns {number} 向下取整后的整数金额
 */
function floorAmount(raw) {
  if (!Number.isFinite(raw)) return 0;
  const corrected = raw + Math.abs(raw) * FLOAT_EPS_REL;
  return Math.max(0, Math.floor(corrected));
}

/**
 * 计算下注金额（无上限倍投）
 *
 * 金额 = floor(base × ratio^losses)，向下取整。
 *
 * 为什么用 floor 而不是 round：
 *   ratio 带小数（2.3 / 1.5 / 2.5 等）时理论值会出现小数，
 *   下注金额必须是整数，向上取整会让实际投入超过预算，故统一向下取整。
 *
 * 另外做了两件保护：
 *   1. 浮点误差修正：避免 229.99999999999997 被砍成 229
 *   2. 严格递增：ratio > 1 时保证比上一注至少 +1，
 *      否则 base=1 / ratio=1.05 这类小参数下会出现「连败了但金额没涨」的假倍投
 */
function calcAmount(base, ratio, losses) {
  const b = Number(base);
  const r = Number(ratio);
  const l = Number(losses) || 0;

  if (!(b > 0)) throw new Error('基础下注金额必须 > 0');
  if (!(r >= 1.0)) throw new Error('倍投比例必须 >= 1.0');
  if (!Number.isInteger(l) || l < 0) throw new Error('连败次数必须为非负整数');

  let amount = floorAmount(b);
  for (let i = 1; i <= l; i++) {
    const next = floorAmount(b * Math.pow(r, i));
    // ratio > 1 时保证严格递增，防止小参数下倍投停滞
    amount = r > 1 ? Math.max(next, amount + 1) : next;
  }
  return Math.max(1, amount);
}

/**
 * 当前连败的累计投入（用于止损判定）
 * 从第 0 次连败到第 losses 次连败的注金之和
 *
 * 必须与 calcAmount 保持完全一致（逐项复用），
 * 否则止损阈值和实际投出去的钱对不上。
 */
function calcCumulativeStake(base, ratio, losses) {
  const l = Number(losses) || 0;
  let total = 0;
  for (let i = 0; i <= l; i++) {
    total += calcAmount(base, ratio, i);
  }
  return total;
}

/**
 * 生成下注指令文本："<方向标签> <金额>"，如 "小 100"
 */
function buildBetText(direction, amount) {
  const label = direction === 'BIG' ? '大' : '小';
  return `${label} ${amount}`;
}

/**
 * 余额停注门槛（.env BALANCE_FLOOR，默认 0）
 * 余额 <= 该值即视为「没钱」，全局停注
 */
function balanceFloor() {
  const n = parseFloat(process.env.BALANCE_FLOOR);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 启用中规则里最小的单注金额（0 = 没有启用规则）
 *
 * 用途：余额连最便宜的一注都买不起时，没必要再发指令去撞
 * 「❌ 余额不足」的墙，直接停注更干净。
 *
 * @param {Array} rules
 * @returns {number}
 */
function minBaseBet(rules) {
  const bases = (rules || [])
    .filter((r) => r.enabled === 1)
    .map((r) => Number(r.base_bet))
    .filter((n) => Number.isFinite(n) && n > 0);
  return bases.length ? Math.min(...bases) : 0;
}

/**
 * 余额是否不足以继续下注
 *
 * 两条判定（任一成立即停注）：
 *   1. 余额 <= BALANCE_FLOOR（默认 0）：余额归零 / 为负
 *   2. 余额 < 最小单注金额：连最便宜的一注都买不起
 * 从未解析到余额（null）时一律返回 false —— 消息格式一变就让整套规则
 * 静默罢工是最危险的行为，宁可照常下注后被机器人拒绝。
 *
 * @param {number|null|undefined} balance
 * @param {Array} rules - 启用中的规则（用于取最小单注）
 * @returns {boolean}
 */
function isBalanceInsufficient(balance, rules) {
  if (balance == null || !Number.isFinite(Number(balance))) return false;
  const b = Number(balance);
  if (b <= balanceFloor()) return true;
  const minBet = minBaseBet(rules);
  return minBet > 0 && b < minBet;
}

/**
 * 生成规则的可读描述
 */
function describeRule(rule) {
  return `连续 ${rule.streak_count} 次开出「大」→ 买「小」；连续 ${rule.streak_count} 次开出「小」→ 买「大」`;
}

module.exports = {
  sizeOf,
  opposite,
  evaluateStreak,
  calcAmount,
  calcCumulativeStake,
  buildBetText,
  describeRule,
  balanceFloor,
  minBaseBet,
  isBalanceInsufficient,
};
