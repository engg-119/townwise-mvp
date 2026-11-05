import { AppError } from '../../src/errors.ts';
import { ConfigError } from '../../src/config.ts';

export function configErrorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw new Error('expected ConfigError', { cause: err });
  }
  throw new Error('expected ConfigError');
}

export function appErrorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw new Error('expected AppError', { cause: err });
  }
  throw new Error('expected AppError');
}
