import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface ConsultantSignalItem {
  src: string;
  tag: string;
  code: string;
  title: string;
  exposure: number;
  when: string;
}

interface ConsultantSignalsResponse {
  signals: ConsultantSignalItem[];
}

export function useConsultantSignals(params: { window?: string }) {
  const search = new URLSearchParams();
  if (params.window) search.set('window', params.window);
  const qs = search.toString();

  return useQuery({
    queryKey: ['consultant-signals', params],
    queryFn: () =>
      apiFetch<ConsultantSignalsResponse>(
        `/v1/consultant/signals${qs ? `?${qs}` : ''}`,
      ),
  });
}
