import type { FleetConfig, ShipnodeApp } from '../../shared/types.js';
import type { RemoteExecutor } from '../remote/executor.js';
import { drain, undrain } from './drain.js';
import type { ReplicaRole } from './orchestrator.js';

/**
 * Rolling an operation across the servers one app runs on.
 *
 * This sits *above* `DeployOrchestrator`, which stays the unit of work for a
 * single replica — blue-green, health checks, release symlinks and locking are
 * all unchanged and intra-replica. The composition is: blue-green within a
 * replica, rolling across replicas.
 *
 * The invariant it exists to hold is that no more than `batch` replicas are out
 * of rotation at once, and that a replica is out of rotation before anything
 * touches it. That is true of a rollback as much as a deploy, so the operation
 * itself is a callback — `applyToReplica` — and both commands drive the same
 * batching, drain timing and partial-failure reporting.
 */

/** A live connection to one replica, held across its whole drain/apply/undrain turn. */
export interface ReplicaSession {
  executor: RemoteExecutor;
  close(): void;
}

export type ReplicaConnector = (serverName: string) => Promise<ReplicaSession>;

export type FleetEvent =
  | { type: 'batch'; servers: string[] }
  | { type: 'drained'; servers: string[]; waitSeconds: number }
  | { type: 'applying'; server: string }
  | { type: 'applied'; server: string }
  | { type: 'undrained'; server: string }
  | { type: 'failed'; server: string; message: string };

export interface FleetRollOptions {
  app: ShipnodeApp;
  fleet: FleetConfig;
  replicas: string[];
  remotePath: string;
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
  /** Injected so tests do not wait out a real drain. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FleetRollResult {
  releaseId?: string;
  /** Replicas the operation succeeded on, in the order they were rolled. */
  applied: string[];
  /** The replica that failed, if any. It is deliberately left out of rotation. */
  failed?: { server: string; message: string };
  /** Replicas never reached because the roll stopped. Still on the old release. */
  skipped: string[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function batches<T>(items: T[], size: number): T[][] {
  const grouped: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    grouped.push(items.slice(index, index + size));
  }
  return grouped;
}

/**
 * Roll an operation across `app`'s replicas.
 *
 * Resolves rather than throwing on a replica failure: a partly-rolled fleet is
 * a real state the caller has to report, not an exception to unwind. Replicas
 * already updated keep serving the new release, untouched ones keep serving the
 * old, and the failed replica stays drained so it is out of rotation and safe
 * to inspect.
 */
export async function rollFleet(options: FleetRollOptions): Promise<FleetRollResult> {
  const { app, fleet, replicas, remotePath, connect, applyToReplica, releaseId, onEvent } = options;
  const sleep = options.sleep ?? defaultSleep;

  const applied: string[] = [];
  const remaining = [...replicas];

  for (const batch of batches(replicas, fleet.batch)) {
    onEvent?.({ type: 'batch', servers: batch });

    const sessions = new Map<string, ReplicaSession>();
    let failure: { server: string; message: string } | undefined;

    try {
      for (const server of batch) {
        sessions.set(server, await connect(server));
      }

      // Drain the whole batch first, then wait once. The load balancer needs
      // `drainWait` to notice regardless of how many replicas flipped, so
      // waiting per replica would just multiply the same delay.
      for (const server of batch) {
        await drain(sessions.get(server)!.executor, remotePath, app.name);
      }
      onEvent?.({ type: 'drained', servers: batch, waitSeconds: fleet.drainWait });
      await sleep(fleet.drainWait * 1000);

      for (const server of batch) {
        const session = sessions.get(server)!;
        onEvent?.({ type: 'applying', server });

        try {
          await applyToReplica({
            serverName: server,
            executor: session.executor,
            releaseId,
            role: {
              first: server === replicas[0],
              last: server === replicas[replicas.length - 1],
              primary: server === (options.primary ?? replicas[0]),
            },
          });
        } catch (error) {
          failure = { server, message: error instanceof Error ? error.message : String(error) };
          onEvent?.({ type: 'failed', server, message: failure.message });
          break;
        }

        onEvent?.({ type: 'applied', server });
        applied.push(server);
        remaining.splice(remaining.indexOf(server), 1);

        // Back into rotation only once this replica is serving the new release.
        await undrain(session.executor, remotePath, app.name);
        onEvent?.({ type: 'undrained', server });
      }

      // Anything in this batch we drained but never touched is still healthy on
      // the old release, so it belongs back in rotation. The replica that
      // actually failed is not — it stays drained.
      for (const server of batch) {
        if (applied.includes(server) || server === failure?.server) continue;
        await undrain(sessions.get(server)!.executor, remotePath, app.name);
        onEvent?.({ type: 'undrained', server });
      }
    } finally {
      for (const session of sessions.values()) session.close();
    }

    if (failure) {
      return { releaseId, applied, failed: failure, skipped: remaining.filter((s) => s !== failure.server) };
    }
  }

  return { releaseId, applied, skipped: [] };
}
