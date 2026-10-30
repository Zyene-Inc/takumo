"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import { MicIcon, SquareIcon, UploadIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { submitNote, transcribe } from "./actions";

// The browser's speech recognition (Chrome, Edge, Safari). Not in TS's DOM types.
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
      }) => void)
    | null;
  start: () => void;
  stop: () => void;
}

const speechRecognition = () => {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** Live speech-to-text in the browser, if it can; final and partial text. */
const liveTranscript = (
  onFinal: (text: string) => void,
  onPartial: (text: string) => void
) => {
  const Speech = speechRecognition();
  if (!Speech) {
    return null;
  }
  const r = new Speech();
  r.continuous = true;
  r.interimResults = true;
  r.lang = navigator.language || "en-US";
  r.onresult = (event) => {
    let finalText = "";
    let partial = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) {
        finalText += result[0].transcript;
      } else {
        partial += result[0].transcript;
      }
    }
    if (finalText.trim()) {
      onFinal(finalText.trim());
    }
    onPartial(partial);
  };
  r.start();
  return r;
};

/** Record from the microphone; `onDone` gets the audio when it stops. */
const recordAudio = async (onDone: (audio: Blob) => void) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    onDone(new Blob(chunks, { type: rec.mimeType }));
  };
  rec.start();
  return rec;
};

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

const savedText = (proposed: string[], skipped: string[]) => {
  if (proposed.length) {
    return `Saved. ${proposed.length} fact${proposed.length === 1 ? "" : "s"} for review:`;
  }
  return `Saved. No new facts in it${skipped.length ? ` (${skipped.join("; ")})` : ""}.`;
};

/** Upload a recording made elsewhere (needs server transcription). */
const AudioUpload = ({
  canTranscribe,
  disabled,
  onFile,
}: {
  canTranscribe: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  if (!canTranscribe) {
    return (
      <p className="text-muted-foreground text-sm">
        Transcribing audio files needs an OpenAI key (OPENAI_API_KEY). Recording
        here works without one.
      </p>
    );
  }
  return (
    <>
      <Button
        className="justify-self-start"
        disabled={disabled}
        onClick={() => input.current?.click()}
        variant="outline"
      >
        <UploadIcon /> Choose a recording
      </Button>
      <input
        accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.mp4"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            onFile(f);
          }
        }}
        ref={input}
        type="file"
      />
    </>
  );
};

export const NoteRecorder = ({
  canTranscribeFiles,
}: {
  canTranscribeFiles: boolean;
}) => {
  const router = useRouter();
  const [tab, setTab] = useState("voice");
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [kind, setKind] = useState<"voice" | "typed">("voice");
  const [supported, setSupported] = useState(true);
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
    facts?: string[];
  } | null>(null);
  const [pending, start] = useTransition();
  const recognition = useRef<Recognition | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const started = useRef(0);

  useEffect(() => {
    setSupported(Boolean(speechRecognition()) || canTranscribeFiles);
  }, [canTranscribeFiles]);

  useEffect(() => {
    if (!recording) {
      return;
    }
    const timer = setInterval(
      () => setSeconds((Date.now() - started.current) / 1000),
      500
    );
    return () => clearInterval(timer);
  }, [recording]);

  const fromAudio = (blob: Blob, name: string) =>
    start(async () => {
      const form = new FormData();
      form.set("audio", new File([blob], name, { type: blob.type }));
      const r = await transcribe(form);
      if (r.ok) {
        setText(r.text);
        setKind("voice");
        setSeconds(r.durationSec ?? seconds);
      } else {
        setMessage({ error: true, text: r.error });
      }
    });

  const startRecording = async () => {
    setMessage(null);
    setText("");
    setInterim("");
    recognition.current = liveTranscript(
      (final) => setText((t) => `${t}${t ? " " : ""}${final}`),
      setInterim
    );
    // Keep the audio too when the server can transcribe it (more accurate).
    if (canTranscribeFiles) {
      try {
        recorder.current = await recordAudio((blob) =>
          fromAudio(blob, "note.webm")
        );
      } catch {
        setMessage({
          error: true,
          text: "Takumo can't use the microphone. Allow it in the browser, or type the note.",
        });
        recognition.current?.stop();
        return;
      }
    }
    started.current = Date.now();
    setSeconds(0);
    setKind("voice");
    setRecording(true);
  };

  const stopRecording = () => {
    recognition.current?.stop();
    recognition.current = null;
    recorder.current?.stop();
    recorder.current = null;
    setInterim("");
    setRecording(false);
  };

  const save = () =>
    start(async () => {
      const r = await submitNote({
        kind,
        text,
        durationSec: kind === "voice" ? Math.round(seconds) : null,
      });
      if (r.ok) {
        setText("");
        setMessage({
          error: false,
          facts: r.proposed,
          text: savedText(r.proposed, r.skipped),
        });
        router.refresh();
      } else {
        setMessage({ error: true, text: r.error });
      }
    });

  return (
    <div className="grid gap-3 rounded-xl border p-4">
      <Tabs onValueChange={setTab} value={tab}>
        <TabsList>
          <TabsTrigger value="voice">Record</TabsTrigger>
          <TabsTrigger value="typed">Type</TabsTrigger>
          <TabsTrigger value="file">Upload audio</TabsTrigger>
        </TabsList>
        <TabsContent className="grid gap-3" value="voice">
          {supported ? (
            <div className="flex items-center gap-3">
              <Button
                className={cn(recording && "animate-pulse")}
                disabled={pending}
                onClick={recording ? stopRecording : startRecording}
                variant={recording ? "destructive" : "default"}
              >
                {recording ? <SquareIcon /> : <MicIcon />}
                {recording ? "Stop" : "Start recording"}
              </Button>
              {recording && (
                <span className="font-mono text-sm">{clock(seconds)}</span>
              )}
              <span className="text-muted-foreground text-sm">
                Say what you know, e.g. "Setup on the OKUMA for P-2001 is really
                two hours, the bar puller has to be reset."
              </span>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              This browser can't transcribe speech. Use Chrome, Edge or Safari,
              or type the note.
            </p>
          )}
        </TabsContent>
        <TabsContent value="typed">
          <p className="text-muted-foreground text-sm">
            Type what you know about a job, machine or part.
          </p>
        </TabsContent>
        <TabsContent className="grid gap-2" value="file">
          <AudioUpload
            canTranscribe={canTranscribeFiles}
            disabled={pending}
            onFile={(f) => fromAudio(f, f.name)}
          />
        </TabsContent>
      </Tabs>
      <Textarea
        aria-label="Note"
        onChange={(e) => {
          setText(e.target.value);
          if (tab === "typed") {
            setKind("typed");
          }
        }}
        placeholder={
          tab === "typed"
            ? "P-2001 chatters above 1,200 rpm on the OKUMA; run it at 1,000."
            : "The transcript shows up here. Fix anything it got wrong before saving."
        }
        rows={4}
        value={interim ? `${text} ${interim}` : text}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={pending || recording || text.trim().length < 3}
          onClick={save}
        >
          {pending && <Spinner />} {pending ? "Reading it…" : "Save note"}
        </Button>
        {message && (
          <span className={cn("text-sm", message.error && "text-destructive")}>
            {message.text}{" "}
            {message.facts?.map((f) => (
              <Link
                className="mr-1 font-medium underline"
                href={`/knowledge/facts?f=${f}`}
                key={f}
              >
                {f}
              </Link>
            ))}
          </span>
        )}
      </div>
    </div>
  );
};
