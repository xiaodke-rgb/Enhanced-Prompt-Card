import { existsSync } from 'node:fs';
import { build } from 'esbuild';

const local = existsSync('node_modules');
const nodePaths = local ? [] : (process.env.OPENCHAMBER_SDK_NODE_MODULES ? [process.env.OPENCHAMBER_SDK_NODE_MODULES] : []);

const shared = { bundle: true, logLevel: 'info', minify: false, sourcemap: false, nodePaths };
const browser = { ...shared, platform: 'browser', format: 'iife', target: 'chrome120' };

await build({ ...browser, entryPoints: ['panel/main.ts'], outfile: 'panel/main.js' });

console.log('build ok: panel/main.js');
