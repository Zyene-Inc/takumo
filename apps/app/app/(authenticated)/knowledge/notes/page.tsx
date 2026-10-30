import { database, forOrg } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { factLabel } from "@/lib/facts/attributes";
import { canTranscribe } from "@/lib/facts/transcribe";
import { Header } from "../../components/header";
import { EmptyState } from "../../shop/components/format";
import { NoteRecorder } from "./recorder";
import { RetryNote } from "./retry-note";

export const metadata: Metadata = { title: "Voice notes · Takumo" };
// Reading a note calls Claude.
export const maxDuration = 120;

const NotesPage = async () => {
  const { orgId } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const notes = await forOrg(database, orgId).note.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      facts: {
        orderBy: { number: "asc" },
        select: { number: true, status: true },
      },
    },
  });

  return (
    <>
      <Header page="Voice notes" pages={["Knowledge"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          Operators and supervisors say what they know: real setup times, which
          machine runs a part best, why a part fails. Takumo turns it into facts
          for a supervisor to approve.
        </p>
        <NoteRecorder canTranscribeFiles={canTranscribe()} />
        <h2 className="font-medium">Recent notes</h2>
        {notes.length === 0 ? (
          <EmptyState>No notes yet.</EmptyState>
        ) : (
          <div className="grid gap-2">
            {notes.map((note) => (
              <div
                className="grid gap-1 rounded-xl border p-3 text-sm"
                key={note.id}
              >
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                  <Badge variant="outline">
                    {note.kind === "voice" ? "Voice" : "Typed"}
                  </Badge>
                  {note.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  {note.durationSec
                    ? ` · ${Math.round(note.durationSec)} s`
                    : ""}
                  {note.status === "failed" && (
                    <Badge variant="destructive">Couldn't read</Badge>
                  )}
                  {note.facts.length > 0 && (
                    <span>
                      · facts:{" "}
                      {note.facts.map((f) => (
                        <Link
                          className="mr-1 font-medium text-foreground underline"
                          href={`/knowledge/facts?f=${factLabel(f.number)}`}
                          key={f.number}
                        >
                          {factLabel(f.number)}
                        </Link>
                      ))}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-line">{note.text}</p>
                {note.status === "failed" && <RetryNote id={note.id} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};

export default NotesPage;
