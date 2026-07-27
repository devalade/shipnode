/**
 * Did the fleet converge?
 *
 * A rolling deploy touches replicas one batch at a time, so an interrupted roll
 * leaves the fleet serving two different releases at once. That state is
 * legitimate mid-roll and a bug afterwards, and nothing about a single replica
 * reveals it — `status` has to compare them. The same comparison catches a
 * replica left drained by a failed roll, which is silently out of rotation and
 * will stay that way until someone notices.
 */

export interface ReplicaObservation {
  server: string;
  /** The release directory `current` points at, or null if there is no release. */
  release: string | null;
  /** Whether the replica is out of rotation. Null for an app with no drain contract. */
  drained: boolean | null;
}

export interface FleetConvergence {
  /** Distinct releases seen, newest-sorting first. One entry means converged. */
  releases: string[];
  /** Replicas out of rotation. */
  drained: string[];
  /** Replicas with no release at all. */
  undeployed: string[];
  converged: boolean;
}

export function assessConvergence(observations: ReplicaObservation[]): FleetConvergence {
  const releases = [...new Set(
    observations.map((o) => o.release).filter((r): r is string => r !== null),
  )].sort().reverse();

  const drained = observations.filter((o) => o.drained === true).map((o) => o.server);
  const undeployed = observations.filter((o) => o.release === null).map((o) => o.server);

  return {
    releases,
    drained,
    undeployed,
    // A replica with no release at all is as much a failure to converge as two
    // different releases — the fleet is not uniformly serving anything.
    converged: releases.length <= 1 && undeployed.length === 0 && drained.length === 0,
  };
}

/** Human-readable lines describing what is wrong, empty when the fleet is converged. */
export function describeConvergence(
  appName: string,
  observations: ReplicaObservation[],
  convergence: FleetConvergence,
): string[] {
  if (convergence.converged) return [];

  const lines: string[] = [];
  const at = (release: string): string =>
    observations.filter((o) => o.release === release).map((o) => o.server).join(', ');

  if (convergence.releases.length > 1) {
    lines.push(
      `${appName} is running ${convergence.releases.length} different releases: ` +
      convergence.releases.map((release) => `${release} on ${at(release)}`).join('; ') +
      `. A roll stopped partway — redeploy to converge the fleet.`,
    );
  }

  if (convergence.undeployed.length > 0) {
    lines.push(`${appName} has no release on ${convergence.undeployed.join(', ')}.`);
  }

  if (convergence.drained.length > 0) {
    lines.push(
      `${appName} is out of rotation on ${convergence.drained.join(', ')} — ` +
      `the load balancer is sending it no traffic. Run 'shipnode undrain --app ${appName}' ` +
      `once it is healthy.`,
    );
  }

  return lines;
}
