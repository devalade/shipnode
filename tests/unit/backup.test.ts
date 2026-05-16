import { describe, it, expect } from 'vitest';
import { scheduleToSystemd } from '../../src/cli/commands/backup.js';

describe('scheduleToSystemd', () => {
  it('maps hourly correctly', () => {
    expect(scheduleToSystemd('hourly')).toBe('*:00:00');
  });

  it('maps daily correctly', () => {
    expect(scheduleToSystemd('daily')).toBe('*-*-* 02:00:00');
  });

  it('maps weekly correctly', () => {
    expect(scheduleToSystemd('weekly')).toBe('Mon *-*-* 02:00:00');
  });
});
