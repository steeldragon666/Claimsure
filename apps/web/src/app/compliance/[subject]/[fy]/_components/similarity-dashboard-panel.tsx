'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Scan, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { postMultiEntityScan } from '../_lib/api';

interface Props {
  subject: string;
  fy: string;
}

export function SimilarityDashboardPanel({ subject, fy: _fy }: Props) {
  const [scanStatus, setScanStatus] = useState<'idle' | 'queued' | 'error'>('idle');

  const mutation = useMutation({
    mutationFn: () => postMultiEntityScan({ subject_tenant_id: subject }),
    onSuccess: () => setScanStatus('queued'),
    onError: () => setScanStatus('error'),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="font-display text-lg font-semibold">
            Multi-Entity Similarity
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || scanStatus === 'queued'}
          >
            <Scan className="h-4 w-4" />
            {mutation.isPending ? 'Scanning…' : 'Run Scan'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Detect high-similarity activity descriptions across entities to flag potential compliance
          risks before ATO submission.
        </p>

        {scanStatus === 'queued' && (
          <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm text-green-700">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Similarity scan queued. Results will appear here once processing completes.
          </div>
        )}

        {scanStatus === 'error' && (
          <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Failed to queue scan.{' '}
            {mutation.error instanceof Error ? mutation.error.message : 'Unknown error'}
          </div>
        )}

        {scanStatus === 'idle' && (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No scan results yet. Click &ldquo;Run Scan&rdquo; to check for similar activity
            descriptions across related entities.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
