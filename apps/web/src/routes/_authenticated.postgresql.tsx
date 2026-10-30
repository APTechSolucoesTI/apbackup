import { createFileRoute } from '@tanstack/react-router';
import { PostgresPage } from '@/features/postgresql/page';
import { z } from 'zod';
export const Route = createFileRoute('/_authenticated/postgresql')({
  validateSearch: z.object({
    profileVersionId: z.uuid().optional(),
    serverId: z.uuid().optional(),
  }),
  component: () => <PostgresPage profileVersionId={Route.useSearch().profileVersionId} />,
});
