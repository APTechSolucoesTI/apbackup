import { createFileRoute, notFound } from '@tanstack/react-router';
import { z } from 'zod';
import { catalogKinds, listSearchSchema, type ListSearchInput } from '@/lib/listing';
import { CatalogPage } from '@/components/catalog-page';
export const Route = createFileRoute('/_authenticated/$section')({
  validateSearch: (search: ListSearchInput) => listSearchSchema.parse(search),
  beforeLoad: ({ params }) => {
    if (!z.enum(catalogKinds).safeParse(params.section).success) throw notFound();
  },
  component: () => <CatalogPage kind={z.enum(catalogKinds).parse(Route.useParams().section)} />,
});
