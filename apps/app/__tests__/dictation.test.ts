import { describe, expect, test } from "vitest";
import { resample, TARGET_RATE, toWav } from "../app/(authenticated)/ask/wav";

const tone = (hz: number, rate: number, seconds: number) =>
  Float32Array.from({ length: rate * seconds }, (_, i) =>
    Math.sin((2 * Math.PI * hz * i) / rate)
  );

const rms = (s: Float32Array) =>
  Math.sqrt(s.reduce((sum, v) => sum + v * v, 0) / s.length);

describe("dictation audio", () => {
  test("resampling keeps speech frequencies and removes what would alias", () => {
    const voice = resample(tone(1000, 48_000, 1), 48_000, TARGET_RATE);
    expect(voice.length).toBe(TARGET_RATE);
    expect(rms(voice.slice(100, -100))).toBeGreaterThan(0.65);
    // 12 kHz can't exist at 16 kHz; unfiltered it would fold back to 4 kHz.
    const high = resample(tone(12_000, 48_000, 1), 48_000, TARGET_RATE);
    expect(rms(high.slice(100, -100))).toBeLessThan(0.02);
  });

  test("the WAV is 16 kHz mono PCM with a short silent tail", async () => {
    const wav = await toWav([tone(440, 44_100, 1)], 44_100);
    const view = new DataView(await wav.arrayBuffer());
    const text = (at: number) =>
      String.fromCharCode(...new Uint8Array(view.buffer, at, 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual([
      "RIFF",
      "WAVE",
      "fmt ",
      "data",
    ]);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(TARGET_RATE);
    const samples = view.getUint32(40, true) / 2;
    expect(samples).toBe(TARGET_RATE + Math.round(0.3 * TARGET_RATE));
    expect(view.getInt16(44 + (samples - 1) * 2, true)).toBe(0);
  });
});
