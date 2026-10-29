import { createFileRoute } from '@tanstack/react-router';
import { DockerPage } from '@/features/docker/page';
export const Route = createFileRoute('/_authenticated/docker')({ component: DockerPage });
