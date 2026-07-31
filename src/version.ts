import { createRequire } from 'node:module';

const requirePackage = createRequire(import.meta.url);
const pkg = requirePackage('../package.json') as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const CLI_VERSION = pkg.version;
