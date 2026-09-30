import { supabaseAdmin } from './supabase.service';
import { randomUUID } from 'node:crypto';

export const TEST_ACCOUNT_PURGE_GATE = 'ALLOW_ADMIN_TEST_ACCOUNT_PURGE';
export const RESET_ALL_TEST_DATA_GATE = 'ALLOW_ADMIN_RESET_ALL_TEST_DATA';
export const RESET_ALL_CONFIRMATION = 'RESET ALL TEST DATA';

/** Feature gate. Fails closed unless the env var is exactly "true". */
export function isTestAccountPurgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[TEST_ACCOUNT_PURGE_GATE] || '').trim().toLowerCase() === 'true';
}

/** A profile is a reset target unless its role is exactly "admin". */
export function isNonAdminResetTarget(role: unknown): boolean {
  return String(role || '').trim().toLowerCase() !== 'admin';
}

const BATCH = 40;

async function deleteWhere(table: string, column: string, value: string): Promise<void> {
  const { error } = await supabaseAdmin.from(table).delete().eq(column, value);
  if (error) throw new Error(`Failed to delete ${table} by ${column}: ${error.message}`);
}

async function deleteWhereIn(table: string, column: string, values: string[]): Promise<void> {
  for (let i = 0; i < values.length; i += BATCH) {
    const chunk = values.slice(i, i + BATCH);
    const { error } = await supabaseAdmin.from(table).delete().in(column, chunk);
    if (error) throw new Error(`Failed to delete ${table} by ${column}: ${error.message}`);
  }
}

/** Account-owned ephemeral rows keyed directly by the target's id. */
const ACCOUNT_OWNED_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'driver_onboarding_requests', column: 'driver_id' },
  { table: 'driver_requirement_audit', column: 'driver_id' },
  { table: 'vehicles', column: 'user_id' },
  { table: 'device_push_tokens', column: 'user_id' },
  { table: 'notifications', column: 'user_id' },
  { table: 'fare_negotiations', column: 'proposed_by' },
  { table: 'driver_bids', column: 'driver_id' },
  { table: 'driver_job_declines', column: 'driver_id' },
  { table: 'marketplace_negotiation_sessions', column: 'customer_id' },
  { table: 'marketplace_negotiation_events', column: 'proposed_by' },
  { table: 'customer_local_service_preferences', column: 'customer_id' },
  { table: 'driver_locations', column: 'driver_id' },
  { table: 'job_locations', column: 'driver_id' },
  { table: 'driver_onboarding_notifications', column: 'driver_id' },
  { table: 'driver_accounts', column: 'user_id' },
  { table: 'driver_issuing_cardholders', column: 'driver_id' },
  { table: 'driver_issuing_cards', column: 'driver_id' },
  { table: 'tenant_users', column: 'user_id' },
  { table: 'subscriptions', column: 'user_id' },
  { table: 'wallets', column: 'user_id' },
  { table: 'email_logs', column: 'user_id' },
  { table: 'wallet_transactions', column: 'user_id' },
  { table: 'driver_earnings', column: 'driver_id' },
  { table: 'errand_funding', column: 'customer_id' },
  { table: 'job_issuing_spend_controls', column: 'customer_id' },
  { table: 'job_issuing_spend_controls', column: 'driver_id' },
  { table: 'job_issuing_authorizations', column: 'driver_id' },
  { table: 'job_issuing_transactions', column: 'driver_id' },
  { table: 'job_messages', column: 'sender_id' },
  { table: 'job_messages', column: 'receiver_id' },
  { table: 'job_events', column: 'actor_id' },
  { table: 'ratings', column: 'customer_id' },
  { table: 'booking_status_history', column: 'changed_by' },
  { table: 'dispatch_logs', column: 'driver_id' },
];

/** Job-owned dependent rows keyed by job_id, deleted before the job row itself. */
const JOB_OWNED_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'fare_negotiations', column: 'job_id' },
  { table: 'driver_bids', column: 'job_id' },
  { table: 'driver_job_declines', column: 'job_id' },
  { table: 'marketplace_negotiation_sessions', column: 'job_id' },
  { table: 'job_messages', column: 'job_id' },
  { table: 'job_events', column: 'job_id' },
  { table: 'job_completion_secrets', column: 'job_id' },
  { table: 'job_service_details', column: 'job_id' },
  { table: 'job_locations', column: 'job_id' },
  { table: 'job_queue', column: 'job_id' },
  { table: 'dispatch_logs', column: 'job_id' },
  { table: 'errand_details', column: 'job_id' },
  { table: 'ride_details', column: 'job_id' },
  { table: 'delivery_details', column: 'job_id' },
  { table: 'van_details', column: 'job_id' },
  { table: 'errand_funding', column: 'job_id' },
  { table: 'wallet_transactions', column: 'job_id' },
  { table: 'driver_earnings', column: 'job_id' },
  { table: 'ratings', column: 'job_id' },
  { table: 'booking_status_history', column: 'job_id' },
  { table: 'job_issuing_spend_controls', column: 'job_id' },
  { table: 'job_issuing_authorizations', column: 'job_id' },
  { table: 'job_issuing_transactions', column: 'job_id' },
];

export type PurgeOutcome =
  | { status: 'purged'; recovered: boolean; removedJobs: number }
  | { status: 'not_found' }
  | { status: 'blocked'; code: string; reason: string }
  | { status: 'error'; message: string };

async function collectAffectedJobIds(targetId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const column of ['customer_id', 'driver_id', 'accepted_driver_id'] as const) {
    const { data, error } = await supabaseAdmin.from('jobs').select('id').eq(column, targetId);
    if (error) throw new Error(`Failed to load affected jobs (${column}): ${error.message}`);
    for (const row of (data || []) as any[]) {
      if (row?.id) ids.add(String(row.id));
    }
  }
  return Array.from(ids);
}

async function cleanupStorage(targetId: string): Promise<number> {
  let failures = 0;
  try {
    const { data: avatars } = await supabaseAdmin.storage.from('profiles').list(`avatars/${targetId}`);
    if (avatars?.length) {
      await supabaseAdmin.storage.from('profiles').remove(avatars.map((f: any) => `avatars/${targetId}/${f.name}`));
    }
  } catch { failures += 1; }
  try {
    const { data: docs } = await supabaseAdmin.storage.from('driver-docs').list(`documents/${targetId}`);
    if (docs?.length) {
      await supabaseAdmin.storage.from('driver-docs').remove(docs.map((f: any) => `documents/${targetId}/${f.name}`));
    }
  } catch { failures += 1; }
  return failures;
}

/**
 * Permanently purge a TEST account, including its affected test-job aggregate.
 * Idempotent/retry-safe: if the profile is already gone but an Auth user
 * remains, the Auth user is hard-deleted and the operation reports recovery.
 */
export async function purgeTestAccount(adminUserId: string, targetUserId: string): Promise<PurgeOutcome> {
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, role')
    .eq('id', targetUserId)
    .maybeSingle();

  if (profileError) return { status: 'error', message: profileError.message };

  if (!profile) {
    const { data: authData } = await supabaseAdmin.auth.admin.getUserById(targetUserId);
    if (authData?.user) {
      await supabaseAdmin.auth.admin.deleteUser(targetUserId, false);
      return { status: 'purged', recovered: true, removedJobs: 0 };
    }
    return { status: 'not_found' };
  }

  if (targetUserId === adminUserId) {
    return { status: 'blocked', code: 'CANNOT_PURGE_SELF', reason: 'You cannot purge your own account.' };
  }
  if (profile.role === 'admin') {
    return { status: 'blocked', code: 'CANNOT_PURGE_ADMIN', reason: 'Administrator accounts cannot be purged.' };
  }

  // Email is resolved from Auth (public.profiles has no email column).
  const email = await resolveAuthEmail(targetUserId);

  // 1. Collect and delete the affected test-job aggregate (child-to-parent).
  try {
    const affectedJobIds = await collectAffectedJobIds(targetUserId);
    await deleteNegotiationEventsForJobs(affectedJobIds);
    for (const entry of JOB_OWNED_TABLES) {
      await deleteWhereIn(entry.table, entry.column, affectedJobIds);
    }
    await deleteWhereIn('jobs', 'id', affectedJobIds);

    // 2. Delete target-owned account rows.
    for (const entry of ACCOUNT_OWNED_TABLES) {
      await deleteWhere(entry.table, entry.column, targetUserId);
    }
    if (email) {
      await deleteWhere('registration_otps', 'email', email);
    }

    // 3. Delete the application profile (service_role bypasses ownership guard).
    const { error: profileDeleteError } = await supabaseAdmin.from('profiles').delete().eq('id', targetUserId);
    if (profileDeleteError) throw new Error(profileDeleteError.message);

    // 4. HARD-delete the Auth user (releases email for immediate re-registration).
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(targetUserId, false);
    if (authError) throw new Error(authError.message);

    // 5. Best-effort storage cleanup (test KYC/profile/vehicle docs).
    await cleanupStorage(targetUserId);

    return { status: 'purged', recovered: false, removedJobs: affectedJobIds.length };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Purge failed.' };
  }
}

export function isResetAllTestDataEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[RESET_ALL_TEST_DATA_GATE] || '').trim().toLowerCase() === 'true';
}

const RESET_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const resetChallenges = new Map<string, { adminUserId: string; expiresAt: number }>();

export interface ResetChallenge { challengeId: string; expiresAt: string; }

export function createResetChallenge(adminUserId: string): ResetChallenge {
  const now = Date.now();
  for (const [id, ch] of resetChallenges) {
    if (ch.expiresAt <= now) resetChallenges.delete(id);
  }
  const challengeId = randomUUID();
  resetChallenges.set(challengeId, { adminUserId, expiresAt: now + RESET_CHALLENGE_TTL_MS });
  return { challengeId, expiresAt: new Date(now + RESET_CHALLENGE_TTL_MS).toISOString() };
}

export function consumeResetChallenge(challengeId: string, adminUserId: string): boolean {
  const ch = resetChallenges.get(challengeId);
  if (!ch) return false;
  resetChallenges.delete(challengeId); // single-use
  if (ch.expiresAt <= Date.now()) return false;
  if (ch.adminUserId !== adminUserId) return false;
  return true;
}

async function collectNonAdminTargets(): Promise<string[]> {
  // public.profiles has id + role (no email). Only admin accounts are preserved.
  const { data, error } = await supabaseAdmin.from('profiles').select('id, role');
  if (error) throw new Error(`Failed to load reset targets: ${error.message}`);
  return ((data || []) as any[])
    .filter((row) => isNonAdminResetTarget(row.role))
    .map((row) => String(row.id));
}

async function resolveAuthEmail(userId: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    return String(data?.user?.email || '').trim().toLowerCase();
  } catch {
    return ''; // Auth user may already be gone (partial cleanup)
  }
}

async function resolveAuthEmails(ids: string[]): Promise<string[]> {
  const emails: string[] = [];
  for (const id of ids) {
    const email = await resolveAuthEmail(id);
    if (email) emails.push(email);
  }
  return emails;
}

async function collectJobIdsForTargets(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const jobIds = new Set<string>();
  for (const column of ['customer_id', 'driver_id', 'accepted_driver_id'] as const) {
    const { data, error } = await supabaseAdmin.from('jobs').select('id').in(column, ids);
    if (error) throw new Error(`Failed to load affected jobs (${column}): ${error.message}`);
    for (const row of (data || []) as any[]) if (row?.id) jobIds.add(String(row.id));
  }
  return Array.from(jobIds);
}

/**
 * Delete ALL marketplace_negotiation_events belonging to the affected jobs'
 * negotiation sessions (by session_id), before the parent session rows are
 * removed. Covers events proposed by any participant, not just the target.
 */
async function deleteNegotiationEventsForJobs(jobIds: string[]): Promise<void> {
  if (!jobIds.length) return;
  const { data, error } = await supabaseAdmin.from('marketplace_negotiation_sessions').select('id').in('job_id', jobIds);
  if (error) throw new Error(`Failed to load negotiation sessions: ${error.message}`);
  const sessionIds = ((data || []) as any[]).map((row) => String(row.id));
  await deleteWhereIn('marketplace_negotiation_events', 'session_id', sessionIds);
}

export interface ResetPreview {
  accounts: number;
  jobs: number;
  vehicles: number;
  wallets: number;
  walletTransactions: number;
  notifications: number;
}

async function countIn(table: string, column: string, values: string[]): Promise<number> {
  if (!values.length) return 0;
  const { count, error } = await supabaseAdmin.from(table).select('id', { count: 'exact', head: true }).in(column, values);
  if (error) throw new Error(`Failed to count ${table}.${column}: ${error.message}`);
  return Number(count || 0);
}

export async function resetPreview(): Promise<ResetPreview> {
  const ids = await collectNonAdminTargets();
  const jobIds = await collectJobIdsForTargets(ids);

  return {
    accounts: ids.length,
    jobs: jobIds.length,
    vehicles: await countIn('vehicles', 'user_id', ids),
    wallets: await countIn('wallets', 'user_id', ids),
    walletTransactions: await countIn('wallet_transactions', 'user_id', ids),
    notifications: await countIn('notifications', 'user_id', ids)
  };
}

export interface ResetResult {
  accountsRemoved: number;
  jobsRemoved: number;
  authDeletionFailures: number;
  storageFailures: number;
}

export async function resetAllTestData(): Promise<ResetResult> {
  const ids = await collectNonAdminTargets();
  const emails = await resolveAuthEmails(ids);

  // 1. Delete the affected test-job aggregate (child-to-parent).
  const jobIds = await collectJobIdsForTargets(ids);
  await deleteNegotiationEventsForJobs(jobIds);
  for (const entry of JOB_OWNED_TABLES) {
    await deleteWhereIn(entry.table, entry.column, jobIds);
  }
  await deleteWhereIn('jobs', 'id', jobIds);

  // 2. Delete account-owned rows.
  for (const entry of ACCOUNT_OWNED_TABLES) {
    await deleteWhereIn(entry.table, entry.column, ids);
  }
  if (emails.length) {
    await deleteWhereIn('registration_otps', 'email', emails);
  }

  // 3. Delete application profiles (service_role bypasses ownership guard).
  await deleteWhereIn('profiles', 'id', ids);

  // 4. HARD-delete Auth users (releases test emails). Track failures.
  let authDeletionFailures = 0;
  for (const id of ids) {
    try {
      await supabaseAdmin.auth.admin.deleteUser(id, false);
    } catch (error) {
      authDeletionFailures += 1;
      console.warn('[TestAccountReset] auth delete failed for', id, error);
    }
  }

  // 5. Best-effort storage cleanup. Track failures.
  let storageFailures = 0;
  for (const id of ids) {
    storageFailures += await cleanupStorage(id);
  }

  return { accountsRemoved: ids.length, jobsRemoved: jobIds.length, authDeletionFailures, storageFailures };
}
