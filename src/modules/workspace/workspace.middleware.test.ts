/**
 * workspace.middleware.test.ts — Tests for the X-Workspace-Token extractor.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { attachWorkspaceToken } from './workspace.middleware';

function fakeReq(headers: Record<string, string | string[] | undefined>): Request {
  return { headers } as unknown as Request;
}

function runMiddleware(
  headers: Record<string, string | string[] | undefined>,
): { req: Request; nextCalls: number } {
  const req = fakeReq(headers);
  const res = {} as Response;
  let nextCalls = 0;
  const next: NextFunction = vi.fn(() => {
    nextCalls++;
  });
  attachWorkspaceToken(req, res, next);
  return { req, nextCalls };
}

describe('attachWorkspaceToken', () => {
  it('no-ops when header is missing', () => {
    const { req, nextCalls } = runMiddleware({});
    expect(req.workspaceAccessToken).toBeUndefined();
    expect(nextCalls).toBe(1);
  });

  it('attaches the token when header is present', () => {
    const { req, nextCalls } = runMiddleware({ 'x-workspace-token': 'ya29.abc' });
    expect(req.workspaceAccessToken).toBe('ya29.abc');
    expect(nextCalls).toBe(1);
  });

  it('strips a "Bearer " prefix (case-insensitive)', () => {
    const { req: lower } = runMiddleware({ 'x-workspace-token': 'bearer ya29.abc' });
    expect(lower.workspaceAccessToken).toBe('ya29.abc');

    const { req: upper } = runMiddleware({ 'x-workspace-token': 'Bearer ya29.abc' });
    expect(upper.workspaceAccessToken).toBe('ya29.abc');
  });

  it('trims surrounding whitespace', () => {
    const { req } = runMiddleware({ 'x-workspace-token': '  ya29.abc  ' });
    expect(req.workspaceAccessToken).toBe('ya29.abc');
  });

  it('does not attach an empty-string token', () => {
    const { req } = runMiddleware({ 'x-workspace-token': '' });
    expect(req.workspaceAccessToken).toBeUndefined();
  });

  it('does not attach a whitespace-only token', () => {
    const { req } = runMiddleware({ 'x-workspace-token': '    ' });
    expect(req.workspaceAccessToken).toBeUndefined();
  });

  it('does not attach when header value is an array (unexpected for this header)', () => {
    // Express preserves header arrays for some fields; we only accept strings.
    const { req } = runMiddleware({ 'x-workspace-token': ['ya29.abc', 'other'] });
    expect(req.workspaceAccessToken).toBeUndefined();
  });

  it('does not throw and calls next exactly once on success', () => {
    const { nextCalls } = runMiddleware({ 'x-workspace-token': 'ya29.abc' });
    expect(nextCalls).toBe(1);
  });
});
