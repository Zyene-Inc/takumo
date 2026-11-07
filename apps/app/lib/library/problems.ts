// Problems with a document that people are told about, in words written for
// them (never an AI provider's own error text). No dependencies, so the
// upload stream and email replies can recognise them cheaply.

/** Reading or storing a document went wrong in a way worth explaining. */
export class DocumentProblem extends Error {
  readonly permanent: boolean;
  constructor(message: string, { permanent }: { permanent: boolean }) {
    super(message);
    this.name = "DocumentProblem";
    this.permanent = permanent;
  }
}

/** Storing the original failed; nothing was kept. */
export class OriginalNotStoredError extends Error {
  constructor() {
    super("Couldn't save the file just now. Try again in a minute.");
    this.name = "OriginalNotStoredError";
  }
}
