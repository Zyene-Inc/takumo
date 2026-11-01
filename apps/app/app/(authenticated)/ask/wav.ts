// Dictation audio as 16 kHz mono WAV: small, and every speech-to-text
// service reads it. Pure, so tested.

export const TARGET_RATE = 16_000;
// Each side of the filter, in output samples: sharp enough to keep speech
// clear, cheap enough for minutes of audio.
const HALF_TAPS = 16;
// A little silence after the last word, so a clip that ends mid-breath
// isn't cut short by the recogniser.
const TAIL_SECONDS = 0.3;

// The filter's shape, sampled finely once so resampling only looks it up.
const STEPS_PER_TAP = 64;

const kernelTable = (cutoff: number, reach: number) => {
  const size = Math.ceil(reach * STEPS_PER_TAP);
  const table = new Float32Array(size + 1);
  for (let k = 0; k <= size; k += 1) {
    const x = k / STEPS_PER_TAP;
    // Blackman window over [-reach, reach], evaluated at x >= 0.
    const phase = (x / reach + 1) / 2;
    const window =
      0.42 -
      0.5 * Math.cos(2 * Math.PI * phase) +
      0.08 * Math.cos(4 * Math.PI * phase);
    const t = 2 * cutoff * x;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    table[k] = sinc * window;
  }
  return table;
};

/** Windowed-sinc resampling, down to `to` Hz without aliasing. */
export const resample = (input: Float32Array, from: number, to: number) => {
  if (from === to) {
    return input;
  }
  const ratio = from / to;
  // Cut a little below the new Nyquist frequency, in cycles per input sample.
  const cutoff = (0.5 / Math.max(1, ratio)) * 0.9;
  const reach = HALF_TAPS * Math.max(1, ratio);
  const table = kernelTable(cutoff, reach);
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const center = i * ratio;
    const first = Math.max(0, Math.ceil(center - reach));
    const last = Math.min(input.length - 1, Math.floor(center + reach));
    let sum = 0;
    let weights = 0;
    for (let j = first; j <= last; j += 1) {
      const w = table[Math.round(Math.abs(j - center) * STEPS_PER_TAP)];
      sum += input[j] * w;
      weights += w;
    }
    out[i] = weights ? sum / weights : 0;
  }
  return out;
};

/** Mono samples at `rate` Hz → 16 kHz, 16-bit PCM WAV. */
export const toWav = (chunks: Float32Array[], rate: number) => {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const speech = resample(all, rate, TARGET_RATE);
  const samples = speech.length + Math.round(TAIL_SECONDS * TARGET_RATE);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  // The tail stays zero: the buffer starts silent.
  for (let i = 0; i < speech.length; i += 1) {
    const v = Math.max(-1, Math.min(1, speech[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x80_00 : v * 0x7f_ff, true);
  }
  return new Blob([view], { type: "audio/wav" });
};
