import type { FastifyReply } from 'fastify';

export const ErrorCode = {
  STORE_NOT_FOUND: 'STORE_NOT_FOUND',
  INVALID_SUBJECT: 'INVALID_SUBJECT',
  MISSING_AUTHOR: 'MISSING_AUTHOR',
  MISSING_SUBJECT: 'MISSING_SUBJECT',
  INVALID_VALUE: 'INVALID_VALUE',
  STORE_ERROR: 'STORE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  GRAPH_NOT_LOADED: 'GRAPH_NOT_LOADED',
  NO_IDENTITY: 'NO_IDENTITY',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  GRAPH_NOT_FOUND: 'GRAPH_NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: ErrorCodeType; message: string };
}

export function ok<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCodeType, message: string): ApiEnvelope<never> {
  return { ok: false, error: { code, message } };
}

export function sendError(reply: FastifyReply, status: number, code: ErrorCodeType, message: string) {
  return reply.code(status).send(fail(code, message));
}
