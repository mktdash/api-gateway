import {
  permissionVersionKey,
  type PermissionVersionStore,
  type PermissionVersionSubject,
} from "../../src/lib/permission-version.ts";

export class FakePermissionVersionStore implements PermissionVersionStore {
  readonly reads: string[] = [];

  #values = new Map<string, string>();
  #failure: Error | undefined;

  publish(subject: PermissionVersionSubject, version: number | string): void {
    this.#values.set(permissionVersionKey(subject).key, String(version));
  }

  failWith(error: Error): void {
    this.#failure = error;
  }

  reset(): void {
    this.reads.length = 0;
    this.#values.clear();
    this.#failure = undefined;
  }

  async get(key: string): Promise<string | null> {
    this.reads.push(key);

    if (this.#failure !== undefined) {
      throw this.#failure;
    }

    return this.#values.get(key) ?? null;
  }
}
