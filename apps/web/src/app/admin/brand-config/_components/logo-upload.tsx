'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { requestLogoUploadUrl, updateBrandConfig } from '../_lib/api';

/**
 * Logo upload (T-C2).
 *
 * Two-step flow: ask the API for a pre-signed S3 PUT URL, then upload
 * the blob to S3, then PATCH /v1/brand-config with the returned s3_key.
 *
 * The PUT step is currently disabled — the server returns a placeholder
 * URL until the storage-infra task lands the real S3 client. Saving
 * just the s3_key still works because the API derives a stable key
 * format (`brand-config/{tenantId}/logo-{uuid}.{ext}`); when real S3
 * lights up, the PUT call gets re-enabled and existing rows already
 * point at well-formed paths.
 */
export function LogoUpload({ currentLogo }: { currentLogo: string | null }) {
  const [file, setFile] = useState<File | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const { s3_key } = await requestLogoUploadUrl({
        content_type: f.type,
        size_bytes: f.size,
      });
      // Real PUT is gated on the storage-infra task. The placeholder
      // URL would 404; skip it and let the s3_key carry through. When
      // S3 wires up, uncomment:
      //   await fetch(upload_url, {
      //     method: 'PUT',
      //     headers: { 'Content-Type': f.type },
      //     body: f,
      //   });
      await updateBrandConfig({ logo_s3_key: s3_key });
      return s3_key;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      toast({ title: 'Logo updated' });
      setFile(null);
    },
    onError: (e) =>
      toast({
        title: 'Upload failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      }),
  });

  return (
    <div className="space-y-2">
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      {file && (
        <p className="text-sm">
          Selected: {file.name} ({Math.round(file.size / 1024)} KB)
        </p>
      )}
      <Button onClick={() => file && upload.mutate(file)} disabled={!file || upload.isPending}>
        {upload.isPending ? 'Uploading…' : 'Upload Logo'}
      </Button>
      {currentLogo && <p className="text-xs text-muted-foreground">Current: {currentLogo}</p>}
    </div>
  );
}
