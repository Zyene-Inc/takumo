// The agent ends an answer with optional blocks the chat shows as buttons:
//
//   <options>          choices for a clarifying question; one click answers it
//   - rev A
//   - rev B
//   </options>
//   <follow-ups>       next questions worth asking
//   - Which machine is the bottleneck?
//   </follow-ups>
//
// Pure (no server code): the chat UI, the route and the evals all split answers.

const BLOCK = /<(options|follow-ups)>([\s\S]*?)(?:<\/\1>|$)/gi;
/** A block or tag still streaming in, e.g. "<follow-u" at the very end. */
const PARTIAL_TAG = /<\/?[a-z-]*$/i;
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/;

const MAX_ITEMS = 4;
const MAX_ITEM_CHARS = 120;

export interface SplitAnswer {
  /** The answer without the blocks: what's shown and checked for citations. */
  body: string;
  followUps: string[];
  options: string[];
}

const items = (block: string) =>
  block
    .split("\n")
    .filter((line) => ITEM.test(line))
    .map((line) => line.replace(ITEM, "").trim())
    .filter((line) => line.length > 0 && line.length <= MAX_ITEM_CHARS)
    .slice(0, MAX_ITEMS);

export const splitAnswer = (text: string): SplitAnswer => {
  const followUps: string[] = [];
  const options: string[] = [];
  const body = text
    .replace(BLOCK, (_, kind: string, inner: string) => {
      (kind.toLowerCase() === "options" ? options : followUps).push(
        ...items(inner)
      );
      return "";
    })
    .replace(PARTIAL_TAG, "")
    .trimEnd();
  return {
    body,
    followUps: followUps.slice(0, MAX_ITEMS),
    options: options.slice(0, MAX_ITEMS),
  };
};

export const ASK_MODES = ["auto", "quick", "thorough"] as const;
export type AskMode = (typeof ASK_MODES)[number];
/** The model a question actually ran on. */
export type AnswerMode = Exclude<AskMode, "auto">;

/** Questions that obviously need the agent model: no classifier call needed. */
const NEEDS_THOROUGH =
  /\b(can we|could we|should we|what if|what happens|take (?:on|the|this|an?)|quote|price|charge|cost|lead time|overtime|ship .* by|make .* by|deliver|scenario|capacity|bottleneck|compare|why|plan|prioriti[sz]e|recommend)\b/i;

export const hintedMode = (question: string): AnswerMode | null =>
  NEEDS_THOROUGH.test(question) ? "thorough" : null;
