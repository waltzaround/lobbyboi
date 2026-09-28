// Wire protocol shared by the server and client. Every message is JSON with a
// `t` discriminator. Keep this file free of runtime imports so it can be used
// from any bundle.

/** Bump when the wire format changes. Mismatched clients are closed with CLOSE.VERSION. */
export const PROTOCOL_VERSION = 1;

/** Close codes. Codes in NO_RECONNECT tell the client that retrying is pointless. */
export const CLOSE = {
  NORMAL: 1000,
  INVALID: 1007,
  POLICY: 1008,
  IDLE: 4000,
  REPLACED: 4001,
  KICKED: 4002,
  VERSION: 4003,
  CLOSED: 4004,
} as const;

export const NO_RECONNECT: ReadonlySet<number> = new Set([
  CLOSE.REPLACED,
  CLOSE.KICKED,
  CLOSE.VERSION,
  CLOSE.CLOSED,
  CLOSE.POLICY,
]);

export type Phase = 'lobby' | 'countdown' | 'playing' | 'results';

export interface PlayerInfo {
  id: string;
  name: string;
  bot: boolean;
  ready: boolean;
  connected: boolean;
  /** Game-defined per-player data shown in the lobby, e.g. team or colour. */
  meta?: Record<string, unknown>;
}

export interface RoomSettings {
  name: string;
  public: boolean;
  maxPlayers: number;
  bots: number;
  /** Game-defined settings chosen by the host, e.g. map or round length. */
  custom: Record<string, unknown>;
}

export interface RoomInfo {
  code: string;
  phase: Phase;
  hostId: string | null;
  players: PlayerInfo[];
  settings: RoomSettings;
  /** Server time (ms) when the current countdown or results screen ends. */
  phaseEndsAt: number | null;
  results: unknown;
}

/** A row in the public lobby list. */
export interface Listing {
  code: string;
  name: string;
  players: number;
  maxPlayers: number;
  phase: Phase;
  public: boolean;
  updatedAt: number;
  expiresAt: number;
}

export type ClientMessage =
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  | { t: 'settings'; settings: Partial<Omit<RoomSettings, 'maxPlayers'>> & { maxPlayers?: number } }
  | { t: 'kick'; playerId: string }
  | { t: 'input'; seq: number; input: unknown }
  | { t: 'ping'; id: number }
  | { t: 'chat'; text: string }
  | { t: 'meta'; meta: Record<string, unknown> }
  | { t: 'resync' }
  | { t: 'leave' };

export type ServerMessage =
  | { t: 'welcome'; you: string; room: RoomInfo; time: number; tickHz: number; snapshotHz: number; seq: number }
  | { t: 'room'; room: RoomInfo }
  | { t: 'snap'; tick: number; time: number; ack: number; state: unknown; frame?: number }
  | { t: 'delta'; tick: number; time: number; ack: number; frame: number; base: number; patch: DeltaPatch }
  | { t: 'event'; name: string; data: unknown }
  | { t: 'pong'; id: number; time: number }
  | { t: 'chat'; from: string; name: string; text: string }
  | { t: 'error'; code: string; message: string };

/** Delta between two snapshot states. See shared/delta.ts. */
export interface DeltaPatch {
  set?: Record<string, unknown>;
  unset?: string[];
  /** Per entity list: new id order (only when it changed) and changed entities. */
  lists?: Record<string, { order?: string[]; upserts?: { id: string; set?: Record<string, unknown>; unset?: string[] }[] }>;
}
