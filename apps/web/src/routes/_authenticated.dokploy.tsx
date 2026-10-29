import { createFileRoute } from '@tanstack/react-router';
import { DokployPage } from '@/features/dokploy/page';
export const Route = createFileRoute('/_authenticated/dokploy')({ component: DokployPage });
