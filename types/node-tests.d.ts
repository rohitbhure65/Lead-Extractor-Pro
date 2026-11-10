// Minimal ambient types for Node built-in test runner used in tests/.

declare var __dirname: string;
declare var console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};

declare function setInterval(
  callback: (...args: any[]) => void,
  ms?: number,
  ...args: any[]
): { unref?: () => void };
declare function clearInterval(id: any): void;
declare function setTimeout(
  callback: (...args: any[]) => void,
  ms?: number,
  ...args: any[]
): { unref?: () => void };
declare function clearTimeout(id: any): void;

declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export = test;
}

declare module 'node:assert/strict' {
  function equal(actual: unknown, expected: unknown, message?: string): void;
  function ok(value: unknown, message?: string): asserts value;
  function match(value: string, regexp: RegExp, message?: string): void;
  function rejects(fn: () => Promise<unknown>, error?: RegExp, message?: string): Promise<void>;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
}

declare module 'node:vm' {
  export function createContext(contextObject?: Record<string, any>): Record<string, any>;
  export function runInContext(code: string, contextifiedObject: Record<string, any>): any;
}

declare function require(id: string): any;
