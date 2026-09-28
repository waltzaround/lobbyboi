// Snapshot delta codec.
//
// A snapshot state is a plain object. Top-level fields are diffed by their JSON
// fingerprint. Top-level arrays whose items all have a string `id` are treated
// as entity lists and diffed per entity and per field, so a moving player costs
// `{id, set: {x, y}}` rather than the whole object. Anything else is sent whole
// when it changes. Empty parts of a patch are left out entirely.
//
// The encoder emits a full keyframe every `keyframeEvery` frames and whenever a
// delta would not be smaller than the full state. The decoder returns null when
// it sees a gap, and the client then asks for a resync.

import type { DeltaPatch } from '../protocol.js';

type Fields = Record<string, unknown>;
type Entity = Fields & { id: string };
type Prints = Map<string, string>;
type ListPatch = NonNullable<DeltaPatch['lists']>[string];
type Upsert = NonNullable<ListPatch['upserts']>[number];

const isEntityList = (value: unknown): value is Entity[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => item && typeof item === 'object' && typeof (item as Entity).id === 'string');

function prints(object: object): Prints {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(object)) {
    const json = JSON.stringify(value);
    if (json !== undefined) out.set(key, json);
  }
  return out;
}

function diff(current: Prints, previous: Prints) {
  const set: Fields = {};
  let changed = false;
  for (const [key, json] of current)
    if (json !== previous.get(key)) {
      set[key] = JSON.parse(json);
      changed = true;
    }
  const unset = [...previous.keys()].filter((key) => !current.has(key));
  return { set: changed ? set : undefined, unset: unset.length ? unset : undefined };
}

export type Encoded =
  | { kind: 'full'; frame: number; state: Fields }
  | { kind: 'delta'; frame: number; base: number; patch: DeltaPatch };

export class DeltaEncoder {
  private frame = 0;
  /** Plain fields by fingerprint; entity lists are marked with a `#name` key. */
  private fields?: Prints;
  private lists = new Map<string, Map<string, Prints>>();

  constructor(private keyframeEvery = 60) {}

  /** Forget the baseline. The next encode is a keyframe. */
  reset() {
    this.fields = undefined;
    this.lists.clear();
  }

  encode(state: Fields): Encoded {
    const base = this.frame;
    const frame = ++this.frame;
    const fields: Prints = new Map();
    const lists = new Map<string, Map<string, Prints>>();
    const listPatches: Record<string, ListPatch> = {};

    for (const [key, value] of Object.entries(state)) {
      if (value === undefined) continue;
      if (!isEntityList(value)) {
        fields.set(key, JSON.stringify(value));
        continue;
      }
      const prior = this.lists.get(key);
      const next = new Map<string, Prints>();
      const upserts: Upsert[] = [];
      for (const entity of value) {
        const current = prints(entity);
        next.set(entity.id, current);
        const old = prior?.get(entity.id);
        if (!old) upserts.push({ id: entity.id, set: { ...entity } });
        else {
          const d = diff(current, old);
          if (d.set || d.unset) upserts.push({ id: entity.id, ...(d.set && { set: d.set }), ...(d.unset && { unset: d.unset }) });
        }
      }
      lists.set(key, next);
      fields.set(`#${key}`, '');
      const order = value.map((entity) => entity.id);
      const reordered = !prior || JSON.stringify([...prior.keys()]) !== JSON.stringify(order);
      if (upserts.length || reordered)
        listPatches[key] = { ...(reordered && { order }), ...(upserts.length && { upserts }) };
    }

    const previous = this.fields;
    this.fields = fields;
    this.lists = lists;
    if (!previous || frame % this.keyframeEvery === 1) return { kind: 'full', frame, state };

    const plain = (prints: Prints) => new Map([...prints].filter(([key]) => !key.startsWith('#')));
    const d = diff(plain(fields), plain(previous));
    const unset = [
      // A plain field that became an entity list is replaced by `lists`.
      ...(d.unset ?? []).filter((key) => !fields.has(`#${key}`)),
      // An entity list that disappeared, unless it is now a plain value such as [].
      ...[...previous.keys()]
        .filter((key) => key.startsWith('#') && !fields.has(key) && !fields.has(key.slice(1)))
        .map((key) => key.slice(1)),
    ];
    const patch: DeltaPatch = {
      ...(d.set && { set: d.set }),
      ...(unset.length && { unset }),
      ...(Object.keys(listPatches).length && { lists: listPatches }),
    };
    // Deltas that aren't smaller than the whole state aren't worth the risk.
    if (JSON.stringify(patch).length >= JSON.stringify(state).length) return { kind: 'full', frame, state };
    return { kind: 'delta', frame, base, patch };
  }
}

export class DeltaDecoder {
  private frame?: number;
  private state?: Fields;

  reset() {
    this.frame = undefined;
    this.state = undefined;
  }

  full(frame: number | undefined, state: Fields): Fields {
    this.frame = frame;
    this.state = state;
    return state;
  }

  /** Apply a delta. Returns null when the baseline is missing; request a resync. */
  apply(frame: number, base: number, patch: DeltaPatch): Fields | null {
    if (!this.state || this.frame !== base) {
      this.reset();
      return null;
    }
    const next: Fields = { ...this.state, ...patch.set };
    for (const key of patch.unset ?? []) delete next[key];
    for (const [key, list] of Object.entries(patch.lists ?? {})) {
      const previous = Array.isArray(this.state[key]) ? (this.state[key] as Entity[]) : [];
      const byId = new Map(previous.map((entity) => [entity.id, entity]));
      for (const upsert of list.upserts ?? []) {
        const entity: Entity = { ...byId.get(upsert.id), ...upsert.set, id: upsert.id };
        for (const field of upsert.unset ?? []) delete entity[field];
        byId.set(upsert.id, entity);
      }
      const items: Entity[] = [];
      for (const id of list.order ?? previous.map((entity) => entity.id)) {
        const entity = byId.get(id);
        if (!entity) {
          this.reset();
          return null;
        }
        items.push(entity);
      }
      next[key] = items;
    }
    this.frame = frame;
    this.state = next;
    return next;
  }
}
