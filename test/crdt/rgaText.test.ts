import { describe, expect, it } from 'vitest';
import { CrdtError, RgaText, minVectors, type RgaSnapshot } from '../../src/crdt/index.js';

describe('RgaText local editing', () => {
  it('inserts and deletes by visible index', () => {
    const doc = new RgaText('a');
    doc.insert(0, 'helo');
    doc.insert(3, 'l');
    expect(doc.text()).toBe('hello');
    doc.delete(0, 1);
    expect(doc.text()).toBe('ello');
    expect(doc.length).toBe(4);
    expect(doc.tombstones).toBe(1);
  });

  it('treats astral characters as single elements', () => {
    const doc = new RgaText('a');
    doc.insert(0, 'a😀b');
    expect(doc.length).toBe(3);
    doc.delete(1, 1);
    expect(doc.text()).toBe('ab');
  });

  it('rejects out of range edits with a typed error', () => {
    const doc = new RgaText('a');
    expect(() => doc.insert(1, 'x')).toThrow(CrdtError);
    doc.insert(0, 'ab');
    expect(() => doc.delete(1, 5)).toThrow(/outside/);
  });

  it('assigns increasing Lamport clocks chained by prev', () => {
    const doc = new RgaText('a');
    const ops = doc.insert(0, 'ab');
    expect(ops.map((op) => [op.id.c, op.prev])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(doc.stateVector()).toEqual({ a: 2 });
  });
});

describe('RgaText merging', () => {
  it('orders concurrent inserts at the same position deterministically', () => {
    const a = new RgaText('a');
    const b = new RgaText('b');
    const opsA = a.insert(0, 'A');
    const opsB = b.insert(0, 'B');
    b.apply(opsA);
    a.apply(opsB);
    expect(a.text()).toBe(b.text());
    // Equal clocks: the larger replica id wins the tie and comes first.
    expect(a.text()).toBe('BA');
  });

  it('keeps runs typed concurrently from interleaving', () => {
    const base = new RgaText('base');
    const seed = base.insert(0, '[]');
    const a = new RgaText('a');
    const b = new RgaText('b');
    a.apply(seed);
    b.apply(seed);
    const opsA = a.insert(1, 'hello');
    const opsB = b.insert(1, 'world');
    a.apply(opsB);
    b.apply(opsA);
    expect(a.text()).toBe(b.text());
    expect(['[helloworld]', '[worldhello]']).toContain(a.text());
  });

  it('buffers operations whose dependencies have not arrived yet', () => {
    const a = new RgaText('a');
    const ops = a.insert(0, 'abc');
    const b = new RgaText('b');
    const first = b.apply([ops[2]!, ops[1]!]);
    expect(first.applied).toHaveLength(0);
    expect(first.pending).toBe(2);
    const second = b.apply([ops[0]!]);
    expect(second.applied).toHaveLength(3);
    expect(b.text()).toBe('abc');
    expect(b.pendingCount).toBe(0);
  });

  it('is idempotent', () => {
    const a = new RgaText('a');
    const ops = [...a.insert(0, 'xy'), ...a.delete(0, 1)];
    const b = new RgaText('b');
    b.apply(ops);
    const again = b.apply(ops);
    expect(again.duplicates).toBe(ops.length);
    expect(b.text()).toBe('y');
  });

  it('applies concurrent deletes of the same element once', () => {
    const a = new RgaText('a');
    const seed = a.insert(0, 'xyz');
    const b = new RgaText('b');
    b.apply(seed);
    const delA = a.delete(1, 1);
    const delB = b.delete(1, 1);
    a.apply(delB);
    b.apply(delA);
    expect(a.text()).toBe('xz');
    expect(b.text()).toBe('xz');
  });

  it('rejects malformed operations', () => {
    const doc = new RgaText('a');
    expect(() =>
      doc.apply([{ type: 'insert', id: { r: 'b', c: 1 }, prev: 0, origin: null, value: 'too long' }]),
    ).toThrow(CrdtError);
    expect(() => doc.apply([{ type: 'insert', id: { r: 'b', c: 1 }, prev: 1, origin: null, value: 'x' }])).toThrow(
      /malformed/,
    );
  });
});

describe('RgaText anchors', () => {
  it('keeps a caret attached to its character across remote edits', () => {
    const a = new RgaText('a');
    const seed = a.insert(0, 'hello world');
    const b = new RgaText('b');
    b.apply(seed);
    const caret = b.anchorAt(6);
    a.apply(b.insert(0, '>> '));
    expect(a.resolveAnchor(caret)).toBe(9);
    a.delete(0, 9);
    expect(a.resolveAnchor(caret)).toBe(0);
    expect(a.resolveAnchor(null)).toBe(0);
  });
});

describe('RgaText snapshots and garbage collection', () => {
  it('round-trips through a snapshot', () => {
    const a = new RgaText('a');
    a.insert(0, 'abcdef');
    a.delete(2, 2);
    const restored = RgaText.fromSnapshot('a', JSON.parse(JSON.stringify(a.snapshot())) as RgaSnapshot);
    expect(restored.text()).toBe('abef');
    expect(restored.stateVector()).toEqual(a.stateVector());
    restored.insert(4, 'g');
    expect(restored.text()).toBe('abefg');
  });

  it('collects only tombstones that every replica has seen', () => {
    const a = new RgaText('a');
    const b = new RgaText('b');
    const ops = [...a.insert(0, 'abc'), ...a.delete(2, 1)];
    b.apply(ops.slice(0, 3));
    expect(a.collectGarbage(minVectors([a.stateVector(), b.stateVector()]))).toBe(0);
    b.apply(ops.slice(3));
    expect(a.collectGarbage(minVectors([a.stateVector(), b.stateVector()]))).toBe(1);
    expect(a.tombstones).toBe(0);
    expect(a.text()).toBe('ab');
  });

  it('keeps a tombstone that still anchors a live element', () => {
    const a = new RgaText('a');
    a.insert(0, 'ab');
    a.delete(0, 1);
    expect(a.collectGarbage(a.stateVector())).toBe(0);
    a.delete(0, 1);
    // Collecting "b" frees "a" in the same pass because children always sit to the right.
    expect(a.collectGarbage(a.stateVector())).toBe(2);
  });

  it('ignores a late concurrent delete of a collected element', () => {
    const a = new RgaText('a');
    const b = new RgaText('b');
    const seed = a.insert(0, 'xy');
    b.apply(seed);
    const delA = a.delete(1, 1);
    const delB = b.delete(1, 1);
    b.apply(delA);
    a.collectGarbage(minVectors([a.stateVector(), b.stateVector()]));
    expect(a.tombstones).toBe(0);
    expect(a.apply(delB).applied).toHaveLength(1);
    expect(a.text()).toBe('x');
  });
});
