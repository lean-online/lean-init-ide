import { describe, expect, it } from 'vitest';
import { explainDiagnostic } from './lean-diagnostic-hints';

describe('explainDiagnostic', () => {
  it('命中分号、圆括号、Prop 交出、未知引理与 rw/rfl/sorry/语法等高频新手坑', () => {
    expect(
      explainDiagnostic(
        { message: 'unsolved goals\n⊢ Q', range: { start: { line: 0 } } },
        'theorem t := by\n  intro hpq hqr hp; apply hpq',
        'zh',
      ),
    ).toContain('分号');

    expect(
      explainDiagnostic(
        { message: 'unsolved goals\n⊢ ∃ k, 6 = 2 * k', range: { start: { line: 0 } } },
        'example : 2 ∣ 6 := by\n  exact (3, rfl)',
        'zh',
      ),
    ).toContain('尖括号');

    expect(
      explainDiagnostic(
        { message: 'Type mismatch\n  P\nhas type\n  Prop\nbut is expected to have type\n  P' },
        'exact P',
        'zh',
      ),
    ).toContain('命题本身');

    expect(
      explainDiagnostic({ message: "Unknown identifier 'Array.getElem?_eq_some'" }, '', 'zh'),
    ).toContain('引理');
    expect(
      explainDiagnostic(
        { message: "tactic 'rewrite' failed, did not find instance of the pattern" },
        '',
        'zh',
      ),
    ).toContain('rw [←');
    expect(explainDiagnostic({ message: "tactic 'rfl' failed" }, '', 'zh')).toContain('rfl');
    expect(explainDiagnostic({ message: 'omega could not prove the goal' }, '', 'zh')).toContain(
      '自动策略',
    );
    expect(explainDiagnostic({ message: "declaration uses 'sorry'" }, '', 'zh')).toContain('sorry');
    expect(explainDiagnostic({ message: 'expected token' }, '', 'zh')).toContain('语法');
    expect(
      explainDiagnostic({ message: 'Type mismatch\n  Nat\nexpected String' }, '', 'zh'),
    ).toContain('类型不匹配');
    expect(explainDiagnostic({ message: 'unsolved goals\n⊢ True' }, 'sorry', 'zh')).toContain(
      'Goal',
    );
  });

  it('英文模式返回纯英文提示，缺 Std/Batteries 与未知无害信息返回 null', () => {
    const enHint = explainDiagnostic({ message: "tactic 'rfl' failed" }, '', 'en');
    expect(enHint).toContain('rfl');
    expect(enHint).not.toMatch(/[\u4e00-\u9fff]/);
    expect(explainDiagnostic({ message: "unknown module prefix 'Std'" }, '', 'zh')).toBeNull();
    expect(explainDiagnostic({ message: 'Nat.add : Nat → Nat → Nat' }, '', 'zh')).toBeNull();
  });
});
