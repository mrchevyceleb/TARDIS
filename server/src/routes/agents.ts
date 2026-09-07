// /api/agents — CRUD for user-defined teammates.

import { Router } from 'express';
import express from 'express';
import { asyncHandler } from './helpers.ts';
import { AgentBrainConflictError, AgentBrainRevisionRequiredError, listAgents, createAgent, updateAgent, deleteAgent, setAgentAvatar, clearAgentAvatar, agentAvatarPath, reorderAgents } from '../chat/agents.ts';
import { personaScopeFor } from '../chat/personaPrompts.ts';
import { agentUnread, markAgentRead, agentLatestSeq } from '../chat/reads.ts';

const rawImage = express.raw({ type: 'image/*', limit: '6mb' });

export const agentsRouter = Router();

agentsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ agents: listAgents().map((a) => ({ ...a, unread: agentUnread(a), muted: Boolean(a.muted) })) });
}));

agentsRouter.post('/:id/read', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const agent = listAgents().find((a) => a.id === id);
  if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
  markAgentRead(id, agentLatestSeq(agent));
  res.json({ ok: true, unread: 0 });
}));

agentsRouter.post('/reorder', asyncHandler(async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.some((x: unknown) => typeof x !== 'string')) {
    res.status(400).json({ error: 'ids must be an array of agent ids' });
    return;
  }
  res.json({ agents: reorderAgents(ids) });
}));

agentsRouter.post('/', asyncHandler(async (req, res) => {
  const { name, role, engine, model, effort, voice, scope } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  res.status(201).json({ agent: createAgent({ name, role, engine, model, effort, voice, scope }) });
}));

agentsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const { name, role, engine, model, effort, brainRevision, voice, pinned, muted, scope } = req.body ?? {};
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (muted !== undefined && typeof muted !== 'boolean') {
    res.status(400).json({ error: 'muted must be a boolean' });
    return;
  }
  try {
    const expectedRevision = Number.isSafeInteger(brainRevision) && brainRevision > 0
      ? brainRevision as number
      : undefined;
    const agent = updateAgent(
      id,
      {
        name, role, engine, model, effort, voice, pinned,
        muted,
        scope,
      },
      expectedRevision,
    );
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
    res.json({ agent });
  } catch (error) {
    if (error instanceof AgentBrainConflictError) {
      res.status(409).json({ error: error.message, agent: error.current });
      return;
    }
    if (error instanceof AgentBrainRevisionRequiredError) {
      res.status(428).json({ error: error.message, agent: error.current });
      return;
    }
    throw error;
  }
}));

agentsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  res.json({ deleted: deleteAgent(id) });
}));

agentsRouter.post('/:id/avatar', rawImage, asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const agent = setAgentAvatar(id, String(req.headers['content-type'] ?? ''), req.body as Buffer);
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
    res.json({ agent });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
}));

agentsRouter.delete('/:id/avatar', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const agent = clearAgentAvatar(id);
  if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
  res.json({ agent });
}));

agentsRouter.get('/:id/avatar', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const path = agentAvatarPath(id);
  if (!path) { res.status(404).end(); return; }
  const { readFile } = await import('node:fs/promises');
  try {
    const bytes = await readFile(path);
    const type = path.endsWith('.png') ? 'image/png'
      : path.endsWith('.jpg') ? 'image/jpeg'
      : path.endsWith('.gif') ? 'image/gif'
      : 'image/webp';
    // The ?v= version param is the avatar stamp, so per-version caching is safe.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', type);
    res.end(bytes);
  } catch {
    res.status(404).end();
  }
}));

agentsRouter.get('/:id/scope', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  res.type('text/markdown').send(personaScopeFor(listAgents().find((a) => a.id === id)?.home ?? ''));
}));
