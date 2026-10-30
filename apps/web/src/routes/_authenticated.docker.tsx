import { createFileRoute } from '@tanstack/react-router';
import { DockerPage } from '@/features/docker/page';
import { z } from 'zod';
export const Route = createFileRoute('/_authenticated/docker')({
  validateSearch: z.object({
    profileVersionId: z.uuid().optional(),
    serverId: z.uuid().optional(),
  }),
  component: () => {
    const search = Route.useSearch();
    return <DockerPage profileVersionId={search.profileVersionId} serverId={search.serverId} />;
  },
});
