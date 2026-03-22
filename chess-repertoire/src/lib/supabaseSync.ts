/**
 * Supabase cloud sync helpers for repertoire files and SR cards.
 * All functions are no-ops when Supabase is not configured.
 */

import { supabase, isSupabaseConfigured } from './supabase';
import type { RepertoireFile } from '../types/repertoireFile';
import type { Card } from './srScheduler';
import type { SRLifetimeStats } from './srStorage';

// ─── Repertoire Files ─────────────────────────────────────────────────────────

export async function fetchRemoteFiles(userId: string): Promise<RepertoireFile[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('repertoire_files')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[Supabase] fetchRemoteFiles error:', error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    tree: row.tree,
    nodeCount: row.node_count ?? 0,
    importedGames: row.imported_games ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function upsertRemoteFile(
  userId: string,
  file: RepertoireFile
): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.from('repertoire_files').upsert(
    {
      id: file.id,
      user_id: userId,
      name: file.name,
      tree: file.tree,
      node_count: file.nodeCount,
      imported_games: file.importedGames ?? null,
      updated_at: file.updatedAt,
      created_at: file.createdAt,
    },
    { onConflict: 'id,user_id' }
  );
  if (error) console.error('[Supabase] upsertRemoteFile error:', error.message);
}

export async function deleteRemoteFile(
  userId: string,
  fileId: string
): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase
    .from('repertoire_files')
    .delete()
    .eq('id', fileId)
    .eq('user_id', userId);
  if (error) console.error('[Supabase] deleteRemoteFile error:', error.message);
}

// Push all local files up to Supabase (used on sign-in to merge local → cloud)
export async function pushAllFilesToCloud(
  userId: string,
  files: RepertoireFile[]
): Promise<void> {
  if (!isSupabaseConfigured || files.length === 0) return;
  for (const file of files) {
    await upsertRemoteFile(userId, file);
  }
}

// ─── SR Cards ─────────────────────────────────────────────────────────────────

export async function fetchRemoteCards(userId: string): Promise<Card[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('sr_cards')
    .select('data')
    .eq('user_id', userId);
  if (error) {
    console.error('[Supabase] fetchRemoteCards error:', error.message);
    return [];
  }
  return (data ?? []).map((row) => row.data as Card);
}

export async function upsertRemoteCard(userId: string, card: Card): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.from('sr_cards').upsert(
    { id: card.id, user_id: userId, data: card },
    { onConflict: 'id,user_id' }
  );
  if (error) console.error('[Supabase] upsertRemoteCard error:', error.message);
}

export async function saveAllRemoteCards(userId: string, cards: Card[]): Promise<void> {
  if (!isSupabaseConfigured || cards.length === 0) return;
  // Delete all then re-insert — simple but effective for small card sets
  await supabase.from('sr_cards').delete().eq('user_id', userId);
  if (cards.length === 0) return;
  const rows = cards.map((c) => ({ id: c.id, user_id: userId, data: c }));
  const { error } = await supabase.from('sr_cards').insert(rows);
  if (error) console.error('[Supabase] saveAllRemoteCards error:', error.message);
}

// ─── SR Stats ─────────────────────────────────────────────────────────────────

export async function fetchRemoteStats(userId: string): Promise<SRLifetimeStats | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase
    .from('sr_stats')
    .select('total_reviewed, total_correct')
    .eq('user_id', userId)
    .single();
  if (error) return null;
  return { totalReviewed: data.total_reviewed, totalCorrect: data.total_correct };
}

export async function upsertRemoteStats(userId: string, stats: SRLifetimeStats): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.from('sr_stats').upsert(
    {
      user_id: userId,
      total_reviewed: stats.totalReviewed,
      total_correct: stats.totalCorrect,
    },
    { onConflict: 'user_id' }
  );
  if (error) console.error('[Supabase] upsertRemoteStats error:', error.message);
}
