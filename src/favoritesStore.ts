import * as vscode from "vscode";
import { isWorktreePath } from "./projectGrouping";

export interface FavoritesEntry {
  path: string;
}

export type FavoritesChangeEvent =
  | { kind: "single"; path: string }
  | { kind: "broad" };

interface FavoritesStorageEnvelope {
  version: 2;
  entries: FavoritesEntry[];
}

export const STORAGE_KEY = "claudeConductor.favorites";
export const MAX_FAVORITES = 25;

export interface MutationResult {
  ok: boolean;
  reason?: string;
}

function canonicalKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Pure read; no write side effects. v1 string[] is converted in-memory only. */
function readWithoutMigrating(memento: vscode.Memento): {
  entries: FavoritesEntry[];
  unknownVersion: boolean;
} {
  const raw = memento.get<unknown>(STORAGE_KEY);
  if (raw === undefined || raw === null) return { entries: [], unknownVersion: false };
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { entries: [], unknownVersion: false };
    if (typeof raw[0] === "string") {
      return {
        entries: (raw as string[]).map(p => ({ path: p })),
        unknownVersion: false,
      };
    }
    return { entries: raw as FavoritesEntry[], unknownVersion: false };
  }
  if (typeof raw === "object" && raw !== null && "version" in raw) {
    const env = raw as FavoritesStorageEnvelope;
    if (env.version === 2) {
      return { entries: Array.isArray(env.entries) ? env.entries : [], unknownVersion: false };
    }
    const maybeEntries = (env as { entries?: unknown }).entries;
    return {
      entries: Array.isArray(maybeEntries) ? maybeEntries as FavoritesEntry[] : [],
      unknownVersion: true,
    };
  }
  return { entries: [], unknownVersion: false };
}

export class FavoritesStore {
  private entries: FavoritesEntry[] = [];
  private keyIndex: Set<string> = new Set();
  private readonly _onDidChange = new vscode.EventEmitter<FavoritesChangeEvent>();
  readonly onDidChange = this._onDidChange.event;

  /** Tracks the latest persist (success or rollback). Mutations await this. */
  private persistChain: Promise<void> = Promise.resolve();

  /** True when storage envelope has an unknown future version — block writes. */
  private readonly unknownVersion: boolean;

  constructor(private readonly memento: vscode.Memento) {
    const r = readWithoutMigrating(memento);
    this.entries = r.entries;
    this.unknownVersion = r.unknownVersion;
    this.rebuildIndex();
  }

  isFavorited(p: string): boolean {
    return this.keyIndex.has(canonicalKey(p));
  }
  list(): readonly FavoritesEntry[] { return this.entries; }
  isOverCap(): boolean { return this.entries.length > MAX_FAVORITES; }

  /** Test helper: wait for in-flight persists (and any rollback) to complete. */
  async waitForIdle(): Promise<void> {
    await this.persistChain.catch(() => undefined);
  }

  async add(p: string): Promise<MutationResult> {
    if (this.unknownVersion) {
      return { ok: false, reason: "Storage version is newer than this build supports." };
    }
    if (isWorktreePath(p)) {
      return { ok: false, reason: "Favorite the project root, not a worktree." };
    }
    if (this.isFavorited(p)) {
      return { ok: true };
    }
    if (this.entries.length >= MAX_FAVORITES) {
      return { ok: false, reason: `Favorites cap reached (${MAX_FAVORITES}). Remove an entry first.` };
    }

    await this.enqueueMutation(
      snapshot => [...snapshot, { path: p }],
      { kind: "single", path: p }
    );
    return { ok: true };
  }

  async remove(p: string): Promise<void> {
    if (this.unknownVersion) return;
    if (!this.isFavorited(p)) return;

    const key = canonicalKey(p);
    await this.enqueueMutation(
      snapshot => snapshot.filter(e => canonicalKey(e.path) !== key),
      { kind: "single", path: p }
    );
  }

  async relocate(oldPath: string, newPath: string): Promise<MutationResult> {
    if (this.unknownVersion) {
      return { ok: false, reason: "Storage version is newer than this build supports." };
    }
    if (isWorktreePath(newPath)) {
      return { ok: false, reason: "Favorite the project root, not a worktree." };
    }

    const oldKey = canonicalKey(oldPath);
    const newKey = canonicalKey(newPath);

    if (oldKey === newKey) {
      return { ok: false, reason: "That's the same path. Choose a different folder." };
    }

    if (!this.keyIndex.has(oldKey)) {
      return { ok: false, reason: "Original entry not found." };
    }

    if (this.keyIndex.has(newKey)) {
      await this.enqueueMutation(
        snapshot => snapshot.filter(e => canonicalKey(e.path) !== oldKey),
        { kind: "broad" }
      );
      return { ok: true, reason: "That folder is already in your Favorites — removed the missing entry." };
    }

    await this.enqueueMutation(
      snapshot => snapshot.map(e =>
        canonicalKey(e.path) === oldKey ? { path: newPath } : e
      ),
      { kind: "single", path: newPath }
    );
    return { ok: true };
  }

  /** Test seam: expose enqueueMutation for the apply-throw test. */
  _enqueueMutationForTest(
    apply: (snapshot: FavoritesEntry[]) => FavoritesEntry[],
    payload: FavoritesChangeEvent
  ): Promise<void> {
    return this.enqueueMutation(apply, payload);
  }

  private async enqueueMutation(
    apply: (snapshot: FavoritesEntry[]) => FavoritesEntry[],
    payload: FavoritesChangeEvent
  ): Promise<void> {
    await this.persistChain.catch(() => undefined);

    const snapshot = [...this.entries];

    let next: FavoritesEntry[];
    try {
      next = apply(snapshot);
    } catch (err) {
      throw err;
    }

    this.entries = next;
    this.rebuildIndex();
    this._onDidChange.fire(payload);

    this.persistChain = Promise.resolve(
      this.memento.update(STORAGE_KEY, { version: 2, entries: this.entries } as FavoritesStorageEnvelope)
    )
      .then(() => undefined)
      .catch((err: unknown) => {
        this.entries = snapshot;
        this.rebuildIndex();
        this._onDidChange.fire({ kind: "broad" });
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Couldn't save Favorites — please try again. (${msg})`
        );
      });

    return this.persistChain;
  }

  private rebuildIndex(): void {
    this.keyIndex = new Set(this.entries.map(e => canonicalKey(e.path)));
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
