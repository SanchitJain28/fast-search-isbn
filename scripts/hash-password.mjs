import fs from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
if (process.stdin.isTTY) throw new Error('Pipe a password to stdin, for example using systemd-ask-password. Do not pass it on the command line.');
const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (password.length < 14) throw new Error('Use a password of at least 14 characters');
const salt = randomBytes(16).toString('hex');
console.log(`scrypt:${salt}:${scryptSync(password, salt, 32).toString('hex')}`);
