import { apiJson } from './api';

export type QaItem = {
  id: string;
  repo: string;
  pr: number;
  title: string;
  app: 'Operly' | 'Studio';
  tester: 'sud' | 'edgar' | 'martin';
  status: 'up_next' | 'testing' | 'fixing' | 'retest' | 'validated';
  dueAt: string;
  slackThreadUrl?: string;
  slackThreadTs?: string;
  stagingUrl?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type QaColumn = { id: 'sud' | 'edgar' | 'martin'; name: string; items: QaItem[] };
export type QaBoard = { me?: QaColumn['id']; testers: QaColumn[] };

export const fetchQaBoard = (signal?: AbortSignal) =>
  apiJson<QaBoard>('/api/qa', { signal, cache: 'no-store' });

export type QaSignInLink = { id: 'sud' | 'edgar' | 'martin'; name: string; path: string; url?: string };

export const fetchQaSignInLinks = (signal?: AbortSignal) =>
  apiJson<{ links: QaSignInLink[] }>('/api/qa/auth/links', { signal, cache: 'no-store' });
