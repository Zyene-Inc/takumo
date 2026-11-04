import { describe, expect, test } from "vitest";
import {
  answerEmail,
  replySubject,
  threadHeaders,
} from "../lib/inbound/ask-email";

describe("answering a question by email", () => {
  test("the reply stays in the thread", () => {
    expect(replySubject("Can we do 300 BRK-2201 by Fri?")).toBe(
      "Re: Can we do 300 BRK-2201 by Fri?"
    );
    expect(replySubject("RE: Can we do 300?")).toBe("RE: Can we do 300?");
    expect(replySubject(null)).toBe("Re: your question");
    expect(
      threadHeaders(
        new Map([
          ["message-id", "<b@x>"],
          ["references", "<a@x>"],
        ])
      )
    ).toEqual({ "In-Reply-To": "<b@x>", References: "<a@x> <b@x>" });
    expect(threadHeaders(new Map())).toEqual({});
  });

  test("the answer, the add-to-plan link and the conversation, no citation brackets", () => {
    const text = answerEmail({
      answer:
        "Answer: Yes, Thu Nov 12 [check NEW-261104-1].\n\nWhy: HAAS-VF2 is free [plan].",
      addToPlan: ["https://app/schedule/check?run=r1"],
      conversationUrl: "https://app/ask?c=c1",
    });
    expect(text).toContain("Answer: Yes, Thu Nov 12.");
    expect(text).not.toContain("[check");
    expect(text).toContain(
      "Add it to the plan (Takumo's plan only; nothing is written to your ERP): https://app/schedule/check?run=r1"
    );
    expect(text).toContain("https://app/ask?c=c1");
  });

  test("a clarifying question has no add-to-plan link", () => {
    const text = answerEmail({
      answer: "Which rev of BRK-2201: B or C?",
      addToPlan: [],
      conversationUrl: "https://app/ask?c=c2",
    });
    expect(text).not.toContain("Add it to the plan");
  });
});
