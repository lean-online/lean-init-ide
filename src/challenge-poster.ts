/**
 * 通关战报 PNG 海报纯前端生成：使用 Canvas 2D 输出 data:image/png URL，
 * 不引入外链字体与外部图片资源，完全兼容严格 CSP（img-src 'self' data:）。
 */
import type { ArcadeRank } from './challenge-stage';
import type { ChallengeMode } from './exercise';
import type { Locale } from './i18n';

export type VictoryPosterInput = {
  locale: Locale;
  mode: ChallengeMode;
  title: string;
  rank: ArcadeRank;
  badgesText: string;
  tiersText: string;
  bestChars: number;
  elapsedLabel: string;
  nickname: string;
  siteUrl: string;
};

export type VictoryPosterSpec = {
  width: number;
  height: number;
  eyebrow: string;
  stamp: string;
  stampColor: string;
  titleLines: string[];
  rank: ArcadeRank;
  metrics: Array<{ label: string; value: string }>;
  challengerLine: string;
  footerSeal: string;
  siteUrl: string;
};

const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f]/;

const charUnits = (ch: string): number => (CJK_CHAR.test(ch) ? 2 : 1);

/** 按视觉宽度的近似单位分行（中文 2 单位、ASCII 1 单位），避免海报标题裁剪溢出。 */
export const wrapPosterText = (text: string, maxUnits: number, maxLines = 3): string[] => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return ['—'];
  const limit = Math.max(4, Math.floor(maxUnits));
  const lines: string[] = [];
  let current = '';
  let units = 0;

  for (const ch of [...clean]) {
    const w = charUnits(ch);
    if (units + w > limit && current.length > 0) {
      lines.push(current.trimEnd());
      if (lines.length >= maxLines) {
        const last = lines[maxLines - 1]!;
        lines[maxLines - 1] = `${last.slice(0, Math.max(1, last.length - 1))}…`;
        return lines;
      }
      current = ch === ' ' ? '' : ch;
      units = ch === ' ' ? 0 : w;
    } else {
      current += ch;
      units += w;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.length > 0 ? lines : ['—'];
};

const STAMP_MAP: Record<ChallengeMode, { zh: string; en: string; color: string }> = {
  verdict: { zh: 'GUILTY · 命题已裁决', en: 'VERDICT SEALED', color: '#f2c14e' },
  bugfix: { zh: 'PATCHED · 漏洞已封堵', en: 'PATCH VERIFIED', color: '#ff8a8a' },
  bounty: { zh: 'BOUNTY · 悬赏已点亮', en: 'BOUNTY CLAIMED', color: '#67d391' },
  classic: { zh: 'Q.E.D. · 形式化认证', en: 'Q.E.D. VERIFIED', color: '#7c9cff' },
};

const RANK_COLOR: Record<ArcadeRank, string> = {
  S: '#f2c14e',
  A: '#7c9cff',
  B: '#67d391',
};

export const buildPosterSpec = (input: VictoryPosterInput): VictoryPosterSpec => {
  const { locale, mode, title, rank, badgesText, tiersText, bestChars, elapsedLabel, nickname } =
    input;
  const stampInfo = STAMP_MAP[mode];
  const cleanNick = nickname.trim();

  const metrics: Array<{ label: string; value: string }> =
    locale === 'zh'
      ? [
          { label: '证明流派', value: badgesText || '独立构造' },
          { label: '最短代码', value: `${bestChars} 字符` },
          { label: '通关耗时', value: elapsedLabel },
          {
            label: tiersText ? '悬赏勋章' : '验证评级',
            value: tiersText || `${rank} 级证明`,
          },
        ]
      : [
          { label: 'PROOF STYLE', value: badgesText || 'Custom Proof' },
          { label: 'SHORTEST CODE', value: `${bestChars} chars` },
          { label: 'CLEAR TIME', value: elapsedLabel },
          {
            label: tiersText ? 'BOUNTY TIERS' : 'ARCADE RANK',
            value: tiersText || `Rank ${rank}`,
          },
        ];

  const challengerLine =
    locale === 'zh'
      ? cleanNick
        ? `挑战者：${cleanNick}`
        : '挑战者：匿名数学侦探'
      : cleanNick
        ? `Challenger: ${cleanNick}`
        : 'Challenger: Anonymous Prover';

  const footerSeal =
    locale === 'zh'
      ? '浏览器本地 Lean 4.36.0 WebAssembly 内核 · 零错误形式化认证'
      : 'Verified locally by the Lean 4.36.0 WebAssembly kernel · 0 errors';

  return {
    width: 1080,
    height: 1350,
    eyebrow: locale === 'zh' ? 'LEAN 4.36 · 浏览器数学游乐场战报' : 'LEAN 4.36 · PROOF ARCADE CARD',
    stamp: stampInfo[locale],
    stampColor: stampInfo.color,
    titleLines: wrapPosterText(title, locale === 'zh' ? 28 : 34, 3),
    rank,
    metrics,
    challengerLine,
    footerSeal,
    siteUrl: input.siteUrl,
  };
};

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.closePath();
};

export const renderVictoryPosterDataUrl = (
  input: VictoryPosterInput,
  canvasFactory: () => HTMLCanvasElement = () => document.createElement('canvas'),
): string | null => {
  const spec = buildPosterSpec(input);
  const canvas = canvasFactory();
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const fontStack = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif';
  const monoStack = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  // 深色街机渐变背景
  const bg = ctx.createLinearGradient(0, 0, spec.width, spec.height);
  bg.addColorStop(0, '#090d16');
  bg.addColorStop(0.55, '#111728');
  bg.addColorStop(1, '#0b101b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, spec.width, spec.height);

  // 背景网格纹理
  ctx.strokeStyle = 'rgba(124, 156, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let x = 60; x < spec.width; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, spec.height);
    ctx.stroke();
  }
  for (let y = 60; y < spec.height; y += 60) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(spec.width, y);
    ctx.stroke();
  }

  // 外框卡片
  drawRoundedRect(ctx, 48, 48, spec.width - 96, spec.height - 96, 36);
  ctx.fillStyle = 'rgba(21, 26, 36, 0.88)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(124, 156, 255, 0.35)';
  ctx.stroke();

  // 顶部眉题
  ctx.fillStyle = '#98a0b0';
  ctx.font = `700 24px ${monoStack}`;
  ctx.fillText(spec.eyebrow, 96, 124);

  // 右上角倾斜印章
  ctx.save();
  ctx.translate(770, 225);
  ctx.rotate(-0.11);
  drawRoundedRect(ctx, -200, -46, 400, 92, 16);
  ctx.fillStyle = 'rgba(13, 16, 22, 0.85)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = spec.stampColor;
  ctx.stroke();
  ctx.fillStyle = spec.stampColor;
  ctx.font = `800 28px ${fontStack}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(spec.stamp, 0, 2);
  ctx.restore();

  // 挑战标题
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e9ecf2';
  ctx.font = `800 48px ${fontStack}`;
  let titleY = 340;
  for (const line of spec.titleLines) {
    ctx.fillText(line, 96, titleY, spec.width - 192);
    titleY += 68;
  }

  // 挑战者署名
  ctx.fillStyle = '#7c9cff';
  ctx.font = `600 28px ${fontStack}`;
  ctx.fillText(spec.challengerLine, 96, titleY + 26);

  // 评级徽章圆环
  const rankColor = RANK_COLOR[spec.rank];
  const centerX = spec.width / 2;
  const centerY = 670;
  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, 105, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(16, 20, 28, 0.96)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = rankColor;
  ctx.stroke();
  ctx.fillStyle = rankColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 108px ${monoStack}`;
  ctx.fillText(spec.rank, centerX, centerY - 6);
  ctx.fillStyle = '#98a0b0';
  ctx.font = `700 20px ${monoStack}`;
  ctx.fillText('RANK', centerX, centerY + 62);
  ctx.restore();

  // 2x2 战绩指标卡片
  const cardW = 420;
  const cardH = 144;
  const startX = 96;
  const startY = 830;
  const gap = 48;

  spec.metrics.forEach((metric, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = startX + col * (cardW + gap);
    const y = startY + row * (cardH + 28);

    drawRoundedRect(ctx, x, y, cardW, cardH, 22);
    ctx.fillStyle = '#10141c';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#262d3a';
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#98a0b0';
    ctx.font = `600 22px ${fontStack}`;
    ctx.fillText(metric.label, x + 28, y + 48);

    ctx.fillStyle = '#e9ecf2';
    ctx.font = `700 32px ${fontStack}`;
    ctx.fillText(metric.value, x + 28, y + 104, cardW - 56);
  });

  // 底部真内核认证条与分享地址
  drawRoundedRect(ctx, 96, 1170, spec.width - 192, 92, 20);
  ctx.fillStyle = 'rgba(103, 211, 145, 0.12)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(103, 211, 145, 0.45)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#67d391';
  ctx.font = `700 24px ${fontStack}`;
  ctx.fillText(spec.footerSeal, centerX, 1212, spec.width - 230);

  ctx.fillStyle = '#98a0b0';
  ctx.font = `500 20px ${monoStack}`;
  ctx.fillText(spec.siteUrl, centerX, 1246, spec.width - 230);

  return canvas.toDataURL('image/png');
};
