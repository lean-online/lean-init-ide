/**
 * 挑战互动舞台的纯逻辑：零 DOM、零网络，与挑战数据脱耦，供单测和 SSG 安全复用。
 */
import type { Locale } from './i18n';

export type StageKind =
  | 'nat-sub'
  | 'even-sum'
  | 'double-neg'
  | 'budget-atm'
  | 'clamp-sim'
  | 'collatz-lab'
  | 'goldbach-lab'
  | 'classic-arena';

export type ArcadeRank = 'S' | 'A' | 'B';

const SLUG_TO_STAGE: Record<string, StageKind> = {
  'nat-sub-trap': 'nat-sub',
  'even-sum-split': 'even-sum',
  'double-negation': 'double-neg',
  'budget-withdraw': 'budget-atm',
  'clamp-contract': 'clamp-sim',
  'collatz-bounty': 'collatz-lab',
  'goldbach-bounty': 'goldbach-lab',
};

export const stageKindForSlug = (slug: string): StageKind => SLUG_TO_STAGE[slug] ?? 'classic-arena';

export const hasInteractiveLab = (slug: string): boolean =>
  stageKindForSlug(slug) !== 'classic-arena';

const clampInt = (raw: number, min: number, max: number, fallback: number): number => {
  if (!Number.isFinite(raw)) return fallback;
  const int = Math.trunc(raw);
  return Math.max(min, Math.min(max, int));
};

export const computeChallengeRank = (codeChars: number, solutionChars: number): ArcadeRank => {
  const chars = Math.max(0, Math.floor(codeChars));
  const ref = Math.max(1, Math.floor(solutionChars));
  if (chars <= Math.max(40, Math.ceil(ref * 1.15))) return 'S';
  if (chars <= Math.ceil(ref * 1.65)) return 'A';
  return 'B';
};

export const formatElapsedMs = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

export type NatSubEvaluation = {
  a: number;
  b: number;
  diff: number;
  lhs: number;
  rhs: number;
  breaks: boolean;
};

export const evaluateNatSub = (aRaw: number, bRaw: number): NatSubEvaluation => {
  const a = clampInt(aRaw, 0, 9999, 5);
  const b = clampInt(bRaw, 0, 9999, 3);
  const diff = Math.max(0, a - b);
  const lhs = diff + b;
  const rhs = a;
  return { a, b, diff, lhs, rhs, breaks: lhs !== rhs };
};

export const buildNatSubCounterCode = (aRaw: number, bRaw: number, locale: Locale): string => {
  const { a, b } = evaluateNatSub(aRaw, bRaw);
  if (locale === 'zh') {
    return `-- 法庭反例呈堂证供：a = ${a}，b = ${b}
-- 当 b > a 时，自然数 a - b 截断为 0，于是 (a - b) + b = ${Math.max(0, a - b) + b} ≠ ${a}
abbrev counter_a : Nat := ${a}
abbrev counter_b : Nat := ${b}

-- 裁判机自动验算你的反例（无需修改下方代码）：
theorem verdict_false : (counter_a - counter_b) + counter_b ≠ counter_a := by
  decide
`;
  }
  return `-- Courtroom counterexample exhibit: a = ${a}, b = ${b}
-- When b > a, natural subtraction truncates a - b to 0, so (a - b) + b = ${Math.max(0, a - b) + b} ≠ ${a}
abbrev counter_a : Nat := ${a}
abbrev counter_b : Nat := ${b}

-- The judge checks your counterexample automatically (do not edit below):
theorem verdict_false : (counter_a - counter_b) + counter_b ≠ counter_a := by
  decide
`;
};

export type EvenSumEvaluation = {
  a: number;
  b: number;
  sum: number;
  sumEven: boolean;
  aEven: boolean;
  bEven: boolean;
  breaks: boolean;
};

export const evaluateEvenSum = (aRaw: number, bRaw: number): EvenSumEvaluation => {
  const a = clampInt(aRaw, 0, 9999, 2);
  const b = clampInt(bRaw, 0, 9999, 2);
  const sum = a + b;
  const sumEven = sum % 2 === 0;
  const aEven = a % 2 === 0;
  const bEven = b % 2 === 0;
  return {
    a,
    b,
    sum,
    sumEven,
    aEven,
    bEven,
    breaks: sumEven && (!aEven || !bEven),
  };
};

export const buildEvenSumCounterCode = (aRaw: number, bRaw: number, locale: Locale): string => {
  const { a, b } = evaluateEvenSum(aRaw, bRaw);
  if (locale === 'zh') {
    return `-- 法庭反例呈堂证供：a = ${a}，b = ${b}
-- 两个奇数相加仍然是偶数，但加数本身并不是偶数
def isEven (n : Nat) : Bool := n % 2 == 0

abbrev counter_a : Nat := ${a}
abbrev counter_b : Nat := ${b}

-- 裁判机自动验算你的反例（无需修改下方代码）：
theorem verdict_false :
    isEven (counter_a + counter_b) = true ∧
      (isEven counter_a = false ∨ isEven counter_b = false) := by
  decide
`;
  }
  return `-- Courtroom counterexample exhibit: a = ${a}, b = ${b}
-- Two odd numbers add up to an even number, yet neither addend is even
def isEven (n : Nat) : Bool := n % 2 == 0

abbrev counter_a : Nat := ${a}
abbrev counter_b : Nat := ${b}

-- The judge checks your counterexample automatically (do not edit below):
theorem verdict_false :
    isEven (counter_a + counter_b) = true ∧
      (isEven counter_a = false ∨ isEven counter_b = false) := by
  decide
`;
};

export type DoubleNegEvaluation = {
  p: boolean;
  notP: boolean;
  notNotP: boolean;
  implicationHolds: boolean;
};

export const evaluateDoubleNeg = (p: boolean): DoubleNegEvaluation => ({
  p,
  notP: !p,
  notNotP: !!p,
  implicationHolds: !p || !!p,
});

export type BudgetAtmSimulation = {
  balance: number;
  amount: number;
  buggyBalance: number;
  expectedBalance: number;
  roundTrip: number;
  conserved: boolean;
  bugKind: 'free-money' | 'overdraft-truncation' | 'ok';
};

export const simulateBudgetWithdraw = (
  balanceRaw: number,
  amountRaw: number,
): BudgetAtmSimulation => {
  const balance = clampInt(balanceRaw, 0, 999999, 100);
  const amount = clampInt(amountRaw, 0, 999999, 30);
  const buggyBalance = amount <= balance ? balance + amount : balance;
  const expectedBalance = amount <= balance ? balance - amount : balance;
  const roundTrip = buggyBalance + amount;
  const conserved = roundTrip === balance;
  const bugKind: BudgetAtmSimulation['bugKind'] =
    amount <= balance && amount > 0
      ? 'free-money'
      : amount > balance
        ? 'overdraft-truncation'
        : 'ok';

  return {
    balance,
    amount,
    buggyBalance,
    expectedBalance,
    roundTrip,
    conserved,
    bugKind,
  };
};

export type ClampSimulation = {
  lo: number;
  hi: number;
  x: number;
  buggyOut: number;
  inRange: boolean;
  bugKind: 'inverted-bounds' | 'swapped-branch' | 'ok';
};

export const simulateClamp = (loRaw: number, hiRaw: number, xRaw: number): ClampSimulation => {
  const lo = clampInt(loRaw, 0, 9999, 10);
  const hi = clampInt(hiRaw, 0, 9999, 20);
  const x = clampInt(xRaw, 0, 9999, 5);
  const buggyOut = x < lo ? hi : hi < x ? lo : x;
  const inRange = lo <= buggyOut && buggyOut <= hi;

  let bugKind: ClampSimulation['bugKind'] = 'ok';
  if (lo > hi) {
    bugKind = 'inverted-bounds';
  } else if (!inRange || (x < lo && buggyOut !== lo) || (x > hi && buggyOut !== hi)) {
    bugKind = 'swapped-branch';
  }

  return { lo, hi, x, buggyOut, inRange, bugKind };
};

export type CollatzSequence = {
  start: number;
  steps: number[];
  stepCount: number;
  peak: number;
  reachedOne: boolean;
  truncated: boolean;
};

export const computeCollatzSequence = (startRaw: number, maxSteps = 200): CollatzSequence => {
  const start = clampInt(startRaw, 1, 100000, 27);
  const limit = clampInt(maxSteps, 1, 500, 200);
  const steps: number[] = [start];
  let current = start;
  let peak = start;

  for (let i = 0; i < limit && current !== 1; i += 1) {
    current = current % 2 === 0 ? current / 2 : 3 * current + 1;
    steps.push(current);
    if (current > peak) peak = current;
  }

  const reachedOne = current === 1;
  return {
    start,
    steps,
    stepCount: steps.length - 1,
    peak,
    reachedOne,
    truncated: !reachedOne,
  };
};

export const buildCollatzSparklinePoints = (
  steps: readonly number[],
  width: number,
  height: number,
  pad = 8,
): string => {
  if (steps.length === 0) return '';
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const logs = steps.map((value) => Math.log2(Math.max(1, value)));
  const maxLog = Math.max(...logs, 1);

  if (steps.length === 1) {
    const y = pad + innerH - (logs[0]! / maxLog) * innerH;
    return `${pad.toFixed(1)},${y.toFixed(1)} ${(pad + innerW).toFixed(1)},${y.toFixed(1)}`;
  }

  return logs
    .map((logVal, index) => {
      const x = pad + (index / (logs.length - 1)) * innerW;
      const y = pad + innerH - (logVal / maxLog) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
};

export const isPrimeInt = (nRaw: number): boolean => {
  if (!Number.isFinite(nRaw)) return false;
  const n = Math.trunc(nRaw);
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let d = 3; d * d <= n; d += 2) {
    if (n % d === 0) return false;
  }
  return true;
};

export type GoldbachResult = {
  n: number;
  validEven: boolean;
  firstPair: [number, number] | null;
  pairCount: number;
};

export const findGoldbachPairs = (nRaw: number): GoldbachResult => {
  const n = clampInt(nRaw, 4, 10000, 100);
  if (n < 4 || n % 2 !== 0) {
    return { n, validEven: false, firstPair: null, pairCount: 0 };
  }

  let firstPair: [number, number] | null = null;
  let pairCount = 0;
  for (let p = 2; p * 2 <= n; p += 1) {
    const q = n - p;
    if (isPrimeInt(p) && isPrimeInt(q)) {
      if (firstPair === null) firstPair = [p, q];
      pairCount += 1;
    }
  }
  return { n, validEven: true, firstPair, pairCount };
};
