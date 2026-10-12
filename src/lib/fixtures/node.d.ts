// Just enough of Node's API for tests to read fixture files, without pulling Node types into the app.
declare module "node:fs" {
  export function readFileSync(path: URL | string): Uint8Array;
}
