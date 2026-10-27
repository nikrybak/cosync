import { describe, expect, it } from 'vitest';
import { Mailbox } from '../../src/domain/mailbox.js';
import { PresenceTracker } from '../../src/domain/presence.js';

describe('Mailbox', () => {
  it('runs tasks one at a time in posting order, even across awaits', async () => {
    const mailbox = new Mailbox();
    const trace: string[] = [];
    const slow = mailbox.post(async () => {
      trace.push('slow:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      trace.push('slow:end');
    });
    const fast = mailbox.post(() => {
      trace.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(trace).toEqual(['slow:start', 'slow:end', 'fast']);
  });

  it('keeps going after a failing task', async () => {
    const mailbox = new Mailbox();
    await expect(mailbox.post(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(mailbox.post(() => 42)).resolves.toBe(42);
    await mailbox.drain();
    expect(mailbox.size).toBe(0);
  });
});

describe('PresenceTracker', () => {
  it('tracks cursors and expires idle sessions', () => {
    const presence = new PresenceTracker();
    presence.join('a', 'ra', { name: 'A', color: '#000' }, 0);
    presence.join('b', 'rb', { name: 'B', color: '#fff' }, 0);
    presence.updateCursor('a', { anchor: { r: 'ra', c: 1 }, head: null }, 900);
    expect(presence.list('b').map((p) => p.cursor)).toEqual([{ anchor: { r: 'ra', c: 1 }, head: null }]);
    expect(presence.expire(1_000, 500)).toEqual(['b']);
    expect(presence.size).toBe(1);
    expect(presence.updateCursor('b', null, 1_000)).toBeNull();
  });
});
