'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { updateBrandConfig } from '../_lib/api';
import { ThemePreview } from './theme-preview';

/**
 * Theme picker (T-C3).
 *
 * Two color fields (primary + accent) with HTML5 `<input type="color">`
 * pickers paired with hex text inputs. The picker is the canonical
 * value — react-hook-form binds both inputs to the same field, so
 * either entry point updates the other. Validation regex
 * (`^#[0-9a-fA-F]{6}$`) mirrors the server-side `hexColor` zod schema
 * in `@cpa/schemas/brand-config`.
 *
 * Submit PATCHes /v1/brand-config; on success we invalidate the
 * `['brand-config']` query so the read view + the preview tile both
 * pick up the new persisted state.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const Schema = z.object({
  primary_color: z.string().regex(HEX_COLOR, 'Must be a 6-digit hex like #00aaff'),
  accent_color: z.string().regex(HEX_COLOR, 'Must be a 6-digit hex like #00aaff'),
});
type FormValues = z.infer<typeof Schema>;

export function ThemePicker({ primary, accent }: { primary: string; accent: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const form = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { primary_color: primary, accent_color: accent },
  });

  // Subscribe to form values for the live preview without forcing the
  // full form to re-render on every keystroke (watch() returns stable
  // references inside react-hook-form's internal state).
  const previewPrimary = form.watch('primary_color');
  const previewAccent = form.watch('accent_color');

  const save = useMutation({
    mutationFn: (values: FormValues) => updateBrandConfig(values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['brand-config'] });
      toast({ title: 'Theme updated' });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      }),
  });

  const onSubmit = (values: FormValues) => save.mutate(values);

  return (
    <Form {...form}>
      <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            control={form.control}
            name="primary_color"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Primary color</FormLabel>
                <FormControl>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={HEX_COLOR.test(field.value) ? field.value : '#000000'}
                      onChange={(e) => field.onChange(e.target.value)}
                      className="h-10 w-12 rounded border cursor-pointer"
                      aria-label="Primary color picker"
                    />
                    <Input
                      type="text"
                      value={field.value}
                      onChange={(e) => field.onChange(e.target.value)}
                      placeholder="#00aaff"
                      className="font-mono"
                    />
                  </div>
                </FormControl>
                <FormDescription>Used for headers, primary buttons.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="accent_color"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Accent color</FormLabel>
                <FormControl>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={HEX_COLOR.test(field.value) ? field.value : '#000000'}
                      onChange={(e) => field.onChange(e.target.value)}
                      className="h-10 w-12 rounded border cursor-pointer"
                      aria-label="Accent color picker"
                    />
                    <Input
                      type="text"
                      value={field.value}
                      onChange={(e) => field.onChange(e.target.value)}
                      placeholder="#ff7a00"
                      className="font-mono"
                    />
                  </div>
                </FormControl>
                <FormDescription>Used for links and highlights.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">Preview</p>
          <ThemePreview
            primary={HEX_COLOR.test(previewPrimary) ? previewPrimary : primary}
            accent={HEX_COLOR.test(previewAccent) ? previewAccent : accent}
          />
        </div>

        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save theme'}
        </Button>
      </form>
    </Form>
  );
}
