import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'sonner';
import { makeQueryClient } from '@/lib/query-client';
import styles from '@/styles.css?url';
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'APBackup · Recuperação sob controle' },
    ],
    links: [
      { rel: 'stylesheet', href: styles },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700;800&display=swap',
      },
    ],
  }),
  component: Root,
  notFoundComponent: () => (
    <main className="standalone">
      <h1>Página não encontrada</h1>
      <p>Confira o endereço ou volte para a cobertura.</p>
      <a href="/">Voltar à cobertura</a>
    </main>
  ),
  errorComponent: ({ reset }) => (
    <main className="standalone">
      <h1>Não foi possível abrir esta página</h1>
      <p>Tente novamente em instantes.</p>
      <button onClick={reset}>Tentar novamente</button>
    </main>
  ),
});
function Root() {
  const [client] = useState(makeQueryClient);
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{document.documentElement.classList.toggle('dark',localStorage.getItem('apbackup:theme')==='dark')}catch{}",
          }}
        />
      </head>
      <body>
        <QueryClientProvider client={client}>
          <Outlet />
          <Toaster position="top-right" richColors />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
