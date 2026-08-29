import { describe, expect, it } from 'vitest';
import {
  assessConvergence,
  describeConvergence,
  type ReplicaObservation,
} from '../../src/domain/deploy/convergence.js';

const replica = (server: string, release: string | null): ReplicaObservation => ({ server, release });

describe('assessConvergence', () => {
  it('is converged when every replica serves the same release', () => {
    const result = assessConvergence([
      replica('web-a', '2026-01-02'),
      replica('web-b', '2026-01-02'),
    ]);

    expect(result.converged).toBe(true);
    expect(result.releases).toEqual(['2026-01-02']);
  });

  it('reports skew newest first, which is the release the roll was heading to', () => {
    const result = assessConvergence([
      replica('web-a', '2026-01-02'),
      replica('web-b', '2026-01-01'),
      replica('web-c', '2026-01-01'),
    ]);

    expect(result.converged).toBe(false);
    expect(result.releases).toEqual(['2026-01-02', '2026-01-01']);
  });

  it('counts a replica with no release as not converged', () => {
    // Uniform in the sense that one release is present, but a replica serving
    // nothing is exactly the failure this is meant to surface.
    const result = assessConvergence([replica('web-a', '2026-01-02'), replica('web-b', null)]);

    expect(result.converged).toBe(false);
    expect(result.undeployed).toEqual(['web-b']);
  });
});

describe('describeConvergence', () => {
  it('says nothing when the fleet is converged', () => {
    const observations = [replica('web-a', '2026-01-02'), replica('web-b', '2026-01-02')];

    expect(describeConvergence('api', observations, assessConvergence(observations))).toEqual([]);
  });

  it('names which replicas are on which release', () => {
    const observations = [
      replica('web-a', '2026-01-02'),
      replica('web-b', '2026-01-01'),
      replica('web-c', '2026-01-01'),
    ];

    const [line] = describeConvergence('api', observations, assessConvergence(observations));

    expect(line).toContain('2026-01-02 on web-a');
    expect(line).toContain('2026-01-01 on web-b, web-c');
    expect(line).toContain('redeploy to converge');
  });

  it('names a replica with no release', () => {
    const observations = [replica('web-a', '2026-01-02'), replica('web-b', null)];

    const lines = describeConvergence('api', observations, assessConvergence(observations));

    expect(lines.join(' ')).toContain('no release on web-b');
  });
});
