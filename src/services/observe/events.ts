/**
 * What a tick noticed, as values rather than rendered strings.
 *
 * The old monitor built `chalk.red(...)` strings inside its polling hook,
 * which put a presentation decision in the data layer and left `--json` with
 * nothing but ANSI escapes to emit. Colour and wording are chosen at render.
 */
export type ObserveEvent =
  | { kind: 'health-failing'; at: string; server: string; app: string; streak: number }
  | { kind: 'health-recovered'; at: string; server: string; app: string }
  | { kind: 'server-unreachable'; at: string; server: string; message: string }
  | { kind: 'server-recovered'; at: string; server: string }
  | { kind: 'app-error'; at: string; server: string; app: string; message: string }
  | { kind: 'notice'; at: string; message: string };
