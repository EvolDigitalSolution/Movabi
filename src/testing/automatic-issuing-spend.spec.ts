import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
import { IssuingSpendService } from '../../server/services/issuing-spend.service';
describe('automatic issued-card spending', () => {
 beforeEach(() => mocks.rpc.mockReset());
 it('uses reconciled net spend, independently of a receipt total', async () => {
  mocks.rpc.mockResolvedValue({ data: { automated: true, pending: false, spent: '42.50' }, error: null });
  expect(await IssuingSpendService.sync('job', true)).toEqual({ automated: true, pending: false, spent: 42.5 });
  expect(mocks.rpc).toHaveBeenCalledWith('sync_job_issuing_spend', { p_job: 'job', p_finalize: true });
 });
 it('keeps pending purchases distinct from settled spending', async () => {
  mocks.rpc.mockResolvedValue({ data: { automated: true, pending: true, spent: 20 }, error: null });
  expect((await IssuingSpendService.sync('job')).pending).toBe(true);
 });
 it('leaves manual shopping available when no issued-card control exists', async () => {
  mocks.rpc.mockResolvedValue({ data: { automated: false }, error: null });
  expect((await IssuingSpendService.sync('job')).automated).toBe(false);
 });
 it('fails closed if reconciliation fails or spend is invalid', async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: 'unreachable' } });
  await expect(IssuingSpendService.sync('job')).rejects.toThrow('reconciled');
  mocks.rpc.mockResolvedValue({ data: { automated: true, spent: -10 }, error: null });
  await expect(IssuingSpendService.sync('job')).rejects.toThrow('Invalid');
 });
 it('deducts refunds, catches missing capture events, and serializes card finalization', () => {
  const sql = readFileSync('supabase/migrations/20261242400000_automatic_issuing_spend.sql','utf8');
  expect(sql).toContain("WHEN status='refund' THEN -amount");
  expect(sql).toContain("a.status='closed' AND a.amount>0 AND NOT EXISTS");
  expect(sql).toContain("'issuing-card-'||card");
  expect(sql).toContain("IF p_finalize AND NOT pending");
 });
});
