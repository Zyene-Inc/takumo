"use client";

import {
  type AnchorHTMLAttributes,
  type ImgHTMLAttributes,
  useMemo,
} from "react";
import { Streamdown } from "streamdown";
import { linkCitations, type Source } from "@/lib/agent/citations";
import { CitationMark } from "./source-chips";

const SAFE_LINK = /^(https?:\/\/|\/(?!\/))/i;

/** Footnote numbers for an answer: sources in order of first citation. */
export const citationNumbers = (
  texts: string[],
  registry: ReadonlyMap<string, Source>
) => {
  const numbers = new Map<string, number>();
  for (const text of texts) {
    for (const source of linkCitations(text, registry).cited) {
      if (!numbers.has(source.id)) {
        numbers.set(source.id, numbers.size + 1);
      }
    }
  }
  return numbers;
};

/**
 * A link in an answer that isn't a citation. Only links within the app can
 * be clicked. An answer can repeat text planted in a document ("click here",
 * with what the person may read in the address), so a web address is shown
 * as text, in full, and never opened from here (audit G3-A).
 */
const PlainLink = ({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) => {
  if (!(href && SAFE_LINK.test(href))) {
    return <span>{children}</span>;
  }
  if (!href.startsWith("/")) {
    return (
      <span>
        {children}
        {typeof children === "string" && children === href
          ? null
          : ` (${href})`}
      </span>
    );
  }
  return (
    <a {...props} className="underline" href={href}>
      {children}
    </a>
  );
};

/** Markdown answer with [kind id] citations turned into chips. */
export const AnswerText = ({
  text,
  registry,
  numbers,
  streaming,
}: {
  numbers: ReadonlyMap<string, number>;
  registry: ReadonlyMap<string, Source>;
  streaming: boolean;
  text: string;
}) => {
  const { markdown, cited } = useMemo(
    () => linkCitations(text, registry),
    [text, registry]
  );
  const components = useMemo(
    () => ({
      a: ({
        href,
        children,
        ...props
      }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
        const index = href?.startsWith("#cite-") ? Number(href.slice(6)) : -1;
        const source = cited[index];
        if (source) {
          return (
            <CitationMark
              n={numbers.get(source.id) ?? index + 1}
              source={source}
            />
          );
        }
        return (
          <PlainLink {...props} href={href}>
            {children}
          </PlainLink>
        );
      },
      // Answers never load images: an image address would be fetched
      // without a click, with whatever the model put in it (audit G3-A).
      img: ({ alt }: ImgHTMLAttributes<HTMLImageElement>) =>
        alt ? <span>{alt}</span> : null,
    }),
    [cited, numbers]
  );
  return (
    <Streamdown
      className="text-base leading-relaxed [&_li]:my-0.5 [&_p]:my-2 [&_ul]:my-2"
      components={components}
      controls={{ code: true, table: true, mermaid: false }}
      isAnimating={streaming}
    >
      {markdown}
    </Streamdown>
  );
};
