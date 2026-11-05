import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import { ApiError } from '../api/client';

export interface Grant { accessToken: string; refreshToken: string }

export interface TokenStore {
  getAccess(): string | null;
  getRefresh(): Promise<string | null>;
  generation(): number;
  save(grant: Grant, generation: number): Promise<boolean>;
  clear(): Promise<void>;
}

export interface InstallMarker {
  exists(): boolean;
  create(): void;
}

export type SecureStoreLike = Pick<typeof SecureStore, 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync'>;

const REFRESH_KEY = 'kit.refreshToken';

function keychain(): SecureStore.SecureStoreOptions {
  return { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
}

/**
 * C-L3: a refresh token that iOS kept after the app was deleted is removed before the first read.
 * When the marker cannot be written, the deletion stands and the error propagates. The caller maps
 * that rejection to storage and does not delete again.
 */
export async function onFirstLaunch(secureStore: SecureStoreLike, marker: InstallMarker): Promise<void> {
  if (marker.exists()) return;
  await secureStore.deleteItemAsync(REFRESH_KEY, keychain());
  marker.create();
}

function defaultMarker(): InstallMarker {
  const file = new File(Paths.document, 'kit-installed');
  return {
    exists: () => file.exists,
    create: () => { file.create(); },
  };
}

export function createSecureTokenStore(deps?: { secureStore?: SecureStoreLike; marker?: InstallMarker }): TokenStore {
  const secureStore = deps?.secureStore ?? SecureStore;
  const marker = deps?.marker ?? defaultMarker();
  let access: string | null = null;
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();
  let prepare: Promise<void> | null = null;

  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(fn, fn);
    chain = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    getAccess: () => access,
    generation: () => generation,
    async getRefresh(): Promise<string | null> {
      prepare ??= onFirstLaunch(secureStore, marker);
      try {
        await prepare;
      } catch (error) {
        throw new ApiError('storage', 'Could not open secure storage.', { cause: error });
      }
      try {
        return await secureStore.getItemAsync(REFRESH_KEY, keychain());
      } catch (error) {
        throw new ApiError('storage', 'Could not read the refresh token.', { cause: error });
      }
    },
    async save(grant: Grant, at: number): Promise<boolean> {
      let stored = false;
      await run(async () => {
        if (at !== generation) return;
        await secureStore.setItemAsync(REFRESH_KEY, grant.refreshToken, keychain());
        if (at !== generation) return;
        access = grant.accessToken;
        stored = true;
      });
      return stored;
    },
    clear(): Promise<void> {
      generation += 1;
      access = null;
      return run(async () => {
        try {
          await secureStore.deleteItemAsync(REFRESH_KEY, keychain());
        } catch {
          // Sign-out must finish even when the keychain rejects the delete.
        }
      });
    },
  };
}
