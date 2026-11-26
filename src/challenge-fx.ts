/**
 * 挑战页视听反馈：极简 WebAudio 合成音效（零外部音频资产）+ 轻量化 CSS 礼花 + 音效/署名偏好。
 */
export const SFX_STORAGE_KEY = 'lean:arcade-sfx';
export const NICKNAME_STORAGE_KEY = 'lean:arcade-nickname';

export type ArcadeSoundKind = 'gavel' | 'victory' | 'alert' | 'click';

export const getSfxEnabled = (): boolean => {
  try {
    return localStorage.getItem(SFX_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

export const setSfxEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(SFX_STORAGE_KEY, String(enabled));
  } catch {
    // 隐私模式或存储受限时安全降级。
  }
};

export const getArcadeNickname = (): string => {
  try {
    return (localStorage.getItem(NICKNAME_STORAGE_KEY) ?? '').slice(0, 24);
  } catch {
    return '';
  }
};

export const setArcadeNickname = (name: string): void => {
  try {
    localStorage.setItem(NICKNAME_STORAGE_KEY, name.trim().slice(0, 24));
  } catch {
    // 隐私模式或存储受限时安全降级。
  }
};

type AudioWindow = {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

let sharedAudioCtx: AudioContext | null = null;

const resolveAudioContext = (): AudioContext | null => {
  if (typeof globalThis === 'undefined') return null;
  const host = globalThis as unknown as AudioWindow;
  const Ctor = host.AudioContext ?? host.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new Ctor();
    }
    if (sharedAudioCtx.state === 'suspended' && typeof sharedAudioCtx.resume === 'function') {
      void sharedAudioCtx.resume();
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
};

const scheduleTone = (
  ctx: AudioContext,
  freq: number,
  delaySec: number,
  durationSec: number,
  type: OscillatorType,
  peakGain = 0.08,
) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = ctx.currentTime + delaySec;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, start + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + durationSec + 0.02);
};

export const playArcadeSound = (kind: ArcadeSoundKind, enabled = getSfxEnabled()): void => {
  if (!enabled) return;
  const ctx = resolveAudioContext();
  if (!ctx) return;

  try {
    if (kind === 'victory') {
      scheduleTone(ctx, 523.25, 0, 0.14, 'triangle', 0.09);
      scheduleTone(ctx, 659.25, 0.08, 0.16, 'triangle', 0.09);
      scheduleTone(ctx, 783.99, 0.16, 0.24, 'triangle', 0.1);
      scheduleTone(ctx, 1046.5, 0.24, 0.32, 'sine', 0.08);
      return;
    }
    if (kind === 'gavel') {
      scheduleTone(ctx, 196, 0, 0.12, 'square', 0.07);
      scheduleTone(ctx, 146.83, 0.09, 0.18, 'triangle', 0.09);
      return;
    }
    if (kind === 'alert') {
      scheduleTone(ctx, 311.13, 0, 0.1, 'sawtooth', 0.05);
      scheduleTone(ctx, 277.18, 0.1, 0.14, 'sawtooth', 0.05);
      return;
    }
    scheduleTone(ctx, 587.33, 0, 0.06, 'sine', 0.04);
  } catch {
    // 浏览器音频策略阻断时静默降级，不打断操作。
  }
};

export const resetAudioContextForTest = (): void => {
  sharedAudioCtx = null;
};

const CONFETTI_COLORS = ['#7c9cff', '#67d391', '#f2c14e', '#ff8a8a'] as const;

export const launchConfettiBurst = (host: HTMLElement): void => {
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
  } catch {
    // ignore media query errors in restricted environments
  }

  const prev = host.querySelector('[data-role="confetti-burst"]');
  prev?.remove();

  const overlay = document.createElement('div');
  overlay.dataset.role = 'confetti-burst';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.className = 'pointer-events-none absolute inset-0 overflow-hidden';

  for (let i = 0; i < 20; i += 1) {
    const piece = document.createElement('span');
    const angle = (Math.PI * 2 * i) / 20;
    const distance = 65 + (i % 4) * 28;
    const tx = Math.cos(angle) * distance;
    const ty = Math.sin(angle) * distance - 24;
    const rot = (i % 2 === 0 ? 1 : -1) * (120 + i * 18);
    piece.className =
      'arcade-confetti-piece absolute top-1/2 left-1/2 h-2 w-3 rounded-xs opacity-0';
    piece.style.backgroundColor = CONFETTI_COLORS[i % CONFETTI_COLORS.length]!;
    piece.style.setProperty('--tx', `${tx.toFixed(0)}px`);
    piece.style.setProperty('--ty', `${ty.toFixed(0)}px`);
    piece.style.setProperty('--rot', `${rot}deg`);
    piece.style.setProperty('--delay', `${(i % 5) * 0.03}s`);
    overlay.appendChild(piece);
  }

  host.appendChild(overlay);
  setTimeout(() => {
    overlay.remove();
  }, 1400);
};
