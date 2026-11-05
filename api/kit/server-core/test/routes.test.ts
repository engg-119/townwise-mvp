import express from 'express';
import { expect, test } from 'vitest';

import { ConfigError, createServer } from '../src/index.ts';
import { configErrorOf } from './helpers/errors.ts';
import { captureLogger, testConfig } from './helpers/server.ts';

function make(paths: string[]): void {
  createServer({
    config: testConfig(),
    logger: captureLogger().logger,
    routes: paths.map((path) => ({ path: path as `/${string}`, router: express.Router() })),
  });
}

test('routes: a path that is a segment prefix of a later path throws ConfigError; /webhooks before / is accepted; /a before /ab is accepted', () => {
  expect(configErrorOf(() => { make(['/', '/webhooks']); }).problems).toEqual([{
    variable: 'routes',
    problem: "'/' is mounted before '/webhooks' and would see its requests first; list more specific paths first",
  }]);
  expect(() => { make(['/api', '/api/v2']); }).toThrow(ConfigError);
  expect(() => { make(['/a', '/a']); }).toThrow(ConfigError);
  expect(() => { make(['/webhooks', '/']); }).not.toThrow();
  expect(() => { make(['/a', '/ab']); }).not.toThrow();
});
