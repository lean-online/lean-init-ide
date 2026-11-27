import { describe, expect, it, vi } from 'vitest';
import {
  buildPosterSpec,
  renderVictoryPosterDataUrl,
  wrapPosterText,
  type VictoryPosterInput,
} from './challenge-poster';

const baseInput = (locale: 'zh' | 'en'): VictoryPosterInput => ({
  locale,
  mode: 'verdict',
  title:
    locale === 'zh'
      ? '自然数减法满足 (a - b) + b = a 吗？'
      : 'Does natural subtraction satisfy (a - b) + b = a?',
  rank: 'S',
  badgesText: locale === 'zh' ? '⚡ 降维打击' : '⚡ Overkill',
  tiersText: '',
  bestChars: 96,
  elapsedLabel: '00:18',
  nickname: locale === 'zh' ? '小王同学' : 'Alex',
  siteUrl: 'https://criticalthinking.de5.net/zh/challenges/nat-sub-trap',
});

describe('通关战报海报生成', () => {
  it('能按视觉宽度合理折行并支持超长截断', () => {
    expect(wrapPosterText('', 10)).toEqual(['—']);
    expect(wrapPosterText('短标题', 20)).toEqual(['短标题']);
    const lines = wrapPosterText('非常长的数学证明题目需要自动分成多行显示以免越界被裁剪掉', 14, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);

    // 英文单词应整词换行，绝不在行尾被劈成两半（例如 omega -> o / mega）。
    const mixedLines = wrapPosterText('6F · 钱包安全锁：unfold 与 omega 自动破盾', 26, 3);
    expect(mixedLines.join('\n')).toContain('omega');
    expect(mixedLines.join('\n')).not.toMatch(/\bo\n+mega\b/);
    expect(mixedLines.join('\n')).toContain('unfold');
  });

  it('中英文海报规格文本完整且英文版不含任何中文字符', () => {
    const zhSpec = buildPosterSpec(baseInput('zh'));
    expect(zhSpec.width).toBe(1080);
    expect(zhSpec.height).toBe(1350);
    expect(zhSpec.stamp).toContain('GUILTY');
    expect(zhSpec.challengerLine).toContain('小王同学');
    expect(zhSpec.metrics).toHaveLength(4);

    const enSpec = buildPosterSpec({
      ...baseInput('en'),
      mode: 'bounty',
      tiersText: '🥉 Bronze · 🥈 Silver',
      nickname: '',
    });
    expect(enSpec.stamp).toBe('BOUNTY CLAIMED');
    expect(enSpec.challengerLine).toContain('Anonymous Prover');
    expect(JSON.stringify(enSpec)).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('在缺少 2D 上下文时返回 null，可用时渲染并输出 PNG DataURL', () => {
    const nullCanvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(renderVictoryPosterDataUrl(baseInput('zh'), () => nullCanvas)).toBeNull();

    const fakeGradient = { addColorStop: vi.fn() };
    const ctx = {
      createLinearGradient: vi.fn(() => fakeGradient),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      closePath: vi.fn(),
      roundRect: vi.fn(),
      rect: vi.fn(),
      fillText: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      arc: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
    };
    const okCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toDataURL: vi.fn(() => 'data:image/png;base64,MOCK'),
    } as unknown as HTMLCanvasElement;

    const url = renderVictoryPosterDataUrl(baseInput('zh'), () => okCanvas);
    expect(url).toBe('data:image/png;base64,MOCK');
    expect(okCanvas.width).toBe(1080);
    expect(okCanvas.height).toBe(1350);
    expect(ctx.fillText).toHaveBeenCalled();
    expect(okCanvas.toDataURL).toHaveBeenCalledWith('image/png');
  });
});
