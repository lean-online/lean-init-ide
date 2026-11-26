import { describe, expect, it } from 'vitest';
import { CHALLENGES } from './challenges';
import {
  buildCollatzSparklinePoints,
  buildEvenSumCounterCode,
  buildNatSubCounterCode,
  computeChallengeRank,
  computeCollatzSequence,
  evaluateDoubleNeg,
  evaluateEvenSum,
  evaluateNatSub,
  findGoldbachPairs,
  formatElapsedMs,
  hasInteractiveLab,
  isPrimeInt,
  simulateBudgetWithdraw,
  simulateClamp,
  stageKindForSlug,
} from './challenge-stage';
import { isChallengeSolved, type ChallengeSpec } from './exercise';

const specOf = (slug: string, locale: 'zh' | 'en'): ChallengeSpec => {
  const c = CHALLENGES.find((item) => item.slug === slug)!;
  return {
    mode: c.mode,
    starter: c.starter[locale],
    verdict: c.verdict,
    requiredConclusion: c.requiredConclusion,
    bounty: c.bounty,
  };
};

describe('挑战互动舞台纯逻辑', () => {
  it('按 slug 路由到对应的互动实验台，其它经典题回落为 classic-arena', () => {
    expect(stageKindForSlug('nat-sub-trap')).toBe('nat-sub');
    expect(stageKindForSlug('even-sum-split')).toBe('even-sum');
    expect(stageKindForSlug('double-negation')).toBe('double-neg');
    expect(stageKindForSlug('budget-withdraw')).toBe('budget-atm');
    expect(stageKindForSlug('clamp-contract')).toBe('clamp-sim');
    expect(stageKindForSlug('collatz-bounty')).toBe('collatz-lab');
    expect(stageKindForSlug('goldbach-bounty')).toBe('goldbach-lab');
    expect(stageKindForSlug('even-plus-even')).toBe('classic-arena');

    expect(hasInteractiveLab('nat-sub-trap')).toBe(true);
    expect(hasInteractiveLab('even-plus-even')).toBe(false);
  });

  it('评级与计时格式化按边界稳定工作', () => {
    expect(computeChallengeRank(50, 50)).toBe('S');
    expect(computeChallengeRank(38, 20)).toBe('S');
    expect(computeChallengeRank(140, 100)).toBe('A');
    expect(computeChallengeRank(200, 100)).toBe('B');

    expect(formatElapsedMs(-500)).toBe('00:00');
    expect(formatElapsedMs(9_400)).toBe('00:09');
    expect(formatElapsedMs(125_000)).toBe('02:05');
    expect(formatElapsedMs(Number.NaN)).toBe('00:00');
  });

  it('自然数减法反例验算与 Lean 代码生成通过判题契约', () => {
    expect(evaluateNatSub(5, 3)).toEqual({
      a: 5,
      b: 3,
      diff: 2,
      lhs: 5,
      rhs: 5,
      breaks: false,
    });
    expect(evaluateNatSub(1, 4)).toEqual({
      a: 1,
      b: 4,
      diff: 0,
      lhs: 4,
      rhs: 1,
      breaks: true,
    });
    expect(evaluateNatSub(-5, 99999)).toEqual({
      a: 0,
      b: 9999,
      diff: 0,
      lhs: 9999,
      rhs: 0,
      breaks: true,
    });

    for (const locale of ['zh', 'en'] as const) {
      const code = buildNatSubCounterCode(2, 7, locale);
      expect(code).toContain('abbrev counter_a : Nat := 2');
      expect(code).toContain('abbrev counter_b : Nat := 7');
      expect(isChallengeSolved(specOf('nat-sub-trap', locale), code, [])).toBe(true);
    }
    expect(buildNatSubCounterCode(2, 7, 'en')).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('偶数和反例验算与 Lean 代码生成通过判题契约', () => {
    expect(evaluateEvenSum(2, 4).breaks).toBe(false);
    expect(evaluateEvenSum(2, 3).breaks).toBe(false);
    expect(evaluateEvenSum(3, 5)).toEqual({
      a: 3,
      b: 5,
      sum: 8,
      sumEven: true,
      aEven: false,
      bEven: false,
      breaks: true,
    });

    for (const locale of ['zh', 'en'] as const) {
      const code = buildEvenSumCounterCode(3, 5, locale);
      expect(code).toContain('abbrev counter_a : Nat := 3');
      expect(code).toContain('abbrev counter_b : Nat := 5');
      expect(isChallengeSolved(specOf('even-sum-split', locale), code, [])).toBe(true);
    }
    expect(buildEvenSumCounterCode(3, 5, 'en')).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('双重否定真值推演永远维持 P → ¬¬P 成立', () => {
    expect(evaluateDoubleNeg(true)).toEqual({
      p: true,
      notP: false,
      notNotP: true,
      implicationHolds: true,
    });
    expect(evaluateDoubleNeg(false)).toEqual({
      p: false,
      notP: true,
      notNotP: false,
      implicationHolds: true,
    });
  });

  it('钱包扣款模拟器能精确复现印钞漏洞与透支截断违约', () => {
    expect(simulateBudgetWithdraw(100, 30)).toEqual({
      balance: 100,
      amount: 30,
      buggyBalance: 130,
      expectedBalance: 70,
      roundTrip: 160,
      conserved: false,
      bugKind: 'free-money',
    });
    expect(simulateBudgetWithdraw(30, 100)).toEqual({
      balance: 30,
      amount: 100,
      buggyBalance: 30,
      expectedBalance: 30,
      roundTrip: 130,
      conserved: false,
      bugKind: 'overdraft-truncation',
    });
    expect(simulateBudgetWithdraw(100, 0).bugKind).toBe('ok');
  });

  it('区间裁剪模拟器能复现边界反转与上下界倒置两类漏洞', () => {
    expect(simulateClamp(10, 20, 5)).toEqual({
      lo: 10,
      hi: 20,
      x: 5,
      buggyOut: 20,
      inRange: true,
      bugKind: 'swapped-branch',
    });
    expect(simulateClamp(20, 10, 15)).toEqual({
      lo: 20,
      hi: 10,
      x: 15,
      buggyOut: 10,
      inRange: false,
      bugKind: 'inverted-bounds',
    });
    expect(simulateClamp(10, 20, 15)).toEqual({
      lo: 10,
      hi: 20,
      x: 15,
      buggyOut: 15,
      inRange: true,
      bugKind: 'ok',
    });
  });

  it('考拉兹轨迹计算与火花线生成能处理小数字、经典 27 与步数截断', () => {
    const seq6 = computeCollatzSequence(6);
    expect(seq6.steps).toEqual([6, 3, 10, 5, 16, 8, 4, 2, 1]);
    expect(seq6.stepCount).toBe(8);
    expect(seq6.peak).toBe(16);
    expect(seq6.reachedOne).toBe(true);
    expect(seq6.truncated).toBe(false);

    const seq27 = computeCollatzSequence(27);
    expect(seq27.stepCount).toBe(111);
    expect(seq27.peak).toBe(9232);
    expect(seq27.reachedOne).toBe(true);

    const trunc = computeCollatzSequence(27, 5);
    expect(trunc.steps).toHaveLength(6);
    expect(trunc.reachedOne).toBe(false);
    expect(trunc.truncated).toBe(true);

    expect(buildCollatzSparklinePoints([], 200, 80)).toBe('');
    expect(buildCollatzSparklinePoints([1], 200, 80).split(' ')).toHaveLength(2);
    expect(buildCollatzSparklinePoints(seq6.steps, 200, 80).split(' ')).toHaveLength(9);
  });

  it('素数判定与哥德巴赫拆分对奇数和偶数均返回预期结果', () => {
    expect(isPrimeInt(1)).toBe(false);
    expect(isPrimeInt(2)).toBe(true);
    expect(isPrimeInt(9)).toBe(false);
    expect(isPrimeInt(97)).toBe(true);

    expect(findGoldbachPairs(15)).toEqual({
      n: 15,
      validEven: false,
      firstPair: null,
      pairCount: 0,
    });
    expect(findGoldbachPairs(10)).toEqual({
      n: 10,
      validEven: true,
      firstPair: [3, 7],
      pairCount: 2,
    });
    expect(findGoldbachPairs(100).pairCount).toBe(6);
  });
});
