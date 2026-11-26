import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getArcadeNickname,
  getSfxEnabled,
  launchConfettiBurst,
  NICKNAME_STORAGE_KEY,
  playArcadeSound,
  resetAudioContextForTest,
  setArcadeNickname,
  setSfxEnabled,
  SFX_STORAGE_KEY,
} from './challenge-fx';

describe('挑战视听反馈与偏好', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAudioContextForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('音效开关与挑战者署名支持持久化与异常降级', () => {
    expect(getSfxEnabled()).toBe(true);
    setSfxEnabled(false);
    expect(localStorage.getItem(SFX_STORAGE_KEY)).toBe('false');
    expect(getSfxEnabled()).toBe(false);

    setArcadeNickname('  Lean大神  ');
    expect(localStorage.getItem(NICKNAME_STORAGE_KEY)).toBe('Lean大神');
    expect(getArcadeNickname()).toBe('Lean大神');

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getSfxEnabled()).toBe(true);
    expect(getArcadeNickname()).toBe('');
    expect(() => setSfxEnabled(true)).not.toThrow();
    expect(() => setArcadeNickname('x')).not.toThrow();
  });

  it('WebAudio 合成音效在静音、缺失或可用时均表现安全', () => {
    expect(() => playArcadeSound('victory', false)).not.toThrow();

    const start = vi.fn();
    const stop = vi.fn();
    const connect = vi.fn();
    const setValueAtTime = vi.fn();
    const exponentialRampToValueAtTime = vi.fn();
    const fakeCtx = {
      state: 'suspended',
      currentTime: 0,
      destination: {},
      resume: vi.fn(async () => undefined),
      createOscillator: vi.fn(() => ({
        type: 'sine',
        frequency: { setValueAtTime },
        connect,
        start,
        stop,
      })),
      createGain: vi.fn(() => ({
        gain: { setValueAtTime, exponentialRampToValueAtTime },
        connect,
      })),
    };
    const AudioCtxMock = vi.fn(function () {
      return fakeCtx;
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      value: AudioCtxMock,
      configurable: true,
    });

    playArcadeSound('victory', true);
    expect(AudioCtxMock).toHaveBeenCalledTimes(1);
    expect(fakeCtx.resume).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(4);

    playArcadeSound('gavel', true);
    playArcadeSound('alert', true);
    playArcadeSound('click', true);
    expect(start).toHaveBeenCalledTimes(9);
  });

  it('礼花粒子在容器内渲染后自动清理，减少动态偏好时跳过', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => ({ matches: false })),
      configurable: true,
    });

    launchConfettiBurst(host);
    const burst = host.querySelector('[data-role="confetti-burst"]');
    expect(burst).not.toBeNull();
    expect(burst?.children).toHaveLength(20);

    vi.advanceTimersByTime(1500);
    expect(host.querySelector('[data-role="confetti-burst"]')).toBeNull();

    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => ({ matches: true })),
      configurable: true,
    });
    launchConfettiBurst(host);
    expect(host.querySelector('[data-role="confetti-burst"]')).toBeNull();
  });
});
