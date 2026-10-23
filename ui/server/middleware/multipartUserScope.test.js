// @vitest-environment node
import express from 'express';
import multer from 'multer';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  requireUserScope,
  runWithRequestUserScope,
  userScopeMiddleware,
} from './userScope.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('multipart user scope', () => {
  it('restores the authenticated user for Multer callbacks without mixing concurrent uploads', async () => {
    const app = express();
    const upload = multer({ storage: multer.memoryStorage() }).single('file');
    app.post('/upload', (req, _res, next) => {
      req.user = { id: req.headers['x-test-user'], role: 'user' };
      next();
    }, userScopeMiddleware, (req, res) => {
      upload(req, res, (error) => runWithRequestUserScope(req, async () => {
        if (error) return res.status(400).json({ error: error.message });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return res.json({ userId: requireUserScope().userId, name: req.file?.originalname });
      }));
    });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const post = async (userId) => {
      const data = new FormData();
      data.append('file', new Blob([`content ${userId}`]), `${userId}.doc`);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/upload`, {
        method: 'POST',
        headers: { 'x-test-user': userId },
        body: data,
      });
      return { status: response.status, body: await response.json() };
    };
    const [alice, bob] = await Promise.all([post('alice'), post('bob')]);
    expect(alice).toEqual({ status: 200, body: { userId: 'alice', name: 'alice.doc' } });
    expect(bob).toEqual({ status: 200, body: { userId: 'bob', name: 'bob.doc' } });
  });
});
