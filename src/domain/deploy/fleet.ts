import type { RemoteExecutor } from '../remote/executor.js';
import type { ReplicaRole } from './orchestrator.js';

/**
 * Rolling an operation across the servers one app runs on.
 *
 * This sits *above* `DeployOrchestrator`, which stays the unit of work for a
 * single replica — blue-green, health checks, release symlinks and locking are
 * all unchanged and intra-replica. The composition is: blue-green within a
 * replica, rolling across replicas.
 *
 * The operation itself is a callback — `applyToReplica` — so a deploy and a
 * rollback drive the same roll: same ordering, same partial-failure reporting.
 * Replicas are visited one at a time, in declaration order.
 */

/** A live connection to one replica, held across its turn. */
export interface ReplicaSession {
  executor: RemoteExecutor;
  close(): void;
}

export type ReplicaConnector = (serverName: string) => Promise<ReplicaSession>;

export type FleetEvent =
  | { type: 'applying'; server: string }
  | { type: 'applied'; server: string }
  | { type: 'failed'; server: string; message: string };

export interface FleetRollOptions {
  replicas: string[];
  connect: ReplicaConnector;
  /** Do the work on one replica — a deploy, a rollback, anything per-replica. */
  applyToReplica: (ctx: {
    serverName: string;
    executor: RemoteExecutor;
    releaseId?: string;
    /**
     * This replica's position in the roll, which decides where the run-once
     * `beforeFleet` / `afterFleet` hooks fire. A roll that dies partway never
     * reaches its last replica, so `afterFleet` correctly never runs.
     */
    role: ReplicaRole;
  }) => Promise<void>;
  /**
   * The fleet's primary server, where `placement: 'primary'` processes run.
   * Defaults to the first replica of this roll — pass it explicitly when the
   * roll has been narrowed (`--on`), so a partial roll cannot promote a
   * secondary replica and start a second scheduler.
   */
  primary?: string;
  /**
   * The release every replica should converge on, when the operation has one.
   * A deploy mints it up front so a converged fleet is distinguishable from a
   * half-rolled one; an instant blue-green rollback has no such name.
   */
  releaseId?: string;
  onEvent?: (event: FleetEvent) => void;
}

export interface FleetRollResult {
  releaseId?: string;
  /** Replicas the operation succeeded on, in the order they were rolled. */
  applied: string[];
  /** The replica that failed, if any. */
  failed?: { server: string; message: string };
  /** Replicas never reached because the roll stopped. Still on the old release. */
  skipped: string[];
}

/**
 * Roll an operation across an app's replicas, one at a time.
 *
 * Resolves rather than throwing on a replica failure: a partly-rolled fleet is
 * a real state the caller has to report, not an exception to unwind. Replicas
 * already updated keep serving the new release, untouched ones keep serving
 * the old — each replica stays in rotation the whole time, because its own
 * blue-green swap never drops traffic and a failed health check never flips
 * it away from the old release.
 */
export async function rollFleet(options: FleetRollOptions): Promise<FleetRollResult> {
  const { replicas, connect, applyToReplica, releaseId, onEvent } = options;
  const primary = options.primary ?? replicas[0];

  const applied: string[] = [];
  const remaining = [...replicas];

  for (const server of replicas) {
    const session = await connect(server);
    onEvent?.({ type: 'applying', server });

    try {
      try {
        await applyToReplica({
          serverName: server,
          executor: session.executor,
          releaseId,
          role: {
            first: server === replicas[0],
            last: server === replicas[replicas.length - 1],
            primary: server === primary,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onEvent?.({ type: 'failed', server, message });
        return {
          releaseId,
          applied,
          failed: { server, message },
          skipped: remaining.filter((s) => s !== server),
        };
      }

      onEvent?.({ type: 'applied', server });
      applied.push(server);
      remaining.splice(remaining.indexOf(server), 1);
    } finally {
      session.close();
    }
  }

  return { releaseId, applied, skipped: [] };
}
