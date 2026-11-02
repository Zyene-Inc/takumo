// One JSON object per line on stdout. Never pass message bodies or secrets.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`
  );
}
