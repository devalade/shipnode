import { RemoteExecutor } from '../../src/domain/remote/executor.js';
import type { ExecResult } from '../../src/shared/types.js';

export interface CommandLogEntry {
  command: string;
  options?: { timeout?: number };
  result: ExecResult;
}

/**
 * A test adapter satisfying RemoteExecutor.
 *
 * Callers record expected responses with `when()`, then inspect
 * the command history with `getHistory()` to assert behaviour.
 */
export class FakeRemoteExecutor extends RemoteExecutor {
  private log: CommandLogEntry[] = [];
  private matchers: Array<{
    predicate: (command: string) => boolean;
    result: ExecResult;
  }> = [];

  /**
   * Register a response for commands matching the predicate.
   * Responses are checked in registration order.
   */
  when(predicate: (command: string) => boolean, result: ExecResult): this {
    this.matchers.push({ predicate, result });
    return this;
  }

  async exec(command: string, options?: { timeout?: number }): Promise<ExecResult> {
    let result: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

    for (const matcher of this.matchers) {
      if (matcher.predicate(command)) {
        result = matcher.result;
        break;
      }
    }

    const entry: CommandLogEntry = { command, options, result };
    this.log.push(entry);
    return result;
  }

  getHistory(): readonly CommandLogEntry[] {
    return this.log;
  }

  getLastCommand(): CommandLogEntry | undefined {
    return this.log[this.log.length - 1];
  }

  clear(): void {
    this.log = [];
    this.matchers = [];
  }
}
