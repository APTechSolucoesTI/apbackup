import { createFileRoute } from '@tanstack/react-router';
import { PostgresPage } from '@/features/postgresql/page';
export const Route = createFileRoute('/_authenticated/postgresql')({ component: PostgresPage });
