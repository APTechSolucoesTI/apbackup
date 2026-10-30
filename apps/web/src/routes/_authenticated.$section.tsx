import { createFileRoute, notFound } from '@tanstack/react-router';
import { z } from 'zod';
import { catalogKinds, listSearchSchema, type ListSearchInput } from '@/lib/listing';
import { CatalogPage } from '@/components/catalog-page';
import { SystemsPage } from '@/features/systems/page';
export const Route = createFileRoute('/_authenticated/$section')({
  validateSearch: (search: ListSearchInput) => listSearchSchema.parse(search),
  beforeLoad: ({ params }) => {
    if (!z.enum(catalogKinds).safeParse(params.section).success) throw notFound();
  },
  component: () =>
    Route.useParams().section === 'systems' ? (
      <SystemsPage />
    ) : (
      <CatalogPage kind={z.enum(catalogKinds).parse(Route.useParams().section)} />
    ),
});
