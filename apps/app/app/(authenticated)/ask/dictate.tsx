"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dictate } from "./actions";
import { toWav } from "./wav";

const MAX_SECONDS = 240;
const BARS = 28;

interface Recording {
  chunks: Float32Array[];
  context: AudioContext;
  processor: ScriptProcessorNode;
  stream: MediaStream;
}

const silence = () => new Array<number>(BARS).fill(0);

/** Stop the microphone and the audio graph. */
const stopRecording = (r: Recording) => {
  r.processor.disconnect();
  for (const track of r.stream.getTracks()) {
    track.stop();
  }
  r.context.close().catch(() => undefined);
};

const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const micError = (error: unknown) =>
  error instanceof DOMException && error.name === "NotAllowedError"
    ? "Allow microphone access in your browser to dictate."
    : "Couldn't start the microphone.";

/**
 * Dictate into the Ask box: records while the waveform moves, then Gemini
 * transcribes it with the shop's part numbers and machine names as hints.
 */
export const DictateButton = ({
  disabled,
  onError,
  onText,
}: {
  disabled?: boolean;
  onError: (message: string) => void;
  onText: (text: string) => void;
}) => {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">(
    "idle"
  );
  const [levels, setLevels] = useState<number[]>(silence);
  const [seconds, setSeconds] = useState(0);
  const recording = useRef<Recording | null>(null);

  const release = () => {
    const r = recording.current;
    recording.current = null;
    if (r) {
      stopRecording(r);
    }
    return r;
  };

  // Let go of the microphone if the page goes away mid-dictation.
  useEffect(
    () => () => {
      if (recording.current) {
        stopRecording(recording.current);
      }
    },
    []
  );

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      const began = Date.now();
      processor.onaudioprocess = (e) => {
        const samples = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(samples));
        let sum = 0;
        for (const v of samples) {
          sum += v * v;
        }
        // Loudness, scaled so normal speech fills most of a bar.
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 6);
        setLevels((prev) => [...prev.slice(1), level]);
        const elapsed = Math.floor((Date.now() - began) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) {
          finish();
        }
      };
      source.connect(processor);
      processor.connect(context.destination);
      recording.current = { chunks, context, processor, stream };
      setLevels(silence());
      setSeconds(0);
      setState("recording");
    } catch (error) {
      release();
      onError(micError(error));
    }
  };

  const cancel = () => {
    release();
    setState("idle");
  };

  const finish = async () => {
    const r = release();
    if (!r) {
      return;
    }
    if (r.chunks.length === 0) {
      setState("idle");
      return;
    }
    setState("transcribing");
    const form = new FormData();
    form.set("audio", toWav(r.chunks, r.context.sampleRate), "dictation.wav");
    const result = await dictate(form);
    setState("idle");
    if (result.ok) {
      onText(result.text);
    } else {
      onError(result.error);
    }
  };

  // Enter finishes and Escape cancels while recording.
  useEffect(() => {
    if (state !== "recording") {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (state === "transcribing") {
    return (
      <div className="flex h-8 items-center gap-2 rounded-full bg-muted px-3 text-muted-foreground text-xs">
        <Spinner className="size-3.5" /> Transcribing…
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div
        aria-live="polite"
        className="flex h-8 items-center gap-1 rounded-full border bg-background py-1 pr-1 pl-1"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Cancel dictation"
              className="size-6 rounded-full"
              onClick={cancel}
              size="icon"
              type="button"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Cancel (Esc)</TooltipContent>
        </Tooltip>
        <div aria-hidden className="flex h-5 items-center gap-[2px] px-1">
          {levels.map((level, i) => (
            <span
              className="w-[2px] rounded-full bg-foreground/70 transition-[height] duration-75"
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positions
              key={i}
              style={{ height: `${Math.max(2, level * 20)}px` }}
            />
          ))}
        </div>
        <span className="w-8 text-muted-foreground text-xs tabular-nums">
          {clock(seconds)}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Stop and insert"
              className="size-6 rounded-full"
              onClick={finish}
              size="icon"
              type="button"
            >
              <CheckIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Done (Enter)</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label="Dictate"
          className={cn("rounded-full", disabled && "opacity-50")}
          disabled={disabled}
          onClick={start}
          size="icon"
          type="button"
          variant="ghost"
        >
          <MicIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Dictate</TooltipContent>
    </Tooltip>
  );
};
