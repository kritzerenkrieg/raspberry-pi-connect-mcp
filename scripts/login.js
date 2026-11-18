#!/usr/bin/env node
// Interactive login from a terminal (the MCP's `login` tool does the same). Starts Chrome as a normal
// process; the user signs in by hand. --fresh signs out first (old session backed up).
import { startLogin, logout, checkDisplay } from '../src/auth.js';

checkDisplay();
if (process.argv.includes('--fresh')) console.log(await logout());
console.log('Sign in in the Chrome window. It will close by itself once your device list is showing.');
const r = await startLogin().promise;
console.log(r.message);
process.exit(r.ok ? 0 : 1);
