import { createFileRoute } from '@tanstack/react-router';
import { CatalogPage } from '@/components/catalog-page';
import { listSearchSchema, type ListSearchInput } from '@/lib/listing';
export const Route = createFileRoute('/_authenticated/')({
  validateSearch: (search: ListSearchInput) => listSearchSchema.parse(search),
  component: () => <CatalogPage kind="coverage" />,
});
