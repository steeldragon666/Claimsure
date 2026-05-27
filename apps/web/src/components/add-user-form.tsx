'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useAddUser } from '@/hooks/use-add-user';
import { ConflictError, NotFoundError } from '@/lib/api';

const Schema = z.object({
  email: z.string().email('Must be a valid email'),
  role: z.enum(['admin', 'consultant', 'viewer']),
  isDefault: z.boolean(),
});
type FormValues = z.infer<typeof Schema>;

export function AddUserForm() {
  const router = useRouter();
  const { toast } = useToast();
  const addUser = useAddUser();

  const form = useForm<FormValues>({
    resolver: zodResolver(Schema),
    defaultValues: { email: '', role: 'consultant', isDefault: false },
  });

  const onSubmit = (values: FormValues) => {
    addUser.mutate(values, {
      onSuccess: () => {
        toast({ title: `Added ${values.email}` });
        router.push('/users');
      },
      onError: (err) => {
        if (err instanceof NotFoundError) {
          toast({
            title: 'User not found',
            description: 'Ask them to complete approved signup first, then retry.',
            variant: 'destructive',
          });
        } else if (err instanceof ConflictError) {
          toast({
            title: 'Already a member',
            description: 'That user is already in this firm.',
            variant: 'destructive',
          });
        } else {
          toast({
            title: 'Failed to add user',
            description: err instanceof Error ? err.message : 'Unknown error',
            variant: 'destructive',
          });
        }
      },
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4 max-w-lg">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="alice@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Role</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="consultant">Consultant</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="isDefault"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2">
              <FormControl>
                <input
                  type="checkbox"
                  checked={field.value}
                  onChange={(e) => field.onChange(e.target.checked)}
                />
              </FormControl>
              <FormLabel className="!mt-0">Set as their default firm at login</FormLabel>
            </FormItem>
          )}
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={addUser.isPending}>
            {addUser.isPending ? 'Adding…' : 'Add user'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push('/users')}>
            Cancel
          </Button>
        </div>
      </form>
    </Form>
  );
}
