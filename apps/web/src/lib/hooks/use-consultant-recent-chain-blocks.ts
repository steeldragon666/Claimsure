import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * One block in the audit chain — a hash-linked, immutable record of a
 * claim-lifecycle event (advance / hold / seal / evidence capture etc).
 *
 * NOTE: audit-chain ingestion is not yet implemented. The endpoint
 * returns an empty array; `ChainPanel` renders an empty state. When
 * ingestion ships, this interface is the contract that must be met.
 * See `docs/plans/consultant-wiring/d3-chain-panel.md`.
 */
export interface ConsultantChainBlock {
  id: string;
  kind: string;
  /** ISO-8601 timestamp; formatted to local HH:MM by the panel. */
  when: string;
  /** Claim slug/ID this block belongs to (e.g. "VANT-7"). */
  claim: string;
}

interface ConsultantRecentChainBlocksResponse {
  blocks: ConsultantChainBlock[];
  /** Current chain head height across the caller's tenant. */
  height: number;
}

export function useConsultantRecentChainBlocks(params: { limit?: number }) {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  const qs = search.toString();

  return useQuery({
    queryKey: ['consultant-recent-chain-blocks', params],
    queryFn: () =>
      apiFetch<ConsultantRecentChainBlocksResponse>(
        `/v1/consultant/chain/recent${qs ? `?${qs}` : ''}`,
      ),
  });
}
