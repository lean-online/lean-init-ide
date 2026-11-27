/**
 * 新手诊断人话提示层：在 Lean 4 原生英文报错上方匹配常见入门坑，给出通俗中文/英文引导。
 * 纯函数实现，无副作用、零运行时依赖。
 */
import type { Locale } from './i18n';

export type DiagnosticHintInput = {
  readonly message: string;
  readonly range?: { readonly start: { readonly line: number } };
};

type HintRule = {
  readonly test: (ctx: { message: string; lineText: string; nearbyText: string }) => boolean;
  readonly zh: string;
  readonly en: string;
};

const stripLineComment = (line: string): string => line.replace(/--.*$/, '');

const RULES: readonly HintRule[] = [
  {
    test: ({ message, nearbyText }) =>
      /(?:^|[^<]);\s*\S/.test(nearbyText) && /unsolved goals|unexpected token ';'/i.test(message),
    zh: 'Lean 4 里多条策略直接换行写（保持相同缩进），不需要用分号 `;` 分隔。',
    en: 'In Lean 4, put tactics on separate aligned lines instead of separating them with `;`.',
  },
  {
    test: ({ message, nearbyText }) =>
      /\(\s*[^,()\n]+,\s*[^,()\n]+\s*\)/.test(nearbyText) &&
      !nearbyText.includes('⟨') &&
      /unsolved goals|type mismatch|invalid constructor|unknown identifier/i.test(message),
    zh: '证明「存在 ∃」或「且 ∧」时要用尖括号 `⟨ , ⟩`，不是普通圆括号 `( , )`，可点上方「符号」快捷输入。',
    en: 'Use angle brackets `⟨ , ⟩` (not `( , )`) for `∃` or `∧` proofs; click Symbols above to insert them.',
  },
  {
    test: ({ message }) =>
      /type mismatch/i.test(message) &&
      (/has type[\s\S]{0,60}\bProp\b|\bProp\b[\s\S]{0,60}is expected/i.test(message) ||
        /has type\s+Prop\s*$/im.test(message)),
    zh: '你交出的是「命题本身」，裁判要的是「证明它的证据变量」（例如交出假设 `hp`，而不是命题 `P`）。',
    en: 'You passed the proposition itself instead of its proof witness (pass e.g. `hp`, not `P`).',
  },
  {
    test: ({ message }) => /unknown identifier|unknown constant/i.test(message),
    zh: '找不到这个引理或变量名（注意大小写与点号）；点上方「查看提示」核对本课可用的引理名。',
    en: 'Identifier or lemma not found (check capitalization and namespaces); expand Hints above to verify the name.',
  },
  {
    test: ({ message }) =>
      /tactic 'rewrite' failed|did not find instance of the pattern/i.test(message),
    zh: '`rw` 没在目标里找到匹配的表达式；试试反向改写 `rw [← 引理名]`，或先用 `unfold` 展开定义。',
    en: '`rw` could not match that pattern in the goal; try reverse `rw [← lemma]` or `unfold` the definition first.',
  },
  {
    test: ({ message }) => /tactic 'rfl' failed/i.test(message),
    zh: '`rfl` 只能关闭两边按定义化简后完全相同的等式；含未知数时需先用 `rw`、`induction` 或 `omega`。',
    en: '`rfl` only closes definitional equalities; with variables, reduce first using `rw`, `induction`, or `omega`.',
  },
  {
    test: ({ message }) => /(?:omega|grind|decide)[^\n]*(?:failed|could not prove)/i.test(message),
    zh: '自动策略暂时推不出结论：检查前提是否漏了条件（如不等式边界），或先用 `intro` / `rcases` 拆出假设。',
    en: 'The automation tactic could not close the goal; check missing hypotheses or unpack with `intro` / `rcases` first.',
  },
  {
    test: ({ message }) => /uses 'sorry'|sorryAx/i.test(message),
    zh: '这里还有占位符 `sorry`，把它替换成真正的证明步骤即可过关。',
    en: 'A `sorry` placeholder remains here—replace it with real proof steps to finish.',
  },
  {
    test: ({ message }) => /expected token|unexpected token|unexpected end of input/i.test(message),
    zh: '语法还没写完整：检查括号是否配对、换行缩进是否对齐，或是否漏写了参数。',
    en: 'Incomplete syntax—check matching brackets, indentation alignment, or missing arguments.',
  },
  {
    test: ({ message }) => /type mismatch/i.test(message),
    zh: '类型不匹配：对照下方报错里的「实际类型（has type）」与「期望类型（expected）」，检查参数顺序或引理。',
    en: 'Type mismatch: compare "has type" vs "expected" below and check argument order or lemma.',
  },
  {
    test: ({ message }) => /unsolved goals/i.test(message),
    zh: '还有待证目标未关闭：把光标停在证明最后一行，看 Goal 面板「⊢」后面还剩什么。',
    en: 'Goals remain open—place your cursor on the last line and check what follows `⊢` in the Goal panel.',
  },
];

export const explainDiagnostic = (
  diagnostic: DiagnosticHintInput,
  code: string,
  locale: Locale = 'zh',
): string | null => {
  const message = diagnostic.message ?? '';
  if (!message || /unknown (?:module prefix|package) '(Std|Batteries)'/i.test(message)) {
    return null;
  }
  const lines = code.split('\n');
  const lineIdx = Math.max(0, diagnostic.range?.start.line ?? 0);
  const lineText = stripLineComment(lines[lineIdx] ?? '');
  const nearbyText = lines
    .slice(Math.max(0, lineIdx - 1), lineIdx + 4)
    .map(stripLineComment)
    .join('\n');

  for (const rule of RULES) {
    if (rule.test({ message, lineText, nearbyText })) {
      return rule[locale];
    }
  }
  return null;
};
