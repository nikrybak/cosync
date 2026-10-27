import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RgaText, minVectors, type Operation } from '../../src/crdt/index.js';
import { mulberry32, shuffled } from '../support/random.js';

type Action =
  | { kind: 'insert'; replica: number; at: number; text: string }
  | { kind: 'delete'; replica: number; at: number; count: number }
  | { kind: 'receive'; replica: number; fraction: number };

const actionArb = (replicas: number): fc.Arbitrary<Action> =>
  fc.oneof(
    fc.record({
      kind: fc.constant('insert' as const),
      replica: fc.nat(replicas - 1),
      at: fc.double({ min: 0, max: 1, noNaN: true }),
      text: fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', '😀') }),
    }),
    fc.record({
      kind: fc.constant('delete' as const),
      replica: fc.nat(replicas - 1),
      at: fc.double({ min: 0, max: 1, noNaN: true }),
      count: fc.integer({ min: 1, max: 3 }),
    }),
    fc.record({
      kind: fc.constant('receive' as const),
      replica: fc.nat(replicas - 1),
      fraction: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  );

interface World {
  readonly docs: RgaText[];
  readonly log: Operation[];
}

function run(world: World, actions: readonly Action[], rand: () => number): void {
  for (const action of actions) {
    const doc = world.docs[action.replica]!;
    if (action.kind === 'insert') {
      world.log.push(...doc.insert(Math.floor(action.at * (doc.length + 1)) % (doc.length + 1), action.text));
    } else if (action.kind === 'delete') {
      if (doc.length === 0) continue;
      const at = Math.floor(action.at * doc.length) % doc.length;
      world.log.push(...doc.delete(at, Math.min(action.count, doc.length - at)));
    } else {
      // Partial, unordered delivery: a random subset of everything produced so far.
      const subset = shuffled(world.log, rand).slice(0, Math.floor(action.fraction * world.log.length));
      doc.apply(subset);
    }
  }
}

function deliverEverything(world: World, rand: () => number): void {
  for (const doc of world.docs) doc.apply(shuffled(world.log, rand));
}

const settings = { numRuns: 150 };

describe('RgaText convergence (property)', () => {
  it('replicas converge after receiving all operations in arbitrary orders', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 4 })
          .chain((n) => fc.tuple(fc.constant(n), fc.array(actionArb(n), { maxLength: 60 }), fc.integer())),
        ([replicas, actions, seed]) => {
          const rand = mulberry32(seed);
          const world: World = { docs: Array.from({ length: replicas }, (_, i) => new RgaText(`r${i}`)), log: [] };
          run(world, actions, rand);
          deliverEverything(world, rand);
          const texts = world.docs.map((d) => d.text());
          expect(new Set(texts).size).toBe(1);
          for (const doc of world.docs) expect(doc.pendingCount).toBe(0);
        },
      ),
      settings,
    );
  });

  it('matches a sequential model when there is a single writer', () => {
    fc.assert(
      fc.property(fc.array(actionArb(1), { maxLength: 80 }), (actions) => {
        const doc = new RgaText('solo');
        let model = '';
        for (const action of actions) {
          const chars = [...model];
          if (action.kind === 'insert') {
            const at = Math.floor(action.at * (chars.length + 1)) % (chars.length + 1);
            doc.insert(at, action.text);
            chars.splice(at, 0, ...action.text);
          } else if (action.kind === 'delete' && chars.length > 0) {
            const at = Math.floor(action.at * chars.length) % chars.length;
            const count = Math.min(action.count, chars.length - at);
            doc.delete(at, count);
            chars.splice(at, count);
          }
          model = chars.join('');
        }
        expect(doc.text()).toBe(model);
      }),
      settings,
    );
  });

  it('garbage collection on one replica does not break later convergence', () => {
    fc.assert(
      fc.property(
        fc.array(actionArb(3), { maxLength: 40 }),
        fc.array(actionArb(3), { maxLength: 40 }),
        fc.integer(),
        (before, after, seed) => {
          const rand = mulberry32(seed);
          const world: World = { docs: [0, 1, 2].map((i) => new RgaText(`r${i}`)), log: [] };
          run(world, before, rand);
          deliverEverything(world, rand);
          const textBefore = world.docs[0]!.text();
          const stable = minVectors(world.docs.map((d) => d.stateVector()));
          world.docs[0]!.collectGarbage(stable);
          expect(world.docs[0]!.text()).toBe(textBefore);
          expect(world.docs[0]!.tombstones).toBeLessThanOrEqual(world.docs[1]!.tombstones);

          run(world, after, rand);
          deliverEverything(world, rand);
          const texts = world.docs.map((d) => d.text());
          expect(new Set(texts).size).toBe(1);
        },
      ),
      settings,
    );
  });

  it('a snapshot restored mid-stream keeps converging', () => {
    fc.assert(
      fc.property(fc.array(actionArb(2), { maxLength: 40 }), fc.integer(), (actions, seed) => {
        const rand = mulberry32(seed);
        const world: World = { docs: [new RgaText('r0'), new RgaText('r1')], log: [] };
        run(world, actions.slice(0, actions.length / 2), rand);
        world.docs[1] = RgaText.fromSnapshot('r1', structuredClone(world.docs[1]!.snapshot()));
        run(world, actions.slice(actions.length / 2), rand);
        deliverEverything(world, rand);
        expect(world.docs[0]!.text()).toBe(world.docs[1].text());
      }),
      settings,
    );
  });
});
