import type { ZodType } from 'zod';

import { GitRequestError, type RepoIdentity, resolveRepoIdentity } from './git';

// Shared plumbing for the review state routes: repo resolution from the
// ?repo= query param, JSON body validation, and error → response mapping.

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function requireRepoIdentity(
  request: Request
): Promise<RepoIdentity> {
  const repo = new URL(request.url).searchParams.get('repo');
  if (repo == null || repo === '') {
    throw new ApiError('repo query parameter is required', 400);
  }
  return resolveRepoIdentity(repo);
}

export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError('Request body must be JSON', 400);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(`Invalid request body: ${result.error.message}`, 400);
  }
  return result.data;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function handleApiError(error: unknown): Response {
  if (error instanceof ApiError || error instanceof GitRequestError) {
    return new Response(error.message, {
      status: error.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(
    error instanceof Error ? error.message : 'Unknown error',
    {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }
  );
}
