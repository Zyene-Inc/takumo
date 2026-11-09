"use client";

import { Streamdown } from "streamdown";

/** A help article's Markdown, styled like Ask Takumo's answers. */
export const ArticleBody = ({ markdown }: { markdown: string }) => (
  <div className="max-w-3xl">
    <Streamdown
      className="text-base leading-relaxed [&_li]:my-1 [&_ol]:my-3 [&_p]:my-3 [&_ul]:my-3"
      controls={{ code: false, table: false, mermaid: false }}
    >
      {markdown}
    </Streamdown>
  </div>
);
