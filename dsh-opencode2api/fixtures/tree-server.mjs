import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const child = spawn(
  process.execPath,
  ['-e', "require('net').createServer().listen(Number(process.env.TEST_CHILD_PORT),'127.0.0.1')"],
  { env: process.env, windowsHide: true, stdio: 'ignore' },
);
child.on('error', () => process.exit(1));
createServer().listen(Number(process.env.TEST_PORT), '127.0.0.1');
