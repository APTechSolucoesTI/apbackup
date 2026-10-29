import { QueryClient } from '@tanstack/react-query';
export const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: false } },
  });
