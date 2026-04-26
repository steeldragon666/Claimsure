'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface AddUserInput {
  email: string;
  role: 'admin' | 'consultant' | 'viewer';
  isDefault: boolean;
}

export interface UserRef {
  id: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'consultant' | 'viewer';
  isDefault: boolean;
  addedAt: string;
}

export function useAddUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddUserInput) =>
      apiFetch<UserRef>('/v1/users', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}
