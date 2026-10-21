/**
 * Synthesize a gentle, pleasant ping chime when a response completes
 * while the application is inactive or in the background (similar to Codex / Antigravity).
 */
export function playPingSound(): void {
  try {
    const AudioCtx =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    // Harmonic two-tone chime: E5 (659.25 Hz) -> A5 (880 Hz) -> E6 (1318.51 Hz)
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(659.25, now);
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12);

    osc2.type = "sine";
    osc2.frequency.setValueAtTime(880, now + 0.08);
    osc2.frequency.exponentialRampToValueAtTime(1318.51, now + 0.22);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now + 0.08);
    osc1.stop(now + 0.55);
    osc2.stop(now + 0.55);

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 700);
  } catch (err) {
    console.warn("[audio] Could not play ping sound:", err);
  }
}
