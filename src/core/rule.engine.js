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
function calcCumulativeStake(base, ratio, losses, mode) {
  // SPEC_FIVE（mode=1）一注 = 5 个数各一份，累计投入按 5 倍计（与实际扣款一致）
  const multiple = Number(mode) === 1 ? NUMBERS_PER_BET : 1;
  const l = Number(losses) || 0;
  let total = 0;
  for (let i = 0; i <= l; i++) {
    total += calcAmount(base, ratio, i) * multiple;
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
// ═══════════════════════════════════════════
// 定位胆策略（v3.4.0 调整：每次买 5 个数）
// 触发条件不变（连击 N 次触发），下注对象从「大/小」改为「号码组」：
//   状态列（armed_direction / pending_direction）与 action_logs.direction
//   存逗号分隔号码串，如 "1,2,3,5,6"；'BIG'/'SMALL' 旧值仍可解析（兼容历史记录）。
// ═══════════════════════════════════════════
/**
 * 每注覆盖的点数个数：1–6 中排除上期开奖数 = 5 个
 */
const NUMBERS_PER_BET = 5;
/**
 * 定位胆赔付倍率（含本金：中一注返还 每注金额 × 5.8，净利 = 5.8A - 5A = 0.8A）
 * 环境变量 DICE_SPEC_PAYOUT 可覆盖。
 * 影响：伴随注的盈利估算（无结算消息解析时的兜底口径），不影响真实输赢判定。
 */
function locationPayoutOdds() {
  const n = parseFloat(process.env.DICE_SPEC_PAYOUT);
  return Number.isFinite(n) && n > 1 ? n : 5.8;
}
/**
 * 选号策略 v2（主人定：取「最近出现的 5 个不同数」，去重，按出现先后回看）
 * 例：开奖序列（新→旧）3,4,5,3,1 → 从最新往回收集不同数：3,4,5,1 →
 *     继续回看直到凑满 5 个；若历史整体不足 5 个不同数，
 *     用 1–6 中尚未收集的数补齐（保证永远恰好 5 注）。
 *
 * @param {number[]} recentValues - 本群历史开奖点数（新→旧）
 * @returns {number[]} 恰好 5 个点数（升序输出，便于指令稳定）
 */
function pickNumbers(recentValues) {
  const seen = [];
  for (const v of (recentValues || [])) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 6 && !seen.includes(n)) seen.push(n);
    if (seen.length >= NUMBERS_PER_BET) break;
  }
  // 历史不足 5 个不同数 → 用未出现的数补齐
  for (const n of [1, 2, 3, 4, 5, 6]) {
    if (seen.length >= NUMBERS_PER_BET) break;
    if (!seen.includes(n)) seen.push(n);
  }
  return seen.slice(0, NUMBERS_PER_BET).sort((a, b) => a - b);
}
/**
 * 生成定位胆下注指令文本：一行一个数，合成一条消息，如
 *   "定位胆4 1\n定位胆2 1\n..."
 */
function buildBetTextForNumbers(numbers, amount) {
  return numbers.map((n) => `定位胆${n} ${amount}`).join('\n');
}
/**
 * 方向/号码组 → 可读标签（日志、面板显示用）
 * 'BIG' → '大'；'SMALL' → '小'；'1,2,3,5,6' → '定位胆1/2/3/5/6'
 */
function directionLabel(direction) {
  const s = String(direction || '');
  if (s.includes('&')) {
    return s.split('&').map((p) => directionLabel(p)).join(' + ');
  }
  if (s === 'BIG') return '大';
  if (s === 'SMALL') return '小';
  return s
    .split(',')
    .filter((x) => x !== '')
    .map((n) => `定位胆${n}`)
    .join('/');
}
/**
 * 点数判中：号码组含该点数即中；'BIG'/'SMALL' 旧值走原大小判定
 *
 * @param {string} direction - '1,2,3,5,6' 或 'BIG'/'SMALL'
 * @param {number} diceValue - 1–6
 * @returns {boolean}
 */
function isDirectionHit(direction, diceValue) {
  if (direction === 'BIG' || direction === 'SMALL') return sizeOf(diceValue) === direction;
  const nums = String(direction)
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n));
  return nums.includes(Number(diceValue));
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
 * 只统计启用中的规则。模拟 / 实发已改为账号级开关：调用方传入真实余额
 * 即按真实余额判定，传入模拟钱包余额即按模拟钱包判定。
 *
 * @param {Array} rules
 * @returns {number}
 */
function minBaseBet(rules) {
  const bases = (rules || [])
    .filter((r) => r.enabled === 1)
    .map((r) => (
      // SPEC_FIVE（mode=1）一注 = 5 个数各一份，实际占用 5×base
      Number(r.mode) === 1 ? Number(r.base_bet) * NUMBERS_PER_BET : Number(r.base_bet)
    ))
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
 * 只对启用中的规则生效；传入的 balance 由调用方决定是真实余额还是模拟钱包。
 *
 * @param {number|null|undefined} balance
 * @param {Array} rules - 启用中的规则（用于取最小单注）
 * @returns {boolean}
 */
function isBalanceInsufficient(balance, rules) {
  const liveRules = (rules || []).filter((r) => r.enabled === 1);
  if (liveRules.length === 0) return false;
  if (balance == null || !Number.isFinite(Number(balance))) return false;
  const b = Number(balance);
  if (b <= balanceFloor()) return true;
  const minBet = minBaseBet(liveRules);
  return minBet > 0 && b < minBet;
}

/** 是否为大小方向（否则视为定位胆号码组） */
function isBigSmallDirection(direction) {
  return direction === 'BIG' || direction === 'SMALL';
}
/**
 * 拆分最终方向 → { big, spec }
 * 'BIG'            → { big: 'BIG',  spec: null }
 * '1,2,3,5,6'      → { big: null,   spec: '1,2,3,5,6' }
 * 'BIG&1,2,3,5,6'  → { big: 'BIG',  spec: '1,2,3,5,6' }
 */
function splitDirectionParts(direction) {
  const s = String(direction || '');
  if (!s.includes('&')) {
    return { big: isBigSmallDirection(s) ? s : null, spec: isBigSmallDirection(s) ? null : s };
  }
  const [big, spec] = s.split('&');
  return { big: big || null, spec: spec || null };
}
/**
 * 生成规则的可读描述（按玩法模式）
 */
function describeRule(rule) {
  if (Number(rule?.mode) === 1) {
    return `每期开奖后自动下注 → 买「最近 5 个不同数」定位胆（赔率 5.8，每数一份额，独立规则）`;
  }
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
  // 定位胆策略
  NUMBERS_PER_BET,
  locationPayoutOdds,
  pickNumbers,
  buildBetTextForNumbers,
  directionLabel,
  isDirectionHit,
  isBigSmallDirection,
  splitDirectionParts,
};
